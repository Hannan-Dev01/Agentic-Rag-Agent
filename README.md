# RAG Agent

A production-oriented Retrieval Augmented Generation app built with **Next.js (App Router)**, **TypeScript**, **LangChain**, **LangGraph**, **Pinecone**, and **OpenAI**.

## Architecture (layered)

```
UI (app/, components/, hooks/)
        │  calls
        ▼
Services (services/)                 ← orchestration: "ingest file", "answer question"
        │  calls
        ▼
LangChain wrappers (langchain/)      LangGraph brain (langgraph/)
        │                                    │
        ▼                                    ▼
Pinecone adapter (pinecone/)  +  OpenAI (embeddings, chat)

services/export.ts  ← reads stored documents back out as PDF / DOCX / Markdown
```

Each layer only depends on the layer below it. Swapping Pinecone for Chroma, or
GPT-4o for another model, is a change confined to one folder.

## Prerequisites

- **Node.js >= 20 LTS** (Next 15 + LangGraph require it; Node 18.0.0 will NOT work)
- **Yarn** (enable via `corepack enable`)
- An **OpenAI** API key
- A **Pinecone** account + API key

## Setup

```bash
corepack enable                 # makes `yarn` available without a global install
yarn install                    # install dependencies
cp .env.example .env.local      # then fill in real keys
yarn dev                        # http://localhost:3000
```

## Query pipeline (LangGraph)

```
START → classifyIntent
          ├─ action ───────────► agent ⇄ tools ──────────────► END
          ├─ chitchat / meta ──► direct ─────────────────────► END
          └─ document_question
                      ├─► retrieve (condense follow-ups → semantic search, top-K)
                      └─► rerank (LLM listwise) + confidence gate
                             ├─ confident? ─ no ─► clarify ──► END
                             └─ yes ───────────► generate ──► END
```

Answers stream token-by-token (LangGraph `messages` mode) with inline `[n]`
citations that map to the sources panel.

## API

| Route | Purpose |
|---|---|
| `POST /api/upload` | Ingest files (PDF/TXT/MD/DOCX). Multipart; per-file success or error |
| `POST /api/chat` | Ask or instruct. Streams NDJSON events: `token`, `tool`, `meta`, `error`, `done` |
| `GET /api/documents` | List everything in the knowledge base |
| `DELETE /api/documents?id=` | Delete a document and all its vectors |
| `GET /api/documents/export?id=&format=` | Download a document as `pdf`, `docx` or `md` |

## Build phases (all complete)

1. ✅ Project setup
2. ✅ Document upload (parse PDF/TXT/MD/DOCX)
3. ✅ Chunking (recursive / token / markdown splitters)
4. ✅ Embeddings (text-embedding-3-small, 1536-dim, cosine)
5. ✅ Pinecone integration (auto-created serverless index)
6. ✅ Retriever (semantic search, top-K, metadata filter, LLM re-rank)
7. ✅ RAG chain (grounded prompt + LLM + output parser)
8. ✅ LangGraph workflow (intent → retrieve → re-rank → confidence → clarify/answer)
9. ✅ Chat UI (ChatGPT-like) + document library
10. ✅ Streaming responses (NDJSON token stream)
11. ✅ Conversation memory + history-aware retrieval
12. ✅ Source citations
13. ✅ Production hardening (rate limit, structured logging, input validation)
14. ✅ Deployment (Vercel + Docker)
15. ✅ Assistant actions (tool-calling branch + confirmed destructive actions)
16. ✅ Document authoring (research-and-compose: the agent writes into the KB)
17. ✅ Export / download (PDF, Word .docx, Markdown)

## Assistant actions (Phase 15)

Anything the app can do, you can also just *ask* for. "List my documents",
"summarise the handbook", "search the policy for the carry-over rule", "delete
the old report" — the assistant performs the action itself rather than pointing
you at the UI.

| Tool | What it does |
|---|---|
| `list_documents` | Everything in the knowledge base, with chunk counts and dates |
| `describe_document` | One document's stored details |
| `search_documents` | Semantic search, optionally scoped to a single file |
| `summarize_document` | Reads a whole file (not just matching passages) and summarises it |
| `create_document` | **Authoring** — researches the corpus, composes a new document, saves it |
| `delete_document` | **Destructive** — two-phase, see below |

