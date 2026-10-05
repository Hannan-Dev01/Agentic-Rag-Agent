import { z } from "zod";
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { listDocuments, removeDocument, resolveDocument } from "@/services/documents";
import { ingestText } from "@/services/ingest";
import { fetchDocumentChunks } from "@/pinecone/vectorstore";
import { semanticSearch } from "@/langchain/retriever";
import { getChatModel } from "@/langchain/llm";
import {
  AGENT_SEARCH_TOP_K,
  SUMMARY_MAX_CHARS,
  TOOL_SNIPPET_CHARS,
} from "@/lib/constants";
import type { PendingAction } from "@/types";

/**
 * PHASE 15 — THE TOOL LAYER
 *
 * Every capability the app has, exposed as something the assistant can DO when
 * asked in plain language. Until now the UI was the only way to list or delete a
 * document; these tools make the chat box a second, equal front-end over the
 * SAME service functions — not a reimplementation of them.
 *
 * Design rules this file follows:
 *
 *  1. TOOLS WRAP SERVICES, THEY DON'T REIMPLEMENT THEM. Every tool below calls
 *     the same `services/` function the HTTP route calls. A bug fixed once is
 *     fixed for both front-ends, and the chat path can never drift from the UI.
 *
 *  2. EVERY TOOL RETURNS A JSON STRING with a consistent `{ ok, summary, … }`
 *     envelope. Tool results go back to the model as plain text, so the shape has
 *     to be something a model reads reliably — and `summary` is exactly what we
 *     surface in the UI's activity trail.
 *
 *  3. DESCRIPTIONS AND SCHEMAS ARE THE PROMPT. The model chooses tools using
 *     nothing but the name, the description, and each field's `.describe()`.
 *     These strings are load-bearing, not documentation.
 *
 *  4. NO TOOL GUESSES WHICH DOCUMENT. Anything taking a document goes through
 *     `resolveDocument()`, which RETURNS ambiguity rather than resolving it.
 *
 * Each tool is built through `defineTool()` below — see the note there on the
 * TS2589 workaround, and on why tool arguments get re-validated at runtime.
 */

/** Envelope every tool returns. Serialised to JSON for the model. */
interface ToolResult {
  ok: boolean;
  /** One line the UI shows in the activity trail. */
  summary: string;
  [key: string]: unknown;
}

const encode = (r: ToolResult): string => JSON.stringify(r);

/**
 * Build a tool from a Zod schema.
 *
 * ── The TypeScript bit that would otherwise cost you an afternoon ──
 * Handing `DynamicStructuredTool` a Zod schema — or even the JSON Schema that
 * `toJsonSchema()` returns — makes the compiler give up with **TS2589**, "type
 * instantiation is excessively deep", under this zod × @langchain/core pairing.
 * It is the same inference blow-up the codebase already works around for
 * `withStructuredOutput` (see langchain/chain.ts and langchain/retriever.ts),
 * and it is purely a compile-time artefact — the runtime behaviour is correct.
 *
 * So the erasure is confined to this ONE function rather than repeated at five
 * call sites. Above this line everything is strongly typed; below it the schema
 * crosses an untyped boundary into the library.
 *
 * Note `tsconfig.json` sets `incremental: true`, so a stale
 * `tsconfig.tsbuildinfo` can hide this error from `yarn typecheck` while
 * `next build` still fails. Delete it when a type error looks impossible.
 *
 * Runtime validation is not a type convenience: tool arguments are written by a
 * language model, so they are untrusted input and get parsed exactly like the
 * HTTP body in app/api/chat/route.ts. `handler` receives parsed, typed args.
 */
function defineTool<S extends z.ZodTypeAny>(spec: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => Promise<string>;
}): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: spec.name,
    description: spec.description,
    // `as never` on the argument too: matching a generic Zod type against
    // toJsonSchema's `InteropZodType | JSONSchema` union is itself deep enough
    // to trip TS2589.
    schema: toJsonSchema(spec.schema as never) as never,
    func: (async (raw: unknown) => spec.handler(spec.schema.parse(raw))) as (
      input: unknown,
    ) => Promise<string>,
  } as never) as unknown as StructuredToolInterface;
}

