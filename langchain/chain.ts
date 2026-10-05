import { z } from "zod";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getChatModel } from "@/langchain/llm";
import {
  qaPrompt,
  clarifyPrompt,
  directPrompt,
  agentPrompt,
} from "@/langchain/prompts";
import { agentTools } from "@/langchain/tools";
import { formatContext } from "@/langchain/context";
import { MAX_HISTORY_TURNS } from "@/lib/constants";
import type { HistoryTurn, QuestionIntent, RetrievedChunk } from "@/types";

/**
 * PHASE 11 — CONVERSATION MEMORY
 *
 * We keep memory STATELESS on the server: the client sends recent history with
 * each request, and we convert it to LangChain messages here (capped to bound
 * token cost). This scales horizontally (no server session store) and is the
 * simplest correct approach. A durable multi-device memory would swap this for a
 * checkpointer keyed by threadId — the prompts already accept a history slot.
 */
export function toLangChainHistory(history: HistoryTurn[] = []): BaseMessage[] {
  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((t) =>
      t.role === "user" ? new HumanMessage(t.content) : new AIMessage(t.content),
    );
}

/**
 * PHASE 8 (node logic) — INTENT CLASSIFICATION
 * Decide whether a question needs document retrieval at all. Greetings and
 * meta-questions ("what can you do?") shouldn't trigger a vector search.
 */
const IntentSchema = z.object({
  intent: z
    .enum(["document_question", "chitchat", "meta", "action"])
    .describe(
      "document_question = a question ANSWERED FROM the content of uploaded docs ('what does the policy say about X'); " +
        "action = the user asks the assistant to DO something to the knowledge base — list/show what is uploaded, " +
        "describe or summarise a whole file, delete a document, or CREATE/draft/write/generate a new document " +
        "from existing material; " +
        "chitchat = greeting/small talk; meta = about the assistant itself",
    ),
});

export async function classifyIntent(
  question: string,
  history: HistoryTurn[] = [],
): Promise<{ intent: QuestionIntent; needsRetrieval: boolean }> {
  // Explicit generic prevents TS2589 (Zod × withStructuredOutput deep inference).
  const model = getChatModel({ temperature: 0 }).withStructuredOutput<{
    intent: QuestionIntent;
  }>(IntentSchema, { name: "classify_intent" });

  const recent = history
    .slice(-2)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  const { intent } = await model.invoke(
    `Classify the user's latest message.\n` +
      (recent ? `Recent conversation:\n${recent}\n\n` : "") +
      `Latest message: ${question}`,
  );

  // Only the plain document question takes the deterministic retrieve→rerank
  // pipeline. "action" has its own branch: the agent does its own retrieval
  // through tools, so pre-fetching context for it would be wasted work.
  return { intent, needsRetrieval: intent === "document_question" };
}

/**
 * The three answer generators. They call the model via `.invoke` (not `.stream`).
 * Token streaming for the UI is achieved at the ROUTE using LangGraph's "messages"
 * stream mode, which streams tokens out of these very calls automatically — so
 * there's ONE implementation, used by both graph.invoke (tests) and the stream route.
 */

/**
 * PHASE 11 — HISTORY-AWARE RETRIEVAL (query condensation)
 *
 * Follow-ups like "which city is IT in?" are meaningless to a vector search on
 * their own — the pronoun's referent lives in the history. We rewrite the
 * follow-up into a STANDALONE question first, then retrieve on that. This is the
 * "condense question" pattern; without it, multi-turn retrieval silently fails.
 * Generation still receives the original question + full history.
 */
export async function condenseQuestion(
  question: string,
  history: HistoryTurn[] = [],
): Promise<string> {
  if (history.length === 0) return question; // nothing to resolve
  const recent = history
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  const rewritten = await getChatModel({ temperature: 0 })
    .pipe(new StringOutputParser())
    .invoke(
      `Given the conversation below and a follow-up question, rewrite the follow-up ` +
        `as a STANDALONE question that includes any context needed to understand it. ` +
        `If it is already standalone, return it unchanged. Output ONLY the question.\n\n` +
        `Conversation:\n${recent}\n\nFollow-up: ${question}\n\nStandalone question:`,
    );
  return rewritten.trim() || question;
}

// streaming:true is REQUIRED for LangGraph's "messages" stream mode to emit
// per-token events. With streaming:false the model returns the whole answer in a
// single callback, so the UI would get one big chunk instead of a live stream.
// (.invoke still returns the full string, so graph.invoke / tests are unaffected.)

/** Grounded QA answer from retrieved context. */
export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  history: HistoryTurn[] = [],
): Promise<string> {
  return qaPrompt
    .pipe(getChatModel({ temperature: 0.1, streaming: true }))
    .pipe(new StringOutputParser())
    .invoke({
      question,
      context: formatContext(chunks),
      history: toLangChainHistory(history),
    });
}

/** Clarifying question (low-confidence path). */
export async function generateClarification(
  question: string,
  history: HistoryTurn[] = [],
): Promise<string> {
  return clarifyPrompt
    .pipe(getChatModel({ temperature: 0.3, streaming: true }))
    .pipe(new StringOutputParser())
    .invoke({ question, history: toLangChainHistory(history) });
}

/** Direct answer (no retrieval needed). */
export async function generateDirect(
  question: string,
  history: HistoryTurn[] = [],
): Promise<string> {
  return directPrompt
    .pipe(getChatModel({ temperature: 0.4, streaming: true }))
    .pipe(new StringOutputParser())
    .invoke({ question, history: toLangChainHistory(history) });
}

/**
 * PHASE 15 — ONE AGENT STEP
 *
 * Deliberately NOT a full agent loop: this is a single model call with the tools
 * bound. The LOOP lives in the graph (agent → tools → agent), because that is
 * what makes each iteration an inspectable graph step rather than something
 * buried inside a library's `while` statement — we get per-step streaming, a
 * step counter we control, and a place to enforce the confirmation rule.
 *
 * This is the whole argument for LangGraph over `createReactAgent` in one file.
 */
export async function agentStep(
  messages: BaseMessage[],
  history: HistoryTurn[] = [],
): Promise<AIMessage> {
  const model = getChatModel({ temperature: 0, streaming: true }).bindTools(
    agentTools,
  );

  const prompt = await agentPrompt.formatMessages({
    history: toLangChainHistory(history),
    messages,
  });

  return (await model.invoke(prompt)) as AIMessage;
}
