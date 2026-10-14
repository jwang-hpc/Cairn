# DR-0008: Multi-model panel
Status: Accepted (2026-10-13)

One panel tool, mode as a parameter. Members are (provider, model, effort) triples from config/models.yaml.
Input is a context packet (files from the ledger), identical for all members.

| Mode | Behavior | Typical use |
|---|---|---|
| independent | parallel, blind, no member sees another | ideation, first-pass hypotheses |
| critique | each critiques others' anonymized outputs | flaws in ideas/designs |
| debate | proposer vs critic for N rounds; ends with unresolved disagreements | contested interpretations |
| relay | A drafts, B revises, A finalizes | designs, sections |
| redteam | one member is a hostile reviewer for a named venue | pre-submission |
| synthesis | comparison matrix, not consensus | always last |

Rules
- Blind labels (Model A/B/...) in the UI until the user records a judgment; then unblind.
- Anti-sycophancy: members hold positions unless given a specific counter-argument; must state what
  changed their mind. Synthesis surfaces disagreements and never resolves them.
- Agreement between models is weak evidence (shared training data); novelty claims still require
  literature verification.
- Every round is stored under engine/panels/<id>/ with the event log.
- Budget-aware: queue calls; back off on usage-limit errors; high-effort multi-model panels reserved for
  hypotheses, novelty checks, result interpretation, and claim review.
- Panels run only on claims that passed the support check (DR-0007).

## Amendment (2026-10-13)
Panel composition rules (vendor diversity, size limits, synthesizer outside the panel) are in DR-0013.
