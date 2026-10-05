import Link from "next/link";

/**
 * Phase 1 landing page. This is intentionally minimal — a map of the app.
 * The real pages (/upload, /documents, /chat) get built in later phases.
 */
export default function HomePage() {
  const links = [
    { href: "/upload", title: "Upload Documents", desc: "Add PDF, TXT, MD, DOCX files" },
    { href: "/documents", title: "Document Library", desc: "See & delete what's been ingested" },
    { href: "/chat", title: "Chat", desc: "Ask questions with cited, streamed answers" },
  ];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header>
        <h1 className="text-3xl font-semibold">RAG Agent</h1>
        <p className="mt-2 text-neutral-600">
          Retrieval Augmented Generation over your own documents. Built with
          Next.js, LangChain, LangGraph, Pinecone, and OpenAI.
        </p>
      </header>

      <nav className="grid gap-4 sm:grid-cols-3">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-xl border border-surface-border bg-surface p-5 transition hover:shadow-sm"
          >
            <div className="font-medium">{l.title}</div>
            <div className="mt-1 text-sm text-neutral-500">{l.desc}</div>
          </Link>
        ))}
      </nav>

      <p className="text-sm text-neutral-400">
        Upload documents, then ask questions — answers are grounded only in your
        files, re-ranked, and cited.
      </p>
    </main>
  );
}
