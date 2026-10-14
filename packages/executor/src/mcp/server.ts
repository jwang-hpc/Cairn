// The executor's MCP server for one agent session (DR-0006, DR-0004 seam 4). The session fixes the project, the
// worktree, the author, and which tools the role may use (roles.yaml executor_tools); each tool set (jobs.*,
// literature.*) contributes its tools, and every call, allowed or refused, is audited. No MCP tool can approve
// anything (seam 5). The server sits behind the authenticated front (bearer token, Host, path).
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { EffortLevel } from "@cairn/shared";
import { createFront } from "../front.js";
import type { AuditLog } from "../jobs/audit.js";
import type { JobFileContent } from "../jobs/lint.js";

export interface ExecutorSession {
  project: string;
  /** Host path of the agent's worktree (never sent to the model). */
  worktree: string;
  branch?: string;
  agent: { run: string; agent: string; role: string; model: string; effort: EffortLevel };
  /** roles.yaml executor_tools for the agent's role. */
  tools: readonly string[];
  /** Reads experiments/<name>/ inside the agent's sandbox (see SubmitRequest.read). */
  read?: (experiment: string) => Promise<JobFileContent[]>;
  /** Adds a verified reference to lit/refs.bib inside the agent's sandbox (literature.resolve). */
  recordReference?: (ref: ReferenceWrite) => Promise<ReferenceWritten>;
}

/** A resolved reference for lit/refs.bib, and its line in lit/resolutions.jsonl. */
export interface ReferenceWrite {
  /** Citekey the BibTeX was rendered with; a suffix (a, b, …) is added if another work already has it. */
  key: string;
  bibtex: string;
  /** Identity of the work: an entry with the same DOI or arXiv id is the same reference. */
  ids: { doi?: string; arxiv?: string };
  log: Record<string, unknown>;
}

export interface ReferenceWritten {
  status: "added" | "exists";
  key: string;
}

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

export interface ToolSet {
  defs: readonly ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Errors whose message is meant for the agent; anything else is reported as an executor error. */
  expected(e: unknown): boolean;
}

export interface ExecutorMcp {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export function createExecutorMcp(sets: readonly ToolSet[], session: ExecutorSession, audit: AuditLog): ExecutorMcp {
  const owner = new Map<string, ToolSet>();
  for (const s of sets) for (const d of s.defs) if (session.tools.includes(d.name)) owner.set(d.name, s);
  const defs = sets.flatMap((s) => s.defs).filter((d) => owner.has(d.name));
  const actor = `agent:${session.agent.agent}`;
  const record = (tool: string, okFlag: boolean, detail: string) => audit.append({ actor, project: session.project, action: `tool ${tool}`, ok: okFlag, detail });

  function server(): Server {
    const s = new Server({ name: "cairn-executor", version: "0.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args = {} } = req.params;
      const set = owner.get(name);
      if (!set) {
        await record(name, false, `not allowed for role ${session.agent.role}`);
        return fail(`${name} is not available to the ${session.agent.role} role`);
      }
      try {
        const r = await set.call(name, args);
        await record(name, r.isError !== true, JSON.stringify(args));
        return r;
      } catch (e) {
        await record(name, false, `${JSON.stringify(args)}: ${(e as Error).message}`);
        return fail(set.expected(e) ? (e as Error).message : `executor error: ${(e as Error).message}`);
      }
    });
    return s;
  }

  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  return {
    async handle(request) {
      const sid = request.headers.get("mcp-session-id");
      let transport = sid ? sessions.get(sid) : undefined;
      if (sid && !transport) return new Response(JSON.stringify({ error: "unknown session" }), { status: 404, headers: { "content-type": "application/json" } });
      if (!transport) {
        const t = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, t),
          onsessionclosed: (id) => void sessions.delete(id),
        });
        await server().connect(t);
        transport = t;
      }
      return transport.handleRequest(request);
    },
    async close() {
      for (const t of sessions.values()) await t.close();
      sessions.clear();
    },
  };
}

/**
 * One agent's executor endpoint: the authenticated front (per-session bearer token, Host, path) in front of its
 * MCP server. In-process: `fetch` goes straight to the front, no socket (spike 2 F5); serveFront() can put the same
 * front on a loopback port later.
 */
export function createEndpoint(opts: { mcp: ExecutorMcp; audit: AuditLog; project: string; token: string }): {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
} {
  const front = createFront({
    token: opts.token,
    handler: (r) => opts.mcp.handle(r),
    onAudit: (e) => {
      if (e.event === "reject") {
        void opts.audit.append({ actor: "http", project: opts.project, action: "http", ok: false, detail: `${e.status} ${e.reason} (${e.method} ${e.path})` }).catch(() => {});
      }
    },
  });
  return {
    fetch: (input, init) => front.handle(input instanceof Request ? input : new Request(input, init)),
    close: () => opts.mcp.close(),
  };
}
