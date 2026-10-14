# DR-0012: Skills, model evolution, and evaluation
Status: Accepted (2026-10-13)

## Skills
- Format: Agent Skills (SKILL.md with name/description; extra fields ignored).
- skills/third_party/<source>@<commit>/: vendored, unmodified, with LICENSE and PROVENANCE.md.
  Current: pipilot@3b8afef (all 19 skills). Planned: ARA skills (research-manager, rigor-reviewer,
  research-fuzzer) pinned the same way.
- skills/local/: our skills and overrides (same name overrides third-party). Planned local skills:
  hypothesis framing, Slurm/PBS job authoring per machine, compression-evaluation parsing, I/O benchmark
  methodology, IEEE/ACM LaTeX conventions, HPC venue writing (SC, HPDC, IPDPS, CLUSTER, TPDS).
- Third-party skills that reference PiPilot-only tools (literature-search, generate_diagram, Paper Wiki)
  get local overrides pointing at our MCP tools. compute-* skills are design references only.
- Unattributed PiPilot skills: fine for the private prototype; confirm origin before public release.
- Loader: progressive disclosure (metadata first, body on use), intent-based activation; see PiPilot loader.

## Model evolution
- Model IDs, roles, and effort levels live in config/models.yaml (routing table). No model IDs in code.
- Every ledger entry records model ID and engine version.
- Shim pattern for models pi-ai does not yet know.

## Evaluation (evals/)
15–30 golden tasks from the user's own research, each with a known answer, e.g.: recover a known related-
work set; catch a planted bug in an experiment script; interpret a result table with a known conclusion;
reject an "idea" that is already published; build and run a known compressor configuration.
Run on every model or worker change; promote only where it wins; keep the false-positive gate fixed.
Re-test skills with and without new model capabilities; delete scaffolding that no longer helps.
