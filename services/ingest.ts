import type { Document } from "@langchain/core/documents";
import { loadDocuments, pageNumberOf } from "@/langchain/loaders";
import { chunkDocuments } from "@/langchain/splitter";
import { storeChunks } from "@/pinecone/vectorstore";
import { newDocumentId } from "@/lib/ids";
import {
  MAX_UPLOAD_BYTES,
  MIME_TO_SOURCE,
  MAX_GENERATED_DOC_CHARS,
} from "@/lib/constants";
import type {
  ChunkMetadata,
  DocumentRecord,
  SupportedMimeType,
  UploadedFileResult,
} from "@/types";

/**
 * The ingestion orchestrator. In Phase 2 it does: validate → parse → summarize.
 * Phases 3–5 will insert chunk → embed → store BETWEEN parse and summarize,
 * without changing this function's callers (the API route).
 *
 * Returning the parsed `Document[]` (not just a summary) is deliberate: it's the
 * hand-off point for the next phases.
 */
export interface ParsedUpload {
  record: DocumentRecord;
  /** Parsed LangChain documents (one per page for PDFs). */
  documents: Document[];
  /** Chunked, metadata-stamped documents — the hand-off to Phase 4 (embeddings). */
  chunks: Document<ChunkMetadata>[];
  preview: string;
}

/** Type guard: is this MIME type one we accept? */
function isSupportedMime(mime: string): mime is SupportedMimeType {
  return mime in MIME_TO_SOURCE;
}

/**
 * Validate + parse a single uploaded file. Throws with a user-safe message on
 * bad input so the route can turn it into a per-file error result.
 */
export async function parseUpload(file: File): Promise<ParsedUpload> {
  // --- Validation: never trust the client. ---
  if (file.size === 0) {
    throw new Error("File is empty.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.`,
    );
  }

  // Browsers sometimes send "" or "application/octet-stream" for .md files.
  // Fall back to the file extension when the MIME type is missing/unknown.
  const mime = resolveMimeType(file);
  if (!isSupportedMime(mime)) {
    throw new Error(`Unsupported file type: ${file.type || "unknown"}.`);
  }

  const sourceType = MIME_TO_SOURCE[mime];
  const documentId = newDocumentId();

  // --- Parse via LangChain loader. `file` is a Blob, passed straight through. ---
  const documents = await loadDocuments(file, sourceType);

  // Stamp our own metadata onto each parsed document so later phases (and
  // Pinecone) carry consistent provenance. We keep the loader's page info.
  const uploadedAt = new Date().toISOString();
  for (const doc of documents) {
    doc.metadata = {
      ...doc.metadata,
      documentId,
      filename: file.name,
      source: sourceType,
      uploadedAt,
      page: pageNumberOf(doc),
    };
  }

  const fullText = documents.map((d) => d.pageContent).join("\n\n");
  const charCount = fullText.length;

  if (charCount === 0) {
    // e.g. a scanned/image-only PDF with no extractable text layer.
    throw new Error(
      "No extractable text found (is this a scanned/image-only document?).",
    );
  }

  // --- Phase 3: split the parsed text into overlapping, metadata-rich chunks. ---
  const chunks = await chunkDocuments(documents, {
    documentId,
    filename: file.name,
    sourceType,
    uploadedAt,
  });

  const record: DocumentRecord = {
    documentId,
    filename: file.name,
    sourceType,
    uploadedAt,
    chunkCount: chunks.length,
    charCount,
  };

  return {
    record,
    documents,
    chunks,
    preview: fullText.slice(0, 300),
  };
}

/** Resolve a usable MIME type, falling back to the filename extension. */
function resolveMimeType(file: File): string {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "md":
    case "markdown":
      return "text/markdown";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return file.type || "";
  }
}

/**
 * Full ingestion for one file: parse → chunk → EMBED + STORE in Pinecone.
 * The embed step is implicit — storeChunks() hands the chunks to PineconeStore,
 * which calls our embeddings client internally.
 */
