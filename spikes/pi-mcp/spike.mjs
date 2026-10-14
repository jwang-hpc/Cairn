// M0 spike 2 (throwaway): pi-mcp client <-> stub executor over Streamable HTTP with a bearer token.
//   node spike.mjs            # in-process: real Streamable HTTP protocol via an injected fetch (no socket)
//   node spike.mjs --socket   # real loopback socket (needs local port binding)
//   node spike.mjs --live     # also let real models (subscription logins from spikes/pi-auth) call the MCP tool
import { randomBytes } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { McpAuthRequiredError, McpClient, McpHttpError, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { createExecutorStub, serve } from "./executor-stub.mjs";

const SOCKET = process.argv.includes("--socket");
const token = randomBytes(32).toString("base64url"); // per-session token issued by the engine (DR-0005)
const stub = createExecutorStub({ token });

let base = "http://127.0.0.1/mcp";
let server;
if (SOCKET) {
  server = await serve(stub);
  base = server.url;
}
const fetchFor = SOCKET ? undefined : (input, init) => stub.handle(new Request(input, init));

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: `${e?.constructor?.name}: ${e?.message}` });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

function connect({ headers = {}, url = base } = {}) {
  const client = new McpClient({ name: "cairn-engine-spike", version: "0.0.0" });
  const transport = new StreamableHttpTransport({ url, headers, ...(fetchFor ? { fetch: fetchFor } : {}) });
  return { client, connected: client.connect(transport) };
}

async function expectRejected(opts, status) {
  const { client, connected } = connect(opts);
  try {
    await connected;
  } catch (e) {
    await client.close().catch(() => {});
    assert(e instanceof McpHttpError && e.status === status, `expected HTTP ${status}, got ${e?.constructor?.name} ${e?.status ?? ""} ${e?.message}`);
    return `${e.constructor.name} ${e.status}${e instanceof McpAuthRequiredError ? " (McpAuthRequiredError)" : ""}`;
  }
  await client.close();
  throw new Error("connected without valid credentials");
}

