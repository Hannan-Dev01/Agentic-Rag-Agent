import { Pinecone, type Index } from "@pinecone-database/pinecone";
import { getEnv } from "@/lib/env";
import { EMBEDDING_DIMENSIONS } from "@/lib/constants";

/**
 * Pinecone client + index lifecycle. This is the ONLY file that talks to the
 * Pinecone control plane. Everything above it deals in LangChain abstractions.
 */

let client: Pinecone | null = null;

export function getPineconeClient(): Pinecone {
  if (client) return client;
  const env = getEnv();
  client = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  return client;
}

/**
 * Idempotently ensure our index exists with the CORRECT dimension + metric,
 * then return a handle to it.
 *
 * Why create it in code (not the Pinecone console)?
 *  - The index dimension MUST equal our embedding model's output (1536). Creating
 *    it here, from the same constant the embedder uses, makes drift impossible.
 *  - metric: "cosine" — matches how OpenAI embeddings encode meaning (direction,
 *    not magnitude). Using euclidean/dotproduct here would silently degrade ranking.
 *  - Reproducible: a fresh environment self-provisions on first run.
 */
// Memoize the in-flight PROMISE (not a boolean). Concurrent callers on a cold
// start — e.g. uploading 5 files at once via Promise.all — all await the SAME
// ensure call, so createIndex is invoked exactly once. A boolean flag doesn't
// prevent this: every concurrent caller reads `false` before any sets `true`.
let ensuring: Promise<void> | null = null;

async function doEnsure(): Promise<void> {
  const env = getEnv();
  const pc = getPineconeClient();

  const existing = await pc.listIndexes();
  const found = existing.indexes?.some((i) => i.name === env.PINECONE_INDEX);
  if (found) return;

  await pc.createIndex({
    name: env.PINECONE_INDEX,
    dimension: EMBEDDING_DIMENSIONS, // 1536, same constant the embedder uses
    metric: "cosine",
    spec: {
      serverless: { cloud: env.PINECONE_CLOUD, region: env.PINECONE_REGION },
    },
    // Block until the index is queryable, and don't throw if a concurrent
    // request already created it (idempotent under races).
    waitUntilReady: true,
    suppressConflicts: true,
  });
}

export async function ensureIndex(): Promise<Index> {
  const env = getEnv();
  const pc = getPineconeClient();

  // First caller starts the ensure; everyone else awaits the same promise.
  if (!ensuring) {
    ensuring = doEnsure().catch((err) => {
      ensuring = null; // reset on failure so a later request can retry
      throw err;
    });
  }
  await ensuring;

  return pc.index(env.PINECONE_INDEX);
}
