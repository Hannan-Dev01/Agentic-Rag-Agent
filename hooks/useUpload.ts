"use client";

import { useState, useCallback } from "react";
import type { UploadResponse, UploadedFileResult } from "@/types";

/**
 * Client hook that owns upload state. Components stay presentational; this hook
 * holds the fetch, loading flag, and results. That separation means we could
 * unit-test the component with mock props and swap the transport here later
 * (e.g. move to resumable/chunked uploads) without touching the UI.
 */
export function useUpload() {
  const [isUploading, setIsUploading] = useState(false);
  const [results, setResults] = useState<UploadedFileResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setIsUploading(true);
    setError(null);
    try {
      const body = new FormData();
      for (const file of files) body.append("files", file);

      const res = await fetch("/api/upload", { method: "POST", body });
      const data = (await res.json()) as UploadResponse;
      setResults((prev) => [...data.results, ...prev]);
    } catch {
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setIsUploading(false);
    }
  }, []);

  return { upload, isUploading, results, error };
}
