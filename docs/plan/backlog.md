# Backlog

Requests not yet scheduled into a milestone. Each notes where it fits and what must be decided first.

## Manage SSH connections (add / edit / remove machines)
*Requested 2026-10-14.* Computing infrastructure will change; adding or retiring a machine should not mean
hand-editing YAML.
- Fits: M5 (executor), later the app's settings (M8).
- Shape: `re machine add|edit|remove|list` editing `config/machines.yaml` (validated by the M1.3 loader:
  DOE machines never auto-approve and must declare allowed paths), plus a connection test that opens and
  checks a user-held ControlMaster (M0 spike 4 pattern).
- Decide: whether Cairn writes SSH host entries into its **own** file that `~/.ssh/config` `Include`s
  (recommended: Cairn never rewrites the user's `~/.ssh/config`) or only references existing aliases.

## Machine and job status in the app
*Requested 2026-10-14.* The app should show each machine's live state (free GPUs, free disk on scratch, load,
memory) and the state of HPC jobs, so the user can see what's running and what a new job would compete with.
- Fits: M8 (app: job/campaign monitor), with collection in the executor (M5 transport) and the optional
  workstation poller of M9.
- What to collect, all through the executor's existing mux-only transport and read-only commands:
  - **Workstation:** `nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv`,
    `df -Pk <scratch>`, `/proc/loadavg`, `/proc/meminfo`, and Cairn's own running jobs (`.cairn/` state).
  - **Slurm HPCs:** `sinfo` per allowed partition (idle/mixed/allocated nodes, GPUs via GRES), `squeue -u $USER`
    (all the user's jobs, not only Cairn's), `sshare` (fair-share), scratch usage (`df`/`lfs quota` where the
    site supports it). Job state already comes from `squeue`/`sacct` (M5); the app shows it live.
