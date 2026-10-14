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
