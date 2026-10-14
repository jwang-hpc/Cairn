// Agent tools that execute inside the agent's own container (DR-0005: loop on host, tools in container).
// The container's mounts are the real boundary; path checks here are defense in depth and give the model
// clear errors. Long output is cut to head + tail by code before it reaches the model (DR-0009).
import { posix } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { OUTBOX, type RunOptions, type RunResult, SKILLS, WORK } from "@cairn/launcher";

/** The one capability tools need: run a command in this agent's container. */
export type ContainerExec = (command: readonly string[], opts?: RunOptions & { workdir?: string }) => Promise<RunResult>;

export interface ToolLimits {
  /** Default and maximum seconds for bash/python. */
  defaultTimeoutS: number;
  maxTimeoutS: number;
  /** Characters of output shown to the model per stream. */
  maxOutputChars: number;
}
export const DEFAULT_LIMITS: ToolLimits = { defaultTimeoutS: 120, maxTimeoutS: 600, maxOutputChars: 30_000 };

export class ToolInputError extends Error {}

/** Resolve a model-supplied path to an absolute container path under one of `roots`. */
export function containerPath(p: string, roots: readonly string[]): string {
  if (typeof p !== "string" || p.trim() === "" || p.includes("\0")) throw new ToolInputError("path must be a non-empty string");
  const abs = posix.normalize(p.startsWith("/") ? p : posix.join(WORK, p));
  if (!roots.some((r) => abs === r || abs.startsWith(`${r}/`))) {
    throw new ToolInputError(`path ${JSON.stringify(p)} is outside ${roots.join(", ")}`);
  }
  return abs;
}
const READ_ROOTS = [WORK, SKILLS, OUTBOX];
const WRITE_ROOTS = [WORK, OUTBOX];

/** Keep the head and tail of long output; the middle is replaced by a marker with the omitted size. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-tail)}`;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

function timeoutMs(requested: number | undefined, limits: ToolLimits): number {
  const s = Math.min(Math.max(requested ?? limits.defaultTimeoutS, 1), limits.maxTimeoutS);
  return s * 1000;
}

function formatRun(r: RunResult, limits: ToolLimits): string {
  const parts = [`exit code: ${r.timedOut ? "timeout" : r.code}`];
  if (r.stdout) parts.push(`stdout:\n${clip(r.stdout, limits.maxOutputChars)}`);
  if (r.stderr) parts.push(`stderr:\n${clip(r.stderr, limits.maxOutputChars)}`);
  if (r.truncated) parts.push("(output exceeded the capture limit and was cut)");
  return parts.join("\n");
}

async function readFileIn(exec: ContainerExec, path: string): Promise<string> {
  const r = await exec(["cat", "--", path], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`cannot read ${path}: ${r.stderr.trim() || `exit ${r.code}`}`);
  if (r.truncated) throw new Error(`${path} is too large to load in full`);
  return r.stdout;
}

async function writeFileIn(exec: ContainerExec, path: string, content: string): Promise<void> {
  // Path is passed as $1, never interpolated into the script.
  const r = await exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], { input: content, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`cannot write ${path}: ${r.stderr.trim() || `exit ${r.code}`}`);
}

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command, run with bash -c in /work" }),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, description: "Seconds before the command is killed (max 600)" })),
});
const ReadParams = Type.Object({
  path: Type.String({ description: "File path, relative to /work or absolute under /work, /skills, /outbox" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return (1-based)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines to return" })),
});
const WriteParams = Type.Object({
  path: Type.String({ description: "File path under /work or /outbox; parent directories are created" }),
  content: Type.String(),
});
const EditParams = Type.Object({
  path: Type.String(),
  old_string: Type.String({ description: "Exact text to replace; must occur exactly once unless replace_all" }),
  new_string: Type.String(),
  replace_all: Type.Optional(Type.Boolean()),
});
const PythonParams = Type.Object({
  code: Type.String({ description: "Python 3 program, run with cwd /work" }),
  timeout_s: Type.Optional(Type.Integer({ minimum: 1, description: "Seconds before it is killed (max 600)" })),
});

/** The five confined tools for one agent container. */
export function confinedTools(exec: ContainerExec, limits: ToolLimits = DEFAULT_LIMITS): AgentTool<any>[] {
  const bash: AgentTool<typeof BashParams> = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command in your sandbox (cwd /work). No network unless your role allows specific domains via the proxy.",
    parameters: BashParams,
    execute: async (_id, { command, timeout_s }, signal) => {
      const r = await exec(["bash", "-c", command], { timeoutMs: timeoutMs(timeout_s, limits) });
      if (signal?.aborted) throw new Error("aborted");
      return text(formatRun(r, limits));
    },
  };

  const read: AgentTool<typeof ReadParams> = {
    name: "read",
    label: "Read file",
    description: "Read a text file. Use offset/limit for large files.",
    parameters: ReadParams,
    execute: async (_id, { path, offset, limit }) => {
      const abs = containerPath(path, READ_ROOTS);
      const content = await readFileIn(exec, abs);
      const lines = content.split("\n");
      const start = (offset ?? 1) - 1;
      const slice = limit !== undefined || offset !== undefined ? lines.slice(start, limit !== undefined ? start + limit : undefined).join("\n") : content;
      return text(clip(slice, limits.maxOutputChars));
    },
  };

  const write: AgentTool<typeof WriteParams> = {
    name: "write",
    label: "Write file",
    description: "Create or overwrite a file under /work or /outbox.",
    parameters: WriteParams,
    execute: async (_id, { path, content }) => {
      const abs = containerPath(path, WRITE_ROOTS);
      await writeFileIn(exec, abs, content);
      return text(`wrote ${abs} (${content.length} characters)`);
    },
  };

  const edit: AgentTool<typeof EditParams> = {
    name: "edit",
    label: "Edit file",
    description: "Replace exact text in a file. old_string must match exactly once unless replace_all is true.",
    parameters: EditParams,
    execute: async (_id, { path, old_string, new_string, replace_all }) => {
      const abs = containerPath(path, WRITE_ROOTS);
      if (old_string === "") throw new ToolInputError("old_string must not be empty");
      if (old_string === new_string) throw new ToolInputError("old_string and new_string are identical");
      const before = await readFileIn(exec, abs);
      const count = before.split(old_string).length - 1;
      if (count === 0) throw new ToolInputError(`old_string not found in ${abs}`);
      if (count > 1 && !replace_all) throw new ToolInputError(`old_string occurs ${count} times in ${abs}; add context or set replace_all`);
      const after = replace_all ? before.split(old_string).join(new_string) : before.replace(old_string, () => new_string);
      await writeFileIn(exec, abs, after);
      return text(`edited ${abs} (${replace_all ? count : 1} replacement${(replace_all ? count : 1) === 1 ? "" : "s"})`);
    },
  };

  const python: AgentTool<typeof PythonParams> = {
    name: "python",
    label: "Python",
    description: "Run a Python 3 program (cwd /work). Read data from files; print results.",
    parameters: PythonParams,
    execute: async (_id, { code, timeout_s }) => {
      const r = await exec(["python3", "-"], { input: code, timeoutMs: timeoutMs(timeout_s, limits) });
      return text(formatRun(r, limits));
    },
  };

  return [bash, read, write, edit, python];
}