- Shape: `re machine status [name]` first (CLI-first rule, DR-0002), then the app polls the engine API. Each
  snapshot carries its time; with no open SSH session the app shows the last snapshot and its age rather than
  opening a connection (the user's master is the human gate, DR-0006).
- Uses: the approval card can show the machine's current state next to the request (e.g. "requests 1 GPU; 0 of
  1 free now"), and lint can warn when a job asks for more than is free. Whether agents may see machine status
  (via a read-only `jobs.machines` tool) is a separate decision: it would send partition and load details to
  model providers.
- Decide: polling interval and when to poll (only while a master is open, or via the M9 workstation poller
  that writes snapshots the executor reads); what the HPC centre's policies allow for periodic `sinfo`/`squeue`
  calls (keep them infrequent).

## Count skill usage
*Requested 2026-10-14.* How often each skill is actually used.
- Fits: the skill loader (DR-0012: metadata first, body on use), not yet scheduled.
- Shape: when an agent loads a skill body, log a `skill_use` event (skill name, source, agent, role, run).
  Counts are derived from the event log (DR-0004 seam 3); `re skills stats [--since]` reports them. Also feeds
  DR-0012's "delete scaffolding that no longer helps".

## Write to Overleaf projects
*Requested 2026-10-14.* Let agents' drafts reach an Overleaf project.
- Fits: with the writer role / drafting work (after M6), as a new executor capability.
- Shape: agents write `drafts/` in their worktree only (no credentials in containers, invariant 1). An
  executor MCP tool `overleaf.push(project)` syncs approved drafts to the Overleaf project's git remote
  **after user approval** (same gate as pushing to GitHub, DR-0001 gate 5); pulls bring co-author edits back
  for review.
- Needs: Overleaf Git integration (a paid Overleaf feature) or GitHub sync; an Overleaf git token stored on
  the host (Keychain, M8); a new network domain (`git.overleaf.com`) approved for the executor only.
- Decide: git integration vs. GitHub sync; whether pulls are automatic or on request.
- Bibliography with the git push: the Overleaf repo's `refs.bib` is a **derived copy**, never a second source.
  - **The record:** the project's `lit/refs.bib` stays the only record.
  - **On each push:** Cairn regenerates Overleaf's copy from it. Optionally the copy holds only the entries the draft
    cites, which is what a submission needs.
  - **Edits made in Overleaf** (e.g. a co-author adds a reference by hand) come back on the pull and are flagged, not
    merged silently. A new reference enters `lit/refs.bib` through `resolve` (or as user-vouched from Zotero), and the
    next push carries it. The same holds for `drafts/`, which the Overleaf repo mirrors.
- Bibliography, for now (2026-10-14): the user copies each project's `lit/refs.bib` into the Overleaf project by
  hand. Its citekeys are the ones the drafts cite. Overleaf's own Zotero link is not used: it is a premium feature,
  imports a whole library (not a collection), and generates its own citekeys.

## Skill and feature trials
*Requested 2026-10-14.* Try new features and skills (e.g. Dong Dai's newest PiPilot skills,
K-Dense-AI/scientific-agent-skills, K-Dense-AI/claude-scientific-writer) before they reach "production".
- Recommendation: not long-lived git branches (they drift and can't A/B the same engine). Instead:
  - **Skills:** vendor candidates pinned and unmodified under `skills/candidates/<source>@<commit>/` (license +
    PROVENANCE, scanned for network/install instructions), **not loaded by default**. `config/skills.yaml`
    enables a candidate per role, project, or run; the event log records the active skill set per run.
    Promote to `third_party/` only when a with/without comparison on the same tasks (DR-0012 evals) and the
    skill-usage counts justify it; otherwise delete.
  - **Engine features:** keep short per-task branches; unfinished features behind config flags on `main`.
  - **"Production":** tag releases (`v0.x`); the workstation's headless engine and the app run a tag.
- Needs: user approval per source (new network fetch, licenses); after M3 so trials run against a ledger.

## Data class in the app
*Requested 2026-10-14.* Most projects use open science data, but the user should say so explicitly instead of
the app assuming it (the CLI already does; DR-0013 amendment).
- Fits: M8 (the new-project dialog and the project header).
- Shape: the new-project dialog has a required choice, with no preselected option. Each option has one plain line:
  - **open**: public or open-science datasets, code, and results;
  - **not public yet**: the user's unpublished results, code, or drafts;
  - **restricted**: e.g. DOE or export-controlled data, or data under an agreement.

  The project header shows the class. Changing it later is a recorded decision (`engine/decisions.md`); it is
  never edited silently. The engine API gains `POST /api/projects` with a required `data_class`.
- Decide: whether `restricted` projects may send literature search queries to the public scholarly APIs. The
  queries are short keyword strings, not project data, but they can reveal what a project is about. Options:
  - allowed, as for every other class (today's behaviour);
  - off for `restricted` unless the user allows it for that project (asked in the same dialog);
  - an allowlist of data classes for the literature services in engine.yaml, like the one for model providers.

## Paper library across projects (Zotero)
*Requested and designed 2026-10-14.* Papers found in one project stay in that project, and the literature agent
re-finds them every time. The user's Zotero library becomes the shared library. Zotero is already the user's paper
manager (Zotero 10, metadata synced by Zotero, PDFs on the user's WebDAV with local copies in Zotero desktop), so
Cairn adds no store of its own. PiPilot's Paper Wiki (RFC-003) informed what is shared and how papers are identified (DOI,
then arXiv id, then title and year).

**Who does what.** Agents never touch Zotero; only the Cairn engine on the user's Mac does.

| | Who | How | What |
|---|---|---|---|
| Search online | literature agent | `literature.search/fetch/expand` tools, run by the engine | Semantic Scholar, OpenAlex, arXiv, Crossref |
| Search Zotero | literature agent | new read-only `literature.library` tool, run by the engine through the desktop's local API | metadata of the user's items (title, authors, year, ids); not the user's own notes or annotations |
| Cite | literature agent | `literature.resolve` writes `lit/refs.bib` in its worktree | verified works, or works the user saved in Zotero ("vouched") |
| Write to Zotero | Cairn engine, only when the user accepts | desktop local API (Zotero 10+), one Zotero "Allow" dialog per write | new items and notes in the "Cairn" collection |
| PDFs | Zotero desktop | attached to items in the personal library; synced to the user's WebDAV like the user's own | whatever Zotero or Cairn attaches |

- **Where Cairn writes:** the user's personal library, so PDFs sync to the user's WebDAV like the rest. Items go
  under a parent collection "Cairn", with one subcollection per project, named after the project or its topic.
  - Each item Cairn creates gets the tag `cairn`, `Citation Key: <citekey>` in Extra (the Better BibTeX
    convention), and a child note with the paper-level sections (Problem, Method, Setup, Key numbers,
    Limitations, Artifact, and `based_on`).
  - If the paper is already in the library (found by DOI or arXiv id), Cairn adds that item to the project's
    subcollection and adds its note. It never edits or deletes the user's fields or items.
  - Restricted projects write nothing to Zotero.
- **What stays in the project:** the relevance score and its reason, the synthesis, and anything about the project.
  Zotero syncs to Zotero's servers, so one project's ideas don't travel through it.
- **How writes are approved:** only after the user accepts in Cairn (`re literature accept` asks "also add to
  Zotero?", or `re library add`). Each write then uses a single-use key that Zotero grants through its own
  Allow/Deny dialog: two human approvals, and no stored write key. A local key can write to any library, so
  "only the Cairn collection, never edit the user's items" is enforced by Cairn's code; the dialog is the
  backstop. Writes need Zotero desktop running; with it closed, Cairn tells the user and writes nothing.
- **PDFs:** Cairn fetches none at first. For a paper Cairn added, the user's Zotero "Find Available PDF" uses the
  user's own (university) access, and the PDF lands on WebDAV. Later, Cairn could attach open copies from arXiv or
  Unpaywall through the same local API; those are new domains to approve. Full text for agents comes from the
  desktop's local copies, turned into text inside the sandbox; a PDF never goes to an agent whole (DR-0009).
- **User-vouched citations:** an item the user saved can be cited even without a DOI or arXiv id that `resolve`
  could verify (e.g. the MPI standard, software manuals, theses, lab reports).
  - Its `refs.bib` entry is marked "vouched for by the user", with provenance `user` and the Zotero item key.
  - `re literature check` verifies it against that Zotero item.
  - Items Cairn created don't count as vouched. Cairn keeps its own record of the item keys it created (the
    `cairn` tag can be edited), and those items were verified by `resolve` anyway.
- **Agent reads are untrusted data,** like every other literature result: imported metadata can hold anything.
- **Needs approval when scheduled:**
  - the `literature.library` tool;
  - the engine reaching `localhost:23119` (host only; agents can't, since their network is pinned and firewalled).

  No new dependency is needed: plain HTTP with fetch. The Web API (`api.zotero.org`, a new domain) is needed only
  for reading without Zotero desktop, e.g. a headless workstation.
- **The same paper in several projects** (e.g. HPC I/O and compression projects citing SZ3):
  - **One paper, one Zotero item.** Before creating anything, Cairn looks the paper up by DOI or arXiv id. If the
    item exists, Cairn adds it to the second project's subcollection; a Zotero item can sit in many collections.
    Cairn keeps its own map in the engine home: id → item key, note key, and the hash of the note it wrote. It can
    be rebuilt from the `cairn` tag and the citation keys.
  - **One citekey everywhere.** The `Citation Key` in Zotero is library-wide. `literature.resolve` asks the library
    first and reuses that key, so SZ3 is `liang2023sz3` in every project. A clash suffix (`a`, `b`) is assigned
    once, library-wide, when the item is created, not per project.
  - **One paper-level note, reused.** `literature.library` shows the agent the existing Cairn note, so a second
    project extends it instead of re-reading the paper. When a new note differs, Cairn never overwrites silently.
    At accept time the user sees the difference and chooses: keep, replace, or keep both. Replacing is suggested
    only when the new note rests on more (full text over abstract). A note the user has edited since Cairn wrote
    it is never replaced; the new one is added beside it.
  - **Per-project parts never conflict.** Relevance scores and syntheses live in each project, so the same paper can
    score 9 in one project and 5 in another.
  - **The project ledger stays the record.** Each project keeps its own `refs.bib` and notes (DR-0007) and can be
    rebuilt without Zotero; Zotero is the shared hub. A user's later fix to a Zotero item doesn't silently change
    a project's `refs.bib`. `re literature check` flags vouched entries whose item changed.
  - **Duplicates already in the library:**
    - Two items with the same DOI: Cairn uses the earliest one and tells the user to merge them in Zotero
      ("Duplicate Items"). Cairn never merges or deletes them itself.
    - **A preprint and its published version are one paper** (decided 2026-10-14): in projects they are already
      one reference (DR-0006 M7 amendment). In Zotero, Cairn warns and merges them the way Zotero's own merge does.
      The published item is kept, and the preprint's notes, PDFs, tags, and collections move to it. The arXiv id
      goes into its Extra, a `dc:replaces` relation records the merged item so documents citing it still resolve,
      and the preprint item goes to the Zotero trash (recoverable). This applies to the user's own items too:
      the one exception to "never edits the user's items", made only after the user confirms. If the two differ
      substantially (title or first author), they stay separate and are marked related.
  - **Two projects accepting at once:** Zotero writes go through one engine lock, and the lookup and the create
    happen inside it, so the second accept finds the item the first one created. Note updates carry version
    preconditions, so a concurrent edit can't be lost.
- **Decide:** whether search may use Zotero's indexed full text (it would show agents text from the user's PDFs).

