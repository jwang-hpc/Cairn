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
**Status (2026-10-14): done** (M3.1–M3.3). `re ledger check`: 7 writes, 7 commits, all tagged
(`scripts/acceptance-m3.sh`). ARA skills vendored at e52a925.

## M4 — Multi-model panel
Modes: independent, critique, debate, relay, redteam, synthesis; blind labels; storage in engine/panels/.
Acceptance: an independent + critique run over a hypothesis with members from at least three vendors,
stored and replayable; a restricted-class project is refused by a disallowed provider.
**Amendment (2026-10-14, user decision):** two or more vendors suffice for M4 acceptance (Claude + GPT are
configured); a third vendor joins once its key and data terms are settled (open questions 7, 8). Until then the
synthesizer is a model outside the panel (DR-0013) but may share a vendor with a member; that is recorded.
**Status (2026-10-14): done** (M4.1–M4.3). `scripts/acceptance-m4.sh`: independent → critique → synthesis over HY01
with Claude Sonnet + GPT (synth Claude Opus), 5 calls, stored in `engine/panels/<id>/` and replayed blind; a
restricted project was refused by both providers (2 approval-denied events, 0 model calls). Synthesizer is not yet
vendor-neutral (open questions 7/8).

## M5 — Executor (host MCP servers)
jobs.submit/status/fetch_results/cancel with linting against machines.yaml and approval requests;
audit log; workstation first, then UNCC HPC; DOE target configured but Tier 0 only.
Acceptance: a coder agent authors a job; user approves via CLI; job runs on the workstation; results land
in evidence/raw/.
**Status (2026-10-14): done** (M5.1–M5.6). `scripts/acceptance-m5.sh`: a Claude Sonnet coder agent wrote and
submitted EXP-001 (pure-Python prime sieve), the user approved it from the card, it ran on the workstation (exit 0),
and `results.csv` landed in `evidence/raw/EXP-001/<job>/`; `re ledger check`: 6 writes, 6 commits, all tagged
(ai-suggested → user → ai-executed). The run also found a launcher bug (single-file role mounts; fixed in M5.6).
The same acceptance on **UNCC HPC** (Slurm 24.11) passed too: the card showed the `sbatch --test-only` estimate,
Slurm job 27314225 completed (sacct), results fetched, ledger clean. Escape suite: 11/11 (6b included).

## M6 — Analysis and claim gate
Python parser framework; support check (code-first, provcheck-style); rigor review; user approval into
claims.md.
Acceptance: a claim with a wrong number is flagged by code alone; a correct one passes with a coverage report.
**Status (2026-10-14): done** (M6.1–M6.5). `scripts/acceptance-m6.sh --full` on the real M5 workstation results:
the correct claim passed (every number covered) and the same claim with 9593 instead of 9592 was flagged by code
alone, no model called. Then the parsers ran in the agent image, a Claude Opus analysis agent drafted a claim citing
13 sources (ratios from the parser tables), the support check passed (19 numbers), the GPT rigor review returned
REVISE (single short run, wording implies a scaling bound, non-operational falsification), and the user approved it
as C01 (`testing`, user-revised); ledger check clean. An independent review before the live run found 10 defects,
fixed in M6.5.

## M7 — Literature
Literature proxy MCP (Semantic Scholar, OpenAlex, arXiv, DBLP, Crossref); structured paper notes; citation
resolution (DOI/DBLP) enforced; local overrides of PiPilot skills that referenced literature-search.
Acceptance: related-work note set for a known topic, every citation resolvable.
- **M7: implemented (2026-10-14); acceptance pending** (`sh scripts/acceptance-m7.sh --full`). Design is in the
  DR-0006 M7 amendment.
  - M7.1 `re literature search | fetch | resolve | contact | key s2` over Semantic Scholar, OpenAlex, arXiv, and
    Crossref, with doi.org checking DOIs.
  - M7.2 the `literature.*` tools for agents; the literature role has no network of its own.
  - M7.3 per-paper notes and the `literature-review` skill; overrides of the six PiPilot skills that used
    `literature-search`; `re literature check` and `accept`.
  - Paper notes carry a 0-10 relevance score; `re literature notes` lists them, most relevant first.
  - A preprint and its publication are one reference: `resolve` prefers the publication, and `accept` merges
    leftover pairs.
