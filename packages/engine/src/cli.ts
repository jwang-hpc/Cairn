import { parseArgs } from "node:util";
import { EFFORT_LEVELS, type EffortLevel, FORMAT_VERSION } from "@cairn/shared";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JobServiceOptions } from "@cairn/executor";
import { ConfigError } from "./config/load.js";
import { JOB_COMMANDS, JOB_OPTIONS, JOB_USAGE, runJobCommand } from "./jobs/commands.js";
import { openJobService } from "./jobs/jobs.js";
import { LEDGER_COMMANDS, LEDGER_OPTIONS, LEDGER_USAGE, openCurrentProject, runLedgerCommand } from "./ledger/commands.js";
import { PANEL_OPTIONS, PANEL_USAGE, runPanelCommand } from "./panel/commands.js";
import { Engine, type LoginIo, type Status } from "./engine.js";
import { type EnginePaths, REPO_ROOT, resolvePaths } from "./paths.js";
import type { WorkerDeps } from "./worker/run.js";
import { runTask } from "./worker/task.js";
import { ENGINE_VERSION } from "./version.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Streamed output without a newline (answers). Defaults to out(). */
  write?(chunk: string): void;
  /** Interactive input for `re login`. */
  login?: LoginIo;
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  openEngine?: (paths: EnginePaths) => Promise<Engine>;
  /** Overrides for `re run` (tests inject a fake sandbox launcher). */
  worker?: Partial<Omit<WorkerDeps, "engine">>;
  /** Overrides for the jobs service (tests inject a local transport). */
  jobs?: Partial<JobServiceOptions>;
}

const USAGE = `usage: re <command> [options]

commands:
  status [--check]                      config, login routes, today's usage vs caps
                                        (--check: one-word test call per route)
  ask [--model A] [--effort E] [--role R] <prompt...>
                                        one-shot agent call; recorded in usage.jsonl
  run [--repo P] --role R --task FILE [--model A] [--effort E] [--keep]
                                        agent in its own worktree + sandbox (default repo:
                                        the current project); changes are committed to
                                        branch agent/<id> for review
  login <pi-provider> <oauth|api_key>   sign in or store an API key (run in your own terminal)
  help                                  show this message

${LEDGER_USAGE}

${PANEL_USAGE}

${JOB_USAGE}

options:
  --version   print engine version

environment:
  CAIRN_CONFIG_DIR   config directory (default: <repo>/config)
  CAIRN_HOME         engine state directory (default: <repo>/.engine)`;

const usd = (n: number) => (n > 0 && n < 0.0001 ? "<$0.0001" : `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`);
const tok = (n: number) => n.toLocaleString("en-US");

