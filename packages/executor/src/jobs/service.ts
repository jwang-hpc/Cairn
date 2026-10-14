// The jobs service behind jobs.submit / status / fetch_results / cancel (DR-0006). Flow: lint → snapshot →
// (Slurm pre-flight) → pending_approval → human approves (or policy auto-approves an identical rerun) → launch
// over the user's SSH session → status → fetch declared outputs into evidence/raw/. Every action is audited; the
// proposal, the human decision, the launch, the final state, and the results are ledger commits.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type JobAuthor,
  type JobRecord,
  type JobState,
  type MachineConfig,
  type Provenance,
  provenance,
  TERMINAL_JOB_STATES,
} from "@cairn/shared";
import { jobDir, RemoteError, type RemoteJob, runnerFor } from "../remote/runners.js";
import { SshTransport, type Transport } from "../remote/transport.js";
import { AuditLog } from "./audit.js";
import { renderCard } from "./card.js";
import { autoApproval, type JobFileContent, lintJob } from "./lint.js";
import { describeFiles, EXPERIMENT_RE, fingerprint, JobError, JobStore, snapshotExperiment } from "./store.js";

/** The project ledger, as the executor sees it: one commit per call. */
export interface JobLedger {
  /** Write engine/jobs/<id>.json and any evidence files (project-relative paths) in one tagged commit. */
  write(job: JobRecord, prov: Provenance, summary: string, evidence?: { path: string; content: Buffer }[]): Promise<void>;
}

export interface JobServiceOptions {
  /** Engine home: jobs/, audit.log, ssh/ (the user's ControlMaster sockets). */
  home: string;
  machines: Record<string, MachineConfig>;
  ledger: (project: string) => Promise<JobLedger>;
  /** Default: mux-only SSH through <home>/ssh. Tests inject LocalTransport. */
  transport?: (machine: MachineConfig) => Transport;
  now?: () => Date;
}

export interface SubmitRequest {
  project: string;
  /** Host path of the worktree holding experiments/<experiment>/. */
  worktree: string;
  /**
   * Reads experiments/<experiment>/ for an agent's submission. The engine passes one that reads inside the agent's
   * sandbox, whose mounts can't reach host files, so no symlink race in the worktree can pull in a host secret.
   * Without it, the host reads the worktree (user submissions, tests).
   */
  read?: (experiment: string) => Promise<JobFileContent[]>;
  branch?: string;
  experiment: string;
  target: string;
  author: JobAuthor;
}

const proposedBy = (a: JobAuthor): Provenance => (a.kind === "agent" ? provenance.aiSuggested(a.model, a.effort) : provenance.user);
const executedBy = (a: JobAuthor): Provenance => (a.kind === "agent" ? provenance.aiExecuted(a.model, a.effort) : provenance.user);
const actorOf = (a: JobAuthor) => (a.kind === "agent" ? `agent:${a.agent}` : "user");
const pad = (n: number) => String(n).padStart(2, "0");

function transition(r: JobRecord, state: JobState, at: string, note?: string): JobRecord {
  return { ...r, state, history: [...r.history, { at, state, ...(note ? { note } : {}) }] };
}
function withoutError(r: JobRecord): JobRecord {
  const { error: _e, ...rest } = r;
  return rest;
}

export class JobService {
  readonly store: JobStore;
  readonly audit: AuditLog;
  readonly #now: () => Date;

  constructor(readonly opts: JobServiceOptions) {
    this.store = new JobStore(opts.home);
    this.audit = new AuditLog(join(opts.home, "audit.log"));
    this.#now = opts.now ?? (() => new Date());
  }

