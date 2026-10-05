"use client";

import Link from "next/link";
import { FileDropzone } from "@/components/FileDropzone";
import { useUpload } from "@/hooks/useUpload";

export default function UploadPage() {
  const { upload, isUploading, results, error } = useUpload();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Upload Documents</h1>
        <Link href="/" className="text-sm text-neutral-500 hover:underline">
          ← Home
        </Link>
      </div>

      <FileDropzone onFiles={upload} disabled={isUploading} />

      {isUploading && (
        <p className="text-sm text-neutral-500">Parsing files…</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {results.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-neutral-600">Results</h2>
          <ul className="flex flex-col gap-3">
            {results.map((r, i) => (
              <li
                key={`${r.filename}-${i}`}
                className="rounded-lg border border-surface-border bg-surface p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{r.filename}</span>
                  <span
                    className={
                      r.ok ? "text-xs text-green-600" : "text-xs text-red-600"
                    }
                  >
                    {r.ok ? "Parsed ✓" : "Failed"}
                  </span>
                </div>

                {r.ok && r.record && (
                  <div className="mt-2 text-xs text-neutral-500">
                    {r.record.sourceType.toUpperCase()} ·{" "}
                    {r.record.chunkCount} segment(s) ·{" "}
                    {r.record.charCount.toLocaleString()} chars
                  </div>
                )}
                {r.ok && r.preview && (
                  <p className="mt-2 line-clamp-3 text-xs text-neutral-400">
                    {r.preview}…
                  </p>
                )}
                {!r.ok && (
                  <p className="mt-2 text-xs text-red-500">{r.error}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
