"use client";

import type { Citation } from "@/types";

/**
 * Retrieved-sources panel (Phase 12). Shows the chunks the answer was grounded
 * in, numbered to match the [n] markers in the answer text.
 */
export function SourcesPanel({ citations }: { citations: Citation[] }) {
  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-surface-border bg-surface p-4 lg:block">
      <h2 className="mb-3 text-sm font-semibold text-neutral-700">
        Retrieved sources
      </h2>
      {citations.length === 0 ? (
        <p className="text-xs text-neutral-400">
          Sources for the latest answer will appear here.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {citations.map((c, i) => (
            <li
              key={`${c.chunkIndex}-${i}`}
              className="rounded-lg border border-surface-border bg-surface-muted p-3"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-neutral-700">
                  [{i + 1}] {c.filename}
                </span>
                <span className="text-neutral-400">
                  {(c.score * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-400">
                <span>
                  {c.page != null ? `page ${c.page} · ` : ""}chunk {c.chunkIndex}
                </span>
                {/* Grounded is not the same as human-verified: say so when the
                    cited passage was written by the assistant. */}
                {c.generated && (
                  <span className="rounded border border-amber-300 bg-amber-50 px-1 text-[10px] font-medium text-amber-700">
                    AI-generated
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-snug text-neutral-600">
                {c.snippet}
              </p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
