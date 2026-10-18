// `re chat`: research sessions in a terminal (DR-0014, CLI parity with the app). You talk with the orchestrator; it reads
// the project and proposes; you launch. A launched worker runs in this process, so `re chat launch` follows it until it
// ends (Ctrl-C stops it, keeping what it changed). The app does the same through `re serve`.
import { join } from "node:path";
import type { JobServiceOptions } from "@cairn/executor";
import type { Engine } from "../engine.js";
import { openJobService } from "../jobs/jobs.js";
import { openCurrentProject } from "../ledger/commands.js";

import { openLiteratureService } from "../literature/literature.js";
import { REPO_ROOT } from "../paths.js";
import type { WorkerDeps } from "../worker/run.js";
import { Delegations, SessionHub } from "./delegate.js";
import { runTurn } from "./orchestrator.js";
import { type Proposal, type SessionRecord, SessionStore, type TranscriptEntry } from "./store.js";

export const CHAT_COMMANDS = ["chat"] as const;
export const CHAT_OPTIONS = { session: { type: "string" }, new: { type: "boolean" } } as const;
export const CHAT_USAGE = `chat commands (research sessions: talk with the orchestrator; it reads the project and proposes, you launch):
  chat                               interactive chat on the current project (/launch P1, /dismiss P1, /show, /new, /quit)
  chat say <message...>              one message; prints the answer and any proposals
  chat sessions                      this project's sessions, newest first
  chat show                          the session's latest transcript and its proposals
  chat launch <P#>                   launch a proposal; a worker task is followed until it ends (Ctrl-C stops it)
  chat dismiss <P#>                  set a proposal aside
  (all take --session <id> (default: the latest; --new starts one) and --project <name>)`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
  write?(chunk: string): void;
  interactive?: boolean;
  ask?(question: string): Promise<string>;
}
export interface ChatDeps {
  jobs?: Partial<JobServiceOptions>;
  /** Worker deps overrides (tests inject a sandbox stand-in). */
  worker?: Partial<Omit<WorkerDeps, "engine" | "observe">>;
}

export function proposalLine(p: Proposal): string {
  const what = p.kind === "task" ? `[${p.role}]` : "[decision]";
  const o = p.outcome;
  const tail = o
    ? ` — ${o.summary.split("\n")[0]!.slice(0, 160)}${o.jobs.length ? ` · jobs waiting: ${o.jobs.join(", ")}` : ""}${o.drafts.length ? ` · drafts: ${o.drafts.join(", ")}` : ""}${o.literature ? " · literature: re literature check" : ""}${o.questions.length ? ` · questions: ${o.questions.join(" | ")}` : ""}${o.error ? ` · ${o.error}` : ""}`
    : p.recorded
      ? ` — recorded as ${p.recorded}`
      : "";
  return `${p.id} ${what} ${p.title}  (${p.state})${tail}`;
}

function entryLines(e: TranscriptEntry): string[] {
  if (e.kind === "user") return [`you> ${e.text}`];
  if (e.kind === "assistant") return [`orchestrator> ${e.text || (e.error ? `(error: ${e.error})` : "(no answer)")}`];
  if (e.kind === "proposal") return [`  card ${proposalLine(e.proposal)}`];
  if (e.kind === "system") return [`  · ${e.text}`];
  return [];
}

