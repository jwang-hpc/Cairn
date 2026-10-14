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
