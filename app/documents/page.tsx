"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { DocumentRecord } from "@/types";

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setDocs(data.documents);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    if (!confirm("Delete this document and all its vectors?")) return;
    setDocs((prev) => prev.filter((d) => d.documentId !== id)); // optimistic
    try {
      const res = await fetch(`/api/documents?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
    } catch {
      void load(); // revert on failure
    }
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <nav className="flex gap-4 text-sm text-neutral-500">
          <Link href="/upload" className="hover:underline">Upload</Link>
          <Link href="/chat" className="hover:underline">Chat</Link>
          <Link href="/" className="hover:underline">Home</Link>
        </nav>
      </div>

      {loading && <p className="text-sm text-neutral-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!loading && !error && docs.length === 0 && (
        <p className="text-sm text-neutral-500">
          No documents yet.{" "}
          <Link href="/upload" className="underline">Upload some →</Link>
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {docs.map((d) => (
          <li
            key={d.documentId}
            className="flex items-center justify-between rounded-lg border border-surface-border bg-surface p-4"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{d.filename}</span>
                {/* Phase 16: assistant-authored documents are retrievable like
                    any other, so the library has to say which is which. */}
                {d.generated && (
                  <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    AI-generated
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {d.sourceType.toUpperCase()} · {d.chunkCount} chunks ·{" "}
                {new Date(d.uploadedAt).toLocaleString()}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {/* Phase 17: plain links, not fetch() — the browser handles the
                  download from Content-Disposition with no JS involved. */}
              {(["pdf", "docx", "md"] as const).map((fmt) => (
                <a
                  key={fmt}
                  href={`/api/documents/export?id=${encodeURIComponent(d.documentId)}&format=${fmt}`}
                  className="rounded-md border border-surface-border px-2 py-1.5 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50"
                  title={`Download as ${fmt.toUpperCase()}`}
                >
                  {fmt.toUpperCase()}
                </a>
              ))}
              <button
                onClick={() => remove(d.documentId)}
                className="ml-1 rounded-md px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
