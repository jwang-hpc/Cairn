// M0 spike 1 (throwaway): minimal pi-agent-core loop with one tool, to confirm auth works beyond
// single calls (multi-turn, tool round-trip, token reuse).
//   node agent.mjs <anthropic|openai> <oauth|api_key> <model-id> [effort]
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { logCall, makeModels } from "./lib.mjs";

const [provider, kind, modelId, effort = "low"] = process.argv.slice(2);
if (!provider || !kind || !modelId) {
  console.error("usage: node agent.mjs <anthropic|openai> <oauth|api_key> <model-id> [effort]");
  process.exit(2);
}

const models = makeModels(kind);
const model = models.getModel(provider, modelId);
if (!model) { console.error(`unknown model ${provider}/${modelId}`); process.exit(1); }

let toolCalls = 0;
const addTool = {
  name: "add",
  label: "Add",
  description: "Add two integers and return the sum.",
  parameters: Type.Object({ a: Type.Integer(), b: Type.Integer() }),
  execute: async (_id, { a, b }) => {
    toolCalls++;
    return { content: [{ type: "text", text: String(a + b) }], details: { a, b } };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a terse assistant. Always use tools for arithmetic.",
    model,
    thinkingLevel: effort,
    tools: [addTool],
  },
  streamFn: models.streamSimple.bind(models),
});

const turns = [];
agent.subscribe(async (e) => {
  if (e.type === "message_end" && e.message.role === "assistant") {
    const m = e.message;
    turns.push(m);
    await logCall({
      spike: "pi-auth/agent", provider, model: modelId, auth: kind, effort,
      stopReason: m.stopReason, error: m.errorMessage ?? null,
      usage: { input: m.usage?.input, output: m.usage?.output, costUsd: m.usage?.cost?.total },
    });
  }
});

await agent.prompt("Use the add tool to compute 17 + 25, then reply with only the number.");

const last = turns.at(-1);
const answer = last?.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
const errors = turns.filter((t) => t.errorMessage).map((t) => t.errorMessage);
console.log(`turns=${turns.length} toolCalls=${toolCalls} answer=${JSON.stringify(answer)}`);
if (errors.length) console.log(`errors: ${errors.join(" | ")}`);
const pass = toolCalls >= 1 && answer?.includes("42") && !errors.length;
console.log(pass ? "PASS" : "FAIL");
process.exitCode = pass ? 0 : 1;
