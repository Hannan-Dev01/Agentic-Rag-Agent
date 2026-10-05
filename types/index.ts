/**
 * Shared domain types — the single source of truth every layer imports from.
 *
 * Why centralize types?
 *  - The UI, services, langchain wrappers, and pinecone adapter must all agree on
 *    the shape of a "document", a "chunk", and the metadata we store per vector.
 *  - If Pinecone's metadata shape lives only inside the pinecone/ folder, the UI
 *    can't safely render citations. One shared contract prevents drift.
 */

/** File types we accept for ingestion. */
export type SupportedMimeType =
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; // .docx

export type DocumentSourceType = "pdf" | "txt" | "md" | "docx";

/**
 * A logical uploaded document (one file). We assign it a stable `documentId`
 * at ingestion time and attach it to every chunk/vector derived from it, so we
 * can later list, filter, or delete "everything from this file" in one operation.
 */
export interface DocumentRecord {
  documentId: string;
  filename: string;
  sourceType: DocumentSourceType;
  /** ISO-8601 string. Stored as string because Pinecone metadata can't hold Dates. */
  uploadedAt: string;
  /** Number of chunks produced. Useful for the UI and for delete verification. */
  chunkCount: number;
  /** Total characters ingested — a cheap proxy for document size. */
  charCount: number;
  /** True if the assistant authored this document (Phase 16). */
  generated?: boolean;
  /** documentIds it was synthesised from, when generated. */
  derivedFrom?: string[];
}

/**
 * The metadata we attach to EVERY vector in Pinecone. This is what makes
 * citations possible: given a retrieved vector, we know exactly which file,
 * page, and chunk it came from.
 *
 * Pinecone metadata values must be string | number | boolean | string[].
 * Keep this flat — no nested objects.
 */
export interface ChunkMetadata {
  documentId: string;
  chunkId: string;
  filename: string;
  source: DocumentSourceType;
  uploadedAt: string;
  /** 1-based page number for PDFs; null/absent for formats without pages. */
  page?: number;
  /** Ordinal position of the chunk within the document (0-based). */
  chunkIndex: number;
  /** The chunk text itself, stored so retrieval can return content for the prompt & UI. */
  text: string;
  /**
   * PHASE 16 — PROVENANCE.
   *
   * True when the assistant AUTHORED this document rather than a human uploading
   * it. This matters more than it looks: once the agent can write into the index,
   * its own output becomes retrievable, and tomorrow's answers can be grounded in
   * yesterday's generated text. Without a provenance flag that loop is invisible
   * and the corpus slowly drifts away from source truth. We flag it at the chunk
   * level so retrieval, citations and the UI can all tell the difference.
   */
  generated?: boolean;
  /** documentIds this was synthesised from. Pinecone allows string[] metadata. */
  derivedFrom?: string[];
  /**
   * PHASE 17 — the complete document text, stored on chunk 0 ONLY.
   *
   * Present for assistant-authored documents so export can emit them verbatim.
   * Chunks overlap by design, so re-joining them duplicates text at the seams;
   * keeping the original avoids reconstructing what we already had. Stripped out
   * on retrieval (see semanticSearch) so it never bloats a prompt or a response.
   */
  fullText?: string;
}

/** A retrieved chunk plus its similarity score, as returned to the query pipeline. */
export interface RetrievedChunk {
  metadata: ChunkMetadata;
  /** Cosine similarity in [0, 1] (higher = more relevant). */
  score: number;
}

/** A citation surfaced in the UI alongside an answer. */
export interface Citation {
  documentId: string;
  filename: string;
  page?: number;
  chunkIndex: number;
  snippet: string;
  score: number;
  /** Assistant-authored source — surfaced in the UI so grounded ≠ human-verified. */
  generated?: boolean;
}

/** A single chat turn. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  /** Tools the agent ran for this turn (Phase 15). */
  toolActivity?: ToolActivity[];
  /** A destructive action awaiting the user's confirmation (Phase 15). */
  pendingAction?: PendingAction;
  /** Documents the assistant authored this turn, offered as downloads (Phase 17). */
  createdDocuments?: CreatedDocument[];
}

/** Per-file outcome returned by the upload API. */
export interface UploadedFileResult {
  filename: string;
  ok: boolean;
  /** Present when ok=true. */
  record?: DocumentRecord;
  /** First ~300 chars of parsed text, for a UI preview / sanity check. */
  preview?: string;
  /** Present when ok=false. */
  error?: string;
}

/** Response body of POST /api/upload. */
export interface UploadResponse {
  results: UploadedFileResult[];
}

/**
 * Classified intent of a user question (Phase 8; "action" added in Phase 15).
 *
 * - document_question → the deterministic RAG pipeline (retrieve → rerank → gate)
 * - chitchat / meta   → a direct answer, no retrieval
 * - action            → the user is asking the assistant to DO something the app
 *                       can do (list, inspect, summarize, delete). Routed to the
 *                       tool-calling agent, which has real discretion.
 */
export type QuestionIntent =
  | "document_question"
  | "chitchat"
  | "meta"
  | "action";

/**
 * PHASE 15 — AGENT CAPABILITIES
 *
 * One record per tool the agent invoked during a turn. Streamed to the UI so the
 * user can SEE what the assistant did on their behalf — an agent that silently
 * mutates state is an agent nobody trusts.
 */
export interface ToolActivity {
  /** Tool name, e.g. "list_documents". */
  name: string;
  /** Arguments the model chose, for the audit trail. */
  args: Record<string, unknown>;
  /** Did the tool succeed? */
  ok: boolean;
  /** One-line, human-readable result ("Found 3 documents."). */
  summary: string;
  /** Wall-clock duration, ms. */
  ms: number;
}

/**
 * A destructive action the agent has PREPARED but not performed, awaiting
 * explicit human confirmation.
 *
 * We have no LangGraph checkpointer (the server is stateless), so a true
 * `interrupt()` isn't available. Instead the tool refuses to act without
 * `confirmed: true`, returns this descriptor, and the UI renders a confirm
 * button. The user's "yes" arrives on the NEXT turn with the exchange in
 * history, and the agent re-calls the tool with confirmation.
 */
/**
 * A document the assistant created this turn (Phase 17). Carried to the UI so it
 * can offer download buttons inline, rather than making the user go find the
 * file in the library.
 */
export interface CreatedDocument {
  documentId: string;
  filename: string;
}

export interface PendingAction {
  tool: string;
  documentId: string;
  filename: string;
  /** What will be destroyed, in plain language, for the confirm dialog. */
  impact: string;
}

/** One turn of history sent from the client to the chat API. */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Request body of POST /api/chat. */
export interface ChatRequest {
  question: string;
  history?: HistoryTurn[];
  /** Optional: scope retrieval to a single document. */
  documentId?: string;
}

/**
 * Streaming protocol: the chat route emits newline-delimited JSON objects.
 * The client reads one JSON object per line.
 */
export type ChatStreamEvent =
  | { type: "token"; value: string }
  | { type: "tool"; activity: ToolActivity }
  | { type: "meta"; citations: Citation[]; confidence: number; needsClarification: boolean; intent: QuestionIntent; usedRetrieval: boolean; toolActivity: ToolActivity[]; pendingAction?: PendingAction; createdDocuments: CreatedDocument[] }
  | { type: "error"; message: string }
  | { type: "done" };
