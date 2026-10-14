// Executor tools for an agent (DR-0004 seam 4): the engine connects to the executor's MCP endpoint with a
// per-run bearer token and wraps each MCP tool as an AgentTool. The token lives only in this client transport —
// never in the container, the tool arguments, or the model's context (spike 2 F1).
import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import {
  type AuditLog,
  createExecutorEndpoint,
  type ExecutorSession,
  type JobFileContent,
  JobError,
  type JobService,
  LIMITS,
  LitError,
  type LiteratureService,
  type ReferenceWrite,
  type ReferenceWritten,
} from "@cairn/executor";
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

export interface ExecutorServices {
  jobs?: JobService;
  literature?: LiteratureService;
  /** Default: the jobs service's audit log. */
  audit?: AuditLog;
}

export async function connectExecutorTools(services: ExecutorServices, session: ExecutorSession): Promise<ExecutorTools> {
  const token = randomBytes(32).toString("base64url");
  const endpoint = createExecutorEndpoint({ ...services, session, token });
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

/** Adds a reference to lit/ inside the container: no symlinks followed, regular files only, append-only. */
const REFERENCE_WRITER = (req: ReferenceWrite) => `import base64, json, os, re, stat, sys
REQ = json.loads(base64.b64decode("${Buffer.from(JSON.stringify(req)).toString("base64")}").decode("utf-8"))
def out(o):
    sys.stdout.write(json.dumps(o)); sys.exit(0)
base = "/work/lit"
try: st = os.lstat(base)
except FileNotFoundError: out({"error": "there is no lit/ in your workspace"})
if not stat.S_ISDIR(st.st_mode): out({"error": "lit/ is not a directory (symlinks are not followed)"})
def path(name):
    p = os.path.join(base, name)
    try: st = os.lstat(p)
    except FileNotFoundError: return p, None
    if not stat.S_ISREG(st.st_mode): out({"error": "lit/%s is not a regular file (symlinks are not followed)" % name})
    if st.st_size > ${4 << 20}: out({"error": "lit/%s is too large" % name})
    return p, st
def read(name):
    p, st = path(name)
    if st is None: return ""
    with os.fdopen(os.open(p, os.O_RDONLY | os.O_NOFOLLOW), "r", encoding="utf-8", errors="replace") as fh: return fh.read()
def append(name, text):
    p, _ = path(name)
    with os.fdopen(os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o644), "a", encoding="utf-8") as fh: fh.write(text)
bib = read("refs.bib")
heads = list(re.finditer(r"@\\w+\\s*\\{\\s*([^,\\s]+)\\s*,", bib))
keys = set()
for i, m in enumerate(heads):
    keys.add(m.group(1))
    body = bib[m.end():heads[i + 1].start() if i + 1 < len(heads) else len(bib)]
    doi = re.search(r"\\bdoi\\s*=\\s*\\{([^}]*)\\}", body, re.I)
    ep = re.search(r"\\beprint\\s*=\\s*\\{([^}]*)\\}", body, re.I)
    if (REQ["ids"].get("doi") and doi and doi.group(1).strip().lower() == REQ["ids"]["doi"]) or (REQ["ids"].get("arxiv") and ep and ep.group(1).strip() == REQ["ids"]["arxiv"]):
        out({"status": "exists", "key": m.group(1)})
key = REQ["key"]
if key in keys:
    key = next((key + c for c in "abcdefghijklmnopqrstuvwxyz" if key + c not in keys), None)
    if key is None: out({"error": "too many references share the key %s" % REQ["key"]})
entry = REQ["bibtex"].replace("{" + REQ["key"] + ",", "{" + key + ",", 1)
append("refs.bib", ("\\n" if bib and not bib.endswith("\\n") else "") + ("\\n" if bib.strip() else "") + entry)
log = dict(REQ["log"]); log["key"] = key
append("resolutions.jsonl", json.dumps(log, ensure_ascii=False) + "\\n")
out({"status": "added", "key": key})
`;

/**
 * Writes resolved references into the agent's lit/ inside its own sandbox (literature.resolve). As with the
 * experiment reader, only the worktree is mounted there, so a symlink the agent plants can't redirect the write.
 */
export function sandboxReferenceWriter(exec: ContainerExec): (ref: ReferenceWrite) => Promise<ReferenceWritten> {
  return async (ref) => {
    if (!/^[a-z0-9]{1,64}$/.test(ref.key)) throw new LitError(`bad citekey ${ref.key}`, "error");
    const r = await exec(["python3", "-"], { input: REFERENCE_WRITER(ref), timeoutMs: 60_000, maxOutputBytes: 1 << 16 });
    if (r.code !== 0 || r.truncated) throw new LitError(`could not update lit/refs.bib in the sandbox: ${(r.stderr || r.stdout).trim().slice(-300)}`, "error");
    let parsed: { error?: string; status?: string; key?: string };
    try {
      parsed = JSON.parse(r.stdout) as typeof parsed;
    } catch {
      throw new LitError("could not update lit/refs.bib in the sandbox: unexpected output", "error");
    }
    if (parsed.error) throw new LitError(parsed.error, "error");
    if ((parsed.status !== "added" && parsed.status !== "exists") || !/^[a-z0-9]{1,65}$/.test(parsed.key ?? "")) throw new LitError("could not update lit/refs.bib: unexpected answer", "error");
    return { status: parsed.status, key: parsed.key! };
  };
}
