// `re run`: worktree -> runWorker -> commit the agent's changes on agent/<id> -> remove the worktree dir.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { commitWorktree, createWorktree, removeWorktree, type WorktreeRef } from "@cairn/launcher";
import { runWorker, type WorkerBudget, type WorkerDeps, type WorkerResult } from "./run.js";

export interface RunTaskOptions extends WorkerBudget {
  repo: string;
  role: string;
  task: string;
  /** Keep the worktree directory after the run (the branch is kept whenever there are changes). */
  keep?: boolean;
}

export interface RunTaskResult {
  result: WorkerResult;
  worktree: WorktreeRef;
  /** Commit on agent/<id> holding the agent's changes, if any. */
  commit: string | undefined;
  /** True if the worktree directory was left in place. */
  kept: boolean;
}

export async function runTask(deps: WorkerDeps, opts: RunTaskOptions): Promise<RunTaskResult> {
  if (!deps.engine.config.roles.roles[opts.role]) {
    throw new Error(`unknown role '${opts.role}' (known: ${Object.keys(deps.engine.config.roles.roles).join(", ")})`);
  }
  const agentId = `${opts.role}-${randomBytes(3).toString("hex")}`;
  const worktree = await createWorktree({ repo: opts.repo, agentId, root: join(deps.engine.paths.home, "worktrees") });
  let result: WorkerResult;
  try {
    result = await runWorker(deps, { text: opts.task }, worktree, opts.role, opts);
  } catch (e) {
    await removeWorktree(worktree, { deleteBranch: true });
    throw e;
  }
  const firstLine = result.report.summary.split("\n")[0]!.slice(0, 100);
  const commit = await commitWorktree(worktree, `agent ${agentId} (${opts.role}): ${firstLine}\n\nCairn-Run: ${result.run}\nCairn-Status: ${result.status}\n`);
  const kept = opts.keep === true;
  if (!kept) await removeWorktree(worktree, { deleteBranch: commit === undefined });
  return { result, worktree, commit, kept };
}
