// M0 spike 2 (throwaway): stub executor MCP server (DR-0006 shape) behind a bearer-token + Host check
// (DR-0005). Transport-agnostic: `handle(Request) -> Response`, so it runs in-process (injected fetch)
// or behind node:http (serve()).
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const MACHINES = { workstation: { doe: false }, bebop: { doe: true } };

const TOOLS = [
  {
    name: "jobs.submit",
    title: "Submit job",
    description:
      "Submit experiments/EXP-NNN/job.* from the agent's worktree to a target machine. Never runs immediately: a human approves first. Returns a request id to poll with jobs.status.",
    inputSchema: {
      type: "object",
      properties: {
        experiment: { type: "string", description: "Experiment name like EXP-001 (a name, not a path)" },
        target: { type: "string", enum: Object.keys(MACHINES) },
      },
      required: ["experiment", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "jobs.status",
    title: "Job status",
    description: "Status of a submission request or job.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
      additionalProperties: false,
    },
  },
];

const text = (s, structured, isError = false) => ({
  content: [{ type: "text", text: s }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError: true } : {}),
});

/**
 * @param {{ token: string, allowedHosts?: string[] }} opts  token = per-session bearer token issued by the engine
 */
export function createExecutorStub({ token, allowedHosts = ["127.0.0.1", "localhost"] }) {
  const audit = []; // DR-0006: every action appended (engine/audit.log in the real thing)
  const requests = new Map(); // request_id -> { experiment, target, status, job_id? }
  const sessions = new Map(); // mcp-session-id -> transport
  let seq = 0;
  const log = (event, data = {}) => audit.push({ ts: new Date().toISOString(), event, ...data });

  function mcpServer() {
    const server = new Server({ name: "cairn-executor-stub", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      log("tool_call", { name, args });
      if (name === "jobs.submit") {
        // Lint (DR-0006 step 2): names not paths, known machines only.
        if (!/^EXP-\d{3}$/.test(String(args.experiment))) {
          log("lint_reject", { reason: "experiment must be a name like EXP-001" });
          return text(`rejected: experiment must be a name like EXP-001, got ${JSON.stringify(args.experiment)}`, null, true);
        }
        if (!(args.target in MACHINES)) return text(`rejected: unknown target ${JSON.stringify(args.target)}`, null, true);
        // Approval lives inside the tool (DR-0004 seam 5): never auto-approved here; DOE never auto-approved.
        const request_id = `REQ-${++seq}`;
        requests.set(request_id, { experiment: args.experiment, target: args.target, status: "pending_approval" });
        log("approval_requested", { request_id, doe: MACHINES[args.target].doe });
        return text(
          `submitted for approval: ${request_id} (${args.experiment} on ${args.target}). A human must approve it; poll jobs.status.`,
          { request_id, status: "pending_approval" },
        );
      }
      if (name === "jobs.status") {
        const r = requests.get(String(args.request_id));
        if (!r) return text(`unknown request ${JSON.stringify(args.request_id)}`, null, true);
        return text(`${args.request_id}: ${r.status}${r.job_id ? ` (job ${r.job_id})` : ""}`, { request_id: args.request_id, ...r });
      }
      return text(`unknown tool ${name}`, null, true);
    });
    return server;
  }

  const deny = (status, reason, extra = {}) => {
    log("http_reject", { status, reason }); // escape attempts are logged (DR-0005); token values never are
    return new Response(JSON.stringify({ error: reason }), {
      status,
      headers: { "content-type": "application/json", ...extra },
    });
  };

  function tokenOk(header) {
    const m = /^Bearer (.+)$/.exec(header ?? "");
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Web-standard handler: auth + Host check, then hand to the session's MCP transport. */
  async function handle(request) {
    const url = new URL(request.url);
    if (!allowedHosts.includes(url.hostname)) return deny(403, `host not allowed: ${url.hostname}`);
    if (url.pathname !== "/mcp") return deny(404, "not found");
    if (!request.headers.get("authorization")) return deny(401, "missing bearer token", { "www-authenticate": "Bearer" });
    if (!tokenOk(request.headers.get("authorization"))) return deny(401, "invalid bearer token", { "www-authenticate": 'Bearer error="invalid_token"' });

    const sid = request.headers.get("mcp-session-id");
    let transport = sid ? sessions.get(sid) : undefined;
    if (sid && !transport) return deny(404, "unknown session");
    if (!transport) {
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          log("session_open", { session: id });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          log("session_close", { session: id });
        },
      });
      await mcpServer().connect(transport);
    }
    return transport.handleRequest(request);
  }

  /** Out-of-band human approval (the app's approval inbox / `re` CLI in the real thing). */
  function approve(request_id) {
    const r = requests.get(request_id);
    if (!r) throw new Error(`unknown request ${request_id}`);
    r.status = "approved";
    r.job_id = `JOB-${request_id.slice(4)}`;
    log("approved", { request_id, by: "user" });
  }

  async function close() {
    for (const t of sessions.values()) await t.close();
    sessions.clear();
  }

  return { handle, approve, audit, requests, close };
}

/** Serve a stub on a real loopback socket (needs local port binding). */
export function serve(stub, port = 0, host = "127.0.0.1") {
  const srv = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const x of [v].flat()) if (x !== undefined) headers.append(k, x);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await stub.handle(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    res.on("close", () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      res.write(value);
    }
    res.end();
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve({ url: `http://${host}:${srv.address().port}/mcp`, close: () => new Promise((r) => srv.close(r)) }));
  });
}
