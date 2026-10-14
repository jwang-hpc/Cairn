// Runners: what "submit / status / cancel / fetch" mean on a machine (DR-0006 amendment). Every script is
// generated here from validated values, single-quoted as a second layer, and sent to `sh -s`; raw output is
// returned for the audit log. Job directories live at <scratch>/cairn/<project>/<job>/ with Cairn's own state in
// .cairn/ next to the user's files.
import { JOB_FILE_PATTERN, JOB_ID_PATTERN, type JobLint, type JobManifest, type JobState, type MachineConfig } from "@cairn/shared";
import type { JobFileContent } from "../jobs/lint.js";
import { type RunResult, SSH_CONNECT_FAILED, type Transport } from "./transport.js";

export class RemoteError extends Error {
  constructor(
    message: string,
    /** Raw output for the audit log. */
    readonly raw: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

export interface RemoteJob {
  id: string;
  dir: string;
  manifest: JobManifest;
  lint: JobLint;
  /** Snapshot of experiments/EXP-NNN/ (paths relative to it). */
  files: JobFileContent[];
}

export interface RemoteStatus {
  state: JobState;
  detail: string;
  raw: string;
}

export interface FetchedFile {
  path: string;
  content: Buffer;
}

export interface FetchResult {
  files: FetchedFile[];
  /** Too large to copy: stays on the machine, referenced by path (DR-0006 step 5). */
  referenced: { path: string; bytes: number }[];
  missing: string[];
  refused: { path: string; reason: string }[];
  /** Tails of the job's stdout/stderr. */
  logs: FetchedFile[];
  raw: string;
}

export interface Runner {
  /** Scheduler pre-flight without queueing (Slurm --test-only); undefined where there is none. */
  preflight(job: RemoteJob): Promise<{ ok: boolean; detail: string; raw: string } | undefined>;
  /** Upload the files and start the job; returns the machine's id for it. */
  start(job: RemoteJob): Promise<{ id: string; raw: string }>;
  status(job: RemoteJob, remoteId: string): Promise<RemoteStatus>;
  cancel(job: RemoteJob, remoteId: string): Promise<{ raw: string }>;
  fetch(job: RemoteJob): Promise<FetchResult>;
}

export const FETCH_LIMITS = { fileBytes: 10 << 20, totalBytes: 50 << 20, logBytes: 256 << 10 } as const;

const FILE_RE = new RegExp(JOB_FILE_PATTERN);
const ID_RE = new RegExp(JOB_ID_PATTERN);
const DIR_RE = /^\/[A-Za-z0-9._/-]+$/;
const TOKEN_RE = /^[A-Za-z0-9_.-]+$/;

/** sh single-quoting. Callers validate values first; this is the second layer. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function must(ok: boolean, what: string, value: string): void {
  if (!ok) throw new RemoteError(`refusing to use ${what} ${JSON.stringify(value)} in a remote command`, "");
}

/** <scratch>/cairn/<project>/<job> */
export function jobDir(machine: MachineConfig, project: string, id: string): string {
  if (!machine.scratch) throw new RemoteError("machine has no scratch path", "");
  must(/^[a-z0-9][a-z0-9-]*$/.test(project), "project name", project);
  must(ID_RE.test(id), "job id", id);
  const dir = `${machine.scratch.replace(/\/+$/, "")}/cairn/${project}/${id}`;
  must(DIR_RE.test(dir) && !dir.split("/").includes(".."), "directory", dir);
  return dir;
}

const raw = (r: RunResult) => `exit ${r.code ?? "timeout"} (${r.ms} ms)\n--- stdout\n${r.out}\n--- stderr\n${r.err}`;

function checked(transport: Transport, r: RunResult, what: string): RunResult {
  if (r.code === SSH_CONNECT_FAILED) {
    throw new RemoteError(`no SSH session to ${transport.host}: open one with scripts/ssh-master.sh open ${transport.host}`, raw(r));
  }
  if (r.code === null) throw new RemoteError(`${what} timed out on ${transport.host}`, raw(r));
  if (r.code !== 0) throw new RemoteError(`${what} failed on ${transport.host} (exit ${r.code}): ${(r.err || r.out).trim().split("\n").slice(-3).join(" | ")}`, raw(r));
  return r;
}

const kv = (text: string) =>
  Object.fromEntries(text.split("\n").filter((l) => /^[a-z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

/** Write files under the job directory; refuse to reuse an existing one. */
export function uploadScript(dir: string, files: { path: string; content: Buffer }[]): string {
  must(DIR_RE.test(dir), "directory", dir);
  const lines = ["set -eu", "umask 077", `D=${shq(dir)}`, 'if [ -e "$D" ]; then echo "cairn: $D already exists" >&2; exit 3; fi', 'mkdir -p "$D/.cairn"', 'cd "$D"'];
  const dirs = new Set<string>();
  for (const f of files) {
    const rel = f.path.startsWith(".cairn/") ? f.path.slice(7) : f.path;
    must(FILE_RE.test(rel), "file name", f.path);
    const parent = f.path.split("/").slice(0, -1).join("/");
    if (parent && !dirs.has(parent)) {
      dirs.add(parent);
      lines.push(`mkdir -p ${shq(parent)}`);
    }
    lines.push(`base64 -d > ${shq(f.path)} <<'CAIRN_B64'`, ...(f.content.toString("base64").match(/.{1,76}/g) ?? []), "CAIRN_B64");
  }
  lines.push(`echo "uploaded=${files.length}"`);
  return `${lines.join("\n")}\n`;
}

/** Copy declared outputs back: regular files inside the job directory only, size-capped, base64 on stdout. */
export function fetchScript(dir: string, outputs: string[]): string {
  must(DIR_RE.test(dir), "directory", dir);
  for (const o of outputs) must(FILE_RE.test(o), "output", o);
  return `${[
    `D=${shq(dir)}`,
    `MAX=${FETCH_LIMITS.fileBytes}`,
    'cd "$D" 2>/dev/null || { echo "=== NODIR"; exit 0; }',
    "ROOT=$(pwd -P)",
    "emit() {",
    '  f="$1"',
    '  if [ -L "$f" ]; then echo "=== REFUSED symlink $f"; return; fi',
    '  if [ ! -f "$f" ]; then echo "=== MISSING $f"; return; fi',
    '  case "$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)/" in "$ROOT"/*) ;; *) echo "=== REFUSED outside $f"; return ;; esac',
    '  if [ -z "$(find "$f" -prune -links 1)" ]; then echo "=== REFUSED hardlink $f"; return; fi',
    "  s=$(wc -c < \"$f\" | tr -d ' ')",
    '  if [ "$s" -gt "$MAX" ]; then echo "=== BIG $s $f"; return; fi',
    '  echo "=== FILE $s $f"; base64 < "$f"; echo "=== END"',
    "}",
    ...outputs.map((o) => `emit ${shq(o)}`),
    "for l in stdout stderr; do",
    '  f=".cairn/$l.log"',
    `  if [ -f "$f" ] && [ ! -L "$f" ]; then echo "=== LOG $l"; tail -c ${FETCH_LIMITS.logBytes} "$f" | base64; echo "=== END"; fi`,
    "done",
    'echo "=== ROOT $ROOT"',
  ].join("\n")}\n`;
}

export function parseFetch(dir: string, out: string, rawText: string): FetchResult {
  const res: FetchResult = { files: [], referenced: [], missing: [], refused: [], logs: [], raw: rawText };
  const lines = out.split("\n");
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let m: RegExpExecArray | null;
    if (l === "=== NODIR") throw new RemoteError(`job directory ${dir} is gone`, rawText);
    if ((m = /^=== MISSING (.+)$/.exec(l))) res.missing.push(m[1]!);
    else if ((m = /^=== REFUSED (\S+) (.+)$/.exec(l))) res.refused.push({ path: m[2]!, reason: m[1]! });
    else if ((m = /^=== BIG (\d+) (.+)$/.exec(l))) res.referenced.push({ path: `${dir}/${m[2]}`, bytes: Number(m[1]) });
    else if ((m = /^=== (FILE (\d+)|LOG) (.+)$/.exec(l))) {
      const body: string[] = [];
      while (i + 1 < lines.length && lines[i + 1] !== "=== END") body.push(lines[++i]!);
      i++;
      const content = Buffer.from(body.join(""), "base64");
      if (m[1] === "LOG") res.logs.push({ path: `${m[3]}.log`, content });
      else if (content.length !== Number(m[2])) res.refused.push({ path: m[3]!, reason: `size mismatch (${content.length} != ${m[2]})` });
      else if (total + content.length > FETCH_LIMITS.totalBytes) res.referenced.push({ path: `${dir}/${m[3]}`, bytes: content.length });
      else {
        total += content.length;
        res.files.push({ path: m[3]!, content });
      }
    }
  }
  return res;
}

// ---------- workstation (no scheduler) ----------

/**
 * The job runs in its own process group (perl's setpgrp: portable, no setsid or job control needed) under a
 * wall-clock watchdog; exit code and timestamps land in .cairn/.
 */
export function workstationRunner(script: string, walltimeSeconds: number): string {
  must(FILE_RE.test(script), "script", script);
  const pg = `perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!\\n"'`;
  return `${[
    "#!/bin/sh",
    "# Cairn workstation runner (generated). The job runs in its own process group under a wall-clock limit.",
    'cd "$(dirname "$0")/.." || exit 1',
    "echo $$ > .cairn/runner.pid",
    "date -u +%Y-%m-%dT%H:%M:%SZ > .cairn/started",
    `${pg} bash ./${shq(script)} > .cairn/stdout.log 2> .cairn/stderr.log < /dev/null &`,
    "JOB=$!",
    'echo "$JOB" > .cairn/pid',
    `${pg} sh -c 'sleep "$1"; echo walltime > .cairn/killed; kill -s TERM -- -"$2" 2>/dev/null; sleep 30; kill -s KILL -- -"$2" 2>/dev/null' cairn-watchdog ${Math.ceil(walltimeSeconds)} "$JOB" > /dev/null 2>&1 < /dev/null &`,
    "DOG=$!",
    'wait "$JOB"',
    "CODE=$?",
    'kill -s TERM -- -"$DOG" 2>/dev/null',
    'echo "$CODE" > .cairn/exit.tmp && mv .cairn/exit.tmp .cairn/exit',
    "date -u +%Y-%m-%dT%H:%M:%SZ > .cairn/finished",
  ].join("\n")}\n`;
}

export class WorkstationRunner implements Runner {
  constructor(readonly transport: Transport) {}

  async preflight(): Promise<undefined> {
    return undefined;
  }

  async start(job: RemoteJob): Promise<{ id: string; raw: string }> {
    const files = [...job.files, { path: ".cairn/run.sh", content: Buffer.from(workstationRunner(job.manifest.script, job.lint.walltime_s)) }];
    const up = checked(this.transport, await this.transport.run(uploadScript(job.dir, files), { timeoutMs: 300_000 }), "upload");
    const start = [
      "set -eu",
      `cd ${shq(job.dir)}`,
      'command -v perl > /dev/null 2>&1 || { echo "cairn: perl is required on this machine" >&2; exit 4; }',
      'command -v bash > /dev/null 2>&1 || { echo "cairn: bash is required on this machine" >&2; exit 4; }',
      "nohup sh .cairn/run.sh > /dev/null 2>&1 < /dev/null &",
      "i=0; while [ ! -s .cairn/pid ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done",
      'echo "pid=$(cat .cairn/pid 2>/dev/null)"',
    ].join("\n");
    const r = checked(this.transport, await this.transport.run(`${start}\n`), "start");
    const pid = kv(r.out).pid;
    if (!pid || !/^\d+$/.test(pid)) throw new RemoteError(`job did not start on ${this.transport.host}`, `${raw(up)}\n${raw(r)}`);
    return { id: pid, raw: `${raw(up)}\n${raw(r)}` };
  }

  async status(job: RemoteJob, _remoteId?: string): Promise<RemoteStatus> {
    const script = [
      `cd ${shq(job.dir)} 2>/dev/null || { echo "dir=missing"; exit 0; }`,
      // Liveness first: the runner writes .cairn/exit before it exits, so reading exit afterwards can't miss it.
      "alive=0",
      'for f in pid runner.pid; do P=$(cat .cairn/$f 2>/dev/null); if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then alive=1; fi; done',
      'echo "alive=$alive"',
      'for k in exit killed started finished; do printf \'%s=%s\\n\' "$k" "$(cat .cairn/$k 2>/dev/null)"; done',
    ].join("\n");
    const r = checked(this.transport, await this.transport.run(`${script}\n`), "status");
    return { ...parseWorkstationStatus(kv(r.out)), raw: raw(r) };
  }

  async cancel(job: RemoteJob, _remoteId?: string): Promise<{ raw: string }> {
    const script = [
      `cd ${shq(job.dir)} 2>/dev/null || exit 0`,
      'if [ -s .cairn/exit ]; then echo "already=1"; exit 0; fi',
      "echo cancelled > .cairn/killed",
      "P=$(cat .cairn/pid 2>/dev/null)",
      'if [ -n "$P" ]; then kill -s TERM -- -"$P" 2>/dev/null || true; nohup sh -c \'sleep 10; kill -s KILL -- -"$1" 2>/dev/null\' cairn-cancel "$P" > /dev/null 2>&1 < /dev/null & fi',
      'echo "cancelled=1"',
    ].join("\n");
    return { raw: raw(checked(this.transport, await this.transport.run(`${script}\n`), "cancel")) };
  }

  async fetch(job: RemoteJob): Promise<FetchResult> {
    const r = checked(this.transport, await this.transport.run(fetchScript(job.dir, job.manifest.outputs), { timeoutMs: 600_000 }), "fetch");
    return parseFetch(job.dir, r.out, `exit ${r.code} (${r.ms} ms, ${r.out.length} bytes)\n--- stderr\n${r.err}`);
  }
}

export function parseWorkstationStatus(f: Record<string, string>): { state: JobState; detail: string } {
  if (f.dir === "missing") return { state: "lost", detail: "job directory is gone" };
  if (f.exit) {
    if (f.exit === "0") return { state: "completed", detail: `exit 0, finished ${f.finished ?? "?"}` };
    if (f.killed === "cancelled") return { state: "cancelled", detail: `cancelled (exit ${f.exit})` };
    if (f.killed === "walltime") return { state: "failed", detail: `walltime exceeded (exit ${f.exit})` };
    return { state: "failed", detail: `exit ${f.exit}` };
  }
  if (f.alive === "1") return { state: "running", detail: `started ${f.started ?? "?"}` };
  return { state: "lost", detail: "no exit code and the runner is gone (machine rebooted or process killed?)" };
}

// ---------- Slurm ----------

/** #SBATCH header from the manifest and machines.yaml: fixed account, allowed partition, limits. */
export function sbatchScript(job: RemoteJob): string {
  const r = job.manifest.resources;
  const { lint } = job;
  must(DIR_RE.test(job.dir), "directory", job.dir);
  must(FILE_RE.test(job.manifest.script), "script", job.manifest.script);
  if (lint.account !== undefined) must(TOKEN_RE.test(lint.account), "account", lint.account);
  if (lint.partition !== undefined) must(TOKEN_RE.test(lint.partition), "partition", lint.partition);
  const tasks = r.tasks_per_node ?? r.cores;
  const walltime = r.walltime;
  must(/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(walltime), "walltime", walltime);
  return `${[
    "#!/bin/bash",
    `#SBATCH --job-name=cairn-${job.id}`,
    ...(lint.account ? [`#SBATCH --account=${lint.account}`] : []),
    ...(lint.partition ? [`#SBATCH --partition=${lint.partition}`] : []),
    `#SBATCH --nodes=${lint.nodes}`,
    `#SBATCH --ntasks-per-node=${tasks}`,
    `#SBATCH --cpus-per-task=${Math.max(1, Math.floor(r.cores / tasks))}`,
    ...(lint.gpus > 0 ? [`#SBATCH --gres=gpu:${lint.gpus}`] : []),
    ...(r.memory_gb ? [`#SBATCH --mem=${Math.ceil(r.memory_gb * 1024)}M`] : []),
    `#SBATCH --time=${walltime}`,
    `#SBATCH --chdir=${job.dir}`,
    `#SBATCH --output=${job.dir}/.cairn/stdout.log`,
    `#SBATCH --error=${job.dir}/.cairn/stderr.log`,
    "date -u +%Y-%m-%dT%H:%M:%SZ > .cairn/started",
    `bash ./${shq(job.manifest.script)}`,
    "CODE=$?",
    'echo "$CODE" > .cairn/exit',
    "date -u +%Y-%m-%dT%H:%M:%SZ > .cairn/finished",
    'exit "$CODE"',
  ].join("\n")}\n`;
}

/**
 * Reason Slurm gave for refusing a request (spike 4 F3). Formats seen: "sbatch: error: Batch job submission
 * failed: <r>" and (Slurm 24.11 --test-only) "allocation failure: <r>".
 */
export function parseRejection(text: string): string | undefined {
  const m = /^(?:sbatch:\s*)?(?:error:\s*(?:Batch job submission failed:\s*)?|allocation failure:\s*)(.+)$/m.exec(text);
  return m?.[1]?.trim();
}

const SQUEUE_STATE: Record<string, JobState> = {
  PENDING: "submitted", CONFIGURING: "submitted", REQUEUED: "submitted", REQUEUE_HOLD: "submitted", RESIZING: "submitted", SUSPENDED: "submitted",
  RUNNING: "running", COMPLETING: "running", STAGE_OUT: "running", SIGNALING: "running",
};

export function parseSlurmStatus(f: Record<string, string>): { state: JobState; detail: string } {
  if (f.squeue) return { state: SQUEUE_STATE[f.squeue] ?? "running", detail: `squeue: ${f.squeue}` };
  const [state = "", exitCode = ""] = (f.sacct ?? "").split("|");
  const base = state.split(" ")[0] ?? "";
  if (base === "COMPLETED") return { state: "completed", detail: `sacct: COMPLETED ${exitCode}`.trim() };
  if (base === "CANCELLED") return { state: "cancelled", detail: `sacct: ${state}` };
  if (base === "PENDING") return { state: "submitted", detail: "sacct: PENDING" };
  if (base === "RUNNING") return { state: "running", detail: "sacct: RUNNING" };
  if (base) return { state: "failed", detail: `sacct: ${state} ${exitCode}`.trim() };
  // Not in squeue or sacct (accounting off or lagging): fall back to the exit file the batch script writes.
  if (f.exit === "0") return { state: "completed", detail: "exit 0 (from .cairn/exit)" };
  if (f.exit) return { state: "failed", detail: `exit ${f.exit} (from .cairn/exit)` };
  return { state: "lost", detail: "not in squeue or sacct, and no exit file" };
}

export class SlurmRunner implements Runner {
  constructor(readonly transport: Transport) {}

  async preflight(job: RemoteJob): Promise<{ ok: boolean; detail: string; raw: string }> {
    const script = `sbatch --test-only 2>&1 <<'CAIRN_SBATCH'\n${sbatchScript(job)}CAIRN_SBATCH\necho "exit=$?"\n`;
    const r = await this.transport.run(script);
    if (r.code === SSH_CONNECT_FAILED || r.code === null) checked(this.transport, r, "pre-flight");
    const m = /Job (\d+) to start at (\S+) using (\d+) processors on nodes (\S+) in partition (\S+)/.exec(r.out);
    if (m) return { ok: true, detail: `would start ${m[2]} on ${m[4]} (${m[3]} processors, partition ${m[5]}); nothing was queued`, raw: raw(r) };
    const reason = parseRejection(r.out);
    return { ok: false, detail: reason ? `Slurm refused: ${reason}` : `unrecognized sbatch --test-only output: ${r.out.trim().slice(0, 200)}`, raw: raw(r) };
  }

  async start(job: RemoteJob): Promise<{ id: string; raw: string }> {
    const files = [...job.files, { path: ".cairn/job.sbatch", content: Buffer.from(sbatchScript(job)) }];
    const up = checked(this.transport, await this.transport.run(uploadScript(job.dir, files), { timeoutMs: 300_000 }), "upload");
    const r = await this.transport.run(`cd ${shq(job.dir)} && sbatch --parsable .cairn/job.sbatch\n`);
    if (r.code !== 0) {
      const reason = parseRejection(`${r.out}\n${r.err}`);
      if (reason) throw new RemoteError(`Slurm refused the job: ${reason}`, `${raw(up)}\n${raw(r)}`);
      checked(this.transport, r, "sbatch");
    }
    const id = /^(\d+)(;\S*)?$/m.exec(r.out.trim())?.[1];
    if (!id) throw new RemoteError(`unrecognized sbatch output: ${r.out.trim().slice(0, 200)}`, `${raw(up)}\n${raw(r)}`);
    return { id, raw: `${raw(up)}\n${raw(r)}` };
  }

  async status(job: RemoteJob, remoteId: string): Promise<RemoteStatus> {
    must(/^\d+$/.test(remoteId), "Slurm job id", remoteId);
    const script = [
      `J=${shq(remoteId)}`,
      "S=$(squeue -h -j \"$J\" -o '%T' 2>/dev/null | head -n 1)",
      'echo "squeue=$S"',
      'if [ -z "$S" ]; then echo "sacct=$(sacct -n -X -P -j "$J" -o State,ExitCode 2>/dev/null | head -n 1)"; fi',
      `echo "exit=$(cat ${shq(`${job.dir}/.cairn/exit`)} 2>/dev/null)"`,
    ].join("\n");
    const r = checked(this.transport, await this.transport.run(`${script}\n`), "status");
    return { ...parseSlurmStatus(kv(r.out)), raw: raw(r) };
  }

  async cancel(_job: RemoteJob, remoteId: string): Promise<{ raw: string }> {
    must(/^\d+$/.test(remoteId), "Slurm job id", remoteId);
    return { raw: raw(checked(this.transport, await this.transport.run(`scancel ${shq(remoteId)}\n`), "scancel")) };
  }

  async fetch(job: RemoteJob): Promise<FetchResult> {
    const r = checked(this.transport, await this.transport.run(fetchScript(job.dir, job.manifest.outputs), { timeoutMs: 600_000 }), "fetch");
    return parseFetch(job.dir, r.out, `exit ${r.code} (${r.ms} ms, ${r.out.length} bytes)\n--- stderr\n${r.err}`);
  }
}

export function runnerFor(machine: MachineConfig, transport: Transport): Runner {
  if (machine.scheduler === "none") return new WorkstationRunner(transport);
  if (machine.scheduler === "slurm") return new SlurmRunner(transport);
  throw new RemoteError(`${machine.scheduler} is not supported yet`, "");
}
