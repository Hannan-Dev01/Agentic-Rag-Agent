import { OpenAIEmbeddings } from "@langchain/openai";
import { getEnv } from "@/lib/env";

/**
 * Single shared embeddings client.
 *
 * Why a singleton?
 *  - Ingestion (embedDocuments) and query (embedQuery) MUST use the exact same
 *    model, or the vectors aren't comparable — a silent, corpus-wide RAG bug.
 *    One shared instance makes that impossible to get wrong.
 *  - Avoids re-reading env / re-constructing the client on every request.
 *
 * text-embedding-3-small → 1536-dim vectors, ~5x cheaper than -large, and plenty
 * accurate for document QA. We pin the dimension in lib/constants so Pinecone's
 * index dimension always matches (Phase 5).
 */
let cached: OpenAIEmbeddings | null = null;

export function getEmbeddings(): OpenAIEmbeddings {
  if (cached) return cached;
  const env = getEnv();
  cached = new OpenAIEmbeddings({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_EMBEDDING_MODEL, // default: text-embedding-3-small
    // Batch up to 512 chunk texts per API request during ingestion. OpenAI's
    // embeddings endpoint accepts arrays, so this turns 100 chunks into ~1 call
    // instead of 100 — massively fewer round-trips and lower latency.
    batchSize: 512,
  });
  return cached;
}