- DBLP is deferred: it answered with a bot-check page. Google Scholar is link-out only.
- Open: whether `restricted` projects may send search queries to these public APIs.

## M8 — Desktop app
Electron + React over the engine API: project view (ARA claims <-> evidence <-> trace), approval inbox
(jobs, claims, pushes), panel comparison (blind), job/campaign monitor, usage dashboard; Keychain via
safeStorage; macOS notifications for approvals; signing + notarization.
Acceptance: the M5 and M6 flows can be completed entirely from the app.
- **M8.1 engine API: implemented (2026-10-14).** `re serve`: HTTP + SSE on 127.0.0.1 with a per-start bearer token
  in `<home>/api.json` (DR-0002 amendment). Endpoints for status/usage, projects and ledger reads (hypotheses, tree,
  claims, decisions), jobs (list, card, approve, deny, submit, cancel, refresh, fetch), machines, panels (list,
  blind show, judge), the claim gate (check, review, approve), and `GET /api/events`; each wraps the functions the
  CLI uses. Tested socketless through `handle(Request)`; the socket test skips where binding a port is refused.
- **M8.2 app shell and job inbox: implemented (2026-10-14).** `apps/desktop`: Electron + React over the engine API
  (DR-0002 amendment).
  - It connects to (or starts) `re serve` and shows the engine's state and today's spend against the cap.
  - It lists projects, and shows a project's jobs grouped by what they need: waiting for approval, in progress,
    finished.
  - A job's approval card, with the actions `re job` allows: approve (which launches), deny with a reason, start,
    refresh, cancel, fetch results. Live updates come from `GET /api/events`.
  - Tests cover the engine connection, request checks, the event-stream parser, the views, and a route contract
    with the engine API. Opening a real window is checked by hand.
- **M8.3 claims and ledger views: implemented (2026-10-14).** The project view has three tabs:
  - **Jobs**, as in M8.2.
  - **Claims:** the drafts agents committed on the project's branches (new `re claim drafts` and
    `GET /api/projects/:name/drafts`), each with where it stands (not reviewed, reviewed with its verdict, approved
    as C<nn>), and the claims in `logic/claims.md`. A draft goes through the gate from the app: support check, rigor
    review, then approval with an optional note. Approval is enabled only once a review of this exact draft is on
    file, and the engine re-checks support.
  - **Ledger:** hypotheses, the exploration tree, decisions.
- **M8 acceptance met (2026-10-14), by the user in the app:**
  - an agent-proposed job on `m5-demo` was approved and launched from the inbox, ran on the workstation, and
    completed;
  - an analysis agent's claim draft went through the support check, a cross-vendor rigor review (REVISE), and the
    user's approval into `logic/claims.md` as C01 (user-revised).
