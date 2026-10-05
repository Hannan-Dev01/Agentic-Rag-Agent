"use client";

import { useCallback, useRef, useState } from "react";
import type {
  ChatMessage,
  ChatStreamEvent,
  Citation,
  HistoryTurn,
} from "@/types";

let idCounter = 0;
const nextId = () => `m_${Date.now()}_${idCounter++}`;

/**
 * Owns chat state + the streaming transport. Reads the /api/chat NDJSON stream,
 * appending tokens to the in-flight assistant message and attaching citations
 * when the final "meta" event arrives.
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (question: string, documentId?: string) => {
      const trimmed = question.trim();
      if (!trimmed || isStreaming) return;
      setError(null);

      // Build history from prior turns (Phase 11 memory).
      const history: HistoryTurn[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const userMsg: ChatMessage = { id: nextId(), role: "user", content: trimmed };
      const assistantId = nextId();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        citations: [],
        toolActivity: [],
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, history, documentId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const msg = res.status === 429 ? "Rate limit exceeded. Slow down a moment." : "Request failed.";
          throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete NDJSON lines.
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const evt = JSON.parse(line) as ChatStreamEvent;
            if (evt.type === "token") {
              patch((m) => ({ ...m, content: m.content + evt.value }));
            } else if (evt.type === "tool") {
              // Phase 15: append live, so the activity trail grows as the agent
              // works rather than appearing all at once when the turn ends.
              patch((m) => ({
                ...m,
                toolActivity: [...(m.toolActivity ?? []), evt.activity],
              }));
            } else if (evt.type === "meta") {
              const citations: Citation[] = evt.citations;
              patch((m) => ({
                ...m,
                citations,
                toolActivity: evt.toolActivity,
                pendingAction: evt.pendingAction,
                createdDocuments: evt.createdDocuments,
              }));
            } else if (evt.type === "error") {
              throw new Error(evt.message);
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setError(message);
        patch((m) => ({
          ...m,
          content: m.content || `⚠️ ${message}`,
        }));
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [messages, isStreaming],
  );

  /**
   * Phase 15: confirm (or decline) a destructive action the agent prepared.
   *
   * This is plain `send()`, not a special API call — and that is deliberate. The
   * confirmation re-enters the SAME graph as an ordinary message, with the
   * preview exchange now sitting in history, so the agent re-calls the tool with
   * `confirmed: true` itself. No out-of-band endpoint that could delete a
   * document without the model's safety rules ever running.
   */
  const confirmAction = useCallback(
    (approved: boolean) =>
      send(approved ? "Yes, I confirm — go ahead and delete it." : "No, cancel that."),
    [send],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setMessages([]), []);

  return { messages, isStreaming, error, send, stop, reset, confirmAction };
}
