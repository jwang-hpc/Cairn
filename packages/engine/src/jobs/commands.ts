// `re job list | show | approve | deny | submit | status | cancel | fetch` and `re machine list`: the human side of
// the executor (DR-0006). Agents propose jobs; only these commands (and later the app) approve them.
import { JobError, type JobService, type JobServiceOptions, printable, SshTransport } from "@cairn/executor";
import type { JobRecord } from "@cairn/shared";
import { join } from "node:path";
import type { Engine } from "../engine.js";
import { openCurrentProject } from "../ledger/commands.js";
import { LedgerError } from "../ledger/ledger.js";
import { openJobService } from "./jobs.js";

export const JOB_COMMANDS = ["job", "machine"] as const;
export const JOB_OPTIONS = {
  reason: { type: "string" },
  all: { type: "boolean" },
  target: { type: "string" },
} as const;

export const JOB_USAGE = `job commands (agents propose jobs; you approve them):
  job list [--all]                   jobs in the current project (--all: every project)
  job propose <EXP-NNN> --target T   propose a job you wrote (experiments/EXP-NNN/ in the project); it waits
                                     for your approval like any other (a campaign: see DR-0011)
  job reconcile [--all]              after the laptop slept: ask the machines about unfinished jobs and fetch
                                     finished campaigns' results
  job show <id>                      the approval card: resources, lint, every file in full
  job approve <id> [--note N]        approve and start it over your SSH session
  job deny <id> --reason R           deny; the reason goes back to the agent
  job submit <id>                    start an approved job (after opening the SSH session)
  job status <id>                    ask the machine
  job cancel <id>                    withdraw it, or stop it on the machine
  job fetch <id>                     copy its outputs into evidence/raw/ in the project ledger
  machine list                       machines.yaml targets and whether your SSH session is open
                                     (open one with: scripts/ssh-master.sh open <ssh-alias>)`;

type Values = Record<string, string | boolean | undefined>;
interface Io {
  out(line: string): void;
  err(line: string): void;
}

const who = (j: JobRecord) => (j.author.kind === "agent" ? `agent ${j.author.agent} (${j.author.model})` : "you");
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

function outcome(j: JobRecord, io0: Io): number {
  const io = safe(io0);
  if (j.state === "running" || j.state === "submitted") {
    io.out(`started on ${j.target}: ${j.remote?.id} in ${j.remote?.dir}`);
    io.out(`follow with: re job status ${j.id}`);
    return 0;
  }
  if (j.state === "approved" && j.error) {
    const host = j.error.match(/ssh-master\.sh open (\S+)/)?.[1];
    io.err(`approved, but it could not start: ${j.error}`);
    io.err(`${host ? `open the session (scripts/ssh-master.sh open ${host}), then ` : ""}run: re job submit ${j.id}`);
    return 1;
  }
  io.out(`${j.id}: ${j.state}`);
  return 0;
}

/** Remote output and agent text reach these lines: escape control characters before they reach the terminal. */
const safe = (io: Io): Io => ({ out: (l) => io.out(printable(l)), err: (l) => io.err(printable(l)) });

function statusLines(j: JobRecord): string[] {
  const last = j.history.at(-1);
  const lines = [`${j.id}  ${j.state}  ${j.experiment} → ${j.target}${last?.note ? `  (${last.note})` : ""}`];
  if (j.error && j.state === "approved") lines.push(`  not started: ${j.error}`);
  if (j.denial) lines.push(`  denied: ${j.denial.reason}`);
  if (j.results) {
    const r = j.results;
    lines.push(`  results: ${r.dir}/ — ${r.files.join(", ") || "(no files)"}`);
    if (r.missing.length) lines.push(`  missing: ${r.missing.join(", ")}`);
    for (const x of r.referenced) lines.push(`  left on ${j.target}: ${x.path} (${x.bytes} bytes)`);
    for (const x of r.refused) lines.push(`  refused: ${x.path} (${x.reason})`);
  } else if (["completed", "failed", "cancelled"].includes(j.state) && j.remote) lines.push(`  fetch results: re job fetch ${j.id}`);
  return lines;
}

export interface MachineSession {
  name: string;
  host: string;
  scheduler: string;
  scratch: string | null;
  doe: boolean;
  /** Whether the user's SSH ControlMaster for this host is up ("bad-host": machines.yaml host is not an ssh alias). */
  session: "open" | "closed" | "bad-host";
}

/** `machine list`: machines.yaml targets and whether the user's SSH session to each is open. */
export async function machineSessions(engine: Engine, overrides: Partial<JobServiceOptions> = {}): Promise<MachineSession[]> {
  const out: MachineSession[] = [];
  for (const [name, m] of Object.entries(engine.config.machines.machines)) {
    let session: MachineSession["session"];
    try {
      const transport = overrides.transport?.(m) ?? new SshTransport(m.host, join(engine.paths.home, "ssh"));
      session = (await transport.alive().catch(() => false)) ? "open" : "closed";
    } catch {
      session = "bad-host";
    }
    out.push({ name, host: m.host, scheduler: m.scheduler, scratch: m.scratch ?? null, doe: m.doe === true, session });
  }
  return out;
}

