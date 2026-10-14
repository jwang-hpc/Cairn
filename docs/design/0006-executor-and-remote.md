# DR-0006: Executor and remote execution
Status: Accepted (2026-10-13)

## Executor (packages/executor)
Host-side MCP servers. The only component holding SSH sessions and service tokens.
Tools: `jobs.submit(experiment, target)`, `jobs.status(job_id)`, `jobs.fetch_results(experiment)`,
`jobs.cancel(job_id)`, `git.push(branch)`, `notify.send(message)`, `literature.search/fetch`.

## Submission flow
1. Agent writes `experiments/EXP-NNN/job.*` in its worktree; calls `jobs.submit` with the experiment name
   (not a path).
2. Executor resolves the file inside that worktree on the host and lints it against config/machines.yaml:
   fixed account/allocation, allowed partitions, max nodes, max walltime, paths under project/scratch, no
   destructive commands outside the experiment directory.
3. Approval card in the app (nodes, walltime, node-hours, diff vs approved template). Auto-approve only
   below per-machine thresholds and never on DOE machines.
4. Executor submits over a user-opened SSH ControlMaster session; records job ID in the ledger.
5. `fetch_results` copies only declared, small outputs into `evidence/raw/EXP-NNN/`; large data stays remote,
   referenced by path.
Every action is appended to `engine/audit.log`.

## DOE machine tiers
- Tier 0 (default): no agent on the machine. Executor-only access as above. Session-scoped: closing the
  ControlMaster (user MFA) revokes all reach.
- Tier 1 (explicit, per task): short-lived headless agent on a login node for build/debug, allowlisted
  commands, project-space working directory, full transcript to ledger. Precondition: verify sandboxing
  actually works there (user namespaces / bubblewrap often unavailable). Never store subscription
  credentials on shared DOE filesystems.
- Before any agent use on DOE systems: confirm facility policy (LCRC etc.) and whether project code/data
  may be sent to commercial model services.

## Workstation and UNCC HPC
Same executor interface; thresholds may allow auto-approval for small jobs.
