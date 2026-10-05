import { Document as DocxDocument, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import PDFDocument from "pdfkit";
import { fetchDocumentChunks } from "@/pinecone/vectorstore";
import { resolveDocument } from "@/services/documents";
import { DEFAULT_CHUNK_OVERLAP } from "@/lib/constants";

/**
 * PHASE 17 — EXPORT
 *
 * A document the assistant wrote is only half-delivered while it lives as
 * vectors. This module turns one stored document back into a file the user can
 * download: Markdown, Word (.docx) or PDF.
 */

export type ExportFormat = "md" | "docx" | "pdf";

export interface ExportedFile {
  buffer: Buffer;
  /** Filename to offer in the download, extension included. */
  filename: string;
  mimeType: string;
  /** False when the text was reconstructed from chunks rather than stored whole. */
  exact: boolean;
}

const MIME: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

/* ------------------------------------------------------------------ *
 * SOURCE RECOVERY
 * ------------------------------------------------------------------ */

/**
 * Recover a document's text.
 *
 * Two paths, and the distinction is honest rather than cosmetic:
 *
 *  - EXACT: documents the assistant authored carry the original Markdown in
 *    `fullText` on chunk 0. We wrote it, so we kept it.
 *  - RECONSTRUCTED: for uploaded files we only ever stored chunks, and chunks
 *    deliberately OVERLAP (DEFAULT_CHUNK_OVERLAP characters) so that a sentence
 *    spanning a boundary stays retrievable from both sides. Concatenating them
 *    naively therefore repeats text at every seam. We strip the overlap below,
 *    but the result is a faithful reconstruction, not a byte-identical original —
 *    and PDF/DOCX layout, images and tables are gone regardless, because only
 *    extracted text was ever stored. Callers surface `exact: false` so the user
 *    is told which they got.
 */
export async function getDocumentText(
  documentId: string,
): Promise<{ filename: string; text: string; exact: boolean }> {
  const chunks = await fetchDocumentChunks(documentId);
  if (chunks.length === 0) {
    throw new Error("Document not found, or it has no stored content.");
  }

  const filename = chunks[0].filename;

  const stored = chunks[0].fullText;
  if (typeof stored === "string" && stored.length > 0) {
    return { filename, text: stored, exact: true };
  }

  return { filename, text: joinChunks(chunks.map((c) => c.text)), exact: false };
}

/**
 * Glue chunks back together, removing the overlap each shares with its
 * predecessor.
 *
 * For each seam we look for the longest suffix of what we have so far that is
 * also a prefix of the next chunk, searching down from a little above the
 * configured overlap (splitters can exceed it slightly when they snap to a
 * separator). We require a minimum match length so that an incidental few
 * characters — two chunks both starting with "The " — are not mistaken for a
 * real overlap and silently eaten.
 */
function joinChunks(texts: string[]): string {
  const MAX_PROBE = DEFAULT_CHUNK_OVERLAP * 2;
  const MIN_MATCH = 24;

  let out = texts[0] ?? "";
  for (let i = 1; i < texts.length; i++) {
    const next = texts[i];
    const probe = Math.min(MAX_PROBE, out.length, next.length);

    let overlap = 0;
    for (let k = probe; k >= MIN_MATCH; k--) {
      if (out.endsWith(next.slice(0, k))) {
        overlap = k;
        break;
      }
    }
    out += overlap > 0 ? next.slice(overlap) : `\n\n${next}`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A DELIBERATELY SMALL MARKDOWN PARSER
 * ------------------------------------------------------------------ */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; text: string }
  | { kind: "code"; text: string }
  | { kind: "para"; text: string };

/**
 * Parse the subset of Markdown the assistant actually writes: ATX headings,
 * bullet and numbered lists, fenced code, and paragraphs.
 *
 * Deliberately not a full CommonMark implementation. Pulling in a parser plus an
 * AST-to-docx and an AST-to-PDF layer would be a large dependency surface for
 * documents we generate ourselves from a prompt that asks for exactly these
 * constructs. Anything unrecognised degrades to a paragraph, so an unsupported
 * construct loses its formatting but never its content.
 */
function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "para", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      if (code.length > 0) blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // h4-h6 are rare in generated docs and render as h3.
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: inline(heading[2]) });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ kind: "bullet", text: inline(bullet[1]) });
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flush();
      blocks.push({ kind: "numbered", text: inline(numbered[1]) });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();

  return blocks;
}