/** The project `job list` shows: none with --all (every project), else the selected project, else every project. */
export async function jobListProject(engine: Engine, v: Values, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return v.all ? undefined : openCurrentProject(engine, v, env).then((l) => l.name, () => undefined);
}

export async function runJobCommand(
  engine: Engine,
  command: string,
  args: string[],
  v: Values,
  io: Io,
  env: NodeJS.ProcessEnv,
  overrides: Partial<JobServiceOptions> = {},
): Promise<number> {
  const jobs: JobService = openJobService(engine, overrides);
  const [sub, id] = args;
  try {
    if (command === "machine") {
      if (sub !== "list") {
        io.err(`re machine: unknown subcommand '${sub ?? ""}'\n${JOB_USAGE}`);
        return 2;
      }
      const machines = await machineSessions(engine, overrides);
      if (machines.length === 0) io.out("(no machines in machines.yaml)");
      const session = { open: "session open", closed: "session closed", "bad-host": "BAD HOST (set machines.yaml host to your ~/.ssh/config alias)" };
      for (const m of machines) {
        io.out(`${m.name.padEnd(14)} ssh ${m.host.padEnd(14)} ${m.scheduler.padEnd(6)} ${m.scratch ? `scratch ${m.scratch}` : "NO SCRATCH (set machines.yaml scratch)"}  ${session[m.session]}${m.doe ? "  [DOE]" : ""}`);
      }
      return 0;
    }
    const needId = () => {
      if (!id) throw new JobError(`usage: re job ${sub} <id>`);
      return id;
    };
    switch (sub) {
      case "list": {
        const project = await jobListProject(engine, v, env);
        const list = await jobs.list(project ? { project } : {});
        if (list.length === 0) io.out(`(no jobs${project ? ` in ${project}` : ""})`);
        for (const j of list) io.out(`${j.id}  ${j.state.padEnd(16)} ${`${j.experiment} → ${j.target}`.padEnd(26)} ${project ? "" : `${j.project}  `}${who(j)}  ${when(j.created)}`);
        const pending = list.filter((j) => j.state === "pending_approval");
        if (pending.length) io.out(`${pending.length} waiting for you: re job show ${pending[0]!.id}`);
        return 0;
      }
      case "show":
        io.out(await jobs.card(needId()));
        return 0;
      case "propose": {
        const experiment = id;
        if (!experiment || typeof v.target !== "string") throw new JobError("usage: re job propose <EXP-NNN> --target <machine>");
        const ledger = await openCurrentProject(engine, v, env);
        const { job, auto } = await jobs.submit({ project: ledger.name, worktree: ledger.dir, experiment, target: v.target, author: { kind: "user" } });
        io.out(`proposed ${job.id}: ${job.experiment} → ${job.target}${job.lint.campaign ? ` (campaign: ${job.lint.campaign.points} points)` : ""}, ${job.state}`);
        io.out(auto.ok ? `auto-approved: ${auto.reason}` : `review: re job show ${job.id}   then: re job approve ${job.id}`);
        return 0;
      }
      case "reconcile": {
        const project = await jobListProject(engine, v, env);
        const r = await jobs.reconcile(project ? { project } : {});
        for (const j of r.checked) io.out(`checked  ${j.id}  ${j.state.padEnd(10)} ${j.experiment} → ${j.target}${j.history.at(-1)?.note ? `  (${j.history.at(-1)!.note})` : ""}`);
        for (const j of r.fetched) io.out(`fetched  ${j.id}  ${j.results?.files.length ?? 0} files into ${j.results?.dir}`);
        for (const u of r.unreachable) io.out(`waiting  ${u.job}  ${u.reason}`);
        if (r.checked.length + r.fetched.length + r.unreachable.length === 0) io.out("(nothing to reconcile)");
        return r.unreachable.length ? 3 : 0;
      }
      case "approve": {
        const j = await jobs.approve(needId(), v.note as string | undefined);
        io.out(`approved ${j.id}`);
        return outcome(j, io);
      }
      case "deny": {
        if (typeof v.reason !== "string") throw new JobError(`usage: re job deny <id> --reason R`);
        const j = await jobs.deny(needId(), v.reason);
        io.out(`denied ${j.id}: ${v.reason}`);
        return 0;
      }
      case "submit":
        return outcome(await jobs.launch(needId()), io);
      case "status":
        for (const l of statusLines(await jobs.refresh(needId()))) io.out(printable(l));
        return 0;
      case "cancel": {
        const j = await jobs.cancel(needId(), "user");
        io.out(`cancelled ${j.id}`);
        return 0;
      }
      case "fetch": {
        const j = await jobs.fetch(needId());
        const r = j.results!;
        io.out(`fetched ${r.files.length} file${r.files.length === 1 ? "" : "s"} into ${j.project}/${r.dir}/ (committed to the ledger)`);
        for (const l of statusLines(j).slice(1)) io.out(printable(l));
        return 0;
      }
      default:
        io.err(`re job: unknown subcommand '${sub ?? ""}'\n${JOB_USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof JobError || e instanceof LedgerError) {
      io.err(`re ${command}: ${printable(e.message, true)}`);
      return 1;
    }
    throw e;
  }
}
