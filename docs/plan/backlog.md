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
*Requested 2026-10-14; Zotero as the backend chosen the same day.* Papers found in one project stay in that project,
and the literature agent re-finds the same papers each time. Zotero becomes the shared library. It is already the
user's paper manager, with sync, group libraries, notes, and attachment storage, so Cairn adds no store of its own.
PiPilot's Paper Wiki (RFC-003) informed what is shared and how papers are identified (DOI, then arXiv id, then title
and year).
- **What goes to Zotero, and what stays in the project:**
  - To Zotero: the paper's verified metadata, from `literature.resolve`, and one child note. The note holds the
    paper-level sections (Problem, Method, Setup, Key numbers, Limitations, Artifact) and their `based_on`.
  - In the project: the relevance score and its reason, the synthesis, and anything about the project. Zotero
    syncs to Zotero's servers, so one project's ideas must not travel through it.
  - Restricted projects: they write nothing to Zotero, and no per-project collection names a restricted project.
- **Reads:** two routes, both used only by the host engine. Agents can't reach either: their network is pinned
  and blocked by the host firewall.
  - **Local API** of Zotero desktop: `http://localhost:23119/api/`, read-only, no key. It needs Zotero running and
    "Allow other applications on this computer to communicate with Zotero" turned on. It works offline and sees
    the desktop's local copies of attachments, including WebDAV-synced files.
  - **Web API:** `https://api.zotero.org`, with a read-only key. This is for an engine without Zotero desktop
    (e.g. a headless workstation, M9). Attachments stored on WebDAV are **not** reachable this way; only Zotero
    File Storage files are.
  - The literature agent gets a read-only tool, e.g. `literature.library`, to search the user's library first.
    Results are labelled untrusted data like any other, since imported metadata and group members' notes can
    hold anything. Any paper cited from the library still goes through `literature.resolve` into
    `lit/refs.bib`.
- **Writes:** never by an agent. Only on a user action: `re literature accept` offers "also add to Zotero?", or a
  separate `re library add`. Writes go through the Web API to the "Cairn" group only, so Cairn's items stay apart
  from the user's hand-curated library.
  Before creating an item, Cairn looks the paper up by DOI or arXiv id and attaches its note to an existing item
  rather than making a duplicate.
  - Each Cairn item gets the tag `cairn` and `Citation Key: <citekey>` in Extra (the Better BibTeX convention).
  - Writes honour `Backoff`/`Retry-After`, at most 4 concurrent requests, and version preconditions.
- **Keys:** a Zotero API key is a credential. It goes in the engine's secrets folder (`re literature key zotero`)
  and never into a container, config, or git (invariants 1 and 8). Read-only and write keys can be separate.
- **Full text and PDFs (later):** these come from the desktop's local copies (the local API or the storage folder),
  never by sending PDFs to the agent whole. A parser turns them into text in the sandbox, as with evidence
  (DR-0009).
- **Needs approval when scheduled:**
  - the domain `api.zotero.org`;
  - the `literature.library` tool;
  - how the engine reaches `localhost:23119` (host only).

  No new dependency is needed: plain HTTP with fetch.
- **Decided (2026-10-14):**
  - **Storage:** the user keeps PDFs on WebDAV, with local copies in Zotero desktop. PDFs and full text therefore come
    only through the desktop (local API or storage folder), never the Web API.
  - **Writes:** Cairn writes only to a separate Zotero group, "Cairn". Its key may write to that group alone; the
    user's personal library is read-only to Cairn. Cairn writes metadata and notes there, not PDFs: groups can't
    use WebDAV, so any group file would go to Zotero's own storage, under the group owner's quota.
  - **User-vouched citations:** an item in the user's personal library can be cited even when it has no DOI or
    arXiv id that `literature.resolve` could verify, e.g. the MPI standard, software manuals, theses, or lab
    reports. Its `refs.bib` entry is marked "vouched for by the user", with provenance `user` and the Zotero item
    key, and `re literature check` verifies it against that Zotero item instead of the public services. Agents
    can't write to the personal library, so they can't plant an item to cite. Items Cairn wrote to the "Cairn"
    group don't count as vouched; they were verified by `resolve` anyway.
- **Decide:**
  - Whether to use Zotero's indexed full text (`qmode=everything`, `/fulltext`) for search.
  - Whether per-project collections are worth the exposure.

