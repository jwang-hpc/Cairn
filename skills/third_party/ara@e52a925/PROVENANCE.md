# Provenance: ARA (Agent-Native Research Artifact) skills

- Source: https://github.com/ARA-Labs/Agent-Native-Research-Artifact (skills/), repository license MIT
  (Copyright (c) 2026 Orchestra Research; see LICENSE)
- Pinned commit: e52a925e9d03b4ada3008653e72f99b04116fca2 (2026-08-24; newest commit at least 14 days old
  when vendored, and the repository's head at that time)
- Vendored: 2026-10-14, unmodified (byte-identical copies). Adaptations go in skills/local/ as overrides,
  never edited here. Never installed by fetching remote prompts (invariant 7): the upstream one-line setup
  (`wire-ara.md`, `npx @ara-commons/ara-skills`) is deliberately not used.

| Skill | Upstream version | Author | Notes |
|---|---|---|---|
| research-manager | 2.6.0 | ara-commons | Defines the ARA schemas Cairn's ledger follows (exploration nodes, claims, provenance, staging). Assumes the artifact lives in `ara/`; Cairn projects are the ARA root (DR-0007) — adapt in skills/local/ |
| rigor-reviewer | 3.1.0 (2026-07-20) | unspecified (repo: Orchestra Research, MIT) | Claim-gate rigor review (DR-0007 step 2) |
| research-fuzzer | unspecified | unspecified (repo: Orchestra Research, MIT) | Contains Python helper scripts (scripts/log.py, scripts/tally.py); never executed by the engine, only by an agent inside its sandbox if a task calls for it |

Not vendored (not planned in DR-0012): compiler, context-drop (uploads to a third-party URL service),
research-foresight, research-visualizer, submit-ara (publishes to a third-party service).

## Files (sha256)
```
25ba8a25365fdc8475b0f7b4818d8ea629cb69d24e30632b0e1a95c759d7368a  ./LICENSE
0e2af034392a5b4de3dbe2e62c02094ce37d9f37026baaf4ec8328ec7eb51b1f  ./research-fuzzer/SKILL.md
dea5df45abd66e0c7b6776bd69cc61b55804827f17a07216c2b586033787bc01  ./research-fuzzer/references/example-notebook.jsonl
8d6d67cc5c16dc16ea59171b9a916ef527e9930f0b8c5ba43b22492dd0c2b788  ./research-fuzzer/scripts/log.py
bf4d4b311e9dec01d97472eb60add2a6b9153e760861d04a5c0406bafad6dd1f  ./research-fuzzer/scripts/tally.py
fc8fb52d57cbae4c754fd7bf9e6023dbf54fd4e796152d87786749e1f30d2c37  ./research-manager/SKILL.md
49a273dca8d05cbe27ad80f4e78907dea23d710db6ced635082204b5c040527b  ./research-manager/references/event-taxonomy.md
b6382632024d61ad57aff83d22caaef6858a8d511ffe141bc76ce34c5f73ca93  ./research-manager/references/taste-comments.md
dcbd8f19a2bec93c56f09d453339939ef2079f027f5ffb786d39e46d459995d4  ./research-manager/templates/reader-report.md
19324b1fadfdc612ec9a2cf43b8db2e86948fc61a745feef52d3e0edab5130c6  ./rigor-reviewer/SKILL.md
faf4c6c61a6f91e019407724b34b338827e0ffab4b7524aef3b579a26668c625  ./rigor-reviewer/references/review-dimensions.md
```