- **M8.4 research sessions in the engine: implemented (2026-10-14).**
  - The orchestrator reads the committed project (its role's read paths) and proposes worker tasks or decisions
    as cards.
  - A launched task runs a sandboxed worker in the background (up to three per project, the rest queued), and
    its steps stream as events. The outcome comes back to the card: report, files, jobs, drafts, literature,
    cost.
  - Chats persist and older turns are condensed.
  - `re chat` (interactive, `say`, `show`, `launch`, `dismiss`, `sessions`), with API routes for
    sessions, messages, proposals, and run steps, and live session events on `GET /api/events`.
  - Acceptance pending (the user, from a terminal): ask about C01's review, launch a proposal, see the worker's
    steps and outcome, resume the chat later.
- **M8.5 the chat-centred app: implemented (2026-10-14).** Built on M8.4.
  - **Layout:** a left sidebar with projects, the outline (problem, claims, hypotheses, exploration tree), and files.
    Centre tabs Chat | Literature | Results | Approvals; the Approvals badge counts what needs the user. A preview
    drawer shows files, figures, tables, job cards (approve, deny), claim drafts (the gate), claims, and worker
    logs (stop).
  - **Chat:** one continuing chat per project plus New chat, and a recap built from the cards and the project.
    Answers stream with tool use folded and a time and cost footer. Messages typed while the orchestrator answers
    queue.
  - **Cards and activity:** proposal and worker cards show the live step, the folded steps, and the outcome with
    links. An activity strip shows the running workers.
  - **Engine additions:** `GET /api/projects/:name/files`, `/file` (text, images, and PDFs as base64; 10 MiB
    limit), and `/literature`.
  - **Not yet in the app:** literature check and accept (CLI only), paper preview (M8.6), PDF preview, and
    rendered Markdown (shown as plain text).
- **UI follow-ups, after the prototype is complete** (the user's call, 2026-10-16):
  - render the orchestrator's Markdown (bold, lists, code) instead of plain text;
  - show a card after the answer that proposed it, not before;
  - recap: failed or stopped tasks under "Next", not "Done";
  - worker errors in one plain sentence (not the raw JSON twice), with what to do;
  - notes rendered as Markdown in the drawer, and PDF preview.
- **Next:** M8.6 paper preview; then blind panel comparison, notifications, Keychain via safeStorage, signing and
  notarization.
  - M8.4: orchestrator sessions in the engine, and `re chat`.
  - M8.5: the chat layout, with Outline, Approvals, Results, and Literature panels.
  - M8.6: paper preview.
  - Then: blind panel comparison, notifications, Keychain via safeStorage, signing and notarization.

## M9 — Campaigns and async
Campaign spec + runner (scheduler-native arrays/dependencies or headless engine on workstation);
reconcile-on-wake; optional workstation poller.
Acceptance: a 20-point sweep runs on the workstation while the laptop sleeps; results reconciled on wake.
- **M9.1 campaigns on the workstation, reconcile on wake: implemented (2026-10-16).** DR-0011 amendment proposed.
  - **Spec:** a `campaign` section in the experiment's `job.json`: a parameter grid (each combination is a point,
    at most 1000), `point_walltime`, `parallel`, and `retries`. `resources.walltime` is the campaign's budget.
    It goes through `jobs.submit`, lint, and the approval card like any job. It never auto-approves.
  - **Run:** a generated, deterministic bash driver inside the workstation runner, with no model. Each point
    gets its own directory and `P_<name>` variables, runs under a time limit, and is retried on failure. No point
    starts that the budget could not finish. Status shows "N of M points done, K not ok".
  - **Results:** `campaign.csv` (one row per point) and each CSV output merged across points, fetched into
    `evidence/raw/` with every point's outputs.
  - **CLI and API:** `re job propose <EXP> --target T` (a job you wrote), `re job reconcile [--all]`, and
    `POST /api/jobs/reconcile`.
  - **Acceptance run 1 (2026-10-18, the user):** 20 of 20 points ok on the workstation, unattended. Reconcile
    fetched 22 files into the evidence.
    - The laptop did not actually sleep (away 2 s), so the lost-session path was not exercised.
    - `re ledger check` failed on the uncommitted `experiments/`. Fixed: `re job propose` now commits the
      experiment.
    - To re-run with a real sleep: `sh scripts/acceptance-m9.sh`.
- **M9.2 campaigns on Slurm (job arrays): implemented (2026-10-18).** DR-0011 amendment proposed.
  - **One job array per campaign:** one task per point, at most `parallel` at once, each with the job's resources
    and a limit of every attempt plus a minute. The campaign's walltime becomes a `--deadline`.
  - **The card:** the array, the deadline, and the node-hour ceiling (points × nodes × task limit).
  - **Status:** counts the tasks by state, plus "N of M points done".
  - **Summary:** rebuilt at every fetch from host-generated text, so Slurm and cancelled campaigns get
    `campaign.csv` and the merged CSVs too.
  - **Acceptance pending:** `sh scripts/acceptance-m9.sh uncc-hpc`. It is the first real test of `--deadline` and
    of array pre-flight on Slurm 24.11.
  - **Next:** notifications when a campaign finishes (with the notify server); the app calls reconcile when it
    connects.

## M10 — Evals and hybrid decision
Golden task suite in evals/; run current models; evaluate adding a Claude Code / Codex worker behind the
worker contract on coding tasks.
Acceptance: eval report; routing decision recorded as a DR.
