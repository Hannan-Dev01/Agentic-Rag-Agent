import { getGraph, initialState } from "@/langgraph/graph";
import { logger } from "@/lib/logger";
import type { GraphStateType } from "@/langgraph/state";
import type { ChatRequest, ChatStreamEvent } from "@/types";

/**
 * PHASE 10 — STREAMING
 *
 * We run the LangGraph with TWO stream modes at once:
 *   - "messages": streams LLM tokens out of any model call inside a node. We
 *     forward only tokens from the answer-producing nodes (generate/clarify/direct),
 *     so the classifier's and re-ranker's internal model calls stay hidden.
 *   - "values": gives us the full state after each step; we keep the last one to
 *     read citations/confidence/intent for the final "meta" event.
 *
 * Output is newline-delimited JSON (one ChatStreamEvent per line) — trivial for
 * the browser to parse incrementally.
 */

// Nodes whose model output is meant for the user. The classifier and re-ranker
// also call models; their tokens must never reach the UI.
// "agent" is included (Phase 15) — but note its intermediate turns are tool-call
// envelopes with EMPTY content, so only its final, answering turn actually emits
// tokens. The filter needs no special case for that.
const ANSWER_NODES = new Set(["generate", "clarify", "direct", "agent"]);

function encodeEvent(e: ChatStreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(e) + "\n");
}

export function streamChat(req: ChatRequest): ReadableStream<Uint8Array> {
  const graph = getGraph();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatStreamEvent) => controller.enqueue(encodeEvent(e));
      let finalState: GraphStateType | null = null;
      let streamedAnyToken = false;
      // Tool activity is cumulative in state; track how much we've already
      // forwarded so each tool call is announced exactly once, as it happens.
      let sentActivity = 0;

      try {
        const stream = await graph.stream(
          initialState({
            question: req.question,
            history: req.history,
            documentId: req.documentId,
          }),
          { streamMode: ["messages", "values"] },
        );

        for await (const [mode, data] of stream as AsyncIterable<
          [string, unknown]
        >) {
          if (mode === "messages") {
            // data = [messageChunk, metadata]
            const [chunk, meta] = data as [
              { content?: unknown },
              { langgraph_node?: string },
            ];
            const node = meta?.langgraph_node ?? "";
            if (!ANSWER_NODES.has(node)) continue;
            const text = typeof chunk?.content === "string" ? chunk.content : "";
            if (text) {
              streamedAnyToken = true;
              send({ type: "token", value: text });
            }
          } else if (mode === "values") {
            finalState = data as GraphStateType;

            // Phase 15: surface each tool call the moment the graph records it,
            // so the user watches "Listing documents… → Deleting handbook.pdf…"
            // live rather than learning after the fact what was done to their
            // data. Visible agency is the whole trust model here.
            const activity = finalState.toolActivity ?? [];
            for (; sentActivity < activity.length; sentActivity++) {
              send({ type: "tool", activity: activity[sentActivity] });
            }
          }
        }

        // Fallback: if token streaming produced nothing (e.g. provider didn't
        // stream), flush the final answer in one chunk so the UI still shows it.
        if (!streamedAnyToken && finalState?.answer) {
          send({ type: "token", value: finalState.answer });
        }

        // Phase 15: the agent can be stopped by the step budget mid-task, in
        // which case no node ever wrote an answer. Say so plainly instead of
        // returning an empty bubble — the tool trail above still shows the work.
        if (!streamedAnyToken && !finalState?.answer) {
          send({
            type: "token",
            value:
              "I wasn't able to finish that in the steps available. Here's what I did manage — ask me to continue and I'll pick it up.",
          });
        }

        if (finalState) {
          send({
            type: "meta",
            citations: finalState.citations ?? [],
            confidence: finalState.confidence ?? 0,
            needsClarification: finalState.needsClarification ?? false,
            intent: finalState.intent ?? "document_question",
            usedRetrieval: finalState.usedRetrieval ?? false,
            toolActivity: finalState.toolActivity ?? [],
            pendingAction: finalState.pendingAction,
            createdDocuments: finalState.createdDocuments ?? [],
          });
        }
        send({ type: "done" });
      } catch (err) {
        logger.error("chat.stream.failed", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        send({
          type: "error",
          message:
            err instanceof Error ? err.message : "Something went wrong.",
        });
      } finally {
        controller.close();
      }
    },
  });
}