Tools live in `langchain/tools.ts` and wrap the same `services/` functions the
HTTP routes call, so the chat path can never drift from the UI.

### How it stays safe

- **Routing, not replacement.** Only `intent: "action"` reaches the agent.
  Ordinary document questions keep the deterministic retrieve → rerank →
  confidence-gate pipeline, unchanged — predictable cost, reproducible answers.
- **Bounded.** `MAX_AGENT_STEPS` (6) caps the model→tools loop. Hitting it ends
  the turn with an honest message instead of an unbounded bill.
- **Destructive actions are two-phase.** `delete_document` called without
  `confirmed` deletes nothing: it reports exactly what *would* be removed and
  returns a pending action the UI renders as a confirm button. Only after the
  user explicitly agrees — on a later turn — does the agent re-call it with
  `confirmed: true`. Confirming sends an ordinary chat message back through the
  graph; there is no path from the button straight to the vector store.
- **Ambiguity is never guessed.** `resolveDocument()` returns ambiguity rather
  than resolving it, so "delete the report" with two reports present asks.
- **Visible.** Every tool call is streamed to the UI as it happens, with its
  arguments, outcome and duration.

> No LangGraph checkpointer is wired up, so this is a stateless stand-in for a
> real `interrupt()`: the turn ends and the user's next message carries the
> confirmation. Adding a checkpointer would let the graph genuinely pause mid-run.

### Document authoring (Phase 16)

> "Using my JavaScript training document, create an internship plan for new
> interns and save it to my knowledge base."

This is the first capability that genuinely plans. The agent triages the corpus
to find what is relevant, reads what it finds, composes a complete Markdown
document, and persists it through the same chunk → embed → store pipeline as an
upload — so the new document is searchable immediately. Observed trace:

```
list_documents → search_documents("javascript training")
               → summarize_document(js-training.md)
               → create_document("JavaScript Internship Plan", …)
```

The step count is not fixed: it depends on how many sources turn out to be
relevant, which is the property the earlier tools lack.

**Provenance is mandatory.** Once the assistant can write into the index, its own
prose becomes retrievable, and tomorrow's answers can be grounded in yesterday's
generated text. That loop is tolerable only while it is visible, so every chunk
is stamped `generated: true` plus the source documentIds, and the flag surfaces
in three places: the document library, the citation cards, and the context block
the model itself reads (`[2] (source: plan.md, assistant-generated)`), so it can
weigh a human-uploaded source above its own earlier output.

**Guards learned from testing**, each of which fired for real before it was fixed:

- *Triage before reading.* The agent originally ran `summarize_document` over
  every file — including a 101-chunk PDF — just to discover nothing matched:
  8 steps and 6 full-document LLM calls. It now searches first and reads only
  what scores well. Same task, 2 steps.
- *No duplicate titles.* Asked twice for the same document, it created a second
  copy. `create_document` now refuses when the title exists and asks whether to
  replace; replacing is delete-then-create, so stale chunks from a longer
  previous version cannot survive and keep being retrieved.
- *No self-sourcing.* Having created a document, the agent then used its own
  output as the source for regenerating it. The prompt now forbids building a
  new document mainly out of assistant-generated ones.
- *Honest about gaps.* Asked for a runbook the corpus does not cover, it says so
  rather than presenting invented specifics as if they came from the user's
  material.

Unlike `delete_document`, creating is **not** two-phase: it is additive and
reversible, so a confirmation step would be friction without safety. Confirmation
cost should track irreversibility.

## Export & download (Phase 17)

A document the assistant wrote is only half-delivered while it lives as vectors,
so every document in the knowledge base can be downloaded as **PDF**, **Word
(.docx)** or **Markdown**:

```
GET /api/documents/export?id=doc_xxx&format=pdf|docx|md
```

Download buttons appear in two places — inline under the assistant's reply for
anything it just wrote, and on every row of the document library. Both are plain
`<a>` links; `Content-Disposition: attachment` makes the browser save the file,
so there is no fetch, blob or object URL to manage.

`.docx` is produced with `docx` and `.pdf` with `pdfkit` (built-in fonts only, so
no font files to ship). `services/export.ts` carries a deliberately small
Markdown parser — headings, bullet and numbered lists, fenced code, paragraphs —
rather than a full CommonMark stack, because the agent is prompted to write
exactly those constructs, and anything unrecognised degrades to a paragraph so
formatting can be lost but content never is.