export async function ingestFile(file: File): Promise<ParsedUpload> {
  const parsed = await parseUpload(file);
  await storeChunks(parsed.chunks);
  return parsed;
}

/**
 * Route-facing wrapper: ingest many files concurrently, never throwing. Each
 * file's success/failure is isolated so one bad file doesn't sink the batch.
 */
export async function ingestUploads(files: File[]): Promise<UploadedFileResult[]> {
  return Promise.all(
    files.map(async (file): Promise<UploadedFileResult> => {
      try {
        const { record, preview } = await ingestFile(file);
        return { filename: file.name, ok: true, record, preview };
      } catch (err) {
        return {
          filename: file.name,
          ok: false,
          error: err instanceof Error ? err.message : "Failed to process file.",
        };
      }
    }),
  );
}

/**
 * PHASE 16 — INGEST ASSISTANT-AUTHORED TEXT
 *
 * The write path for documents the agent composes itself, as opposed to files a
 * human uploads. It joins the EXISTING pipeline at the chunking step —
 * `chunkDocuments` → `storeChunks` — rather than duplicating it, so generated
 * documents are chunked, embedded, stored and retrieved by exactly the same code
 * as uploads. The only difference is where the text came from, and that
 * difference is recorded in metadata rather than in a separate code path.
 *
 * We skip the loader stage for the obvious reason: there is no file to parse.
 * The text is already text.
 */
export async function ingestText(args: {
  /** Human-facing title; becomes the filename, with .md appended if absent. */
  title: string;
  /** Markdown body authored by the assistant. */
  text: string;
  /** documentIds this was synthesised from, for provenance. */
  derivedFrom?: string[];
}): Promise<DocumentRecord> {
  const text = args.text.trim();
  if (text.length === 0) throw new Error("Refusing to store an empty document.");
  if (text.length > MAX_GENERATED_DOC_CHARS) {
    throw new Error(
      `Generated document exceeds the ${MAX_GENERATED_DOC_CHARS}-character limit.`,
    );
  }

  const filename = args.title.toLowerCase().endsWith(".md")
    ? args.title
    : `${args.title}.md`;
  const documentId = newDocumentId();
  const uploadedAt = new Date().toISOString();

  // One synthetic page-level Document, shaped exactly like a loader's output.
  const documents: Document[] = [
    {
      pageContent: text,
      metadata: { documentId, filename, source: "md", uploadedAt },
    } as Document,
  ];

  // Markdown splitter: the agent writes headed Markdown, so section-aware
  // boundaries are the right call for the same reason they are for uploaded .md.
  const chunks = await chunkDocuments(documents, {
    documentId,
    filename,
    sourceType: "md",
    uploadedAt,
  });

  // Stamp provenance on every chunk, so a retrieved passage carries its origin
  // even when nothing else about the document is in scope.
  //
  // The FIRST chunk additionally carries `fullText`: the exact Markdown we
  // authored. Export needs the document verbatim, and chunks cannot be glued
  // back together losslessly — they overlap by DEFAULT_CHUNK_OVERLAP characters
  // by design, so naive concatenation duplicates text at every seam. Since we
  // wrote this document ourselves, we simply keep the original. Capped at
  // MAX_GENERATED_DOC_CHARS (20k), comfortably inside Pinecone's 40KB
  // per-record metadata limit.
  const stamped = chunks.map((c, i) => ({
    ...c,
    metadata: {
      ...c.metadata,
      generated: true,
      ...(args.derivedFrom?.length ? { derivedFrom: args.derivedFrom } : {}),
      ...(i === 0 ? { fullText: text } : {}),
    },
  }));

  await storeChunks(stamped);

  return {
    documentId,
    filename,
    sourceType: "md",
    uploadedAt,
    chunkCount: stamped.length,
    charCount: text.length,
    generated: true,
    derivedFrom: args.derivedFrom,
  };
}
