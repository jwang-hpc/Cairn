import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_FILE, EventLog, InvalidEventError, USAGE_FILE, envelope, readUsage } from "./log.js";

let home: string;
beforeEach(async () => {
  home = join(await mkdtemp(join(tmpdir(), "cairn-events-")), "engine-home");
});
afterEach(async () => {
  await rm(join(home, ".."), { recursive: true, force: true });
});

const lines = async (file: string) =>
  (await readFile(join(home, file), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function usage(overrides: Partial<UsageEvent> = {}, at = new Date()): UsageEvent {
  return {
    ...envelope("run-1", "mbp", at),
    type: "usage",
    provider: "anthropic",
    route: "anthropic",
    auth: "oauth",
    model: "claude-haiku-5-5",
    role: "triage",
    effort: "low",
    nativeEffort: { turnEffort: "low" },
    tokens: { input: 44, output: 4, cacheRead: 0, cacheWrite: 0 },
    cost: { usd: 0.00002, kind: "notional" },
    durationMs: 500,
    stopReason: "stop",
    error: null,
    ...overrides,
  };
}

describe("EventLog", () => {
  it("writes every event to events.jsonl and usage events also to usage.jsonl", async () => {
    const log = new EventLog(home);
    await log.append({ ...envelope("run-1", "mbp"), type: "message", role: "user", text: "hello" });
    await log.append(usage());
    expect((await lines(EVENTS_FILE)).map((e) => e.type)).toEqual(["message", "usage"]);
    expect((await lines(USAGE_FILE)).map((e) => e.type)).toEqual(["usage"]);
  });

  it("creates the engine home and files private to the user", async () => {
    await new EventLog(home).append(usage());
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, USAGE_FILE))).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid events and writes nothing", async () => {
    const log = new EventLog(home);
    const bad = { ...usage(), effort: "turbo" } as unknown as UsageEvent;
    await expect(log.append(bad)).rejects.toBeInstanceOf(InvalidEventError);
    await expect(stat(join(home, EVENTS_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps lines intact under concurrent appends", async () => {
    const log = new EventLog(home);
    const big = "x".repeat(20_000);
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        log.append({ ...envelope(`run-${i}`, "mbp"), type: "message", role: "assistant", text: `${i}:${big}` }),
      ),
    );
    const events = await lines(EVENTS_FILE);
    expect(events).toHaveLength(200);
    expect(new Set(events.map((e) => e.run)).size).toBe(200);
  });

  it("a failed write does not block later appends", async () => {
    const log = new EventLog(home);
    await expect(log.append({} as UsageEvent)).rejects.toBeInstanceOf(InvalidEventError);
    await log.append(usage());
    expect(await lines(USAGE_FILE)).toHaveLength(1);
  });
});

describe("readUsage", () => {
  it("returns nothing when no usage has been recorded", async () => {
    expect(await readUsage(home)).toEqual({ records: [], badLines: [] });
  });

  it("filters by time window [from, to)", async () => {
    const log = new EventLog(home);
    await log.append(usage({ model: "a" }, new Date("2026-10-12T23:59:59Z")));
    await log.append(usage({ model: "b" }, new Date("2026-10-13T00:00:00Z")));
    await log.append(usage({ model: "c" }, new Date("2026-10-14T00:00:00Z")));
    const r = await readUsage(home, { from: new Date("2026-10-13T00:00:00Z"), to: new Date("2026-10-14T00:00:00Z") });
    expect(r.records.map((u) => u.model)).toEqual(["b"]);
  });

  it("skips and reports corrupt or invalid lines", async () => {
    const log = new EventLog(home);
    await log.append(usage({ model: "ok-1" }));
    await appendFile(join(home, USAGE_FILE), '{"truncated": \n{"type":"usage"}\n');
    await log.append(usage({ model: "ok-2" }));
    const r = await readUsage(home);
    expect(r.records.map((u) => u.model)).toEqual(["ok-1", "ok-2"]);
    expect(r.badLines).toEqual([2, 3]);
  });
});
