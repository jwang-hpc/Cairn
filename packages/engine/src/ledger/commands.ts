// `re project | hypothesis | trace | tree | decision | ledger` — the user's interface to project ledgers.
// Everything typed at the terminal is the user's own input, so CLI writes carry `user` provenance.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type DataClass, NODE_TYPES, type NodeType, provenance } from "@cairn/shared";
import type { Engine } from "../engine.js";
import { Ledger, LedgerError, type NodeInput } from "./ledger.js";

export const LEDGER_COMMANDS = ["project", "hypothesis", "trace", "tree", "decision", "ledger"] as const;

/** parseArgs option definitions used by ledger commands. */
export const LEDGER_OPTIONS = {
  project: { type: "string", short: "p" },
  title: { type: "string" },
  "data-class": { type: "string" },
  authors: { type: "string" },
  statement: { type: "string" },
  prediction: { type: "string" },
  falsification: { type: "string" },
  baseline: { type: "string" },
  experiment: { type: "string" },
  kill: { type: "string" },
  note: { type: "string" },
  refs: { type: "string" },
  parent: { type: "string" },
  depends: { type: "string" },
  description: { type: "string" },
  choice: { type: "string" },
  alternatives: { type: "string" },
  evidence: { type: "string" },
  result: { type: "string" },
  hypothesis: { type: "string" },
  failure: { type: "string" },
  lesson: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  trigger: { type: "string" },
} as const;

export const LEDGER_USAGE = `project commands (writes are tagged provenance: user, committed to the project repo):
  project new <name> --title T [--data-class public|unpublished|restricted] [--authors "A, B"]
  project list | project use <name> | project            (show current)
  hypothesis add --title T --statement S --prediction P --falsification F --baseline B
                 --experiment E --kill K [--parent N01]
  hypothesis list | hypothesis approve HY01 [--note N]   (approval = human gate 1)
  trace add question --title T --description D            [--parent N01] [--depends N02,N03]
  trace add decision --title T --choice C --alternatives "a; b" --evidence "N02; table1"
  trace add experiment --title T --result R --evidence "evidence/tables/t1.csv"
  trace add dead-end --title T --hypothesis H --failure F --lesson L
  trace add pivot --title T --from A --to B --trigger X
  tree                                                    (exploration tree as text)
  decision add --title T [--refs "HY01, N02"] [--note N]
  ledger check                                            (every write tagged?)
  (all accept --project <name>; default: CAIRN_PROJECT, then \`project use\`)`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
const list = (s: string | undefined) => (s ?? "").split(/[;,]/).map((x) => x.trim()).filter(Boolean);

export function projectsDir(engine: Engine): string {
  return resolve(expandHome(engine.config.engine.projects_dir ?? join(engine.paths.home, "projects")));
}
const statePath = (engine: Engine) => join(engine.paths.home, "state.json");

async function readState(engine: Engine): Promise<{ project?: string }> {
  try {
    return JSON.parse(await readFile(statePath(engine), "utf8")) as { project?: string };
  } catch {
    return {};
  }
}

async function writeState(engine: Engine, state: { project: string }): Promise<void> {
  await mkdir(engine.paths.home, { recursive: true, mode: 0o700 });
  await writeFile(statePath(engine), JSON.stringify(state));
}

export async function openCurrentProject(engine: Engine, v: Values, env: NodeJS.ProcessEnv): Promise<Ledger> {
  const name = (v.project as string | undefined) ?? env.CAIRN_PROJECT ?? (await readState(engine)).project;
  if (!name) throw new LedgerError("no project selected: pass --project <name>, set CAIRN_PROJECT, or run `re project use <name>`");
  return Ledger.open(join(projectsDir(engine), name));
}

