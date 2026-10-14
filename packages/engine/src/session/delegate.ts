// Delegation (DR-0014): a proposal the user launches. A task runs a sandboxed worker (the same path as `re run`) in the
// background, at most `maxPerProject` at once (the user's choice: 3), the rest queued; its steps stream as events and
// its outcome comes back to the session's card. A decision is recorded in the ledger (user-revised: the orchestrator
// drafted it, the user accepted it). Nothing here approves a job or a claim: those gates are unchanged.
import { provenance, type EngineEvent } from "@cairn/shared";
import type { Engine } from "../engine.js";
import { readUsage } from "../events/log.js";
import type { Ledger } from "../ledger/ledger.js";
import type { WorkerDeps } from "../worker/run.js";
import { runTask } from "../worker/task.js";
import type { DelegationOutcome, Proposal, SessionStore } from "./store.js";

export type SessionEvent =
  | { type: "turn_delta"; project: string; session: string; text: string }
  | { type: "turn_tool"; project: string; session: string; name: string; detail: string }
  | { type: "turn_end"; project: string; session: string; run: string; usd: number; error: string | null }
  | { type: "proposal"; project: string; session: string; proposal: Proposal }
  | { type: "worker_step"; project: string; session: string; proposal: string; run: string; at: string; step: string };

/** In-process fan-out of session events (the API forwards them to the app's event stream). */
export class SessionHub {
  readonly #listeners = new Set<(e: SessionEvent) => void>();
  subscribe(fn: (e: SessionEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }
  emit(e: SessionEvent): void {
    for (const fn of this.#listeners) {
      try {
        fn(e);
      } catch {
        // a listener's failure is its own
      }
    }
  }
}

const short = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** A worker's step in plain words, for the activity card (undefined: not worth showing). */
export function describeStep(e: EngineEvent): string | undefined {
  if (e.type === "tool_call") {
    const a = (e.args ?? {}) as Record<string, unknown>;
    const name = e.mcp ?? e.name;
    if (name === "bash") return `running: ${short(a.command)}`;
    if (name === "python") return "running python";
    if (name === "read") return `reading ${short(a.path)}`;
    if (name === "write") return `writing ${short(a.path)}`;
    if (name === "edit") return `editing ${short(a.path)}`;
    if (name === "jobs.submit") return `proposing a job: ${short(a.experiment)} on ${short(a.target)}`;
    if (name === "jobs.status") return "checking job status";
    if (name === "jobs.fetch_results") return `fetching results of ${short(a.experiment)}`;
    if (name === "literature.search") return `searching literature: ${short(a.query)}`;
    if (name === "literature.fetch") return `reading paper ${short(a.id)}`;
    if (name === "literature.resolve") return `verifying a citation: ${short(a.doi ?? a.arxiv ?? a.title)}`;
    if (name === "literature.expand") return `following ${short(a.direction)} of ${short(a.id)}`;
    return `using ${name}`;
  }
  if (e.type === "tool_result" && e.isError) return `error in ${e.name}: ${short(e.text, 120)}`;
  if (e.type === "message" && e.role === "assistant") return `note: ${short(e.text, 120)}`;
  return undefined;
}

export interface DelegationDeps {
  engine: Engine;
  store: SessionStore;
  hub: SessionHub;
  ledgerFor: (project: string) => Promise<Ledger>;
  /** Everything runWorker needs besides the engine (skills dir, jobs, literature, sandbox launcher for tests). */
  worker: Omit<WorkerDeps, "engine" | "observe">;
  maxPerProject?: number;
}

export class DelegationError extends Error {}

type Ref = { project: string; session: string; proposal: string };
const key = (r: Ref) => `${r.project}/${r.session}/${r.proposal}`;

export class Delegations {
  readonly #running = new Map<string, number>();
  readonly #queue = new Map<string, Ref[]>();
  readonly #stops = new Map<string, AbortController>();
  readonly #done = new Set<Promise<void>>();

  constructor(readonly deps: DelegationDeps) {}

  get maxPerProject(): number {
    return this.deps.maxPerProject ?? 3;
  }

  async #update(r: Ref, change: (p: Proposal) => void): Promise<Proposal> {
    let out: Proposal | undefined;
    await this.deps.store.update(r.project, r.session, (rec) => {
      const p = rec.proposals.find((x) => x.id === r.proposal);
      if (!p) throw new DelegationError(`no proposal ${r.proposal} in session ${r.session}`);
      change(p);
      p.updated = new Date().toISOString();
      rec.updated = p.updated;
      out = p;
    });
    await this.deps.store.append(r.project, r.session, { at: out!.updated, kind: "proposal", proposal: out! });
    this.deps.hub.emit({ type: "proposal", project: r.project, session: r.session, proposal: out! });
    return out!;
  }

