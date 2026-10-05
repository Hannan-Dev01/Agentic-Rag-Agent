import { NextResponse } from "next/server";
import { z } from "zod";
import { streamChat } from "@/services/chat";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * POST /api/chat — streams a RAG answer as newline-delimited JSON events.
 *
 * Thin route: validate input → rate-limit → hand off to the streaming service.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  question: z.string().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      }),
    )
    .max(20)
    .optional(),
  documentId: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  // --- Rate limiting (Phase 13): protect the expensive LLM/embedding calls. ---
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429 },
    );
  }

  // --- Validate input: never trust the client. ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  logger.info("chat.request", {
    ip,
    questionLength: parsed.data.question.length,
    hasHistory: Boolean(parsed.data.history?.length),
  });

  const stream = streamChat(parsed.data);
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
