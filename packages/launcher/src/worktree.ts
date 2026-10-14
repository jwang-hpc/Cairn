// One git worktree per agent (DR-0005). The engine runs git on the host; agents never see .git (the worktree's
// .git file points at the main repo's gitdir, which is not mounted). Engine-run git is hardened so a project's
// config or attributes can't make it execute anything.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WorktreeRef {
  agentId: string;
  /** Main repository (absolute). */
  repo: string;
  /** Worktree directory (absolute). */
  path: string;
  branch: string;
  /** Commit the agent started from. */
  base: string;
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** Options that keep a repo's own config from running code or changing output. */
const HARDEN = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "color.ui=false",
];

/** User env minus GIT_* overrides (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_* ... would redirect git). */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run("git", [...HARDEN, "-C", cwd, ...args], { env: gitEnv(), maxBuffer: 64 << 20 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new WorktreeError(`git ${args[0]} failed: ${(err.stderr || err.message).trim().split("\n").at(-1)}`);
  }
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Create `<root>/<agentId>` as a worktree of `repo` on new branch `agent/<agentId>` at `baseRef`. */
export async function createWorktree(opts: { repo: string; agentId: string; root: string; baseRef?: string }): Promise<WorktreeRef> {
  if (!AGENT_ID.test(opts.agentId)) throw new WorktreeError(`invalid agent id ${JSON.stringify(opts.agentId)}`);
  const repo = (await git(resolve(opts.repo), ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new WorktreeError(`not a git repository: ${opts.repo}`);
  })).trim();
  const base = (await git(repo, ["rev-parse", "--verify", `${opts.baseRef ?? "HEAD"}^{commit}`])).trim();
  const branch = `agent/${opts.agentId}`;
  const path = join(resolve(opts.root), opts.agentId);
  if (await exists(path)) throw new WorktreeError(`worktree path already exists: ${path}`);
  const known = await git(repo, ["branch", "--list", branch]);
  if (known.trim() !== "") throw new WorktreeError(`branch ${branch} already exists`);
  await git(repo, ["worktree", "add", "--quiet", "-b", branch, path, base]);
  return { agentId: opts.agentId, repo, path, branch, base };
}

export interface WorktreeChanges {
  /** Unified diff against the base commit, including new and deleted files. */
  diff: string;
  /** Changed paths (worktree-relative, posix). */
  files: { path: string; status: "added" | "modified" | "deleted" | "renamed" | "other" }[];
}

/** Everything the agent changed relative to its base commit (staged into the worktree's own index). */
export async function worktreeDiff(ref: WorktreeRef): Promise<WorktreeChanges> {
  await git(ref.path, ["add", "--all"]);
  const common = ["--cached", "--no-ext-diff", "--no-textconv", "--no-renames", ref.base];
  const diff = await git(ref.path, ["diff", "--binary", ...common]);
  const names = await git(ref.path, ["diff", "--name-status", "-z", ...common]);
  const parts = names.split("\0").filter((s) => s !== "");
  const files: WorktreeChanges["files"] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!.charAt(0);
    const status = ({ A: "added", M: "modified", D: "deleted", R: "renamed" } as const)[code as "A"] ?? "other";
    files.push({ path: parts[i + 1]!, status });
  }
  return { diff, files };
}

/**
 * Changed paths not covered by the role's write paths (defense in depth behind the container mounts).
 * Write paths ending in "/" cover their subtree; others are single files.
 */
export function outsideAllowed(files: readonly { path: string }[], writePaths: readonly string[]): string[] {
  const rules = writePaths.map((w) => ({ dir: w.endsWith("/"), p: posix.normalize(w).replace(/\/+$/, "") }));
  return files
    .map((f) => posix.normalize(f.path))
    .filter((p) => !rules.some((r) => (r.dir ? p === r.p || p.startsWith(`${r.p}/`) : p === r.p)));
}

/** Remove the worktree (and optionally its branch). Safe to call twice. */
export async function removeWorktree(ref: WorktreeRef, opts: { deleteBranch?: boolean } = {}): Promise<void> {
  if (await exists(ref.path)) await git(ref.repo, ["worktree", "remove", "--force", ref.path]);
  await git(ref.repo, ["worktree", "prune"]);
  if (opts.deleteBranch) {
    const known = await git(ref.repo, ["branch", "--list", ref.branch]);
    if (known.trim() !== "") await git(ref.repo, ["branch", "-D", ref.branch]);
  }
}
