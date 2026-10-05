import { NextResponse } from "next/server";
import { listDocuments, removeDocument } from "@/services/documents";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/documents — list all ingested documents. */
export async function GET() {
  try {
    const documents = await listDocuments();
    return NextResponse.json({ documents });
  } catch (err) {
    logger.error("documents.list.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to list documents." },
      { status: 500 },
    );
  }
}

/** DELETE /api/documents?id=doc_xxx — delete a document and all its vectors. */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing ?id" }, { status: 400 });
  }
  try {
    await removeDocument(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("documents.delete.failed", {
      documentId: id,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to delete document." },
      { status: 500 },
    );
  }
}