export async function runChatCommand(engine: Engine, args: string[], v: Values, io: Io, env: NodeJS.ProcessEnv, deps: ChatDeps = {}): Promise<number> {
  const [sub = "", ...rest] = args;
  if (!["", "say", "sessions", "show", "launch", "dismiss"].includes(sub)) {
    io.err(`re chat: unknown subcommand '${sub}'\n${CHAT_USAGE}`);
    return 2;
  }
  const ledger = await openCurrentProject(engine, v, env);
  const store = new SessionStore(engine.paths.home);
  const jobs = openJobService(engine, deps.jobs);
  const hub = new SessionHub();
  const delegations = new Delegations({
    engine,
    store,
    hub,
    ledgerFor: async () => ledger,
    worker: { skillsDir: join(REPO_ROOT, "skills"), jobs, ...deps.worker },
    workerExtras: async () => (deps.worker?.literature ? {} : { literature: await openLiteratureService(engine) }),
  });
  hub.subscribe((e) => {
    if (e.type === "worker_step") io.out(`  ${e.proposal} · ${e.step}`);
    // Between "launched" and the final line, only the start is news.
    else if (e.type === "proposal" && e.proposal.state === "running") io.out(`  ${e.proposal.id} started`);
  });

  if (sub === "sessions") {
    const list = await store.list(ledger.name);
    if (list.length === 0) io.out(`(no sessions in ${ledger.name}; start one with re chat)`);
    for (const s of list) io.out(`${s.id}  ${s.updated.slice(0, 16).replace("T", " ")}  ${String(s.turns).padStart(3)} turns  ${s.title}`);
    return 0;
  }

  const session = async (create: boolean): Promise<SessionRecord> => {
    if (typeof v.session === "string") return store.load(ledger.name, v.session);
    if (!v.new) {
      const latest = (await store.list(ledger.name))[0];
      if (latest) return store.load(ledger.name, latest.id);
    }
    if (!create) throw new Error(`no session in ${ledger.name} yet; start one with re chat`);
    const s = await store.create(ledger.name);
    io.err(`new session ${s.id} on ${ledger.name}`);
    return s;
  };

  const say = async (rec: SessionRecord, text: string) => {
    // Stream the answer where the terminal can take partial lines; otherwise print it whole.
    if (io.write) io.write("orchestrator> ");
    let streamed = false;
    const r = await runTurn({ engine, ledger, store, jobs: async () => (await jobs.list({ project: ledger.name })).map((j) => ({ id: j.id, state: j.state, experiment: j.experiment, target: j.target })) }, rec, text, {
      delta: (t) => {
        streamed = true;
        if (io.write) io.write(t);
      },
    });
    const answer = r.text || (r.error ? `(error: ${r.error})` : "(no answer)");
    if (!io.write) io.out(`orchestrator> ${answer}`);
    else io.write(streamed ? "\n" : `${answer}\n`);
    for (const p of r.proposals) io.out(`  card ${proposalLine(p)}   → re chat launch ${p.id}${p.kind === "task" ? "" : " (records it)"}`);
    io.err(`  ${(r.ms / 1000).toFixed(1)} s · $${r.usd.toFixed(4)}${r.error ? ` · error: ${r.error}` : ""}`);
    return r.error ? 1 : 0;
  };

  const launch = async (rec: SessionRecord, id: string) => {
    const ref = { project: ledger.name, session: rec.id, proposal: id.toUpperCase() };
    const p = await delegations.launch(ref);
    if (p.kind === "decision") {
      io.out(`recorded ${p.title} as ${p.recorded} in engine/decisions.md`);
      return 0;
    }
    io.out(`launched ${p.id} (${p.role}): ${p.title}`);
    const onInt = () => void delegations.stop(ref).catch(() => {});
    process.once("SIGINT", onInt);
    try {
      await delegations.idle();
    } finally {
      process.removeListener("SIGINT", onInt);
    }
    const done = (await store.load(ledger.name, rec.id)).proposals.find((x) => x.id === ref.proposal)!;
    io.out(proposalLine(done));
    if (done.outcome?.branch) io.out(`  review: git -C ${ledger.dir} diff main...${done.outcome.branch}`);
    return done.state === "done" ? 0 : done.state === "needs_input" ? 3 : 1;
  };

  if (sub === "say") {
    const text = rest.join(" ").trim();
    if (!text) throw new Error("usage: re chat say <message...>");
    return say(await session(true), text);
  }
  if (sub === "show") {
    const rec = await session(false);
    io.out(`session ${rec.id} · ${rec.title} · ${rec.turns} turns`);
    for (const e of (await store.transcript(ledger.name, rec.id)).slice(-30)) for (const l of entryLines(e)) io.out(l);
    if (rec.proposals.length) io.out("proposals:");
    for (const p of rec.proposals) io.out(`  ${proposalLine(p)}`);
    return 0;
  }
  if (sub === "launch" || sub === "dismiss") {
    const id = rest[0];
    if (!id) throw new Error(`usage: re chat ${sub} <P#>`);
    const rec = await session(false);
    if (sub === "dismiss") {
      io.out(proposalLine(await delegations.dismiss({ project: ledger.name, session: rec.id, proposal: id.toUpperCase() })));
      return 0;
    }
    return launch(rec, id);
  }

  // Interactive.
  if (!io.interactive || !io.ask) throw new Error("re chat needs a terminal; use re chat say <message> otherwise");
  let rec = await session(true);
  io.out(`${ledger.name} · session ${rec.id} (${rec.turns} turns) · /launch P1, /dismiss P1, /show, /new, /quit`);
  for (const e of (await store.transcript(ledger.name, rec.id)).slice(-6)) for (const l of entryLines(e)) io.out(l);
  for (;;) {
    let line: string;
    try {
      line = (await io.ask("you>")).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;
    try {
      const [cmd, arg] = line.split(/\s+/, 2);
      if (cmd === "/show") {
        rec = await store.load(ledger.name, rec.id);
        for (const p of rec.proposals) io.out(`  ${proposalLine(p)}`);
      } else if (cmd === "/new") {
        rec = await store.create(ledger.name);
        io.out(`new session ${rec.id}`);
      } else if (cmd === "/launch" && arg) await launch(rec, arg);
      else if (cmd === "/dismiss" && arg) io.out(proposalLine(await delegations.dismiss({ project: ledger.name, session: rec.id, proposal: arg.toUpperCase() })));
      else if (cmd?.startsWith("/")) io.out("commands: /launch P1, /dismiss P1, /show, /new, /quit");
      else {
        await say(rec, line);
        rec = await store.load(ledger.name, rec.id);
      }
    } catch (e) {
      io.err(`re chat: ${(e as Error).message}`);
    }
  }
  await delegations.idle();
  return 0;
}

