# Milestones

Each milestone ends with something the user can run and verify. One PR per task where practical.

## M0 — De-risking spikes (throwaway code in spikes/, findings written to docs/design/open-questions.md)
- pi-agent-core loop + pi-ai calls (`@earendil-works/*`, pinned) to Claude and GPT via subscription login
  (Claude Team seat, ChatGPT plan; API-key fallback), Gemini via API key or Vertex, and MAI via its
  OpenAI-compatible endpoint (Foundry or a third-party host). Record effort mapping per provider.
- Connect `@earendil-works/pi-mcp` (Streamable HTTP, bearer token) to a stub executor MCP server.
- Node drives Apple `container`: create, mount a single directory, `exec` a command, capture output,
  enforce no-network and an allowlisted domain. ~~Same via Docker.~~ (Dropped 2026-10-14: no Docker
  fallback; see DR-0002 amendment.)
- Executor spike: open an SSH ControlMaster to the workstation (and UNCC HPC), run `sbatch --test-only`
  or equivalent, parse output.
Acceptance: a short report per spike (works / workaround / blocker).
**Status (2026-10-14): done.** All four spikes work (Claude/OpenAI auth; Gemini and MAI still untested).
Reports: `spikes/{pi-auth,pi-mcp,containers,executor-ssh}/REPORT.md`; DRs amended accordingly.

## M1 — Engine skeleton and event log
pnpm monorepo; packages/shared schemas (TypeBox); normalized event log; budget governor (records usage,
enforces a daily cap); config loading (models/roles/machines); engine CLI `re status`.
Acceptance: a pi agent answers a prompt; the call appears in engine/usage.jsonl with model, effort, tokens.
**Status (2026-10-13): done** (PRs #2–#8). Verified live with `re ask`; usage lands in `.engine/usage.jsonl`
until projects exist (M3).

## M2 — Launcher and confined tools
Git worktree per agent; container per agent with role-based mounts; pi tools (bash, read, write, edit,
python) executed via container exec; egress allowlists from roles.yaml; escape-test suite in tests/escape/.
Acceptance: an agent edits files in its worktree only; all escape tests pass.
**Status (2026-10-14): done** (M2.1–M2.8). Acceptance run: `scripts/acceptance-m2.sh` (agent changed only
`analysis/summary.md`, committed on `agent/<id>`). Escape suite: 9/9 pass, 30 attempts logged. Known gap:
host services bound to all interfaces are reachable from agents (open question 12).

## M3 — ARA ledger
Create/open a project as an ARA artifact; PAPER.md manifest; hypotheses with falsification criteria;
exploration tree with dead ends; provenance tags; decisions.md. Vendored ARA skills pinned.
Acceptance: `re project new`, `re hypothesis add`, tree renders as text; every write tagged.

## M4 — Multi-model panel
Modes: independent, critique, debate, relay, redteam, synthesis; blind labels; storage in engine/panels/.
Acceptance: an independent + critique run over a hypothesis with members from at least three vendors,
stored and replayable; a restricted-class project is refused by a disallowed provider.

## M5 — Executor (host MCP servers)
jobs.submit/status/fetch_results/cancel with linting against machines.yaml and approval requests;
audit log; workstation first, then UNCC HPC; DOE target configured but Tier 0 only.
Acceptance: a coder agent authors a job; user approves via CLI; job runs on the workstation; results land
in evidence/raw/.

## M6 — Analysis and claim gate
Python parser framework; support check (code-first, provcheck-style); rigor review; user approval into
claims.md.
Acceptance: a claim with a wrong number is flagged by code alone; a correct one passes with a coverage report.

## M7 — Literature
Literature proxy MCP (Semantic Scholar, OpenAlex, arXiv, DBLP, Crossref); structured paper notes; citation
resolution (DOI/DBLP) enforced; local overrides of PiPilot skills that referenced literature-search.
Acceptance: related-work note set for a known topic, every citation resolvable.

## M8 — Desktop app
Electron + React over the engine API: project view (ARA claims <-> evidence <-> trace), approval inbox
(jobs, claims, pushes), panel comparison (blind), job/campaign monitor, usage dashboard; Keychain via
safeStorage; macOS notifications for approvals; signing + notarization.
Acceptance: the M5 and M6 flows can be completed entirely from the app.

## M9 — Campaigns and async
Campaign spec + runner (scheduler-native arrays/dependencies or headless engine on workstation);
reconcile-on-wake; optional workstation poller.
Acceptance: a 20-point sweep runs on the workstation while the laptop sleeps; results reconciled on wake.

## M10 — Evals and hybrid decision
Golden task suite in evals/; run current models; evaluate adding a Claude Code / Codex worker behind the
worker contract on coding tasks.
Acceptance: eval report; routing decision recorded as a DR.
