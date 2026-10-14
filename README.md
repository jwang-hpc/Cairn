# Cairn 

A local, human-in-the-loop research workbench: ideation and hypotheses, literature, experiment design,
offloading experiments to a workstation and HPC systems, result analysis, and paper writing, with
multi-model panels (Claude + GPT) and strict agent confinement. Packaged as a macOS Electron app.

- Design decisions: `docs/design/README.md`
- Build plan: `docs/plan/milestones.md`
- Instructions for coding agents: `CLAUDE.md`

Status: M0–M7 done (engine, confinement, executor for workstation and HPC, claim gate, literature); M8 (desktop
app) in progress: research sessions (chat with an orchestrator) are next. Requires macOS 26 with Apple `container`.

## Setup

```sh
corepack pnpm install
corepack pnpm run build
```

## The `re` command

`re` is the engine's command line (`packages/engine/dist/bin.js`); everything the app does can be done with it. It is
not installed globally. Either run it through pnpm from the repository folder:

```sh
corepack pnpm -s re status
```

or add an alias once, so `re` works in every terminal and folder:

```sh
echo "alias re='node $PWD/packages/engine/dist/bin.js'" >> ~/.zshrc   # run from the repository folder
source ~/.zshrc
re status
```

`re` runs the last build: after pulling or switching branches, run `corepack pnpm run build` again. `re --help`
lists the commands.

## The desktop app

```sh
corepack pnpm --filter @cairn/desktop dev
```

See `apps/desktop/README.md`.
