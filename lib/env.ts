import { z } from "zod";

/**
 * Validate environment variables ONCE, at import time, with clear errors.
 *
 * Why: a missing OPENAI_API_KEY should fail loudly at startup with a readable
 * message — not deep inside an OpenAI call as a cryptic 401 during a user's
 * first chat. Zod turns "undefined env var" into an explicit, typed failure.
 *
 * This module is server-only. Never import it into a client component — it
 * would leak secret keys into the browser bundle.
 */
const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),

  PINECONE_API_KEY: z.string().min(1, "PINECONE_API_KEY is required"),
  PINECONE_INDEX: z.string().min(1, "PINECONE_INDEX is required"),
  // Serverless deployment target. Defaults match Pinecone's free Starter tier,
  // which is only available on AWS us-east-1.
  PINECONE_CLOUD: z.enum(["aws", "gcp", "azure"]).default("aws"),
  PINECONE_REGION: z.string().default("us-east-1"),

  // Model + embedding config, with sensible production defaults.
  OPENAI_CHAT_MODEL: z.string().default("gpt-4o"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
});

/**
 * Lazily-validated, cached env accessor. We DON'T validate at module load so
 * that `next build` (which imports files without runtime secrets) doesn't crash.
 * Call getEnv() inside request handlers / services where the keys are needed.
 */
let cached: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
