# Cairn 

A local, human-in-the-loop research workbench: ideation and hypotheses, literature, experiment design,
offloading experiments to a workstation and HPC systems, result analysis, and paper writing, with
multi-model panels (Claude + GPT) and strict agent confinement. Packaged as a macOS Electron app.

- Design decisions: `docs/design/README.md`
- Build plan: `docs/plan/milestones.md`
- Instructions for coding agents: `CLAUDE.md`

Status: M0 (de-risking spikes) and M1 (engine skeleton, `re` CLI) done; next is M2 (launcher and confined
tools). Requires macOS 26 with Apple `container`.
