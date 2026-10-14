# DR-0007: Research ledger (ARA) and claim gate
Status: Accepted (2026-10-13)

Each research project is one ARA artifact (https://github.com/ARA-Labs/Agent-Native-Research-Artifact)
in git, plus an `engine/` folder for our bookkeeping.

```
project/
  PAPER.md                      ~200-token manifest; read at every session start
  logic/  claims.md  experiments.md  related_work.md  solution/  hypotheses.md
  src/    configs/  environment.md   (+ HPC: machine, filesystem, striping, modules, MPI/library
                                      versions, allocation)
  trace/  exploration_tree.yaml       decisions and dead ends (first-class nodes)
  evidence/ tables/ figures/ raw/     written only by parsers and the executor
  lit/    notes/<paper-id>.md  refs.bib   (citations must resolve to DOI/DBLP)
  drafts/
  engine/ panels/ campaigns/ requests/ audit.log usage.jsonl decisions.md
```

## Hypotheses
Each hypothesis records, before experiments: prediction, falsification criterion, baseline to beat,
decisive experiment, kill criteria.

## Provenance tags (ARA tags extended with model and effort)
`user`, `user-revised`, `ai-suggested(<model>, <effort>)`, `ai-executed(<model>, <effort>)`.
Panel outputs stay `ai-suggested` until the user accepts them.

## Claim gate (nothing enters logic/claims.md otherwise)
1. Support check (code-first, provcheck-style): every factual statement in the claim is backed by
   evidence/ files, executor records, or transcripts that existed before the claim; numbers are re-read
   from the actual files. Model only extracts claims and judges ambiguous cases; it cannot create a match.
2. Rigor review (ARA rigor-reviewer skill and/or panel critique mode).
3. User approval.
Support is not correctness: the gate's report states what was checked and what was not.

## Writes
Raw episodes (transcripts, evidence) are kept. Consolidated knowledge (claims, PAPER.md, related_work)
changes only through gated, user-approved edits.

## Amendment (2026-10-14): M6 claim gate mechanics
- **Drafts:** one ARA claim block per file, `staging/claims/<name>.md` (the analysis role may write there; skill
  `skills/local/claim-drafting`). Sources are sub-bullets: `<value> ← <path>:<line> «verbatim line» [input|result]`
  or `<value> ← [pending: reason]`. The heading id is a placeholder; ids are assigned at approval.
- **Support check (code only, `re claim check`):** every source is read from the ledger *as committed* (`git show
  HEAD:path`), never the working copy. The cited line must equal the quote verbatim (line endings aside) and contain
  the value, exactly or as the claim's rounding of the file's value (|claimed − actual| ≤ half a unit in the claim's
  last digit). `[result]` values must come from `evidence/` or executor records (`engine/jobs/`); `[input]` may also
  come from `experiments/`, `src/`, `logic/`, `configs/`. Every number in Statement, Conditions and Proof must be
  backed by a source that checked out; identifiers in code spans, ids, dates and paths are not quantities. Pending
  sources fail. The report lists what was and was not checked.
- **Derived numbers come from code:** parsers (`packages/engine/parsers`, run in the agent image) write
  `evidence/tables/<EXP>/<job>/` with a `PARSED.json` record; tables inherit the provenance of their evidence.
  Fetched results also keep the exact job files (`evidence/raw/<EXP>/<job>/job/`), so inputs are citable.
- **Rigor review (`re claim review`):** only after the support check passes; one tool-less call to
  `routing.analysis.reviewer` with D1, D2, D3 and D6 of the vendored rigor-reviewer skill verbatim (D4, D5 are
  artifact-level). Committed as `ai-suggested` under `engine/claims/reviews/<draft sha256 prefix>`. Advice only.
- **Approval (`re claim approve`):** `Ledger.approveClaim` is the only writer of `logic/claims.md`. It re-runs the
  support check at the current commit, requires a review of this exact draft, refuses a hand-edited claims.md,
  assigns `C<nn>`, enters AI drafts as `user-revised`, and commits the claim with `engine/claims/<id>/{draft.md,
  gate.json}` (report, review, approval) in one commit.