/** Strip inline emphasis/code markers — both renderers draw plain runs. */
function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)(?<!\s)\*/g, "$1$2")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");
}

/* ------------------------------------------------------------------ *
 * RENDERERS
 * ------------------------------------------------------------------ */

async function renderDocx(markdown: string, title: string): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);

  const children = blocks.map((b) => {
    switch (b.kind) {
      case "heading":
        return new Paragraph({
          text: b.text,
          heading:
            b.level === 1
              ? HeadingLevel.HEADING_1
              : b.level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          spacing: { before: 240, after: 120 },
        });
      case "bullet":
        return new Paragraph({ text: b.text, bullet: { level: 0 }, spacing: { after: 60 } });
      case "numbered":
        return new Paragraph({
          text: b.text,
          numbering: { reference: "numbered", level: 0 },
          spacing: { after: 60 },
        });
      case "code":
        return new Paragraph({
          children: [new TextRun({ text: b.text, font: "Courier New", size: 20 })],
          spacing: { after: 120 },
        });
      default:
        return new Paragraph({ text: b.text, spacing: { after: 120 } });
    }
  });

  const doc = new DocxDocument({
    title,
    numbering: {
      config: [
        {
          reference: "numbered",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "left" }],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

function renderPdf(markdown: string, title: string): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);

  return new Promise((resolve, reject) => {
    // Only the 14 built-in PDF fonts are used, so no font files need shipping.
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: title } });
    const parts: Buffer[] = [];

    doc.on("data", (c: Buffer) => parts.push(c));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);

    const SIZES = { 1: 20, 2: 15, 3: 12.5 } as const;

    for (const b of blocks) {
      switch (b.kind) {
        case "heading":
          doc
            .moveDown(b.level === 1 ? 0.4 : 0.7)
            .font("Helvetica-Bold")
            .fontSize(SIZES[b.level])
            .text(b.text)
            .moveDown(0.3);
          break;
        case "bullet":
          doc.font("Helvetica").fontSize(10.5).text(`•  ${b.text}`, { indent: 14 });
          break;
        case "numbered":
          doc.font("Helvetica").fontSize(10.5).text(b.text, { indent: 14 });
          break;
        case "code":
          doc.font("Courier").fontSize(9).text(b.text, { indent: 14 }).moveDown(0.4);
          break;
        default:
          doc.font("Helvetica").fontSize(10.5).text(b.text, { align: "left" }).moveDown(0.4);
      }
    }

    doc.end();
  });
}

/* ------------------------------------------------------------------ *
 * ENTRY POINT
 * ------------------------------------------------------------------ */

/** Base filename without its original extension, so we can append our own. */
function stem(filename: string): string {
  return filename.replace(/\.(md|markdown|txt|pdf|docx)$/i, "");
}

/** Build a downloadable file for one stored document. */
export async function exportDocument(
  documentId: string,
  format: ExportFormat,
): Promise<ExportedFile> {
  const { filename, text, exact } = await getDocumentText(documentId);
  const base = stem(filename);

  const buffer =
    format === "md"
      ? Buffer.from(text, "utf8")
      : format === "docx"
        ? await renderDocx(text, base)
        : await renderPdf(text, base);

  return { buffer, filename: `${base}.${format}`, mimeType: MIME[format], exact };
}

/** Accept a filename or documentId, as the chat tools do. */
export async function exportByReference(
  ref: string,
  format: ExportFormat,
): Promise<ExportedFile> {
  const res = await resolveDocument(ref);
  if (res.status !== "found") {
    throw new Error(
      res.status === "ambiguous"
        ? `"${ref}" matches more than one document.`
        : `No document matching "${ref}".`,
    );
  }
  return exportDocument(res.document.documentId, format);
}
