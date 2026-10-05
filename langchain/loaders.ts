import type { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import { TextLoader } from "langchain/document_loaders/fs/text";
import type { DocumentSourceType } from "@/types";

/**
 * Turn an uploaded file (a Blob, exactly what FormData gives us on the server)
 * into an array of LangChain `Document`s.
 *
 * Why return Document[] and not a single string?
 *  - PDFs are loaded one Document PER PAGE, each carrying metadata.loc.pageNumber.
 *    Preserving that page boundary is what makes page-level citations possible.
 *  - For txt/md there are no pages, so we get a single Document.
 *
 * All these loaders extend a base that accepts `string | Blob`, so we can pass
 * the in-memory Blob directly — no temp files, no disk I/O, no cleanup.
 */
export async function loadDocuments(
  blob: Blob,
  sourceType: DocumentSourceType,
): Promise<Document[]> {
  switch (sourceType) {
    case "pdf": {
      // splitPages: true (the default) → one Document per page with page metadata.
      const loader = new PDFLoader(blob, { splitPages: true });
      return loader.load();
    }
    case "docx": {
      // mammoth extracts raw text from the .docx XML. DOCX has no page concept
      // (pages are a rendering artifact), so this yields a single Document.
      const loader = new DocxLoader(blob);
      return loader.load();
    }
    case "txt":
    case "md": {
      // Plain text. Markdown is loaded as-is here; markdown-AWARE splitting
      // (respecting headings/code fences) happens in Phase 3.
      const loader = new TextLoader(blob);
      return loader.load();
    }
    default: {
      // Exhaustiveness guard: if we add a source type to the union and forget a
      // case here, TypeScript flags it at compile time.
      const _never: never = sourceType;
      throw new Error(`Unsupported source type: ${String(_never)}`);
    }
  }
}

/** Extract a 1-based page number from a LangChain PDF Document, if present. */
export function pageNumberOf(doc: Document): number | undefined {
  const loc = doc.metadata?.loc as { pageNumber?: number } | undefined;
  return typeof loc?.pageNumber === "number" ? loc.pageNumber : undefined;
}
