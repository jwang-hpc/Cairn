// Executor tools for an agent (DR-0004 seam 4): the engine connects to the executor's MCP endpoint with a
// per-run bearer token and wraps each MCP tool as an AgentTool. The token lives only in this client transport —
// never in the container, the tool arguments, or the model's context (spike 2 F1).
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { createExecutorEndpoint, type ExecutorSession, type JobFileContent, JobError, type JobService, LIMITS } from "@cairn/executor";
import { EXPERIMENT_PATTERN } from "@cairn/shared";
import { ENGINE_VERSION } from "../version.js";
import type { ContainerExec } from "./confined.js";

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

/** Walks experiments/<name>/ inside the container: no symlinks, regular files only, bounded. */
const READER = (name: string) => `import base64, json, os, stat, sys
NAME = ${JSON.stringify(name)}
MAX_FILES, MAX_BYTES = ${LIMITS.files * 2}, ${LIMITS.totalBytes * 2}
def out(o):
    sys.stdout.write(json.dumps(o)); sys.exit(0)
base = "/work/experiments"; root = os.path.join(base, NAME)
for p in (base, root):
    try: st = os.lstat(p)
    except FileNotFoundError: out({"error": "no experiments/%s/ in the worktree" % NAME})
    if not stat.S_ISDIR(st.st_mode): out({"error": "%s is not a directory (symlinks are not followed)" % os.path.relpath(p, "/work")})
files, total = [], 0
for d, dirs, names in os.walk(root, followlinks=False):
    dirs.sort()
    for n in dirs + sorted(names):
        p = os.path.join(d, n); rel = os.path.relpath(p, root); st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode): out({"error": "experiments/%s/%s is a symlink; job files must be regular files" % (NAME, rel)})
        if stat.S_ISDIR(st.st_mode): continue
        if not stat.S_ISREG(st.st_mode): out({"error": "experiments/%s/%s is not a regular file" % (NAME, rel)})
        total += st.st_size
        if len(files) >= MAX_FILES or total > MAX_BYTES: out({"error": "experiments/%s/ is too large for a job" % NAME})
        with open(p, "rb") as fh: files.append({"path": rel, "b64": base64.b64encode(fh.read()).decode()})
out({"files": files})
`;

/**
 * Reads an agent's experiments/<name>/ inside its own sandbox for jobs.submit. Only the worktree is mounted there
 * (DR-0005), so a symlink the agent plants — or swaps in while we read — can't reach host files.
 */
export function sandboxExperimentReader(exec: ContainerExec): (experiment: string) => Promise<JobFileContent[]> {
  return async (experiment) => {
    if (!new RegExp(EXPERIMENT_PATTERN).test(experiment)) throw new JobError(`experiment must be a name like EXP-001, not ${JSON.stringify(experiment)}`);
    const r = await exec(["python3", "-"], { input: READER(experiment), timeoutMs: 120_000, maxOutputBytes: 32 << 20 });
    if (r.code !== 0 || r.truncated) throw new JobError(`could not read experiments/${experiment}/ in the sandbox: ${r.truncated ? "output too large" : (r.stderr || r.stdout).trim().slice(-300)}`);
    let parsed: { error?: string; files?: { path: string; b64: string }[] };
    try {
      parsed = JSON.parse(r.stdout) as typeof parsed;
    } catch {
      throw new JobError(`could not read experiments/${experiment}/ in the sandbox: unexpected output`);
    }
    if (parsed.error) throw new JobError(parsed.error);
    return (parsed.files ?? []).map((f) => ({ path: String(f.path), content: Buffer.from(String(f.b64), "base64") }));
  };
}
