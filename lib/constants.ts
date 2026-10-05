import type { DocumentSourceType, SupportedMimeType } from "@/types";

/**
 * Central place for tunable constants. Keeping these here (not scattered as
 * magic numbers) means Phase 3 chunking and Phase 6 retrieval have one dial each.
 */

/** OpenAI text-embedding-3-small produces 1536-dimensional vectors. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Chunking defaults (revisited & justified in Phase 3). */
export const DEFAULT_CHUNK_SIZE = 1000; // characters
export const DEFAULT_CHUNK_OVERLAP = 150; // characters

/** Retrieval defaults (revisited in Phase 6). */
export const DEFAULT_TOP_K = 8; // how many candidates to fetch before re-ranking
export const DEFAULT_RERANK_KEEP = 4; // how many survive re-ranking into the prompt

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per file

/**
 * Confidence gate (Phase 8). If the best retrieved chunk's cosine score is below
 * this, we route to "clarify" instead of answering — better to ask than to
 * guess from weak context. Calibrated from observed scores: a strong match ~0.5+,
 * unrelated text ~0.1. 0.25 cleanly separates the two.
 */
export const MIN_CONFIDENCE_SCORE = 0.25;

/** Max prior turns of conversation to send into the prompt (bounds token cost). */
export const MAX_HISTORY_TURNS = 6;

/**
 * Agent limits (Phase 15).
 *
 * MAX_AGENT_STEPS is the loop guard: the agent alternates model → tools → model,
 * and a confused model can ping-pong forever.
 *
 * Raised from 6 to 10 in Phase 16. Command-style tasks need 2-3 steps
 * (list → act), but AUTHORING a document is genuinely open-ended: list, then
 * several searches or summaries across however many sources turn out to be
 * relevant, then create. That is the first task here whose step count we cannot
 * predict — which is also what makes it the first properly agentic one.
 */
export const MAX_AGENT_STEPS = 10;

/** Top-K for the agent's search tool. Lower than DEFAULT_TOP_K: no re-rank stage
 *  follows, and the results are read by a model that is also juggling a task. */
export const AGENT_SEARCH_TOP_K = 5;

/** Chars of a passage returned to the agent per search hit. */
export const TOOL_SNIPPET_CHARS = 400;

/**
 * Cap on a document the assistant authors (Phase 16). Generous enough for a real
 * training plan or onboarding guide, small enough that a runaway generation can't
 * flood the index.
 */
export const MAX_GENERATED_DOC_CHARS = 20_000;

/** Hard cap on document text fed to summarize_document — bounds cost on a huge PDF. */
export const SUMMARY_MAX_CHARS = 24_000;

/** Chars of chunk text shown as a citation snippet in the UI. */
export const CITATION_SNIPPET_CHARS = 220;

/** Map incoming MIME types to our internal source type. */
export const MIME_TO_SOURCE: Record<SupportedMimeType, DocumentSourceType> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export const ACCEPTED_MIME_TYPES = Object.keys(MIME_TO_SOURCE) as SupportedMimeType[];
