"use client";

import type {
  ChatMessage,
  CreatedDocument,
  PendingAction,
  ToolActivity,
} from "@/types";

/** Friendly verbs for the activity trail — tool names are for logs, not users. */
const TOOL_LABELS: Record<string, string> = {
  list_documents: "Listing documents",
  describe_document: "Checking document details",
  search_documents: "Searching documents",
  summarize_document: "Reading the full document",
  create_document: "Writing new document",
  delete_document: "Deleting document",
};

/** ChatGPT-like message list. User right-aligned, assistant left with sources count. */
export function ChatMessages({
  messages,
  isStreaming,
  onConfirm,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** Phase 15: approve/decline a destructive action the agent prepared. */
  onConfirm?: (approved: boolean) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md">
          <h2 className="text-lg font-medium text-neutral-700">
            Ask about your documents
          </h2>
          <p className="mt-2 text-sm text-neutral-400">
            Answers are generated only from your uploaded files, with inline
            citations like [1], [2].
          </p>
          <p className="mt-3 text-sm text-neutral-400">
            You can also just tell me what to do — &ldquo;list my documents&rdquo;,
            &ldquo;summarise the handbook&rdquo;, &ldquo;delete the old report&rdquo;.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
      {messages.map((m, i) => {
        const isUser = m.role === "user";
        const isLast = i === messages.length - 1;
        return (
          <div
            key={m.id}
            className={isUser ? "flex justify-end" : "flex flex-col items-start gap-2"}
          >
            {/* Activity trail renders ABOVE the answer: it's what the assistant
                did, and it arrives before the answer it justifies. */}
            {!isUser && m.toolActivity && m.toolActivity.length > 0 && (
              <ActivityTrail activity={m.toolActivity} />
            )}

            <div
              className={[
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                isUser
                  ? "bg-neutral-900 text-white"
                  : "border border-surface-border bg-surface text-neutral-800",
              ].join(" ")}
            >
              {m.content || (isLast && isStreaming ? <Cursor /> : "")}
              {!isUser && m.citations && m.citations.length > 0 && (
                <div className="mt-2 text-[11px] text-neutral-400">
                  {m.citations.length} source
                  {m.citations.length > 1 ? "s" : ""} · see panel →
                </div>
              )}
            </div>

            {/* Phase 17: a document the assistant just wrote is offered as a
                download right here, so the user never has to go hunting for it
                in the library. */}
            {!isUser && m.createdDocuments && m.createdDocuments.length > 0 && (
              <DownloadLinks documents={m.createdDocuments} />
            )}

            {/* Only the newest message can be acted on — confirming a stale
                proposal from earlier in the thread would be a nasty surprise. */}
            {!isUser && m.pendingAction && isLast && !isStreaming && onConfirm && (
              <ConfirmAction action={m.pendingAction} onConfirm={onConfirm} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Download buttons for documents created during this turn. */
function DownloadLinks({ documents }: { documents: CreatedDocument[] }) {
  return (
    <div className="flex max-w-[85%] flex-col gap-2">
      {documents.map((d) => (
        <div
          key={d.documentId}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-surface-border bg-surface-muted px-3 py-2"
        >
          <span className="text-xs font-medium text-neutral-700">{d.filename}</span>
          <span className="text-[11px] text-neutral-400">Download as</span>
          {(["pdf", "docx", "md"] as const).map((fmt) => (
            // A plain anchor: Content-Disposition makes the browser save it, so
            // no fetch, no blob, no object URL to revoke.
            <a
              key={fmt}
              href={`/api/documents/export?id=${encodeURIComponent(d.documentId)}&format=${fmt}`}
              className="rounded-md border border-surface-border bg-surface px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50"
            >
              {fmt.toUpperCase()}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The audit trail: one row per tool the agent ran, with outcome and duration. */
function ActivityTrail({ activity }: { activity: ToolActivity[] }) {
  return (
    <div className="flex max-w-[85%] flex-col gap-1 rounded-xl border border-surface-border bg-neutral-50 px-3 py-2">
      {activity.map((a, i) => (
        <div key={i} className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span aria-hidden>{a.ok ? "✓" : "✕"}</span>
          <span className="font-medium text-neutral-600">
            {TOOL_LABELS[a.name] ?? a.name}
          </span>
          <span className="truncate">{a.summary}</span>
          <span className="ml-auto shrink-0 tabular-nums text-neutral-400">
            {a.ms}ms
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Confirmation gate for an irreversible action.
 *
 * The agent has already PREPARED the delete and told the user what it would
 * destroy; nothing has happened yet. Clicking Delete sends an ordinary chat
 * message back through the graph, which is what lets the agent re-call its tool
 * with `confirmed: true` — there is no path from this button straight to the
 * vector store.
 */
function ConfirmAction({
  action,
  onConfirm,
}: {
  action: PendingAction;
  onConfirm: (approved: boolean) => void;
}) {
  return (
    <div className="max-w-[85%] rounded-xl border border-red-200 bg-red-50 px-4 py-3">
      <div className="text-xs font-medium text-red-800">Confirm deletion</div>
      <p className="mt-1 text-xs leading-relaxed text-red-700">{action.impact}</p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onConfirm(true)}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
        >
          Delete {action.filename}
        </button>
        <button
          onClick={() => onConfirm(false)}
          className="rounded-md border border-red-200 bg-surface px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Cursor() {
  return <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 align-middle" />;
}
