// Budget governor (DR-0010 layer 2). Every model call goes through a BudgetRun: check() before the call,
// record() after. Daily totals are rebuilt from usage.jsonl, so caps hold across processes and restarts.
import type { AuthKind, EngineConfig, UsageEvent } from "@cairn/shared";
import { type EventLog, readUsage } from "../events/log.js";

export type BudgetCaps = EngineConfig["budget"];

/** Subscription limits are usage windows, not money: they are capped in tokens (spike finding C7). */
export const tokensOf = (u: UsageEvent) => u.tokens.input + u.tokens.output + u.tokens.cacheRead + u.tokens.cacheWrite;

interface Tally {
  total: number;
  byProvider: Map<string, number>;
  byRole: Map<string, number>;
}
const tally = (): Tally => ({ total: 0, byProvider: new Map(), byRole: new Map() });
const bump = (t: Tally, provider: string, role: string, n: number) => {
  t.total += n;
  t.byProvider.set(provider, (t.byProvider.get(provider) ?? 0) + n);
  t.byRole.set(role, (t.byRole.get(role) ?? 0) + n);
};

export interface DailyTotals {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Billed (API-key) spend in USD. */
  usd: Tally;
  /** Subscription tokens. */
  tokens: Tally;
  /** usage.jsonl lines that could not be read. */
  badLines: number[];
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: "daily" | "run",
    readonly configKey: string,
    readonly used: number,
    readonly cap: number,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtTok = (n: number) => n.toLocaleString("en-US");

export class BudgetGovernor {
  #today: DailyTotals | undefined;
  #loading: Promise<DailyTotals> | undefined;

  constructor(
    readonly caps: BudgetCaps,
    readonly log: EventLog,
    readonly now: () => Date = () => new Date(),
  ) {}

  /** Today's totals, reloaded from usage.jsonl when the local day changes (or when forced). */
  async today(reload = false): Promise<DailyTotals> {
    const day = localDay(this.now());
    if (!reload && this.#today?.day === day) return this.#today;
    if (!this.#loading) {
      this.#loading = (async () => {
        const from = localMidnight(this.now());
        const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
        const { records, badLines } = await readUsage(this.log.home, { from, to });
        const t: DailyTotals = { day, usd: tally(), tokens: tally(), badLines };
        for (const u of records) add(t, u);
        this.#today = t;
        return t;
      })().finally(() => {
        this.#loading = undefined;
      });
    }
    return this.#loading;
  }

  /**
   * Begin a run (one worker invocation or CLI call) for a role. Reloads today's totals so spend by other
   * engine processes on this machine is seen; overspend across processes is bounded by concurrent runs.
   */
  async startRun(role: string, runId: string): Promise<BudgetRun> {
    await this.#idle();
    await this.today(true);
    return new BudgetRun(this, role, runId);
  }

  /** Wait for in-flight record() calls so a reload can't miss or double-count them. */
  #pending = new Set<Promise<void>>();
  async #idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** Throws BudgetExceededError if a daily cap relevant to this call is already reached. */
  async checkDaily(provider: string, auth: AuthKind, role: string): Promise<void> {
    const t = await this.today();
    const d = this.caps.daily;
    if (auth === "api_key") {
      limit("daily", "budget.daily.usd.total", t.usd.total, d.usd.total, "USD", `billed calls today`);
      limit("daily", `budget.daily.usd.per_provider.${provider}`, t.usd.byProvider.get(provider) ?? 0, d.usd.per_provider?.[provider], "USD", `billed ${provider} calls today`);
      limit("daily", `budget.daily.per_role.${role}.usd`, t.usd.byRole.get(role) ?? 0, d.per_role?.[role]?.usd, "USD", `billed calls by role '${role}' today`);
    } else {
      limit("daily", "budget.daily.tokens.total", t.tokens.total, d.tokens.total, "tokens", `subscription tokens today`);
      limit("daily", `budget.daily.tokens.per_provider.${provider}`, t.tokens.byProvider.get(provider) ?? 0, d.tokens.per_provider?.[provider], "tokens", `${provider} subscription tokens today`);
      limit("daily", `budget.daily.per_role.${role}.tokens`, t.tokens.byRole.get(role) ?? 0, d.per_role?.[role]?.tokens, "tokens", `subscription tokens by role '${role}' today`);
    }
  }

  /**
   * Persist a usage record (invariant 6) and add it to today's totals. Totals are loaded *before* the
   * append, so a first-time load can't count this record twice.
   */
  record(u: UsageEvent): Promise<void> {
    const p = (async () => {
      const t = await this.today();
      await this.log.append(u);
      if (localDay(new Date(u.ts)) === t.day) add(t, u);
    })();
    // Tracking copy never rejects; the caller still sees failures through `p`.
    const tracked: Promise<void> = p.then(
      () => undefined,
      () => undefined,
    ).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
    return p;
  }
}

function add(t: DailyTotals, u: UsageEvent) {
  if (u.cost.kind === "billed") bump(t.usd, u.provider, u.role, u.cost.usd);
  else bump(t.tokens, u.provider, u.role, tokensOf(u));
}

function limit(
  scope: "daily" | "run",
  key: string,
  used: number,
  cap: number | undefined,
  unit: "USD" | "tokens" | "turns",
  what: string,
) {
  if (cap === undefined || used < cap) return;
  const fmt = unit === "USD" ? fmtUsd : fmtTok;
  const when = scope === "daily" ? "or wait until local midnight" : "or split the task";
  throw new BudgetExceededError(
    scope,
    key,
    used,
    cap,
    `${scope} budget reached: ${what}: ${fmt(used)}${unit === "USD" ? "" : ` ${unit}`} of ${fmt(cap)} cap (${key} in config/engine.yaml). Raise the cap ${when}.`,
  );
}

/** Per-run accounting; stops runaway loops (max turns / tokens / billed USD per run). */
export class BudgetRun {
  turns = 0;
  tokens = 0;
  usd = 0;

  constructor(
    readonly governor: BudgetGovernor,
    readonly role: string,
    readonly runId: string,
  ) {}

  /** Call before every model request. */
  async check(provider: string, auth: AuthKind): Promise<void> {
    const r = this.governor.caps.run;
    limit("run", "budget.run.max_turns", this.turns, r.max_turns, "turns", `model calls in run ${this.runId}`);
    limit("run", "budget.run.max_tokens", this.tokens, r.max_tokens, "tokens", `tokens in run ${this.runId}`);
    limit("run", "budget.run.max_usd", this.usd, r.max_usd, "USD", `billed spend in run ${this.runId}`);
    await this.governor.checkDaily(provider, auth, this.role);
  }

  /** Call after every model request, including failed ones (they can still consume tokens). */
  async record(u: UsageEvent): Promise<void> {
    if (u.run !== this.runId || u.role !== this.role) {
      throw new Error(`usage record for run ${u.run}/${u.role} recorded on run ${this.runId}/${this.role}`);
    }
    await this.governor.record(u);
    this.turns += 1;
    this.tokens += tokensOf(u);
    if (u.cost.kind === "billed") this.usd += u.cost.usd;
  }
}