/** Schema for a tool taking no arguments. */
const NoArgs = z.object({});

/**
 * Shared handling for an unresolvable document reference. Returning the
 * candidate list (not merely "not found") lets the model recover within the same
 * turn — it can name the real files back to the user instead of dead-ending.
 */
async function resolveOrExplain(ref: string) {
  const res = await resolveDocument(ref);
  if (res.status === "found") return { doc: res.document, error: null as string | null };

  const names = res.candidates.map((d) => d.filename);
  const error =
    res.status === "ambiguous"
      ? encode({
          ok: false,
          summary: `"${ref}" matched ${names.length} documents`,
          error: "ambiguous_reference",
          candidates: names,
          instruction:
            "Ask the user which of these they mean. Do NOT pick one yourself.",
        })
      : encode({
          ok: false,
          summary: `No document matching "${ref}"`,
          error: "not_found",
          availableDocuments: names,
          instruction:
            names.length > 0
              ? "Tell the user it doesn't exist and list what IS available."
              : "Tell the user the knowledge base is empty and invite them to upload a file.",
        });

  return { doc: null, error };
}

/* ------------------------------------------------------------------ *
 * READ-ONLY TOOLS
 * ------------------------------------------------------------------ */

/** "What have I uploaded?" / "list my documents" / "how many files are there?" */
const listDocumentsTool = defineTool({
  name: "list_documents",
  description:
    "List every document in the knowledge base with its filename, type, chunk count and upload date. " +
    "Use this whenever the user asks what is uploaded, how many files there are, or refers to a document " +
    "by name — you need the documentId from here before using any other document tool.",
  schema: NoArgs,
  handler: async () => {
    const docs = await listDocuments();
    return encode({
      ok: true,
      summary: `Found ${docs.length} document${docs.length === 1 ? "" : "s"}.`,
      count: docs.length,
      documents: docs.map((d) => ({
        documentId: d.documentId,
        filename: d.filename,
        type: d.sourceType,
        chunks: d.chunkCount,
        uploadedAt: d.uploadedAt,
      })),
    });
  },
});

const DescribeSchema = z.object({
  document: z
    .string()
    .describe("The filename or documentId, e.g. 'handbook.pdf' or 'doc_1a2b…'"),
});

/** "Tell me about handbook.pdf" — metadata, not content. */
const describeDocumentTool = defineTool({
  name: "describe_document",
  description:
    "Get the stored details of ONE document (type, chunk count, upload date) by filename or documentId. " +
    "This returns metadata only — to read its contents use search_documents or summarize_document.",
  schema: DescribeSchema,
  handler: async (args) => {
    const { document } = args;
    const { doc, error } = await resolveOrExplain(document);
    if (error) return error;

    return encode({
      ok: true,
      summary: `${doc!.filename}: ${doc!.chunkCount} chunks, ${doc!.sourceType.toUpperCase()}.`,
      documentId: doc!.documentId,
      filename: doc!.filename,
      type: doc!.sourceType,
      chunks: doc!.chunkCount,
      uploadedAt: doc!.uploadedAt,
    });
  },
});

const SearchSchema = z.object({
  query: z
    .string()
    .describe("A self-contained search question — resolve any pronouns first"),
  document: z
    .string()
    .optional()
    .describe("Optional: restrict the search to this filename or documentId"),
});

