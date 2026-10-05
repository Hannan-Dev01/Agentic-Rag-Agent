import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  Citation,
  CreatedDocument,
  HistoryTurn,
  PendingAction,
  QuestionIntent,
  RetrievedChunk,
  ToolActivity,
} from "@/types";

/**
 * PHASE 8 — LANGGRAPH STATE
 *
 * State is the shared, typed object that flows through the graph. Each node
 * receives the current state and returns a PARTIAL update; LangGraph merges it in
 * using each channel's reducer. Here every channel is "last write wins" (the
 * default), which is what we want — nodes overwrite their slice.
 *
 * Think of this as the single source of truth for one question's journey:
 * inputs (question, history) → decisions (intent, needsRetrieval) →
 * evidence (retrieved, reranked) → verdict (confidence, needsClarification) →
 * output (answer, citations).
 */
export const GraphState = Annotation.Root({
  // --- Inputs ---
  question: Annotation<string>(),
  history: Annotation<HistoryTurn[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  documentId: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),

  // --- Decisions ---
  intent: Annotation<QuestionIntent>({
    reducer: (_p, n) => n,
    default: () => "document_question",
  }),
  needsRetrieval: Annotation<boolean>({
    reducer: (_p, n) => n,
    default: () => true,
  }),
  usedRetrieval: Annotation<boolean>({
    reducer: (_p, n) => n,
    default: () => false,
  }),

  // --- Evidence ---
  retrieved: Annotation<RetrievedChunk[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),
  reranked: Annotation<RetrievedChunk[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),

  // --- Verdict ---
  confidence: Annotation<number>({
    reducer: (_p, n) => n,
    default: () => 0,
  }),
  needsClarification: Annotation<boolean>({
    reducer: (_p, n) => n,
    default: () => false,
  }),

  // --- Agent scratchpad (Phase 15) ---
  /**
   * The agent's working transcript: its own tool-calling AIMessages and the
   * ToolMessages carrying results.
   *
   * This is the FIRST channel in the graph with an APPENDING reducer, and the
   * contrast is the point. Every channel above is last-write-wins because each
   * node owns its slice outright. The agent loop is different: `agent` and
   * `tools` take turns writing, and each turn must PRESERVE what came before —
   * a model that can't see the result of the tool it just called cannot reason.
   * Overwrite semantics here would produce an infinite loop of identical calls.
   */
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  /** How many model→tools round-trips we've done. Enforces MAX_AGENT_STEPS. */
  steps: Annotation<number>({
    reducer: (_p, n) => n,
    default: () => 0,
  }),
  /** Audit trail of tool calls, appended as they execute, streamed to the UI. */
  toolActivity: Annotation<ToolActivity[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  /** A destructive action previewed but not performed, awaiting user confirmation. */
  pendingAction: Annotation<PendingAction | undefined>({
    reducer: (_p, n) => n,
    default: () => undefined,
  }),
  /** Documents authored this turn. Appending: one turn may create several. */
  createdDocuments: Annotation<CreatedDocument[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),

  // --- Output ---
  answer: Annotation<string>({
    reducer: (_p, n) => n,
    default: () => "",
  }),
  citations: Annotation<Citation[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),
});

/** The inferred TypeScript type of the full state object. */
export type GraphStateType = typeof GraphState.State;
