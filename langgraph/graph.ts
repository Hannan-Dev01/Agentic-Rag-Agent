import { StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { GraphState, type GraphStateType } from "@/langgraph/state";
import {
  classifyIntentNode,
  retrieveNode,
  rerankNode,
  generateNode,
  clarifyNode,
  directNode,
  agentNode,
  toolsNode,
  agentRouter,
} from "@/langgraph/nodes";
import type { HistoryTurn } from "@/types";

/**
 * PHASE 8 — THE GRAPH
 *
 * Flow (matches the design diagram):
 *
 *   START
 *     └─ classifyIntent
 *          ├─ action ──────────────► agent ⇄ tools ─────────► END
 *          ├─ chitchat/meta ───────► direct ────────────────► END
 *          └─ document_question ──► retrieve ─► rerank
 *                                  ├─ confident? ── no ─► clarify ─► END
 *                                  └─ yes ────────────► generate ─► END
 *
 * PHASE 15 added the `agent` branch, and note what it did NOT change: the
 * document-question path is byte-for-byte what it was. That was the whole point
 * of adding agency as a BRANCH rather than replacing the pipeline with one big
 * agent loop. Questions keep their deterministic retrieve → rerank → confidence
 * gate (predictable cost, the clarify safety net, reproducible answers); only
 * genuinely open-ended "do something for me" requests get model discretion, and
 * they get it inside a step budget.
 *
 * EDGES come in two kinds:
 *  - addEdge(A, B): unconditional "after A, go to B".
 *  - addConditionalEdges(A, fn, map): CONDITIONAL routing — fn(state) returns a
 *    key, map turns it into the next node. This is how the graph branches on
 *    intent (retrieve vs. direct) and on confidence (generate vs. clarify).
 *
 * On "clarify" (the diagram's "ask user & wait"): we END the turn with a
 * clarifying question. The user's next message re-enters the graph WITH the prior
 * turn in `history` — that's the "wait for response, then continue" at the app
 * level, kept stateless. A durable pause would add a checkpointer + interrupt.
 */
function buildGraph() {
  const workflow = new StateGraph(GraphState)
    .addNode("classifyIntent", classifyIntentNode)
    .addNode("retrieve", retrieveNode)
    .addNode("rerank", rerankNode)
    .addNode("generate", generateNode)
    .addNode("clarify", clarifyNode)
    .addNode("direct", directNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "classifyIntent")
    .addConditionalEdges(
      "classifyIntent",
      (s: GraphStateType) =>
        s.intent === "action" ? "agent" : s.needsRetrieval ? "retrieve" : "direct",
      { agent: "agent", retrieve: "retrieve", direct: "direct" },
    )
    .addEdge("retrieve", "rerank")
    .addConditionalEdges(
      "rerank",
      (s: GraphStateType) => (s.needsClarification ? "clarify" : "generate"),
      { clarify: "clarify", generate: "generate" },
    )
    .addEdge("generate", END)
    .addEdge("clarify", END)
    .addEdge("direct", END)
    // The agent loop. `tools` always returns to `agent` so the model can read
    // what its tools returned — that unconditional back-edge is what makes this
    // a cycle rather than a pipeline, and cycles are the thing LangGraph exists
    // for that plain LCEL chains cannot express.
    .addConditionalEdges("agent", agentRouter, { tools: "tools", end: END })
    .addEdge("tools", "agent");

  return workflow.compile();
}

/** Compile once and reuse (compilation validates the graph topology). */
let compiled: ReturnType<typeof buildGraph> | null = null;
export function getGraph() {
  if (!compiled) compiled = buildGraph();
  return compiled;
}

/**
 * The initial state for one question.
 *
 * `messages` seeds the agent branch's scratchpad with the user's question. It
 * belongs here rather than inside agentNode because messages written by a node
 * are re-emitted by the "messages" stream mode — seeding it in the node streamed
 * the question back to the UI ahead of the answer. Graph INPUT isn't re-emitted.
 * The other branches simply never read this channel.
 */
export function initialState(input: {
  question: string;
  history?: HistoryTurn[];
  documentId?: string;
}) {
  return {
    question: input.question,
    history: input.history ?? [],
    documentId: input.documentId,
    messages: [new HumanMessage(input.question)],
  };
}

/** Non-streaming run — used by tests and as a fallback. Returns the final state. */
export async function runChat(input: {
  question: string;
  history?: HistoryTurn[];
  documentId?: string;
}): Promise<GraphStateType> {
  return getGraph().invoke(initialState(input));
}
