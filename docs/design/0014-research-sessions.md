# DR-0014: Research sessions: a chat-centred app
Status: Accepted (2026-10-14), with the user's changes after a survey of PiPilot's app (see "Amendment" below).

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
       clicks, with provenance `user-revised` (the orchestrator drafted it, the user accepted it), as with claims
       from the gate.

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

## Decided (2026-10-14)
- **Autonomy:** every worker launch is the user's click. The orchestrator starts nothing by itself, read-only tasks
  included.
- **Concurrency:** up to three delegated workers may run at once per project; any further launches wait in a queue.
  Each worker has its own sandbox and branch.

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

## Amendment (2026-10-14): user's changes after a survey of PiPilot's app
PiPilot (Dong Dai's Research Copilot) puts one chat at the centre with tabs and a preview drawer. Its approvals live
in a "Needs you" queue in its Compute tab. Its known gaps: one thread per project with no way to start or switch
chats, earlier answers lost after an analysis step, input blocked while the agent works, no in-app figures or paper
preview, and agent code running unsandboxed on the host. The user adopted the following; they replace point 1 above
where they differ.
- **Layout:**
  - **Centre tabs:** Chat | Literature | Results | Approvals, with badges for what waits.
  - **Left sidebar:** the project outline (problem, hypotheses, exploration tree) and files.
  - **Preview drawer:** an item opened from anywhere (figure, table, claim, note, draft, a worker's log) slides in
    over the chat, which keeps the chat wide. Paper preview opens there too.
- **One "Needs you" queue:**
  - Approval cards appear in the chat and are mirrored in the Approvals tab, with badges.
  - "Send back" requires the user's comment.
  - Approving acts directly through the engine, without a model call. The result comes back as a system row,
    never as a message in the user's name.
- **Chat details:**
  - one compact card per worker, with its steps folded;
  - a footer per round with time and cost;
  - a "welcome back" recap built from the ledger (what was done, what is next);
  - "save to ledger" on a message, as a decision or note;
  - @-mentions of project items;
  - the user can keep typing while workers run; messages queue for the orchestrator.
- **Chats:** one continuing chat per project, with compaction and persisted summaries, plus "New chat", which
  starts fresh from the ledger.
- **What each sub-agent is doing (the user's question).** The user talks with the orchestrator; the orchestrator
  delegates to sub-agents (workers). Every delegated worker shows in the chat as a live card:
  - **The card:** role and task, state (queued, running, done, failed, needs input), elapsed time, cost so far,
    and its current step in plain words ("reading evidence/tables/…", "running bench.py", "wrote
    staging/claims/…"), with the earlier steps folded ("show all 23 steps").
  - **An activity strip** above the input lists every running worker (up to three) with its current step.
  - **Opening a card** shows the worker's full log in the preview drawer: every step, the commands and their
    output, and its messages. A Stop button ends the worker.
  - **When the worker ends,** its card shows the report, the files it changed, and anything now waiting for approval.
  - **Questions:** a worker that needs a decision ends with its questions as a card in the chat. The user's answer
    goes to a new worker run with that answer and the earlier report (sessions stay disposable, DR-0009).

  The steps come from the event log, which already records each worker's tool calls and results by run
  (invariant 6). Talking to a running worker directly (steering it mid-run) stays out of scope for now.
