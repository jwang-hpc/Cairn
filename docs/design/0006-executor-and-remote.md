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

## Amendment (2026-10-14): M0 results (spike 4)
- **User-held sessions:** the user opens one SSH ControlMaster per host (key via jump host for the
  workstation; password + Duo for UNCC HPC). Sockets live in the engine home, mode 0700.
  `ControlPersist` (4 h default) bounds how long the executor can act without the user.
- **Executor connects mux-only:** `ControlMaster=no`, `BatchMode=yes`, every authentication method off,
  all forwarding off (agent, X11, ports). It therefore can't open its own connection or prompt, and
  closing the master revokes its reach on every host, including key-based ones (verified).
- **Remote scripts** go to `sh -s` on stdin; untrusted strings are never interpolated into a shell command.
- **`sbatch --test-only` is the lint pre-flight:** it validates partition, account, and limits and
  estimates a start time without queueing; show the estimate on the approval card. Slurm messages vary by
  version (24.11 reports `allocation failure: <reason>`), so parse tolerantly and keep raw output in
  `engine/audit.log`.
- **Workstation has no scheduler:** `jobs.submit` there needs a runner (e.g. `systemd-run --user` or a
  detached wrapper) and a configured scratch path (`$HOME` is small).
- **`config/machines.yaml` holds `~/.ssh/config` aliases,** not raw hostnames.

## Amendment (2026-10-14): M5 job format and policy
- **Job files:** `experiments/EXP-NNN/job.json` (manifest: `script`, `resources` {nodes, cores per node,
  tasks_per_node, gpus, memory_gb, walltime, partition}, `outputs`) plus the script and any helper files in that
  directory (≤ 100 files, ≤ 1 MiB each, ≤ 4 MiB total). Scripts carry no `#SBATCH`/`#PBS` lines: the executor
  writes the header from the manifest and `machines.yaml` (fixed account, allowed partition).
- **Remote layout:** `<scratch>/cairn/<project>/<job-id>/`; `scratch` is a new `machines.yaml` field (absolute,
  inside `paths.allowed_prefixes` when those are set). Limits gain `max.cores` and `max.gpus` (per node).
- **Lint** is exact for resources and heuristic for scripts (shell files only): it refuses remote access, privilege
  changes, persistence, detaching (`nohup`, `setsid`, `tmux`), nested submission, download-and-run, `..` paths,
  destructive commands on paths outside the job directory, and absolute paths outside the machine's project/scratch
  areas, and any file (any language) that names a credential location (`.ssh`, `id_ed25519`, `.aws/credentials`,
  ...); network use, installs, background processes, `eval`, and `$HOME` are warnings shown on the card.
- **Auto-approval** additionally requires an exact rerun (same file fingerprint) of a job the user approved before,
  and no lint warnings. Every new script is approved by a human once; the "approved template" of step 3 is that
  earlier job.
