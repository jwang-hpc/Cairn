# CLAUDE.md — Research Engine

You are implementing a local, human-in-the-loop research workbench for an HPC/scientific-data researcher.
Read this file fully before any change. The design is fixed in `docs/design/` (decision records, "DRs");
the build order is in `docs/plan/milestones.md`. If an implementation choice contradicts a DR, stop and
ask rather than deviating. If a DR is wrong, propose an amendment in the PR description.

## What this system is
- A workbench, not an autonomous scientist. The human approves hypotheses, compute spend, and claims.
  The only autonomous mode is a pre-approved parameter-sweep campaign (DR-0011).
- One uniform agent runtime (pi-mono, `@earendil-works/*`) across Claude, GPT, Gemini, and MAI models
  (DR-0002, DR-0004, DR-0013).
- All research state lives in an ARA-format ledger in git, never in model sessions (DR-0007).
- Agents are confined: the agent loop and all credentials stay on the host; every agent tool executes
  inside that agent's own container, which mounts only its worktree (DR-0005).

## Repository layout
```
apps/desktop/            Electron + React UI (thin client over the engine API)
packages/engine/         orchestrator, worker contract, panel, ledger, budget governor, event log
packages/executor/       host-side MCP servers: jobs (HPC/workstation), git push, notify, literature proxy
packages/launcher/       containers, git worktrees, per-role policy -> mounts/allowlists
packages/shared/         schemas (TypeBox), types, event-log format
containers/agent/        agent container image (tools runtime + Python stack, egress firewall)
config/                  *.example.yaml (models, roles, machines); real configs are gitignored
skills/third_party/      vendored, pinned, UNMODIFIED skills (+ LICENSE, PROVENANCE.md)
skills/local/            our skills and overrides of third-party skills
docs/design/             decision records; docs/plan/ milestones
tests/escape/            security invariant tests (must always pass)
evals/                   golden research tasks for model/worker evaluation
```

## Non-negotiable invariants (tests in tests/escape/ enforce these)
1. No credentials (model tokens, API keys, SSH keys, GitHub/Slack tokens) are ever mounted, copied,
   or passed into an agent container. Model calls happen in the host engine.
2. A container mounts only: its own worktree (rw), the skills folder (ro), and an outbox folder (rw).
   Never the user's home directory, never `~/.claude`, `~/.codex`, `~/.ssh`.
3. Container egress is deny-by-default; allowlists come from the role policy (config/roles.yaml).
4. Agents never SSH anywhere. Remote actions go only through executor MCP tools, which lint the request
   and require human approval for anything above policy thresholds (DR-0006).
5. Nothing is written to `logic/claims.md` without passing the claim gate (DR-0007).
6. Every model call is recorded in the normalized event log with model, effort, usage, and machine.
7. Third-party skills are never edited in place and never installed by fetching remote prompts.
8. No secret ever enters git. Real configs live outside the repo or are gitignored.
9. No project data goes to a provider not allowed for that project's data class (DR-0013).

## The extensibility seams (DR-0004) — do not break these
- Callers use only `runWorker(task, worktree, role, budget) -> WorkerResult`; never pi internals.
- Downstream code judges work by artifacts (git diff, report.json, evidence/), not by chat transcripts.
- Provenance/audit/budget consume only the normalized event log (packages/shared/events).
- Privileged capabilities are MCP servers in packages/executor; agent tools reach them via an MCP client.
- Approvals happen inside MCP tools, not inside the agent loop.
- Permissions are data (role policy) translated by the launcher.
- Skills are Agent Skills format (SKILL.md, name/description frontmatter) loaded from one folder tree.
- Launcher supports `secrets: none | model-token` (only `none` is used for now).

## Conventions
- TypeScript strict, ESM, Node LTS, pnpm workspaces. Schemas with TypeBox; validate at every boundary.
- Tests: vitest. Every package has unit tests; integration tests live next to the package.
- Python (>=3.11) only for result parsers and analysis scripts under `packages/engine/parsers/`,
  invoked as tools; never for core engine logic.
- Pin dependency versions exactly. pi-mono packages (`@earendil-works/*`) pinned; model IDs live in config,
  not code. PiPilot uses the older `@mariozechner/*` 0.70.x packages: port, don't copy blindly.
- Small PRs, one milestone task each. Commit messages: `area: what changed` (e.g. `launcher: role mounts`).
- Dong Dai's PiPilot (MIT) is a reference implementation. Read it for patterns (coordinator, context
  compaction, usage-limit handling, model shim). If code is copied, keep the MIT notice in that file.

## Working rules for you (Claude Code)
- Work only inside this repository. Do not read or modify files outside it.
- Before each milestone task: restate the acceptance criteria, then implement, then run tests.
- Never claim tests pass unless you ran them after your last edit. Report what you did not verify.
- Ask before adding a new dependency, a new network domain, or a new MCP tool.
- Mac-specific features (Apple container, Keychain/safeStorage, signing) must be tested on macOS.
