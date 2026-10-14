---
name: claim-drafting
description: |
  Draft a research claim for Cairn's claim gate (DR-0007) from evidence in the project. Use when asked to draw a
  conclusion from experiment results. Writes one ARA claim block per file under staging/claims/. Every number in
  the claim must be copied from a file line that is quoted verbatim in Sources; code checks each one, and a claim
  with any unbacked or wrong number is refused before a human sees it.
---

# Drafting a claim for the claim gate

Nothing enters `logic/claims.md` except through the gate: **(1)** a code check of every number against the cited
files, **(2)** a rigor review by another model, **(3)** the user's approval. You only write the draft. It extends the
ARA research-manager "Claim" schema; read `/skills/third_party/ara@*/research-manager/SKILL.md` ("Number grounding")
for the reasoning behind it.

## Where

One claim per file: `staging/claims/<short-name>.md`. Don't edit `logic/claims.md`; you can't, and it would be refused.

## Format

```markdown
## C??: <the generalized takeaway, not a recipe name>
- **Statement**: <the mechanism or relationship the evidence supports; no run numbers here>
- **Conditions**: <the regime it holds in, and the untested boundary>
- **Sources**:
  - <value> ← <path>:<line> «<that line, copied exactly>» [result]
  - <value> ← <path>:<line> «<that line, copied exactly>» [input]
- **Status**: supported | weakened | testing | hypothesis
- **Provenance**: ai-suggested
- **Falsification**: <a concrete observation that would disprove it>
- **Proof**: <the run(s) and numbers, e.g. "Job `20261014-1251-c30f`: 9592 primes below 100000 in 0.0052 s">
- **Dependencies**: []
- **Tags**: <comma-separated>
```

## Rules the code check enforces

1. **Open before you write.** Read the file, find the line, copy it verbatim between « and », then copy the number
   from that quote. Never type a number from memory.
2. **One Sources entry per number** in Statement, Conditions, and Proof. A number may appear rounded
   (`0.0052` for `0.00518620199727593`), but a rounding that changes the digits it keeps is a different number.
3. **Results only from `evidence/`** (`evidence/raw/<EXP>/<job>/` from the executor, `evidence/tables/` from parsers)
   or executor records (`engine/jobs/`). Tag them `[result]`. Values you set (N, cores, walltime) are `[input]`; cite
   them from `evidence/raw/<EXP>/<job>/job/` (the exact files the job ran).
4. **Derived numbers come from code.** A ratio, mean, or speedup must be in a file: use the parser tables
   (`evidence/tables/<EXP>/<job>/*.summary.csv`, `*.ratios.csv`) and cite that line. Don't compute it yourself.
5. **Identifiers go in `code spans`**: job ids, Slurm ids, versions, paths. Numbers in code spans aren't quantities.
6. **Paths and line numbers** are relative to the project root and 1-based. The check reads the committed ledger,
   so cite files that already exist there.
7. Can't find a source? Write `<value> ← [pending: what's missing]`. The claim won't pass, but it stays honest.

## Scope

Claim what the evidence supports and no more: one machine, one run, three sizes is a narrow regime. Say so in
Conditions. The reviewer and the user will judge the inference; the code check only proves the numbers are real.
