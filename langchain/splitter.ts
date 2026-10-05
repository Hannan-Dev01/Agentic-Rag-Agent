import type { Document } from "@langchain/core/documents";
import {
  RecursiveCharacterTextSplitter,
  MarkdownTextSplitter,
  TextSplitter,
} from "@langchain/textsplitters";
import { chunkIdFor } from "@/lib/ids";
import { pageNumberOf } from "@/langchain/loaders";
import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from "@/lib/constants";
import type { ChunkMetadata, DocumentSourceType } from "@/types";

/**
 * Pick the right splitter for the document type.
 *
 * - Markdown → MarkdownTextSplitter: pre-seeded with Markdown separators (headings,
 *   code fences, lists) so a chunk boundary lands between sections, not mid-heading.
 * - Everything else (pdf/txt/docx) → RecursiveCharacterTextSplitter: tries
 *   paragraph → line → word → char separators in priority order, keeping the
 *   largest coherent unit that fits. This is the best general-purpose default:
 *   character-measured, structure-respecting.
 *
 * We deliberately do NOT default to TokenTextSplitter: token-exact splitting cuts
 * mid-sentence and only matters when a hard token ceiling is the binding
 * constraint. At ~1000 chars (~250 tokens) we're nowhere near the 8191 limit.
 */
function splitterFor(sourceType: DocumentSourceType): TextSplitter {
  const opts = {
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  };
  if (sourceType === "md") {
    return new MarkdownTextSplitter(opts);
  }
  return new RecursiveCharacterTextSplitter(opts);
}

/**
 * Split parsed page-level Documents into overlapping chunk Documents, stamping
 * each with our full ChunkMetadata contract.
 *
 * Why `splitDocuments` (not `splitText`)? It preserves each INPUT document's
 * metadata onto its child chunks — so the PDF page number we attached in Phase 2
 * propagates to every chunk automatically. That's what makes page-level
 * citations "just work" downstream.
 */
export async function chunkDocuments(
  documents: Document[],
  args: {
    documentId: string;
    filename: string;
    sourceType: DocumentSourceType;
    uploadedAt: string;
  },
): Promise<Document<ChunkMetadata>[]> {
  const splitter = splitterFor(args.sourceType);
  const rawChunks = await splitter.splitDocuments(documents);

  return rawChunks.map((chunk, index) => {
    const chunkId = chunkIdFor(args.documentId, index);
    const metadata: ChunkMetadata = {
      documentId: args.documentId,
      chunkId,
      filename: args.filename,
      source: args.sourceType,
      uploadedAt: args.uploadedAt,
      page: pageNumberOf(chunk), // inherited from the parent page Document, if any
      chunkIndex: index,
      // Store the chunk text IN metadata too: Pinecone returns metadata on query,
      // so this is how retrieval gets the actual text back for the prompt + UI.
      text: chunk.pageContent,
    };
    // Return a Document whose metadata IS our contract type.
    return { pageContent: chunk.pageContent, metadata } as Document<ChunkMetadata>;
  });
}
