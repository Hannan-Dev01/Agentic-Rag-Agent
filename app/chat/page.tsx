"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "@/hooks/useChat";
import { ChatMessages } from "@/components/ChatMessages";
import { SourcesPanel } from "@/components/SourcesPanel";
import type { Citation } from "@/types";

export default function ChatPage() {
  const { messages, isStreaming, error, send, confirmAction } = useChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Sources for the latest assistant message → the side panel.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const citations: Citation[] = lastAssistant?.citations ?? [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = input;
    setInput("");
    void send(q);
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-surface-border bg-surface px-4 py-3">
        <h1 className="text-sm font-semibold">RAG Chat</h1>
        <nav className="flex gap-4 text-sm text-neutral-500">
          <Link href="/upload" className="hover:underline">Upload</Link>
          <Link href="/documents" className="hover:underline">Documents</Link>
          <Link href="/" className="hover:underline">Home</Link>
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <ChatMessages
              messages={messages}
              isStreaming={isStreaming}
              onConfirm={confirmAction}
            />
          </div>

          {error && (
            <div className="px-4 pb-1 text-xs text-red-600 sm:px-6">{error}</div>
          )}

          <form
            onSubmit={submit}
            className="border-t border-surface-border bg-surface p-3 sm:p-4"
          >
            <div className="mx-auto flex max-w-3xl items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit(e);
                  }
                }}
                rows={1}
                placeholder="Ask about your documents — or tell me to list, summarise or delete one…"
                className="max-h-40 flex-1 resize-none rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-neutral-400"
              />
              <button
                type="submit"
                disabled={isStreaming || !input.trim()}
                className="rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {isStreaming ? "…" : "Send"}
              </button>
            </div>
          </form>
        </main>

        <SourcesPanel citations={citations} />
      </div>
    </div>
  );
}
