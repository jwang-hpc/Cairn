import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthKind, UsageEvent } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, envelope, readUsage } from "../events/log.js";
import { type BudgetCaps, BudgetExceededError, BudgetGovernor } from "./governor.js";

const caps: BudgetCaps = {
  daily: {
    usd: { total: 10, per_provider: { anthropic: 5, openai: 5 } },
    tokens: { per_provider: { anthropic: 1000 } },
    per_role: { coder: { usd: 1 } },
  },
  run: { max_usd: 2, max_tokens: 500, max_turns: 3 },
};

let home: string;
let clock: Date;
const now = () => clock;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-budget-"));
  clock = new Date(2026, 9, 13, 15, 0, 0); // local 2026-10-13 15:00
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function usage(run: string, role: string, o: { provider?: string; auth?: AuthKind; usd?: number; tokens?: number; at?: Date } = {}): UsageEvent {
  const auth = o.auth ?? "api_key";
  return {
    ...envelope(run, "mbp", o.at ?? clock),
    type: "usage",
    provider: o.provider ?? "openai",
    route: auth === "oauth" ? "openai-codex" : "openai",
    auth,
    model: "gpt-6.1-sol",
    role,
    effort: "low",
    nativeEffort: {},
    tokens: { input: o.tokens ?? 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { usd: o.usd ?? 0.01, kind: auth === "api_key" ? "billed" : "notional" },
    durationMs: 1,
    stopReason: "stop",
    error: null,
  };
}

const governor = () => new BudgetGovernor(caps, new EventLog(home), now);

async function caught(p: Promise<unknown>): Promise<BudgetExceededError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BudgetExceededError) return e;
    throw e;
  }
  throw new Error("expected BudgetExceededError");
}

// Daily-cap tests seed spend through governor.record() (as earlier runs would) and check with a fresh
// run, so per-run caps don't fire first.
describe("daily caps", () => {
  it("blocks billed calls once a provider's USD cap is reached, with an actionable message", async () => {
    const g = governor();
    await g.record(usage("earlier", "analysis", { usd: 5.02 }));
    const run = await g.startRun("analysis", "r1");
    const e = await caught(run.check("openai", "api_key"));
    expect(e.scope).toBe("daily");
    expect(e.configKey).toBe("budget.daily.usd.per_provider.openai");
    expect(e.message).toBe(
      "daily budget reached: billed openai calls today: $5.02 of $5.00 cap (budget.daily.usd.per_provider.openai in config/engine.yaml). Raise the cap or wait until local midnight.",
    );
  });

  it("does not block subscription calls on USD caps, nor billed calls on token caps", async () => {
    const g = governor();
    await g.record(usage("earlier", "analysis", { usd: 6 }));
    const run = await g.startRun("analysis", "r1");
    await expect(run.check("openai", "oauth")).resolves.toBeUndefined();

    await g.record(usage("earlier", "analysis", { provider: "anthropic", auth: "oauth", tokens: 1000 }));
    expect((await caught(run.check("anthropic", "oauth"))).configKey).toBe("budget.daily.tokens.per_provider.anthropic");
    await expect(run.check("anthropic", "api_key")).resolves.toBeUndefined();
  });

  it("enforces the per-role and total USD caps", async () => {
    const g = governor();
    await g.record(usage("earlier", "coder", { usd: 1 }));
    const coder = await g.startRun("coder", "r1");
    expect((await caught(coder.check("anthropic", "api_key"))).configKey).toBe("budget.daily.per_role.coder.usd");

    await g.record(usage("earlier", "analysis", { provider: "anthropic", usd: 4.5 }));
    await g.record(usage("earlier", "analysis", { provider: "openai", usd: 4.5 }));
    const other = await g.startRun("analysis", "r2");
    expect((await caught(other.check("google", "api_key"))).configKey).toBe("budget.daily.usd.total");
  });

  it("rebuilds today's totals from usage.jsonl after a restart", async () => {
    const run = await governor().startRun("analysis", "r1");
    await run.record(usage("r1", "analysis", { usd: 5 }));
    const fresh = await governor().startRun("analysis", "r2"); // new process, same home
    expect((await caught(fresh.check("openai", "api_key"))).used).toBeCloseTo(5);
  });

  it("counts a record exactly once when it is the governor's first call (regression)", async () => {
    const g = governor();
    await g.record(usage("earlier", "analysis", { usd: 1.25 }));
    expect((await g.today()).usd.total).toBeCloseTo(1.25);
  });

  it("sees spend recorded by another engine process when a run starts", async () => {
    const a = governor();
    const b = governor(); // second process, same engine home
    const runB = await b.startRun("analysis", "rb");
    await a.record(usage("ra", "analysis", { usd: 5 }));
    await expect(runB.check("openai", "api_key")).resolves.toBeUndefined(); // b's run predates a's spend
    const runB2 = await b.startRun("analysis", "rb2");
    expect((await caught(runB2.check("openai", "api_key"))).used).toBeCloseTo(5);
  });

  it("does not double-count records still being written when a run starts", async () => {
    const g = governor();
    const writes = Array.from({ length: 20 }, () => g.record(usage("earlier", "analysis", { usd: 0.1 })));
    await g.startRun("analysis", "r1");
    await Promise.all(writes);
    expect((await g.today()).usd.total).toBeCloseTo(2);
  });

  it("ignores yesterday's usage and resets at local midnight", async () => {
    const g = governor();
    await g.record(usage("earlier", "analysis", { usd: 5, at: new Date(2026, 9, 12, 23, 59) }));
    const run = await g.startRun("analysis", "r1");
    await expect(run.check("openai", "api_key")).resolves.toBeUndefined();

    await g.record(usage("earlier", "analysis", { usd: 5 }));
    expect((await caught(run.check("openai", "api_key"))).scope).toBe("daily");
    clock = new Date(2026, 9, 14, 0, 0, 1);
    const next = await g.startRun("analysis", "r2");
    await expect(next.check("openai", "api_key")).resolves.toBeUndefined();
  });
});

describe("run caps (runaway loops)", () => {
  it("stops after max_turns model calls", async () => {
    const run = await governor().startRun("analysis", "r1");
    for (let i = 0; i < 3; i++) {
      await run.check("openai", "oauth");
      await run.record(usage("r1", "analysis", { auth: "oauth" }));
    }
    const e = await caught(run.check("openai", "oauth"));
    expect(e).toMatchObject({ scope: "run", configKey: "budget.run.max_turns", used: 3, cap: 3 });
  });

  it("stops on run token and billed-USD caps", async () => {
    const r1 = await governor().startRun("analysis", "r1");
    await r1.record(usage("r1", "analysis", { auth: "oauth", tokens: 500 }));
    expect((await caught(r1.check("openai", "oauth"))).configKey).toBe("budget.run.max_tokens");

    const r2 = await governor().startRun("analysis", "r2");
    await r2.record(usage("r2", "analysis", { usd: 2 }));
    expect((await caught(r2.check("openai", "oauth"))).configKey).toBe("budget.run.max_usd");
  });

  it("records every call to usage.jsonl and refuses records from another run", async () => {
    const run = await governor().startRun("analysis", "r1");
    await run.record(usage("r1", "analysis"));
    await expect(run.record(usage("r2", "analysis"))).rejects.toThrow(/recorded on run r1/);
    expect((await readUsage(home)).records).toHaveLength(1);
  });
});