/** Retrieval, exposed as a tool so the agent can look things up mid-task. */
const searchDocumentsTool = defineTool({
  name: "search_documents",
  description:
    "Semantic search across the knowledge base (optionally scoped to one document). " +
    "Returns the most relevant passages with filename, page number and similarity score. " +
    "Use this to look up a fact mid-task. Always cite the filename and page in your reply.",
  schema: SearchSchema,
  handler: async (args) => {
    const { query, document } = args;

    let documentId: string | undefined;
    if (document) {
      const { doc, error } = await resolveOrExplain(document);
      if (error) return error;
      documentId = doc!.documentId;
    }

    const hits = await semanticSearch(query, { topK: AGENT_SEARCH_TOP_K, documentId });
    if (hits.length === 0) {
      return encode({
        ok: true,
        summary: `No passages found for "${query}".`,
        count: 0,
        results: [],
      });
    }

    return encode({
      ok: true,
      summary: `Found ${hits.length} passage${hits.length === 1 ? "" : "s"} for "${query}".`,
      count: hits.length,
      results: hits.map((h) => ({
        filename: h.metadata.filename,
        page: h.metadata.page,
        score: Number(h.score.toFixed(3)),
        text: truncate(h.metadata.text, TOOL_SNIPPET_CHARS),
      })),
    });
  },
});

const SummarizeSchema = z.object({
  document: z.string().describe("Filename or documentId to summarise"),
  focus: z
    .string()
    .optional()
    .describe("Optional topic to focus the summary on, e.g. 'the refund policy'"),
});

/**
 * Whole-document summarisation.
 *
 * Note this deliberately does NOT go through retrieval: a summary needs the
 * entire file, not the passages matching some query. We fetch every chunk in
 * reading order and cap the total characters — a 300-page PDF would otherwise
 * blow both the context window and the budget. The cap is reported back so the
 * model can be honest about having read only part of the file.
 */
const summarizeDocumentTool = defineTool({
  name: "summarize_document",
  description:
    "Read an ENTIRE document and produce a summary. Use this for 'summarise X', 'what is X about', " +
    "or 'give me the key points of X' — unlike search_documents it reads the whole file, not just " +
    "matching passages. Optionally narrow it with a focus topic.",
  schema: SummarizeSchema,
  handler: async (args) => {
    const { document, focus } = args;
    const { doc, error } = await resolveOrExplain(document);
    if (error) return error;

    const chunks = await fetchDocumentChunks(doc!.documentId);
    if (chunks.length === 0) {
      return encode({
        ok: false,
        summary: `${doc!.filename} has no readable content.`,
        error: "empty_document",
      });
    }

    let text = chunks.map((c) => c.text).join("\n\n");
    const truncated = text.length > SUMMARY_MAX_CHARS;
    if (truncated) text = text.slice(0, SUMMARY_MAX_CHARS);

    const documentSummary = await getChatModel({ temperature: 0.2 })
      .pipe(new StringOutputParser())
      .invoke(
        `Summarise the document below${focus ? `, focusing on: ${focus}` : ""}. ` +
          `Be concise and factual. Use only what the text actually says.\n\n` +
          `Document: ${doc!.filename}\n\n${text}`,
      );

    return encode({
      ok: true,
      summary: `Summarised ${doc!.filename} (${chunks.length} chunks${truncated ? ", truncated" : ""}).`,
      filename: doc!.filename,
      chunksRead: chunks.length,
      truncated,
      ...(truncated && {
        note: "Only the first portion of the document was read — say so in your reply.",
      }),
      documentSummary: documentSummary.trim(),
    });
  },
});

/* ------------------------------------------------------------------ *
 * AUTHORING TOOL — the agent produces something instead of fetching it
 * ------------------------------------------------------------------ */

const CreateSchema = z.object({
  title: z
    .string()
    .min(3)
    .describe("Title for the new document, e.g. 'JavaScript Internship Plan'"),
  content: z
    .string()
    .min(200)
    .describe(
      "The FULL document body in Markdown, with headings. Write the complete document here — " +
        "this is saved verbatim, so do not write a summary, an outline, or a placeholder.",
    ),
  derivedFrom: z
    .array(z.string())
    .optional()
    .describe(
      "Filenames or documentIds of the source documents this was built from, for provenance",
    ),
  replaceExisting: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY after the user agreed to overwrite a document that already has this title.",
    ),
});

