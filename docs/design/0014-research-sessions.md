# DR-0014: Research sessions: a chat-centred app
Status: Proposed (2026-10-14). Needs the user's OK before it is built.

## Context
- **The gap:** the user expected to work with Cairn the way they work with Claude or ChatGPT: a chat window in which
  they start, delegate, and discuss work. The spec never had one.
  - M8 listed a project view, an approval inbox, panel comparison, monitors, and usage.
  - Models are reached only from the CLI: `re ask` is a one-off question with no project and no tools, and
    `re run --task` hands a task file to a sandboxed worker.
  - So after a "no" (a denied job, a REVISE review) nothing carries the conversation on.
- **What DR-0009 already plans:** an orchestrator with a clean main context that delegates to disposable workers.
  It was never scheduled. This DR schedules it, as the centre of the app.

## Decision
1. **Layout.** The chat is the centre of the app, one per project. Around it, as side panels:
   - **Outline:** PAPER.md, the problem, hypotheses, the exploration tree.
   - **Approvals:** jobs, claim drafts, and literature branches waiting for the user.
   - **Results:** figures and tables from `evidence/figures/`, `evidence/tables/`, `analysis/`.
   - **Literature:** paper notes by relevance.
   - **Paper:** a preview of `drafts/`.
   - **Usage.**

   The M8.2–M8.3 views become these panels.
2. **The orchestrator** is an agent in the host engine (pi-agent-core), one per session.
   - **What it reads:** the project as committed, through read-only tools: list, read (bounded), and search files;
     job and claim state. The paths come from a new `orchestrator` role in `roles.yaml` ("permissions are data",
     DR-0004): PAPER.md, `logic/`, `trace/`, `evidence/tables/`, `analysis/`, `lit/notes/`, `engine/claims/`,
     `engine/jobs/`.
   - **What it can't do:** write, run a shell, reach the network, hold a credential, or use a sandbox. Ledger
     content it reads (literature abstracts, agent output) is untrusted, so prompt injection can at worst produce
     a bad proposal, which the user sees before anything happens.
   - **What it proposes, as cards in the chat:**
     - delegate a task to a worker (role, task text, referenced files);
     - add a hypothesis, an exploration-tree node, or a decision. These are ledger writes, made after the user
       clicks, with provenance `ai-suggested`.

     It cannot approve a job or a claim, and it starts nothing by itself (see Open).
   - **Model:** `routing.orchestrator` in models.yaml, chosen by evals (DR-0012). Its calls go through the model
     layer: data-class gating, budgets, and the event log (invariants 6 and 9).
3. **Delegation.**
   - **Launch:** a launched card starts a worker (`runWorker`, the same path as `re run`) in the background, and
     its steps stream into the chat from the event log.
   - **Report back:** when the worker ends, a message shows its report, the files it changed, and anything now
     waiting for approval (a job, a claim draft, a literature branch), with links into the panels.
   - **Gates:** unchanged.
   - **Loops** come as cards: a REVISE review gets "revise with these findings" for the analysis agent; a denied
     job gets "send back with my reason" for the coder.
4. **Sessions and memory** (DR-0009).
   - **Storage:** a session is a transcript in the engine home (`sessions/<project>/<id>.jsonl`, host only, mode
     0600), not in the ledger.
   - **Compaction** follows PiPilot's coordinator:
     - past a token threshold, older turns are summarized and recent turns kept verbatim;
     - a tool call is never separated from its result;
     - later compactions extend the summary rather than redo it;
     - a summarizer failure never breaks the session.
   - **New sessions** start from a brief generated from the ledger, not from old chats.
   - **What persists** is recorded in the ledger through cards (a decision, a hypothesis, a dead end).
5. **CLI parity** (DR-0002). `re chat [--project P] [--session S]` is the same session in a terminal; cards appear
   as numbered proposals, launched by number.
6. **Results and paper.**
   - **Results:** images (PNG, JPEG, SVG) and PDFs, read through the engine API with type and size checks. SVG is
     shown only as an image, so no script in it runs. CSV tables are shown as tables.
   - **Paper:** the preview renders Markdown drafts. LaTeX and PDF builds come with the writer role.

## Open (for the user)
- **Autonomy:** may the orchestrator start read-only worker tasks (a literature search, an analysis that writes
  nothing) without a click? Default: no, every launch is a click.
- **Concurrency:** how many workers may run at once per project? Default: one, with the rest queued.

## Plan
This replaces the order of M8's remaining work.
- **M8.4 engine:**
  - orchestrator sessions: read-only tools, proposals, compaction, transcripts;
  - background delegation with progress events;
  - API: sessions, messages streamed over SSE, proposals, runs;
  - `re chat`.
- **M8.5 app:** the chat-centred layout. The Outline, Approvals, Results, and Literature panels take over the M8.2
  and M8.3 views.
- **M8.6:** paper preview; then blind panel comparison, notifications, Keychain, and signing.
- **Acceptance**, without leaving the app:
  1. ask in the chat why C01 got REVISE;
  2. delegate "add five repeated runs to EXP-001";
  3. approve that job;
  4. see the new figure in Results;
  5. delegate a revised claim, and approve it.