  /** The user's click. A task is queued (and starts when a slot is free); a decision is recorded now. */
  async launch(r: Ref): Promise<Proposal> {
    const rec = await this.deps.store.load(r.project, r.session);
    const p = rec.proposals.find((x) => x.id === r.proposal);
    if (!p) throw new DelegationError(`no proposal ${r.proposal} in session ${r.session}`);
    if (p.state !== "proposed") throw new DelegationError(`${p.id} is ${p.state}, not waiting for launch`);
    if (p.kind === "decision") {
      const ledger = await this.deps.ledgerFor(r.project);
      const id = await ledger.addDecision(p.title, provenance.userRevised, p.refs ?? [], p.rationale);
      return this.#update(r, (x) => {
        x.state = "recorded";
        x.recorded = id;
      });
    }
    const queued = await this.#update(r, (x) => void (x.state = "queued"));
    (this.#queue.get(r.project) ?? this.#queue.set(r.project, []).get(r.project)!).push(r);
    this.#pump(r.project);
    return queued;
  }

  async dismiss(r: Ref): Promise<Proposal> {
    return this.#update(r, (p) => {
      if (p.state !== "proposed") throw new DelegationError(`${p.id} is ${p.state}; only a proposal waiting for launch can be dismissed`);
      p.state = "dismissed";
    });
  }

  /** Stop a running worker (it keeps what it changed), or take a queued one out of the queue. */
  async stop(r: Ref): Promise<Proposal> {
    const q = this.#queue.get(r.project) ?? [];
    const i = q.findIndex((x) => key(x) === key(r));
    if (i >= 0) {
      q.splice(i, 1);
      return this.#update(r, (p) => void (p.state = "stopped"));
    }
    const c = this.#stops.get(key(r));
    if (!c) throw new DelegationError(`${r.proposal} is not running`);
    c.abort();
    const rec = await this.deps.store.load(r.project, r.session);
    return rec.proposals.find((x) => x.id === r.proposal)!;
  }

  /** Workers running or queued, per project. */
  activity(project: string): { running: number; queued: number } {
    return { running: this.#running.get(project) ?? 0, queued: this.#queue.get(project)?.length ?? 0 };
  }

  /** Resolves when every started worker has finished (tests, and a clean exit of `re chat`). */
  async idle(): Promise<void> {
    while (this.#done.size) await Promise.allSettled([...this.#done]);
  }

  #pump(project: string): void {
    const q = this.#queue.get(project) ?? [];
    while ((this.#running.get(project) ?? 0) < this.maxPerProject && q.length) {
      const r = q.shift()!;
      this.#running.set(project, (this.#running.get(project) ?? 0) + 1);
      const p = this.#run(r).finally(() => {
        this.#running.set(project, (this.#running.get(project) ?? 1) - 1);
        this.#done.delete(p);
        this.#pump(project);
      });
      this.#done.add(p);
    }
  }

  async #run(r: Ref): Promise<void> {
    const { engine, store, hub } = this.deps;
    const stop = new AbortController();
    this.#stops.set(key(r), stop);
    try {
      const rec = await store.load(r.project, r.session);
      const p = rec.proposals.find((x) => x.id === r.proposal)!;
      const ledger = await this.deps.ledgerFor(r.project);
      const task = [
        p.task ?? p.title,
        ...(p.files?.length ? ["", `Project files to start from: ${p.files.join(", ")}`] : []),
        "",
        `(Delegated from a research session on project ${r.project} after the researcher launched it. When you finish, write /outbox/report.json; put anything the researcher must decide under "questions".)`,
      ].join("\n");
      let run: string | undefined;
      const result = await runTask(
        {
          engine,
          ...this.deps.worker,
          observe: {
            started: (id) => {
              run = id;
              void this.#update(r, (x) => {
                x.state = "running";
                x.run = id;
              }).catch(() => {});
            },
            event: (e) => {
              const step = describeStep(e);
              if (step && run) hub.emit({ type: "worker_step", project: r.project, session: r.session, proposal: r.proposal, run, at: e.ts, step });
            },
          },
        },
        { repo: ledger.dir, role: p.role!, task, signal: stop.signal },
      );
      const res = result.result;
      const branch = result.commit ? result.worktree.branch : undefined;
      const jobs = (await this.deps.worker.jobs?.list().catch(() => [])) ?? [];
      const usd = (await readUsage(engine.paths.home)).records.filter((u) => u.run === res.run).reduce((s, u) => s + u.cost.usd, 0);
      const outcome: DelegationOutcome = {
        status: stop.signal.aborted ? "stopped" : res.status,
        summary: res.report.summary,
        ...(branch ? { branch } : {}),
        ...(result.commit ? { commit: result.commit } : {}),
        files: res.files.map((f) => `${f.path} (${f.status})`),
        questions: res.report.questions ?? [],
        jobs: jobs.filter((j) => j.author.kind === "agent" && j.author.run === res.run).map((j) => `${j.id} (${j.state})`),
        drafts: branch ? res.files.filter((f) => f.status !== "deleted" && /^staging\/claims\/[^/]+\.md$/.test(f.path)).map((f) => `${branch}:${f.path}`) : [],
        literature: res.files.some((f) => f.path.startsWith("lit/")),
        ...(res.error ? { error: res.error } : {}),
        usd,
      };
      await this.#update(r, (x) => {
        x.state = stop.signal.aborted ? "stopped" : res.status === "done" ? "done" : res.status === "needs_input" ? "needs_input" : "failed";
        x.outcome = outcome;
      });
    } catch (e) {
      await this.#update(r, (x) => {
        x.state = stop.signal.aborted ? "stopped" : "failed";
        x.outcome = { status: "failed", summary: "", files: [], questions: [], jobs: [], drafts: [], literature: false, error: (e as Error).message };
      }).catch(() => {});
    } finally {
      this.#stops.delete(key(r));
    }
  }
}