function need(v: Values, keys: string[], usage: string): void {
  const missing = keys.filter((k) => typeof v[k] !== "string" || (v[k] as string).trim() === "");
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((k) => `--${k}`).join(", ")}\nusage: re ${usage}`);
}
class UsageError extends Error {}

const TRACE_TYPES: Record<string, NodeType> = { question: "question", decision: "decision", experiment: "experiment", "dead-end": "dead_end", dead_end: "dead_end", pivot: "pivot" };

export async function runLedgerCommand(engine: Engine, command: string, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    return await dispatch(engine, command, args, v, io, env);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`re ${command}: ${e.message}`);
      return 2;
    }
    if (e instanceof LedgerError) {
      io.err(`re ${command}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function dispatch(engine: Engine, command: string, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  const [sub, ...rest] = args;
  const user = provenance.user;
  switch (command) {
    case "project": {
      if (sub === "new") {
        const name = rest[0];
        if (!name) throw new UsageError("usage: re project new <name> --title T [--data-class C]");
        need(v, ["title"], "project new <name> --title T");
        const dc = (v["data-class"] as string | undefined) ?? engine.config.models.projects_default_data_class;
        if (!["public", "unpublished", "restricted"].includes(dc)) throw new UsageError("--data-class must be public, unpublished, or restricted");
        await mkdir(projectsDir(engine), { recursive: true });
        const l = await Ledger.create({
          projectsDir: projectsDir(engine), name, title: v.title as string, dataClass: dc as DataClass, authors: list(v.authors as string | undefined),
        });
        await writeState(engine, { project: name });
        io.out(`created ${name} (${dc}) at ${l.dir}`);
        io.out(`current project: ${name}`);
        return 0;
      }
      if (sub === "list") {
        const names = await readdir(projectsDir(engine)).catch(() => [] as string[]);
        const cur = (await readState(engine)).project;
        if (names.length === 0) io.out("(no projects)");
        for (const n of names.sort()) {
          try {
            const l = await Ledger.open(join(projectsDir(engine), n));
            io.out(`${n === cur ? "*" : " "} ${n}  [${l.dataClass}]`);
          } catch {
            // not a Cairn project; skip
          }
        }
        return 0;
      }
      if (sub === "use") {
        const name = rest[0];
        if (!name) throw new UsageError("usage: re project use <name>");
        await Ledger.open(join(projectsDir(engine), name));
        await writeState(engine, { project: name });
        io.out(`current project: ${name}`);
        return 0;
      }
      if (sub === undefined) {
        const l = await openCurrentProject(engine, v, env);
        io.out(`${l.name}  [${l.dataClass}]  ${l.dir}`);
        return 0;
      }
      throw new UsageError(`unknown subcommand '${sub}'\n${LEDGER_USAGE}`);
    }
    case "hypothesis": {
      const l = await openCurrentProject(engine, v, env);
      if (sub === "add") {
        need(v, ["title", "statement", "prediction", "falsification", "baseline", "experiment", "kill"], "hypothesis add --title ... (see re help)");
        const r = await l.addHypothesis(
          {
            title: v.title as string, statement: v.statement as string, prediction: v.prediction as string, falsification: v.falsification as string,
            baseline: v.baseline as string, decisive_experiment: v.experiment as string, kill_criteria: v.kill as string,
          },
          user,
          v.parent ? { parent: v.parent as string } : {},
        );
        io.out(`added ${r.id} (proposed), opened ${r.node} in the exploration tree`);
        io.out(`approve with: re hypothesis approve ${r.id}`);
        return 0;
      }
      if (sub === "list") {
        const hs = await l.hypotheses();
        if (hs.length === 0) io.out("(no hypotheses)");
        for (const h of hs) io.out(`${h.id}  ${h.status.padEnd(9)} ${h.title}  [${h.provenance}] (${h.opened})`);
        return 0;
      }
      if (sub === "approve") {
        const id = rest[0];
        if (!id) throw new UsageError("usage: re hypothesis approve HY01 [--note N]");
        const r = await l.approveHypothesis(id, user, v.note as string | undefined);
        io.out(`approved ${id}: decision ${r.decision}, node ${r.node}`);
        return 0;
      }
      throw new UsageError(`unknown subcommand '${sub ?? ""}'\n${LEDGER_USAGE}`);
    }
    case "trace": {
      if (sub !== "add") throw new UsageError(`usage: re trace add <${Object.keys(TRACE_TYPES).filter((t) => t !== "dead_end").join("|")}> ...`);
      const type = TRACE_TYPES[rest[0] ?? ""];
      if (!type) throw new UsageError(`node type must be one of ${NODE_TYPES.join(", ").replace("dead_end", "dead-end")}`);
      const l = await openCurrentProject(engine, v, env);
      const base = { type, title: v.title as string, ...(v.parent ? { parent: v.parent as string } : {}), ...(v.depends ? { also_depends_on: list(v.depends as string) } : {}) };
      const fields: Record<NodeType, () => NodeInput> = {
        question: () => (need(v, ["title", "description"], "trace add question --title T --description D"), { ...base, description: v.description as string, status: "open" }),
        decision: () => (need(v, ["title", "choice"], "trace add decision --title T --choice C --alternatives A --evidence E"),
          { ...base, choice: v.choice as string, alternatives: list(v.alternatives as string), evidence: list(v.evidence as string) }),
        experiment: () => (need(v, ["title", "result"], "trace add experiment --title T --result R --evidence E"), { ...base, result: v.result as string, evidence: list(v.evidence as string) }),
        dead_end: () => (need(v, ["title", "hypothesis", "failure", "lesson"], "trace add dead-end --title T --hypothesis H --failure F --lesson L"),
          { ...base, hypothesis: v.hypothesis as string, failure_mode: v.failure as string, lesson: v.lesson as string }),
        pivot: () => (need(v, ["title", "from", "to", "trigger"], "trace add pivot --title T --from A --to B --trigger X"),
          { ...base, from: v.from as string, to: v.to as string, trigger: v.trigger as string }),
      };
      const id = await l.addNode(fields[type](), user);
      io.out(`added ${id} (${type})`);
      return 0;
    }
    case "tree": {
      io.out(await (await openCurrentProject(engine, v, env)).renderTree());
      return 0;
    }
    case "decision": {
      if (sub !== "add") throw new UsageError("usage: re decision add --title T [--refs R] [--note N]");
      need(v, ["title"], "decision add --title T");
      const id = await (await openCurrentProject(engine, v, env)).addDecision(v.title as string, user, list(v.refs as string), v.note as string | undefined);
      io.out(`added ${id}`);
      return 0;
    }
    case "ledger": {
      if (sub !== "check") throw new UsageError("usage: re ledger check");
      const r = await (await openCurrentProject(engine, v, env)).check();
      if (r.ok) io.out(`ok: ${r.writes} ledger writes, ${r.commits} commits, all tagged`);
      for (const p of r.problems) io.out(`problem: ${p}`);
      return r.ok ? 0 : 1;
    }
  }
  return 2;
}