/**
 * create_document — write a new document into the knowledge base.
 *
 * This is the first tool that PRODUCES rather than retrieves, and it is what
 * makes a request like "build an internship plan from our JavaScript training
 * material" possible: the agent researches with the read tools, composes the
 * document in its own output, and persists it here. The number of research steps
 * is decided by the agent based on what it finds, not by us.
 *
 * Two deliberate decisions:
 *
 *  - NOT two-phase, unlike delete. Creating is additive and reversible — if the
 *    user dislikes the result they can delete it. Gating every write behind a
 *    confirmation would make the capability tedious for no safety gain. The
 *    asymmetry is the point: confirmation cost should track irreversibility.
 *
 *  - PROVENANCE IS MANDATORY, not optional. Every chunk is stamped
 *    `generated: true` plus the source documentIds. Once the agent can write
 *    into the index its own prose becomes retrievable, so later answers can be
 *    grounded in earlier generated text. That loop is acceptable only while it
 *    stays VISIBLE — hence the flag, the citation badge, and the library badge.
 */
const createDocumentTool = defineTool({
  name: "create_document",
  description:
    "Write a NEW document into the knowledge base, authored by you. Use this when the user asks you to " +
    "create, draft, write or generate a document, plan, guide, curriculum or summary that should be SAVED. " +
    "Research the existing documents first (list_documents, then search_documents or summarize_document) " +
    "so the content is grounded in what is actually there, then pass the complete Markdown body as `content`. " +
    "The document becomes searchable immediately.",
  schema: CreateSchema,
  handler: async ({ title, content, derivedFrom, replaceExisting }) => {
    const filename = title.toLowerCase().endsWith(".md") ? title : `${title}.md`;

    // Guard against silently creating a SECOND document with the same title.
    // Observed in testing: asked twice for the same runbook, the agent happily
    // made a duplicate — and then, worse, treated its own earlier output as a
    // source on the next run. Refusing here breaks both halves of that loop.
    const existing = await resolveDocument(filename);
    if (existing.status === "found" && !replaceExisting) {
      return encode({
        ok: false,
        summary: `"${filename}" already exists — not overwritten.`,
        error: "already_exists",
        existingDocumentId: existing.document.documentId,
        existingChunks: existing.document.chunkCount,
        wasGenerated: existing.document.generated === true,
        instruction:
          "Do NOT create a duplicate. Tell the user a document with this title already " +
          "exists and ask whether to replace it or use a different title. Only retry with " +
          "replaceExisting: true after they agree to replace it.",
      });
    }
    // Resolve human-friendly source references to real IDs. A source we cannot
    // resolve is dropped from provenance rather than failing the write — the
    // document is still worth saving, just with weaker lineage.
    const sourceIds: string[] = [];
    const unresolved: string[] = [];
    for (const ref of derivedFrom ?? []) {
      const res = await resolveDocument(ref);
      if (res.status === "found") sourceIds.push(res.document.documentId);
      else unresolved.push(ref);
    }

    try {
      // Replacing is delete-then-create: chunk counts differ between versions,
      // so leftover chunks from the longer old version would otherwise survive
      // and keep being retrieved alongside the new text.
      if (existing.status === "found" && replaceExisting) {
        await removeDocument(existing.document.documentId);
      }

      const record = await ingestText({ title, text: content, derivedFrom: sourceIds });
      return encode({
        ok: true,
        summary: `Created ${record.filename} (${record.chunkCount} chunks, ${record.charCount} chars).`,
        documentId: record.documentId,
        filename: record.filename,
        chunks: record.chunkCount,
        characters: record.charCount,
        derivedFrom: sourceIds,
        replaced: existing.status === "found" && replaceExisting === true,
        ...(unresolved.length > 0 && { unresolvedSources: unresolved }),
        createdDocument: { documentId: record.documentId, filename: record.filename },
        instruction:
          "Saved and searchable. Tell the user the document name, what you based it on, " +
          "that it is marked as assistant-generated in their library, and that they can " +
          "download it as PDF, Word or Markdown using the buttons shown with your reply.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return encode({
        ok: false,
        summary: `Could not create "${title}": ${message}`,
        error: "create_failed",
      });
    }
  },
});