**Exports are verbatim for generated documents, reconstructed for uploads.**
Chunks overlap by `DEFAULT_CHUNK_OVERLAP` characters by design, so re-joining
them repeats text at every seam. For documents the assistant authored we simply
keep the original Markdown on chunk 0 (`fullText`, stripped out on retrieval so
it never bloats a prompt), and export it byte-for-byte. For uploaded files only
chunks were ever stored, so export de-duplicates the overlap and returns a
faithful reconstruction — text only, since layout, images and tables were never
in the index. The response says which you got via the `X-Export-Exact` header.

Verified end-to-end by exporting a generated plan in all three formats and then
re-ingesting the PDF through the app's own parser, confirming the text survives
the round trip:

```
md   → ASCII text, 1842 bytes     X-Export-Exact: true
docx → Microsoft Word 2007+       X-Export-Exact: true
pdf  → PDF document, 1 page       X-Export-Exact: true
```

## How agentic is this, really?

Honestly: **this is natural-language routing over the app's own API, not deep
agency.** Worth stating plainly, because "agent" is a word that gets oversold.

The distinction we hold ourselves to:

> In a tool-calling chatbot, the *developer* fixes the sequence and the model
> fills in arguments. In an agent, the *model* chooses the sequence, the number
> of steps is not knowable in advance, and step N+1 depends on what step N
> returned.

Measured against that, the Phase 15 command tools look like:

```
"summarise the leave policy"       → list_documents → summarize_document   (2 steps)
"search X for the carry-over rule" → list_documents → search_documents     (2 steps)
"delete leave-policy.md"           → list_documents → delete_document      (2 steps)
```

Always the same shape — resolve a name, call one function. `list_documents` and
`describe_document` in particular are CRUD wrappers; a `switch` on the intent
classifier would do the same job.

Phase 16 authoring is the first task that escapes this. Its step count varies
with the corpus rather than the command, it chooses between searching and
reading based on what scores well, and it abandons the plan when the material
isn't there. That is why `MAX_AGENT_STEPS` went from 6 to 10 — command tasks
never needed more than 2.

Three things here *are* genuinely model-driven, and they are the floor rather
than the ceiling:

1. **The model derives the order.** Nothing in the code says "call
   `list_documents` before `summarize_document`." The prompt states a constraint
   and the model works out the sequence.
2. **Errors cause re-planning.** When `resolveDocument()` returns `ambiguous`,
   the agent abandons its plan and asks a question instead. That branch exists
   nowhere in our control flow — the tool returns a fact, the model decides.
3. **It drives a procedure across turns.** The two-phase delete is not enforced
   by code (`confirmed: true` would work if sent); it holds because the model
   tracks where it is in a stated procedure.

## Roadmap — what would make it actually agentic

The test for each: *we cannot say in advance how many steps it will take.*

Note the structural critique these share. Today the `action` branch is
agentic-shaped but trivial, while `document_question` — where the hard reasoning
lives — is a fixed pipeline with no agency at all. The interesting work is on the
wrong side of the router.

1. **Self-correcting retrieval (highest value).** Retrieval is currently one
   shot: if the hits are weak we give up and ask a clarifying question. A
   researcher instead notices the search was bad and searches *differently*.

   ```
   Q: "what's our policy on INV-2024-8891 disputes?"

   search("INV-2024-8891 disputes")             → best score 0.12   ← weak
     ↳ model reads the scores, concludes the query was wrong
   search("invoice dispute resolution process")  → 0.61             ← good
   search("chargeback escalation", doc=finance-policy)              ← narrowing
   synthesise + cite
   ```

   Steps 2–3 exist *only because step 1 failed*. This is the published
   CRAG / Self-RAG pattern, and it directly mitigates the dense-retrieval
   weakness below — the agent recovers from exact-ID queries that embeddings
   handle badly, without us building hybrid search. It also turns
   `MIN_CONFIDENCE_SCORE` from a hardcoded threshold into a feedback signal the
   model reasons about.

2. **Multi-hop questions.** "Who approves leave over 10 days, and what is their
   email?" — hop 2's query is contained in hop 1's answer, so it cannot be
   pre-planned. One-shot retrieval fails this today.

3. **Cross-document reasoning.** "Does the vendor contract contradict our
   security policy on data retention?" The agent cannot know how many documents
   are relevant until it looks; step count scales with the corpus, not the
   question.

