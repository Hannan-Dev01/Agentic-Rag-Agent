import { NextResponse } from "next/server";
import { exportDocument, type ExportFormat } from "@/services/export";
import { logger } from "@/lib/logger";

/**
 * GET /api/documents/export?id=doc_xxx&format=md|docx|pdf
 *
 * Streams one stored document back as a downloadable file.
 *
 * Node.js runtime, not Edge: pdfkit and docx are Node libraries (pdfkit reads
 * its built-in font metrics from disk).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS = new Set<ExportFormat>(["md", "docx", "pdf"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const format = (params.get("format") ?? "pdf") as ExportFormat;

  if (!id) {
    return NextResponse.json({ error: "Missing ?id" }, { status: 400 });
  }
  if (!FORMATS.has(format)) {
    return NextResponse.json(
      { error: `Unsupported format. Use one of: ${[...FORMATS].join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const file = await exportDocument(id, format);

    return new Response(new Uint8Array(file.buffer), {
      headers: {
        "Content-Type": file.mimeType,
        // `attachment` makes the browser download rather than render it.
        // The filename is quoted and stripped of quotes/newlines so a document
        // title can never break out of the header.
        "Content-Disposition": `attachment; filename="${file.filename.replace(/["\r\n]/g, "")}"`,
        "Content-Length": String(file.buffer.length),
        "Cache-Control": "no-store",
        // Tells the client whether this is the original text or a reconstruction
        // from overlapping chunks (uploaded files keep no pristine copy).
        "X-Export-Exact": String(file.exact),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("documents.export.failed", { documentId: id, format, message });
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