/* ------------------------------------------------------------------ *
 * MUTATING TOOL — two-phase, never fires on the model's own judgment
 * ------------------------------------------------------------------ */

const DeleteSchema = z.object({
  document: z.string().describe("Filename or documentId to delete"),
  confirmed: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY after the user explicitly confirmed this exact deletion. Omit otherwise.",
    ),
});

/**
 * delete_document — the one irreversible capability.
 *
 * THE SAFETY MODEL, because this is the part that matters:
 *
 *  - The tool is two-phase. Called without `confirmed: true` it performs NO
 *    deletion; it resolves the target, reports exactly what would be destroyed,
 *    and returns a PendingAction the UI renders as a confirm button.
 *  - `confirmed: true` is only legitimate once the USER has said yes, in words,
 *    on a previous turn. The agent's system prompt states that rule; this
 *    comment states the reason. A model setting it unprompted is a bug — which
 *    is why the pending action is ALSO surfaced in the UI, so the two-step dance
 *    is visible rather than taken on trust.
 *  - Ambiguity is never resolved by the model (see resolveOrExplain). "Delete
 *    the report" with two reports present asks rather than picks.
 *
 * This is the stateless stand-in for a LangGraph `interrupt()`. With a
 * checkpointer we would genuinely pause the graph mid-run; without one we end
 * the turn and let the user's next message carry the confirmation.
 */
const deleteDocumentTool = defineTool({
  name: "delete_document",
  description:
    "Permanently delete a document and all of its vectors from the knowledge base. " +
    "ALWAYS call this first WITHOUT `confirmed` to preview what would be removed and ask the user " +
    "to confirm. Only set `confirmed: true` after the user has explicitly agreed to delete that " +
    "specific document in the conversation. Never confirm on their behalf.",
  schema: DeleteSchema,
  handler: async (args) => {
    const { document, confirmed } = args;
    const { doc, error } = await resolveOrExplain(document);
    if (error) return error;

    const impact =
      `${doc!.filename} and all ${doc!.chunkCount} of its indexed chunks will be ` +
      `permanently removed. This cannot be undone.`;

    if (!confirmed) {
      const pendingAction: PendingAction = {
        tool: "delete_document",
        documentId: doc!.documentId,
        filename: doc!.filename,
        impact,
      };
      return encode({
        ok: true,
        summary: `Awaiting confirmation to delete ${doc!.filename}.`,
        performed: false,
        requiresConfirmation: true,
        pendingAction,
        instruction:
          `STOP. Nothing has been deleted. Tell the user exactly what will be removed ` +
          `(${impact}) and ask them to confirm. Do not call this tool again until they ` +
          `have explicitly said yes.`,
      });
    }

    await removeDocument(doc!.documentId);
    return encode({
      ok: true,
      summary: `Deleted ${doc!.filename} (${doc!.chunkCount} chunks).`,
      performed: true,
      filename: doc!.filename,
      chunksRemoved: doc!.chunkCount,
    });
  },
});

/* ------------------------------------------------------------------ *
 * REGISTRY
 * ------------------------------------------------------------------ */

/**
 * The tools bound to the agent. Adding a capability means adding it here and
 * nowhere else — the agent node reads this list, and so does the tool executor.
 */
export const agentTools: StructuredToolInterface[] = [
  listDocumentsTool,
  describeDocumentTool,
  searchDocumentsTool,
  summarizeDocumentTool,
  createDocumentTool,
  deleteDocumentTool,
];

/** Name → tool, for the executor node's dispatch. */
export const toolsByName = new Map(agentTools.map((t) => [t.name, t]));

/** Tools that change state. Logged more loudly and shown prominently in the UI. */
export const MUTATING_TOOLS = new Set(["delete_document", "create_document"]);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
