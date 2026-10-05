import { ChatOpenAI } from "@langchain/openai";
import { getEnv } from "@/lib/env";

/**
 * Factory for the chat model. Unlike embeddings (one shared instance), we build
 * per call because callers need different settings:
 *  - QA answering: low temperature (grounded, deterministic, less hallucination)
 *  - classification / re-ranking: temperature 0 (we want the single best judgment)
 *
 * Why low temperature for RAG? Temperature controls randomness. For "answer only
 * from these documents" we want faithful, repeatable output — not creativity.
 */
export function getChatModel(opts?: {
  temperature?: number;
  streaming?: boolean;
}): ChatOpenAI {
  const env = getEnv();
  return new ChatOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_CHAT_MODEL, // default: gpt-4o
    temperature: opts?.temperature ?? 0.1,
    streaming: opts?.streaming ?? false,
  });
}
