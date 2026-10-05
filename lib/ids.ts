import { randomUUID } from "node:crypto";

/**
 * Stable ID generation. We prefix IDs so that when we're staring at raw Pinecone
 * data, we can tell at a glance what an ID refers to.
 *
 * - documentId: one per uploaded file. Attached to every chunk so we can later
 *   "delete everything from this file" with a single metadata-filtered delete.
 * - chunkId: one per chunk. Becomes the Pinecone vector ID (must be unique).
 */
export function newDocumentId(): string {
  return `doc_${randomUUID()}`;
}

export function chunkIdFor(documentId: string, chunkIndex: number): string {
  // Deterministic given (documentId, index): re-ingesting the same doc overwrites
  // the same vector IDs instead of creating duplicates.
  return `${documentId}::chunk_${chunkIndex}`;
}