// 1. Rejections first (escape-test precursors): nothing reaches MCP without the token.
await check("no token -> 401", () => expectRejected({}, 401));
await check("wrong token -> 401", () => expectRejected({ headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` } }, 401));
if (!SOCKET) {
  await check("foreign Host -> 403 (DNS-rebinding guard)", () =>
    expectRejected({ url: "http://attacker.example/mcp", headers: { authorization: `Bearer ${token}` } }, 403),
  );
}

// 2. Authorized session.
const { client, connected } = connect({ headers: { authorization: `Bearer ${token}` } });
let tools = [];
await check("connect with token (initialize)", async () => {
  const init = await connected;
  return `server ${init.serverInfo.name}, protocol ${init.protocolVersion}`;
});
await check("tools/list", async () => {
  tools = await client.listTools();
  const names = tools.map((t) => t.name);
  assert(names.includes("jobs.submit") && names.includes("jobs.status"), `got ${names}`);
  return names.join(", ");
});

// 3. Tool calls: lint, approval inside the tool, out-of-band approval.
let requestId;
await check("jobs.submit lint rejects a path instead of a name", async () => {
  const r = await client.callTool("jobs.submit", { experiment: "../../etc/passwd", target: "workstation" });
  assert(r.isError === true, "expected isError");
  return r.content[0].text;
});
await check("jobs.submit -> pending approval (approval inside the tool)", async () => {
  const r = await client.callTool("jobs.submit", { experiment: "EXP-001", target: "workstation" });
  assert(!r.isError && r.structuredContent?.status === "pending_approval", JSON.stringify(r));
  requestId = r.structuredContent.request_id;
  return r.content[0].text;
});
await check("out-of-band approval -> jobs.status approved", async () => {
  stub.approve(requestId);
  const r = await client.callTool("jobs.status", { request_id: requestId });
  assert(r.structuredContent?.status === "approved", JSON.stringify(r.structuredContent));
  return r.content[0].text;
});

// 4. MCP tools as pi-agent-core AgentTools (DR-0004 seam 4), driven by a scripted (faux) model.
await check("pi-agent-core agent calls an MCP tool", async () => {
  const agentTools = tools.map((tool) => ({
    name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
    execute: async (_id, params, signal) => {
      const result = await client.callTool(tool.name, params, { signal });
      return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
    },
  }));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", reasoning: false }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mcp_jobs_submit", { experiment: "EXP-002", target: "bebop" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Submitted EXP-002 to bebop; waiting for your approval.")]),
  ]);
  const agent = new Agent({
    initialState: { systemPrompt: "Use the executor tools.", model: faux.getModel(), tools: agentTools },
    streamFn: models.streamSimple.bind(models),
  });
  await agent.prompt("Submit EXP-002 to bebop.");
  const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
  assert(toolResult && !toolResult.isError, `tool result: ${JSON.stringify(toolResult)}`);
  const call = stub.audit.find((a) => a.event === "tool_call" && a.args?.experiment === "EXP-002");
  assert(call, "executor never saw the call");
  return `tool names: ${agentTools.map((t) => t.name).join(", ")}; result: ${toolResult.content[0].text}`;
});

// 4b. Real models: do providers accept these MCP tool schemas and call them correctly?
if (process.argv.includes("--live")) {
  const { makeModels } = await import("../pi-auth/lib.mjs");
  const live = makeModels("oauth");
  for (const [provider, modelId] of [["anthropic", "claude-haiku-5-5"], ["openai-codex", "gpt-6.1-sol"]]) {
    await check(`live ${provider}/${modelId} calls the MCP tool`, async () => {
      const before = stub.audit.filter((a) => a.event === "tool_call").length;
      const agentTools = tools.map((tool) => ({
        name: `mcp_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
        label: tool.title ?? tool.name,
        description: tool.description ?? tool.name,
        parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
        execute: async (_id, params, signal) => {
          const result = await client.callTool(tool.name, params, { signal });
          return { content: toLlmContent(result), details: undefined, isError: result.isError === true };
        },
      }));
      const agent = new Agent({
        initialState: { systemPrompt: "You operate the lab executor through tools. Be brief.", model: live.getModel(provider, modelId), tools: agentTools },
        streamFn: live.streamSimple.bind(live),
      });
      await agent.prompt("Submit experiment EXP-003 to the workstation, then tell me the request id.");
      const last = agent.state.messages.at(-1);
      const err = last?.errorMessage;
      assert(!err, `model error: ${err}`);
      const calls = stub.audit.filter((a) => a.event === "tool_call").slice(before);
      assert(calls.some((c) => c.name === "jobs.submit" && c.args?.experiment === "EXP-003" && c.args?.target === "workstation"), `calls: ${JSON.stringify(calls)}`);
      const answer = last.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      assert(/REQ-\d+/.test(answer), `answer lacks request id: ${answer}`);
      return `called ${calls.map((c) => c.name).join(", ")}; answered: ${answer.slice(0, 80)}`;
    });
  }
}

// 5. Clean shutdown (DELETE ends the session server-side).
await check("close session", async () => {
  await client.close();
  await new Promise((r) => setTimeout(r, 50));
  assert(stub.audit.some((a) => a.event === "session_close"), "server never saw the session close");
  return "session closed";
});

await stub.close();
await server?.close();

console.log(`\nM0 spike 2 — pi-mcp over Streamable HTTP (${SOCKET ? `socket ${base}` : "in-process via injected fetch"})\n`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log("\naudit (server side, no secrets):");
for (const a of stub.audit) console.log(`  ${a.event}${a.status ? ` ${a.status}` : ""}${a.reason ? ` — ${a.reason}` : ""}${a.name ? ` ${a.name}` : ""}`);
console.log(`\ntoken leaked into audit: ${JSON.stringify(stub.audit).includes(token) ? "YES (bad)" : "no"}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
