# DR-0001: Scope and design principles
Status: Accepted (2026-10-13)

## Scope
A workbench that helps one researcher: turn questions into falsifiable hypotheses; find and verify related
work; design experiments; run them on a workstation and HPC systems; parse results; reason about
scientific contribution; write papers. Not an autonomous scientist. Not a multi-user service.

## Human gates (always on)
1. Selecting hypotheses to pursue. 2. Compute above policy thresholds. 3. Any claim entering the ledger.
4. Any action on DOE machines. 5. Pushing to GitHub.
The single autonomous mode is a pre-approved sweep campaign (DR-0011).

## Principles (transferable to other agentic systems)
- Verification is the bottleneck, not intelligence. Build checks before capabilities.
- Code handles hard evidence; models extract and judge ambiguous cases, never invent evidence.
- State lives outside the model. Sessions are disposable; the ledger is the system.
- Capabilities as tools, never credentials. Tool boundaries carry policy, approval, and audit.
- Isolation by default; least privilege per role.
- Context is a budget: clean main context, specialized subagents, compact returns.
- Memory writes are dangerous: gate them; keep raw episodes; consolidate sparingly.
- Novelty checking is infrastructure (retrieval + provenance + replay), not prompting.
- Papers are narratives: check code, artifacts, and appendices, not only the text.
- Evals decide upgrades (models, workers, skills), not preference.

Lessons drawn from Dong Dai's posts ("Auto Research Is Real", "Agent Reliability Is a Systems Problem",
"Agent Memory: Accuracy, Cost, and Gaps") and his PiPilot implementation.