/** Parse argv (without node/script) and run a command. Returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        check: { type: "boolean" },
        model: { type: "string", short: "m" },
        effort: { type: "string", short: "e" },
        role: { type: "string", short: "r" },
        repo: { type: "string" },
        task: { type: "string" },
        keep: { type: "boolean" },
        ...LEDGER_OPTIONS,
        ...PANEL_OPTIONS,
        ...JOB_OPTIONS,
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    io.err(`re: ${(e as Error).message}`);
    io.err(USAGE);
    return 2;
  }
  const { values: v, positionals } = parsed;

  if (v.version) {
    io.out(`re ${ENGINE_VERSION} (format v${FORMAT_VERSION})`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (command === undefined || command === "help" || v.help) {
    io.out(USAGE);
    return 0;
  }
  if (![...["status", "ask", "run", "login", "panel"], ...LEDGER_COMMANDS, ...JOB_COMMANDS].includes(command)) {
    io.err(`re: unknown command '${command}'`);
    io.err(USAGE);
    return 2;
  }

  const paths = resolvePaths(deps.env ?? process.env);
  let engine: Engine;
  try {
    engine = await (deps.openEngine ?? Engine.open)(paths);
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }

  if (command === "panel") return runPanelCommand(engine, rest, v, io, deps.env ?? process.env);
  if ((JOB_COMMANDS as readonly string[]).includes(command)) return runJobCommand(engine, command, rest, v, io, deps.env ?? process.env, deps.jobs);
  if ((LEDGER_COMMANDS as readonly string[]).includes(command)) {
    return runLedgerCommand(engine, command, rest, v, io, deps.env ?? process.env);
  }

  switch (command) {
    case "status":
      return status(engine, io, v.check === true);
    case "ask": {
      const prompt = rest.join(" ").trim();
      if (prompt === "") {
        io.err("re ask: missing prompt");
        return 2;
      }
      if (v.effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(v.effort)) {
        io.err(`re ask: --effort must be one of ${EFFORT_LEVELS.join(", ")}`);
        return 2;
      }
      return ask(engine, io, prompt, { model: v.model, effort: v.effort as EffortLevel | undefined, role: v.role });
    }
    case "run": {
      if (!v.role || !v.task) {
        io.err("usage: re run [--repo <git repo>] --role <role> --task <file> [--model A] [--effort E] [--keep]");
        return 2;
      }
      let repo = v.repo ? resolve(v.repo) : undefined;
      if (!repo) {
        try {
          repo = (await openCurrentProject(engine, v, deps.env ?? process.env)).dir;
        } catch (e) {
          io.err(`re run: no --repo and ${(e as Error).message}`);
          return 2;
        }
      }
      if (v.effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(v.effort)) {
        io.err(`re run: --effort must be one of ${EFFORT_LEVELS.join(", ")}`);
        return 2;
      }
      let task: string;
      try {
        task = await readFile(resolve(v.task), "utf8");
      } catch (e) {
        io.err(`re run: cannot read task file: ${(e as Error).message}`);
        return 2;
      }
      return run(engine, io, { jobs: openJobService(engine, deps.jobs), ...deps.worker }, {
        repo, role: v.role, task, keep: v.keep === true,
        ...(v.model ? { alias: v.model } : {}), ...(v.effort ? { effort: v.effort as EffortLevel } : {}),
      });
    }
    case "login": {
      const [provider, kind] = rest;
      if (!provider || (kind !== "oauth" && kind !== "api_key")) {
        io.err("usage: re login <pi-provider> <oauth|api_key>   e.g. re login anthropic oauth");
        return 2;
      }
      if (!io.login) {
        io.err("re login: needs an interactive terminal");
        return 1;
      }
      try {
        io.out(await engine.login(provider, kind, io.login));
        return 0;
      } catch (e) {
        io.err(`re login: ${(e as Error).message}`);
        if (/EPERM|EACCES|listen/.test((e as Error).message)) {
          io.err("hint: login opens a local callback port; run it in your own terminal, not inside a sandbox");
        }
        return 1;
      }
    }
  }
  return 2;
}

async function run(
  engine: Engine,
  io: CliIo,
  overrides: CliDeps["worker"],
  opts: Parameters<typeof runTask>[1],
): Promise<number> {
  io.err(`re run: role ${opts.role} on ${opts.repo} (sandbox + worktree; this can take a while)`);
  let out;
  try {
    out = await runTask({ engine, skillsDir: join(REPO_ROOT, "skills"), ...overrides }, opts);
  } catch (e) {
    io.err(`re run: ${(e as Error).message}`);
    return 1;
  }
  const { result: r, worktree, commit, kept } = out;
  io.out(`status   ${r.status}${r.error ? ` (${r.error.split("\n")[0]})` : ""}`);
  io.out(`summary  ${r.report.summary.split("\n")[0]}${r.reportSource === "engine" ? "  [no report.json; taken from last message]" : ""}`);
  for (const q of r.report.questions ?? []) io.out(`question ${q}`);
  io.out(`changed  ${r.files.length === 0 ? "nothing" : r.files.map((f) => `${f.path} (${f.status})`).join(", ")}`);
  if (r.violations.length > 0) io.out(`VIOLATION changes outside the role's write paths: ${r.violations.join(", ")}`);
  for (const u of r.usage) {
    io.err(`— ${u.model} via ${u.route}/${u.auth} · effort ${u.effort} · ${tok(u.tokens.input)} in / ${tok(u.tokens.output)} out · ${usd(u.cost.usd)} ${u.cost.kind}${u.error ? ` · failed: ${u.error.split("\n")[0]}` : ""}`);
  }
  io.out(`run      ${r.run} · transcript ${r.transcriptPath}`);
  if (commit) {
    io.out(`review   git -C ${worktree.repo} diff ${worktree.base.slice(0, 12)}...${worktree.branch}   (commit ${commit.slice(0, 12)})`);
  }
  if (kept) io.out(`worktree ${worktree.path} (kept)`);
  for (const j of (await overrides?.jobs?.list().catch(() => [])) ?? []) {
    if (j.author.kind === "agent" && j.author.run === r.run) io.out(`job      ${j.id} ${j.state} (${j.experiment} → ${j.target})  review: re job show ${j.id}`);
  }
  return r.status === "done" ? 0 : r.status === "needs_input" ? 3 : 1;
}

async function ask(
  engine: Engine,
  io: CliIo,
  prompt: string,
  o: { model: string | undefined; effort: EffortLevel | undefined; role: string | undefined },
): Promise<number> {
  const write = io.write ?? io.out;
  let streamed = false;
  const r = await engine.ask(prompt, {
    ...(o.model ? { alias: o.model } : {}),
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.role ? { role: o.role } : {}),
    onText: (d) => {
      streamed = true;
      write(d);
    },
  });
  if (streamed) write("\n");
  for (const u of r.usage) {
    const cost = `${usd(u.cost.usd)} ${u.cost.kind}`;
    const outcome = u.error ? `failed: ${u.error.split("\n")[0]}` : u.stopReason;
    io.err(`— ${u.model} via ${u.route}/${u.auth} · effort ${u.effort} · ${tok(u.tokens.input)} in / ${tok(u.tokens.output)} out · ${cost} · ${outcome}`);
  }
  if (!r.ok) {
    io.err(`re ask: ${r.error ?? "no answer"}`);
    return 1;
  }
  io.err(`  run ${r.run} · recorded in ${engine.paths.home}/usage.jsonl`);
  return 0;
}

async function status(engine: Engine, io: CliIo, check: boolean): Promise<number> {
  const s: Status = await engine.status();
  io.out(`re ${ENGINE_VERSION} · machine ${s.machine}`);
  io.out(`  config  ${s.paths.configDir}`);
  io.out(`  home    ${s.paths.home}`);
  io.out("");
  io.out("providers");
  for (const p of s.providers) {
    io.out(`  ${p.name}  [data: ${p.dataClasses.join(", ") || "none"}]`);
    for (const r of p.routes) io.out(`    ${r.problem ? "✗" : "✓"} ${r.route}${r.problem ? ` — ${r.problem}` : ""}`);
  }
  io.out("");
  const { today, caps } = s;
  const cap = (used: number, c: number | undefined, f: (n: number) => string) => (c === undefined ? f(used) : `${f(used)} / ${f(c)}`);
  const providers = s.providers.map((p) => p.name);
  io.out(`today ${today.day} (local)`);
  io.out(
    `  billed USD    total ${cap(today.usd.total, caps.daily.usd.total, usd)}` +
      providers
        .filter((p) => today.usd.byProvider.has(p) || caps.daily.usd.per_provider?.[p] !== undefined)
        .map((p) => ` · ${p} ${cap(today.usd.byProvider.get(p) ?? 0, caps.daily.usd.per_provider?.[p], usd)}`)
        .join(""),
  );
  io.out(
    `  sub. tokens   total ${cap(today.tokens.total, caps.daily.tokens.total, tok)}` +
      providers
        .filter((p) => today.tokens.byProvider.has(p) || caps.daily.tokens.per_provider?.[p] !== undefined)
        .map((p) => ` · ${p} ${cap(today.tokens.byProvider.get(p) ?? 0, caps.daily.tokens.per_provider?.[p], tok)}`)
        .join(""),
  );
  io.out(`  per run       ${caps.run.max_turns} turns · ${tok(caps.run.max_tokens)} tokens · ${usd(caps.run.max_usd)} billed`);
  if (today.badLines.length > 0) io.out(`  ! ${today.badLines.length} unreadable line(s) in usage.jsonl: ${today.badLines.join(", ")}`);

  if (!check) return 0;
  io.out("");
  io.out("check (one-word call per available route)");
  let failed = 0;
  for (const r of await engine.check()) {
    if (r.result === "failed") failed++;
    const mark = { ok: "✓", failed: "✗", skipped: "–" }[r.result];
    io.out(`  ${mark} ${r.provider} ${r.route} — ${r.result === "skipped" ? "skipped: " : ""}${r.detail.split("\n")[0]}`);
  }
  return failed > 0 ? 1 : 0;
}
