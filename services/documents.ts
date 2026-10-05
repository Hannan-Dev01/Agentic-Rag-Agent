import { ensureIndex } from "@/pinecone/client";
import { deleteDocument } from "@/pinecone/vectorstore";
import type { ChunkMetadata, DocumentRecord, DocumentSourceType } from "@/types";

/**
 * Document listing, Pinecone-only (no separate DB, per the chosen architecture).
 *
 * Pinecone has no "scan all metadata" API, but it CAN list vector IDs by prefix.
 * Our chunk IDs are "doc_<uuid>::chunk_<n>", so we:
 *   1) list every ID with prefix "doc_",
 *   2) group by documentId,
 *   3) fetch one representative chunk per document to recover its metadata.
 *
 * Trade-off: this is O(number of chunks) list calls + O(number of documents)
 * fetches. Fine for hundreds of docs; at large scale you'd keep a documents table
 * in Postgres. The metadata contract already supports that migration.
 */
export async function listDocuments(): Promise<DocumentRecord[]> {
  const index = await ensureIndex();

  // 1) Collect all chunk IDs by prefix, paginating.
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await index.listPaginated({ prefix: "doc_", paginationToken: token });
    for (const v of page.vectors ?? []) {
      if (typeof v.id === "string") ids.push(v.id);
    }
    token = page.pagination?.next;
  } while (token);

  if (ids.length === 0) return [];

  // 2) Group by documentId and pick a representative id per document.
  const groups = new Map<string, { count: number; rep: string }>();
  for (const id of ids) {
    const documentId = id.split("::")[0];
    const g = groups.get(documentId);
    if (g) g.count += 1;
    else groups.set(documentId, { count: 1, rep: id });
  }

  // 3) Fetch representative chunks to recover filename/source/uploadedAt.
  const reps = [...groups.values()].map((g) => g.rep);
  const metaById = new Map<string, ChunkMetadata>();
  // Pinecone fetch handles a batch of ids at once.
  for (let i = 0; i < reps.length; i += 100) {
    const batch = reps.slice(i, i + 100);
    const res = await index.fetch(batch);
    for (const [, record] of Object.entries(res.records ?? {})) {
      const md = record.metadata as unknown as ChunkMetadata | undefined;
      if (md?.documentId) metaById.set(md.documentId, md);
    }
  }

  const records: DocumentRecord[] = [];
  for (const [documentId, g] of groups) {
    const md = metaById.get(documentId);
    records.push({
      documentId,
      filename: md?.filename ?? "(unknown)",
      sourceType: (md?.source as DocumentSourceType) ?? "txt",
      uploadedAt: md?.uploadedAt ?? new Date(0).toISOString(),
      chunkCount: g.count,
      charCount: 0, // not recoverable from a scan; shown as chunk count in the UI
      generated: md?.generated === true,
      derivedFrom: md?.derivedFrom,
    });
  }

  // Newest first.
  records.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return records;
}

export async function removeDocument(documentId: string): Promise<void> {
  await deleteDocument(documentId);
}

/**
 * PHASE 15 — resolve a human reference ("the handbook", "q3 report.pdf") to a
 * real document.
 *
 * People name files the way they remember them, not by `doc_<uuid>`. Rather than
 * let the agent guess an ID — the one mistake that would make a delete
 * catastrophic — every tool that needs a document resolves through here, and
 * AMBIGUITY IS RETURNED, NEVER GUESSED. Two matches means the agent must ask.
 */
export type ResolveResult =
  | { status: "found"; document: DocumentRecord }
  | { status: "none"; candidates: DocumentRecord[] }
  | { status: "ambiguous"; candidates: DocumentRecord[] };

export async function resolveDocument(ref: string): Promise<ResolveResult> {
  const docs = await listDocuments();
  const needle = ref.trim().toLowerCase();

  // Exact documentId wins outright — no fuzzy matching when we were given an ID.
  const byId = docs.find((d) => d.documentId === ref.trim());
  if (byId) return { status: "found", document: byId };

  const exact = docs.filter((d) => d.filename.toLowerCase() === needle);
  if (exact.length === 1) return { status: "found", document: exact[0] };

  const partial = docs.filter((d) => d.filename.toLowerCase().includes(needle));
  if (partial.length === 1) return { status: "found", document: partial[0] };
  if (partial.length > 1) return { status: "ambiguous", candidates: partial };

  return { status: "none", candidates: docs };
}