  #at(): string {
    return this.#now().toISOString();
  }

  #machine(target: string): MachineConfig {
    const m = this.opts.machines[target];
    if (!m) throw new JobError(`unknown target '${target}' (machines.yaml has: ${Object.keys(this.opts.machines).join(", ") || "none"})`);
    return m;
  }

  #transport(m: MachineConfig): Transport {
    if (this.opts.transport) return this.opts.transport(m);
    try {
      return new SshTransport(m.host, join(this.opts.home, "ssh"));
    } catch (e) {
      throw new RemoteError(`machines.yaml host ${JSON.stringify(m.host)}: ${(e as Error).message}`, "");
    }
  }

  #remote(r: JobRecord, files: RemoteJob["files"] = []): RemoteJob {
    if (!r.remote) throw new JobError(`job ${r.id} has not been launched`);
    return { id: r.id, dir: r.remote.dir, manifest: r.manifest, lint: r.lint, files };
  }

  async #newId(): Promise<string> {
    const t = this.#now();
    const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
    const taken = new Set((await this.store.list()).map((j) => j.id));
    for (;;) {
      const id = `${stamp}-${randomBytes(2).toString("hex")}`;
      if (!taken.has(id)) return id;
    }
  }

  async #record(r: JobRecord, prov: Provenance, summary: string, evidence?: { path: string; content: Buffer }[]): Promise<void> {
    await (await this.opts.ledger(r.project)).write(r, prov, summary, evidence);
  }

  /** jobs.submit: lint, snapshot, pre-flight, then wait for a human (or auto-approve an identical, small rerun). */
  async submit(req: SubmitRequest): Promise<{ job: JobRecord; auto: { ok: boolean; reason: string } }> {
    const actor = actorOf(req.author);
    const base = { actor, project: req.project, target: req.target };
    const reject = async (msg: string, raw?: string): Promise<never> => {
      await this.audit.append({ ...base, action: "submit", ok: false, detail: `${req.experiment}: ${msg}`, ...(raw ? { raw } : {}) });
      throw new JobError(msg);
    };
    const machine = this.opts.machines[req.target];
    let files;
    try {
      if (!EXPERIMENT_RE.test(req.experiment)) throw new JobError(`experiment must be a name like EXP-001, not ${JSON.stringify(req.experiment)}`);
      files = req.read ? await req.read(req.experiment) : await snapshotExperiment(req.worktree, req.experiment);
    } catch (e) {
      return reject((e as Error).message);
    }
    const { lint, manifest } = lintJob({ target: req.target, machine, files });
    if (lint.errors.length > 0 || !manifest || !machine) return reject(`job rejected by lint:\n${lint.errors.map((x) => `- ${x}`).join("\n")}`);

    const id = await this.#newId();
    let preflight: JobRecord["preflight"];
    let preflightNote: string | undefined;
    if (machine.scheduler === "slurm") {
      const transport = this.#transport(machine);
      if (await transport.alive().catch(() => false)) {
        const rj: RemoteJob = { id, dir: jobDir(machine, req.project, id), manifest, lint, files };
        const p = await runnerFor(machine, transport).preflight(rj).catch((e: unknown) => {
          if (e instanceof RemoteError) return { ok: false, detail: `pre-flight failed: ${e.message}`, raw: e.raw };
          throw e;
        });
        if (p) {
          await this.audit.append({ ...base, job: id, action: "preflight", ok: p.ok, detail: p.detail, raw: p.raw });
          if (!p.ok && p.detail.startsWith("Slurm refused")) return reject(p.detail, p.raw);
          preflight = { ok: p.ok, detail: p.detail };
        }
      } else preflightNote = `pre-flight not run: no SSH session to ${machine.host}`;
    }

    const fp = fingerprint(files);
    const all = await this.store.list();
    const twin = all.find((j) => j.project === req.project && j.target === req.target && j.fingerprint === fp && j.approval?.by === "user");
    const auto = autoApproval(req.target, machine, lint, twin !== undefined);
    const at = this.#at();
    let job: JobRecord = {
      v: 1,
      id,
      project: req.project,
      experiment: req.experiment,
      target: req.target,
      state: "pending_approval",
      created: at,
      author: req.author,
      ...(req.branch ? { branch: req.branch } : {}),
      manifest,
      files: describeFiles(files),
      fingerprint: fp,
      lint,
      ...(preflight ? { preflight } : {}),
      history: [{ at, state: "pending_approval", note: [`submitted by ${actor}`, preflightNote].filter(Boolean).join("; ") }],
    };
    await this.store.create(job, files);
    await this.audit.append({ ...base, job: id, action: "submit", ok: true, detail: `${req.experiment}: pending approval (${auto.reason})` });
    await this.#record(job, proposedBy(req.author), `job ${id}: ${req.experiment} on ${req.target}, awaiting approval`);

    if (auto.ok) {
      job = await this.store.update(id, (r) => transition({ ...r, approval: { by: "auto", at: this.#at() } }, "approved", this.#at(), auto.reason));
      await this.audit.append({ ...base, actor: "auto", job: id, action: "approve", ok: true, detail: auto.reason });
      await this.#record(job, executedBy(req.author), `job ${id}: auto-approved (${auto.reason})`);
      job = await this.launch(id);
    }
    return { job, auto };
  }

  /** Human gate: only the user approves (the CLI/app calls this; no MCP tool does). */
  async approve(id: string, note?: string): Promise<JobRecord> {
    const at = this.#at();
    const job = await this.store.update(id, (r) => {
      if (r.state !== "pending_approval") throw new JobError(`job ${id} is ${r.state}, not pending approval`);
      return transition({ ...r, approval: { by: "user", at, ...(note ? { note } : {}) } }, "approved", at, note);
    });
    await this.audit.append({ actor: "user", job: id, project: job.project, target: job.target, action: "approve", ok: true, ...(note ? { detail: note } : {}) });
    await this.#record(job, provenance.user, `job ${id}: approved${note ? ` (${note})` : ""}`);
    return this.launch(id);
  }

  async deny(id: string, reason: string): Promise<JobRecord> {
    if (reason.trim() === "") throw new JobError("a denial needs a reason (it goes back to the agent)");
    const at = this.#at();
    const job = await this.store.update(id, (r) => {
      if (r.state !== "pending_approval") throw new JobError(`job ${id} is ${r.state}, not pending approval`);
      return transition({ ...r, denial: { at, reason } }, "denied", at, reason);
    });
    await this.audit.append({ actor: "user", job: id, project: job.project, target: job.target, action: "deny", ok: true, detail: reason });
    await this.#record(job, provenance.user, `job ${id}: denied (${reason})`);
    return job;
  }

  /**
   * Launch an approved job over the user's SSH session. A remote failure leaves the job approved with `error` set
   * (retry with `re job submit <id>` once the session is open); the next attempt uses a fresh remote directory.
   */
  async launch(id: string): Promise<JobRecord> {
    return this.store.claim(id, "launch", async () => {
      const r = await this.store.get(id);
      if (r.state !== "approved") throw new JobError(`job ${id} is ${r.state}; only approved jobs are launched`);
      if (r.remote) throw new JobError(`job ${id} was already launched`);
      const machine = this.#machine(r.target);
      const attempt = (r.attempts ?? 0) + 1;
      const files = await this.store.files(r);
      const base = { actor: r.approval?.by ?? "user", job: id, project: r.project, target: r.target, action: "launch" };
      try {
        const runner = runnerFor(machine, this.#transport(machine));
        // A failed launch may still have started (connection lost after sbatch, slow start): adopt it, never run twice.
        let started: { id: string; raw: string; dir: string; adopted?: number } | undefined;
        for (let k = attempt - 1; k >= 1 && !started; k--) {
          const dir = jobDir(machine, r.project, id, k);
          const found = await runner.find({ id, dir, manifest: r.manifest, lint: r.lint, files: [] });
          if (found) started = { ...found, dir, adopted: k };
        }
        if (!started) {
          const rj: RemoteJob = { id, dir: jobDir(machine, r.project, id, attempt), manifest: r.manifest, lint: r.lint, files };
          started = { ...(await runner.start(rj)), dir: rj.dir };
        }
        const res = started;
        const at = this.#at();
        const state: JobState = machine.scheduler === "none" ? "running" : "submitted";
        const note = `${machine.host}: ${res.id}${res.adopted ? ` (attempt ${res.adopted} had started after all)` : ""}`;
        const job = await this.store.update(id, (x) =>
          transition(withoutError({ ...x, attempts: res.adopted ?? attempt, remote: { host: machine.host, dir: res.dir, id: res.id, submitted: at } }), state, at, note),
        );
        await this.audit.append({ ...base, ok: true, detail: `${res.dir} (${res.id})${res.adopted ? " adopted" : ""}`, raw: res.raw });
        await this.#record(job, executedBy(r.author), `job ${id}: started on ${r.target} (${res.id})`);
        return job;
      } catch (e) {
        if (!(e instanceof RemoteError)) throw e;
        await this.audit.append({ ...base, ok: false, detail: e.message, raw: e.raw });
        return this.store.update(id, (x) => ({ ...x, attempts: attempt, error: e.message }));
      }
    });
  }

  /** jobs.status: ask the machine when the job is in flight; terminal states are final. */
  async refresh(id: string): Promise<JobRecord> {
    const r = await this.store.get(id);
    if (!r.remote || TERMINAL_JOB_STATES.includes(r.state)) return r;
    const machine = this.#machine(r.target);
    let st;
    try {
      st = await runnerFor(machine, this.#transport(machine)).status(this.#remote(r), r.remote.id);
    } catch (e) {
      if (!(e instanceof RemoteError)) throw e;
      await this.audit.append({ actor: "executor", job: id, project: r.project, target: r.target, action: "status", ok: false, detail: e.message, raw: e.raw });
      throw new JobError(`could not reach ${r.target}: ${e.message} (last known state: ${r.state})`);
    }
    if (st.state === "unknown") {
      await this.audit.append({ actor: "executor", job: id, project: r.project, target: r.target, action: "status", ok: false, detail: `state unknown, kept ${r.state}: ${st.detail}`, raw: st.raw });
      return r;
    }
    if (st.state === r.state) return r;
    const next = st.state;
    const at = this.#at();
    const job = await this.store.update(id, (x) => (x.state === r.state ? transition(x, next, at, st.detail) : x));
    await this.audit.append({ actor: "executor", job: id, project: r.project, target: r.target, action: "status", ok: true, detail: `${r.state} → ${job.state}: ${st.detail}`, raw: st.raw });
    if (TERMINAL_JOB_STATES.includes(job.state) || job.state === "lost") await this.#record(job, executedBy(r.author), `job ${id}: ${job.state} (${st.detail})`);
    return job;
  }

  /** jobs.cancel: withdraw a job before launch, or stop it on the machine. */
  async cancel(id: string, actor: string): Promise<JobRecord> {
    return this.store.claim(id, "cancel", async () => {
      const r = await this.store.get(id);
      if (TERMINAL_JOB_STATES.includes(r.state)) throw new JobError(`job ${id} is already ${r.state}`);
      const base = { actor, job: id, project: r.project, target: r.target, action: "cancel" };
      let raw: string | undefined;
      if (r.remote) {
        const machine = this.#machine(r.target);
        try {
          raw = (await runnerFor(machine, this.#transport(machine)).cancel(this.#remote(r), r.remote.id)).raw;
        } catch (e) {
          if (!(e instanceof RemoteError)) throw e;
          await this.audit.append({ ...base, ok: false, detail: e.message, raw: e.raw });
          throw new JobError(`could not cancel on ${r.target}: ${e.message}`);
        }
      }
      const job = await this.store.update(id, (x) => transition(x, "cancelled", this.#at(), r.remote ? `cancelled by ${actor}` : `withdrawn before launch by ${actor}`));
      await this.audit.append({ ...base, ok: true, ...(raw ? { raw } : {}) });
      await this.#record(job, actor === "user" ? provenance.user : executedBy(r.author), `job ${id}: cancelled by ${actor}`);
      return job;
    });
  }

  /**
   * jobs.fetch_results: copy declared outputs (and log tails) into evidence/raw/<EXP>/<job>/ with a MANIFEST.json;
   * larger files stay on the machine, referenced by path (DR-0006 step 5).
   */
  async fetch(id: string): Promise<JobRecord> {
    const current = await this.refresh(id);
    return this.store.claim(id, "fetch", async () => {
      const r = await this.store.get(current.id);
      if (!r.remote) throw new JobError(`job ${id} has not been launched`);
      if (!["completed", "failed", "cancelled"].includes(r.state)) throw new JobError(`job ${id} is ${r.state}; fetch its results after it finishes`);
      const machine = this.#machine(r.target);
      const base = { actor: "executor", job: id, project: r.project, target: r.target, action: "fetch" };
      let res;
      try {
        res = await runnerFor(machine, this.#transport(machine)).fetch(this.#remote(r));
      } catch (e) {
        if (!(e instanceof RemoteError)) throw e;
        await this.audit.append({ ...base, ok: false, detail: e.message, raw: e.raw });
        throw new JobError(`could not fetch from ${r.target}: ${e.message}`);
      }
      const at = this.#at();
      const dir = `evidence/raw/${r.experiment}/${id}`;
      const manifest = {
        job: id,
        project: r.project,
        experiment: r.experiment,
        target: r.target,
        state: r.state,
        remote_dir: r.remote.dir,
        fetched: at,
        author: r.author,
        files: describeFiles(res.files),
        logs: describeFiles(res.logs),
        referenced: res.referenced,
        missing: res.missing,
        refused: res.refused,
      };
      const evidence = [
        ...res.files.map((f) => ({ path: `${dir}/${f.path}`, content: f.content })),
        ...res.logs.map((f) => ({ path: `${dir}/logs/${f.path}`, content: f.content })),
        { path: `${dir}/MANIFEST.json`, content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      ];
      const results = { at, dir, files: res.files.map((f) => f.path), referenced: res.referenced, missing: res.missing, refused: res.refused };
      const job = await this.store.update(id, (x) => ({ ...x, results }));
      const summary = `job ${id}: results for ${r.experiment} (${res.files.length} file${res.files.length === 1 ? "" : "s"}${res.referenced.length ? `, ${res.referenced.length} left on ${r.target}` : ""}${res.missing.length ? `, ${res.missing.length} missing` : ""}${res.refused.length ? `, ${res.refused.length} refused` : ""})`;
      await this.#record(job, executedBy(r.author), summary, evidence);
      await this.audit.append({ ...base, ok: true, detail: summary, raw: res.raw });
      return job;
    });
  }

  get(id: string): Promise<JobRecord> {
    return this.store.get(id);
  }

  async list(filter: { project?: string } = {}): Promise<JobRecord[]> {
    return (await this.store.list()).filter((j) => !filter.project || j.project === filter.project);
  }

  /** The approval card, with the full text of every job file. */
  async card(id: string): Promise<string> {
    const job = await this.store.get(id);
    const files = await this.store.files(job);
    const twin = (await this.store.list()).find(
      (j) => j.id !== id && j.project === job.project && j.target === job.target && j.fingerprint === job.fingerprint && j.approval?.by === "user",
    );
    const machine = this.opts.machines[job.target];
    const auto = machine && job.state === "pending_approval" ? autoApproval(job.target, machine, job.lint, twin !== undefined) : undefined;
    return renderCard(job, files, {
      ...(twin ? { approvedTwin: twin.id } : {}),
      ...(auto ? { autoApproval: `${auto.ok ? "yes" : "no"} — ${auto.reason}` } : {}),
      snapshotDir: join(this.store.root, id, "files"),
      ...(machine ? { scheduler: machine.scheduler } : {}),
    });
  }
}
