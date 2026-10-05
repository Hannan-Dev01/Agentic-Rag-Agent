import type { Document } from "@langchain/core/documents";
import { PineconeStore } from "@langchain/pinecone";
import { getEmbeddings } from "@/langchain/embeddings";
import { ensureIndex } from "@/pinecone/client";
import { chunkIdFor } from "@/lib/ids";
import type { ChunkMetadata } from "@/types";

/**
 * Build a LangChain PineconeStore bound to our embeddings + index.
 *
 * PineconeStore is the adapter that unifies the vector DB behind LangChain's
 * VectorStore interface. It will:
 *   - call getEmbeddings().embedDocuments() for us on write (why Phase 4 didn't
 *     need a manual embed step), and embedQuery() on read (Phase 6),
 *   - upsert vectors + metadata,
 *   - run similarity search.
 *
 * textKey: "text" tells the store to put the chunk's pageContent into the
 * metadata field named "text" — which is exactly the field our ChunkMetadata
 * already defines, so retrieval hands us the chunk text back with no extra fetch.
 */
export async function getVectorStore(): Promise<PineconeStore> {
  const pineconeIndex = await ensureIndex();
  return new PineconeStore(getEmbeddings(), {
    pineconeIndex,
    textKey: "text",
  });
}

/**
 * Pinecone metadata may only contain string | number | boolean | string[].
 * `undefined`/`null` values (e.g. `page` on a non-paged DOCX) cause upsert errors,
 * so we strip them here — keeping this Pinecone-specific constraint inside the
 * pinecone/ boundary rather than leaking it upward.
 */
type PineconeMetadataValue = string | number | boolean | string[];

function sanitize(metadata: ChunkMetadata): Record<string, PineconeMetadataValue> {
  const out: Record<string, PineconeMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    // string[] is permitted (we use it for derivedFrom); an EMPTY array is not
    // a useful filter target and some tiers reject it, so drop those too.
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value as string[];
      continue;
    }
    out[key] = value as string | number | boolean;
  }
  return out;
}

/**
 * Store chunk documents. We pass explicit `ids` = chunkId so re-ingesting the
 * same document UPSERTS (overwrites) instead of creating duplicate vectors.
 */
export async function storeChunks(
  chunks: Document<ChunkMetadata>[],
): Promise<number> {
  if (chunks.length === 0) return 0;
  const store = await getVectorStore();

  const cleaned = chunks.map((c) => ({
    pageContent: c.pageContent,
    metadata: sanitize(c.metadata) as Record<string, string | number | boolean>,
  }));
  const ids = chunks.map((c) => c.metadata.chunkId);

  await store.addDocuments(cleaned, { ids });
  return chunks.length;
}

/**
 * Delete every vector belonging to one document.
 *
 * IMPORTANT: Pinecone SERVERLESS (the free Starter tier) does NOT support
 * metadata-filtered deletes — only delete-by-ID. Our chunk IDs are prefixed with
 * the documentId ("doc_xxx::chunk_N"), so we list IDs by prefix and delete those.
 * This is the portable approach that works on every tier.
 */
export async function deleteDocument(documentId: string): Promise<void> {
  const index = await ensureIndex();
  const prefix = `${chunkIdFor(documentId, 0).split("::")[0]}::`; // "doc_xxx::"

  let paginationToken: string | undefined;
  do {
    const page = await index.listPaginated({ prefix, paginationToken });
    const ids = (page.vectors ?? [])
      .map((v) => v.id)
      .filter((id): id is string => typeof id === "string");
    if (ids.length > 0) await index.deleteMany(ids);
    paginationToken = page.pagination?.next;
  } while (paginationToken);
}

/**
 * PHASE 15 — fetch EVERY chunk of one document, in reading order.
 *
 * Retrieval answers "which passages match this question?"; summarisation needs
 * "give me the whole file". Same prefix-listing trick as deleteDocument(), then
 * batched fetches, then sorted by chunkIndex so the text reads in document order
 * rather than Pinecone's arbitrary return order.
 */
export async function fetchDocumentChunks(
  documentId: string,
): Promise<ChunkMetadata[]> {
  const index = await ensureIndex();
  const prefix = `${documentId}::`;

  const ids: string[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await index.listPaginated({ prefix, paginationToken });
    for (const v of page.vectors ?? []) {
      if (typeof v.id === "string") ids.push(v.id);
    }
    paginationToken = page.pagination?.next;
  } while (paginationToken);

  const chunks: ChunkMetadata[] = [];
  // Pinecone caps fetch batch size; 100 is the safe, documented batch.
  for (let i = 0; i < ids.length; i += 100) {
    const res = await index.fetch(ids.slice(i, i + 100));
    for (const [, record] of Object.entries(res.records ?? {})) {
      const md = record.metadata as unknown as ChunkMetadata | undefined;
      if (md?.chunkId) chunks.push(md);
    }
  }

  return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
}
