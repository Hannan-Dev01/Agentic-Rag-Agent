import { z } from "zod";
import { getVectorStore } from "@/pinecone/vectorstore";
import { getChatModel } from "@/langchain/llm";
import { DEFAULT_TOP_K, DEFAULT_RERANK_KEEP } from "@/lib/constants";
import type { ChunkMetadata, RetrievedChunk } from "@/types";

/**
 * PHASE 6 — RETRIEVAL
 *
 * Two stages, deliberately separated:
 *  1) semanticSearch  — cheap, fast vector recall. Cast a WIDE net (top-K=8).
 *  2) rerank          — expensive, accurate. Re-order those 8 with an LLM and
 *                       keep the best 4 for the prompt.
 *
 * Why two stages? Vector similarity is fast but approximate — the #1 cosine hit
 * isn't always the most USEFUL chunk for the question. Re-ranking with a smarter
 * model on a small candidate set gives better final context without running the
 * expensive model over the whole corpus. This is the standard retrieve-then-rerank
 * pattern used in production RAG.
 */

/**
 * Stage 1: semantic search over Pinecone.
 * - Embeds `query` (via the shared embeddings client — same model as ingestion).
 * - Returns the top-K nearest chunks by COSINE similarity.
 * - Optional metadata `filter` scopes the search (e.g. one document) — Pinecone
 *   applies it server-side so we never pull irrelevant vectors over the wire.
 */
export async function semanticSearch(
  query: string,
  opts: { topK?: number; documentId?: string } = {},
): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const store = await getVectorStore();

  // Pinecone metadata filter syntax. Only set when scoping to a document.
  const filter = opts.documentId ? { documentId: opts.documentId } : undefined;

  const results = await store.similaritySearchWithScore(query, topK, filter);

  return results.map(([doc, score]) => {
    // PineconeStore moves the textKey ("text") OUT of metadata and INTO
    // pageContent on retrieval. Reattach it so downstream (rerank, context,
    // citations) can rely on metadata.text being present.
    const md = doc.metadata as ChunkMetadata;
    // `fullText` lives on chunk 0 of generated documents for export (Phase 17).
    // It is up to 20k characters and useless to retrieval, so drop it here
    // rather than carrying it into re-ranking, the prompt, or the HTTP response.
    const { fullText: _fullText, ...rest } = md;
    return {
      metadata: { ...rest, text: md.text ?? doc.pageContent },
      score, // cosine similarity in ~[0,1]; higher = more relevant
    };
  });
}

/**
 * Stage 2: LLM re-ranking (listwise).
 *
 * We show the model the question + the numbered candidate snippets and ask it to
 * return the indices of the most relevant ones, best first. One structured call
 * re-orders all candidates — far cheaper than scoring each in isolation.
 *
 * We preserve each chunk's ORIGINAL cosine score (used later for the confidence
 * gate); re-ranking changes ORDER, not the similarity number.
 */
const RankSchema = z.object({
  ranking: z
    .array(z.number().int())
    .describe("Indices of candidates from most to least relevant to the question"),
});

export async function rerank(
  query: string,
  candidates: RetrievedChunk[],
  keep: number = DEFAULT_RERANK_KEEP,
): Promise<RetrievedChunk[]> {
  if (candidates.length <= 1) return candidates.slice(0, keep);

  // Explicit generic prevents TS2589 (Zod × withStructuredOutput deep inference).
  const model = getChatModel({ temperature: 0 }).withStructuredOutput<{
    ranking: number[];
  }>(RankSchema, { name: "rank_candidates" });

  const list = candidates
    .map((c, i) => `[${i}] ${truncate(c.metadata.text, 500)}`)
    .join("\n\n");

  try {
    const { ranking } = await model.invoke(
      `You are a search re-ranker. Given a question and numbered candidate passages, ` +
        `return the indices ordered from MOST to LEAST relevant to answering the question. ` +
        `Only include indices that are actually relevant.\n\n` +
        `Question: ${query}\n\nCandidates:\n${list}`,
    );

    // Map valid indices back to chunks, dedupe, then append any the model omitted
    // (so we never lose a candidate entirely if the model returns a short list).
    const seen = new Set<number>();
    const ordered: RetrievedChunk[] = [];
    for (const idx of ranking) {
      if (idx >= 0 && idx < candidates.length && !seen.has(idx)) {
        seen.add(idx);
        ordered.push(candidates[idx]);
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) ordered.push(candidates[i]);
    }
    return ordered.slice(0, keep);
  } catch {
    // If re-ranking fails (model error), degrade gracefully to cosine order.
    return candidates.slice(0, keep);
  }
}

/** Convenience: recall wide, then re-rank down to the best few. */
export async function retrieveAndRerank(
  query: string,
  opts: { topK?: number; keep?: number; documentId?: string } = {},
): Promise<{ retrieved: RetrievedChunk[]; reranked: RetrievedChunk[] }> {
  const retrieved = await semanticSearch(query, {
    topK: opts.topK,
    documentId: opts.documentId,
  });
  const reranked = await rerank(query, retrieved, opts.keep);
  return { retrieved, reranked };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
