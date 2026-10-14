// Executor tools for an agent (DR-0004 seam 4): the engine connects to the executor's MCP endpoint with a
// per-run bearer token and wraps each MCP tool as an AgentTool. The token lives only in this client transport —
// never in the container, the tool arguments, or the model's context (spike 2 F1).
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { createExecutorEndpoint, type ExecutorSession, type JobService } from "@cairn/executor";
import { ENGINE_VERSION } from "../version.js";

/** Provider tool names allow only [A-Za-z0-9_-]{1,64} (spike 2 F3): jobs.submit -> mcp_jobs_submit. */
export const agentToolName = (mcpName: string) => `mcp_${mcpName}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

export interface ExecutorTools {
  tools: AgentTool[];
  /** Agent tool name -> MCP tool name (logged with every call). */
  names: Map<string, string>;
  close(): Promise<void>;
}

/** Long enough for an upload or a fetch over a slow link; the executor's own timeouts are shorter. */
const REQUEST_TIMEOUT_MS = 15 * 60_000;

export async function connectExecutorTools(service: JobService, session: ExecutorSession): Promise<ExecutorTools> {
  const token = randomBytes(32).toString("base64url");
  const endpoint = createExecutorEndpoint({ service, session, token });
  const client = new McpClient({ name: "cairn-engine", version: ENGINE_VERSION, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  try {
    await client.connect(
      new StreamableHttpTransport({ url: "http://127.0.0.1/mcp", headers: { authorization: `Bearer ${token}` }, fetch: (input, init) => endpoint.fetch(input, init) }),
    );
    const names = new Map<string, string>();
    const tools: AgentTool[] = (await client.listTools()).map((tool) => {
      const name = agentToolName(tool.name);
      names.set(name, tool.name);
      return {
        name,
        label: tool.title ?? tool.name,
        description: tool.description ?? tool.name,
        parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {} }),
        execute: async (_id, params, signal) => {
          const r = await client.callTool(tool.name, params as Record<string, unknown>, { ...(signal ? { signal } : {}) });
          if (r.isError === true) throw new Error(toLlmContent(r).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"));
          return { content: toLlmContent(r), details: {} };
        },
      };
    });
    return {
      tools,
      names,
      close: async () => {
        await client.close().catch(() => {});
        await endpoint.close();
      },
    };
  } catch (e) {
    await client.close().catch(() => {});
    await endpoint.close();
    throw e;
  }
}
