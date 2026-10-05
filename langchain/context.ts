import { CITATION_SNIPPET_CHARS } from "@/lib/constants";
import type { Citation, RetrievedChunk } from "@/types";

/**
 * PHASE 12 — CITATIONS
 *
 * Two jobs, from the same reranked chunks:
 *  - formatContext(): build the numbered context block injected into the prompt.
 *    The [1], [2] markers are what the model cites inline, and they line up with…
 *  - buildCitations(): …the citation objects the UI renders in the sources panel.
 *
 * Keeping numbering identical in both is what makes "[2]" in the answer point to
 * the right source card. Off-by-one here silently mis-attributes answers.
 */

/** The context string the LLM sees. Each source is labeled [n] with provenance. */
export function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const loc =
        c.metadata.page != null
          ? `${c.metadata.filename}, page ${c.metadata.page}`
          : c.metadata.filename;
      // Phase 16: tell the MODEL too when a passage is assistant-authored, so it
      // can weigh a human-uploaded source above its own earlier prose.
      const origin = c.metadata.generated ? ", assistant-generated" : "";
      return `[${i + 1}] (source: ${loc}${origin})\n${c.metadata.text}`;
    })
    .join("\n\n---\n\n");
}

/** The citation cards the UI shows, numbered to match the context markers. */
export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c) => ({
    documentId: c.metadata.documentId,
    filename: c.metadata.filename,
    page: c.metadata.page,
    chunkIndex: c.metadata.chunkIndex,
    snippet: truncate(c.metadata.text, CITATION_SNIPPET_CHARS),
    score: c.score,
    generated: c.metadata.generated === true,
  }));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}
