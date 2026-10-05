import { NextResponse } from "next/server";
import { ingestUploads } from "@/services/ingest";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import type { UploadResponse } from "@/types";

/**
 * POST /api/upload  (multipart/form-data, field name: "files", one or many)
 *
 * This route is intentionally THIN: it only speaks HTTP. It pulls files out of
 * the form, hands them to the ingest service, and shapes the JSON response.
 * All parsing/validation logic lives in services/ — so it's reusable and testable.
 */

// pdf-parse / mammoth are Node-only; force the Node.js runtime (not Edge).
export const runtime = "nodejs";
// Uploads are inherently dynamic; never cache this route.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse<UploadResponse>> {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(ip)) {
    return NextResponse.json(
      { results: [{ filename: "(request)", ok: false, error: "Rate limit exceeded." }] },
      { status: 429 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { results: [{ filename: "(request)", ok: false, error: "Expected multipart/form-data." }] },
      { status: 400 },
    );
  }

  // Accept both `files` (multiple) and a single `file`.
  const files = [
    ...formData.getAll("files"),
    ...formData.getAll("file"),
  ].filter((v): v is File => v instanceof File);

  if (files.length === 0) {
    return NextResponse.json(
      { results: [{ filename: "(none)", ok: false, error: "No files provided." }] },
      { status: 400 },
    );
  }

  // parse → chunk → embed → store in Pinecone (per file, isolated failures).
  const results = await ingestUploads(files);
  logger.info("upload.complete", {
    ip,
    files: files.length,
    ok: results.filter((r) => r.ok).length,
  });
  // 207-style semantics: some files may fail while others succeed. We return 200
  // and let the client inspect per-file `ok`.
  return NextResponse.json({ results });
}
