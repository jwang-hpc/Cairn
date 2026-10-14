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
- **Runtime shape (M5):** one jobs MCP session per agent run, in-process behind the authenticated front (bearer
  token per run, Host and path checks); the session fixes project, worktree, author, and the role's
  `executor_tools`. No MCP tool approves: `re job approve` (later the app) is the only approval path. The
  executor submits the fingerprint-checked snapshot taken at `jobs.submit`, never the live worktree.
- **States:** pending_approval → approved → submitted/running → completed/failed/cancelled (or denied, lost).
  Proposal (`ai-suggested`), decision (`user`), launch, final state and results (`ai-executed`) are ledger
  commits; every action and raw remote output goes to `<engine home>/audit.log` (host only).
- **Workstation runner:** job in its own process group (perl `setpgrp`) with a wall-clock watchdog; exit code
  and timestamps in `.cairn/` next to the job. Fetch copies only regular, single-link files inside the job
  directory (no symlinks or hard links), ≤ 10 MiB each and 50 MiB per fetch; larger files are referenced.
- **Hardening after review (M5):** `jobs.submit` reads an agent's experiment **inside its sandbox** (only the
  worktree is mounted, so no symlink race can reach host files); the host-side reader is for user submissions.
  Auto-approval also requires the same target. Fetch accepts only the declared outputs and the two logs, framed
  by a random per-call marker. Workstation cancel is a TERM to the runner (pid captured at launch), which stops its
  own job group; nothing the job can write decides what gets signalled. A launch that failed ambiguously is
  looked up (`.cairn/runner.pid`, or `squeue/sacct --name cairn-<job>`) and adopted, never run twice. A scheduler
  error leaves the state unchanged ("unknown"); `lost` is re-checked on the next status. Cards and CLI output
  escape control characters; files with NUL bytes are flagged and still scanned.

## Amendment (2026-10-14): M7 literature tools
- **Sources:** Semantic Scholar, OpenAlex, arXiv, and Crossref; doi.org's handle API checks that a DOI is
  registered. DBLP is deferred: it answered with a bot-check page instead of data. Google Scholar has no API and
  its terms forbid scraping, so it is linked from notes only (a pasted Scholar BibTeX entry goes through
  `resolve` like any other citation).
- **Tools:** `literature.search`, `literature.fetch`, `literature.resolve`, and `literature.expand` (one step of the
  citation graph). They are host-side and serve the same per-run MCP session as `jobs.*`, filtered by
  `executor_tools`. No model runs inside them.
- **Network:** each source is pinned to its single host, and redirects are checked against that host. The user's
  contact address (`re literature contact`, stored in engine.yaml) goes only to OpenAlex and Crossref, their
  "polite pool". An optional Semantic Scholar key (`re literature key s2`, `<home>/secrets/literature.json`,
  mode 0600) goes only to Semantic Scholar.
- **Protections against throttling and overuse:** per-source pacing, Retry-After handling, a breaker after
  repeated failures, a stop before OpenAlex's free daily credits run out, a 7-day cache in
  `<home>/literature-cache/` that never stores the address or the key, and at most 300 tool calls per run.
- **Untrusted data:** every result is labelled as untrusted external data. Search results carry no
  abstracts; `fetch` gives an abstract, quoted and clipped to 1,500 characters. Markup and control characters are
  stripped.
- **Citations:** references enter `lit/refs.bib` only through `literature.resolve`, which accepts:
  - a DOI that is registered and has metadata from Crossref, OpenAlex, or arXiv;
  - an arXiv id that exists;
  - a title that matches exactly one paper closely.

  The resolve tool appends the BibTeX entry and a line to `lit/resolutions.jsonl`. It does this inside the agent's
  sandbox, with no symlinks followed and append only. A different work with the same citekey gets a suffix. BibTeX
  values are plain text: no backslashes or braces survive. This amends DR-0007's "DOI/DBLP" to DOI or arXiv id.
- **Into the ledger (M7.3):** `re literature check <branch>` reads the branch's `lit/` from git. It re-verifies
  every `refs.bib` entry against the services: `resolutions.jsonl` is provenance only, since the agent can write it.
  Each entry must look exactly like what resolve writes, with the same title, year, and first author as the record
  it names. Every `[@key]` or `\cite{key}` in `lit/notes/` and `logic/related_work.md` must be in `refs.bib`.
  Per-paper notes are `lit/notes/<citekey>.md`, with frontmatter `paper: doi:…|arxiv:…` and the sections from
  DR-0009 (missing sections are a warning). Each paper note also carries `relevance: 0-10`: the agent's judgement of
  the paper against the project's problem, using the rubric in the `literature-review` skill. A malformed score fails
  the check; a missing one is a warning. `re literature notes [<branch>]` lists the notes, most relevant first.
- **Preprints:** a preprint and its publication are one reference: the publication, with the arXiv id as its
  `eprint`. That's what goes into a submission's bibliography.
  - `resolve` on an arXiv id whose record names a registered journal DOI returns the publication.
  - `resolve` on a DOI keeps a preprint the publisher names (Crossref `has-preprint`) only after arXiv confirms
    it.
  - `check` warns about pairs left in `refs.bib` (same eprint, or same title and first author). `accept` merges
    them automatically and reports it: the preprint entry goes, its citations are rewritten, and its note becomes
    the publication's (or is dropped if the publication has one). The merged result is checked again before it is
    written.
  - Pairs that differ substantially (title similarity below 0.9, or a different first author) stay separate works.
- **Accept:** `re literature accept <branch>` runs the check, then writes the checked files as one ledger commit
  tagged `ai-suggested(<model>, <effort>)`, taken from the run's usage record via the commit's `Cairn-Run` trailer.
  It is refused if `lit/` changed in the project since the branch started, or if the branch deletes or symlinks
  anything there. Agent branches are never merged with git: their commits carry no provenance trailer.
- **Open:** queries go to four public APIs whatever the project's data class. They are short keyword strings, not
  project data, but whether `restricted` projects may use them is for the user to decide.