4. ~~**Actions that produce, not just fetch.**~~ Shipped in Phase 16 — see
   *Document authoring* above. Still open in this direction: autonomous
   maintenance ("find stale or duplicated documents and propose removals"),
   which needs the agent to sample, compare, judge and justify across the whole
   corpus rather than work from a named target.

## Known gaps

Stated explicitly so nobody mistakes the demo for the finished system.

- **No evaluation harness.** No golden Q&A set, no recall@k, faithfulness or
  citation-accuracy measurement, and no measurement of whether the agent picks
  the right tool or writes a good document. The authoring guards above were
  found by hand-testing, which is exactly the argument for building this. Every tuned value — `chunkSize` 1000, `topK` 8, the 0.25
  confidence threshold — is reasoned rather than measured. Highest-value thing
  to add next.
- **Dense retrieval only.** No sparse/BM25 or hybrid search, so exact tokens
  (invoice IDs, error codes, SKUs, rare proper nouns) retrieve poorly.
- **No durable agent state.** No checkpointer, so no true `interrupt()` and no
  multi-device memory; history is sent by the client each turn.
- **No OCR.** Scanned/image-only PDFs are rejected with a clear error.
- **`listDocuments()` scans by ID prefix** — O(chunks) list calls. Fine for
  hundreds of documents; past that it wants a real documents table.
- **Rate limiting is in-memory** and therefore per-instance (see Deployment).
- **No auth or multi-tenancy.** Every user sees every document.
- **Uploads are not de-duplicated.** `create_document` refuses to duplicate a
  title, but uploading the same file twice still creates two documents. Observed
  during testing, when the agent then correctly refused to guess which was meant.
- **Exporting an upload is lossy.** Only extracted text was ever stored, so a
  re-exported PDF has no original layout, images or tables (`X-Export-Exact:
  false`). Exports of assistant-authored documents are exact.
- **Document listing is eventually consistent.** Immediately after a delete,
  Pinecone's ID listing can still return the removed vectors, which surfaces
  briefly as a `(unknown)` row in the library. It resolves on the next load.
- **Generated documents are retrievable like any other.** They are flagged
  everywhere, and the model is told to prefer human-uploaded sources, but nothing
  *prevents* an answer being grounded in assistant-authored text. A stricter
  policy (exclude generated chunks from retrieval unless asked) is a one-line
  metadata filter in `semanticSearch` if you want it.

## Development notes

- **`yarn typecheck` can report a false pass.** `tsconfig.json` sets
  `incremental: true`, so a stale `tsconfig.tsbuildinfo` can mask errors that
  `next build` still fails on. Run `rm -f tsconfig.tsbuildinfo` before trusting a
  clean typecheck.
- **`TS2589: Type instantiation is excessively deep`** recurs wherever Zod meets
  this `@langchain/core` version — both `withStructuredOutput` and
  `DynamicStructuredTool`. It is a compile-time inference blow-up only; runtime
  is unaffected. Fixes in use: an explicit generic for structured output, and a
  single `defineTool()` choke point in `langchain/tools.ts` for tools.
- **Node-only libraries must be listed in `serverExternalPackages`**
  (`next.config.mjs`): `pdf-parse`, `mammoth` and `pdfkit`. pdfkit in particular
  loads its built-in font metrics from disk at runtime, which a bundler would
  rewrite and break. Symptoms are a build that succeeds and a route that 500s.
- **Don't interleave `yarn build` and `yarn dev`** on the same `.next/`
  directory — incremental state corrupts (ENOENT on `route.js` → 500s).
  `rm -rf .next` when switching.

## Deployment

### Vercel (easiest)
1. Push to GitHub, import the repo in Vercel.
2. Add env vars (`OPENAI_API_KEY`, `PINECONE_API_KEY`, `PINECONE_INDEX`, …) under
   Project Settings → Environment Variables.
3. Deploy. API routes run on the Node.js runtime (required by the PDF/DOCX parsers).

> The in-memory rate limiter is per-instance. For multi-instance/serverless
> production, back it with Upstash/Redis (swap `lib/rate-limit.ts`).

### Docker (self-host)
```bash
docker build -t rag-agent .
docker run -p 3000:3000 --env-file .env.local rag-agent
```
Uses `output: "standalone"` for a minimal image; env vars are injected at runtime,
never baked in.
