/**
 * PHASE 13 — RATE LIMITING (in-memory token bucket)
 *
 * Protects the expensive OpenAI/Pinecone calls from abuse or runaway clients.
 *
 * ⚠️ SCOPE: this is PER-INSTANCE memory. On a single server it's fine; across
 * multiple serverless instances each has its own bucket, so the effective limit
 * multiplies. For real multi-instance production, back this with Redis / Upstash
 * (the interface below stays the same — swap the store). Documented, not hidden.
 */
const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 20; // per IP per window

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

// Opportunistic cleanup so the Map doesn't grow unbounded.
export function sweepRateLimiter() {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now > b.resetAt) buckets.delete(key);
  }
}
