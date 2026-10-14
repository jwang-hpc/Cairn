import { describe, expect, it } from "vitest";
import { EngineEvent, UsageEvent } from "./events.js";
import { validate } from "./validate.js";

const envelope = { v: 1, ts: "2026-10-13T22:26:11.929Z", id: "e1", run: "r1", machine: "mbp", engine: "0.0.0" } as const;

const usage = {
  ...envelope,
  type: "usage",
  provider: "anthropic",
  route: "anthropic",
  auth: "oauth",
  model: "claude-haiku-5-5",
  alias: "claude-haiku",
  role: "triage",
  effort: "max",
  nativeEffort: { turnEffort: "max" },
  tokens: { input: 44, output: 60, cacheRead: 0, cacheWrite: 0 },
  cost: { usd: 0.0000344, kind: "notional" },
  durationMs: 1581,
  stopReason: "stop",
  error: null,
};

describe("event schemas", () => {
  it("accepts one valid event of each type", () => {
    const events = [
      { ...envelope, type: "message", role: "user", text: "hi" },
      { ...envelope, type: "tool_call", toolCallId: "t1", name: "add", args: { a: 1, b: 2 } },
      { ...envelope, type: "tool_result", toolCallId: "t1", name: "add", isError: false, text: "3" },
      usage,
      { ...envelope, type: "approval", subject: "jobs.submit EXP-001 on workstation", decision: "approved", by: "user" },
      { ...envelope, type: "egress", agent: "a1", role: "coder", decision: "deny", target: "example.com:443", reason: "not on allowlist" },
    ];
    for (const e of events) expect(validate(EngineEvent, e)).toEqual({ ok: true, value: e });
  });

  it("requires the fields invariant 6 depends on (model, effort, tokens, machine)", () => {
    for (const key of ["model", "effort", "tokens", "machine"] as const) {
      const { [key]: _dropped, ...rest } = usage;
      const r = validate(UsageEvent, rest);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain(`(root): missing required key '${key}'`);
    }
  });

  it("rejects effort levels outside the engine scale, naming the allowed values", () => {
    const r = validate(UsageEvent, { ...usage, effort: "xhigh" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['effort: must be one of "low", "medium", "high", "max"']);
  });

  it("distinguishes billed from notional cost", () => {
    expect(validate(UsageEvent, { ...usage, cost: { usd: 0.01, kind: "billed" } }).ok).toBe(true);
    const r = validate(UsageEvent, { ...usage, cost: { usd: 0.01, kind: "free" } });
    expect(r.ok).toBe(false);
  });

  it("rejects negative token counts and unknown keys", () => {
    const r = validate(UsageEvent, { ...usage, tokens: { ...usage.tokens, input: -1 }, prompt: "leaked" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("tokens.input: must be >= 0");
      expect(r.errors).toContain("(root): unknown key 'prompt'");
    }
  });

  it("rejects malformed timestamps and wrong format versions", () => {
    expect(validate(EngineEvent, { ...usage, ts: "yesterday" }).ok).toBe(false);
    expect(validate(EngineEvent, { ...usage, v: 2 }).ok).toBe(false);
  });
});
