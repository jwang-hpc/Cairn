import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  type Provider,
  Type,
} from "@earendil-works/pi-ai";
import type { EngineEvent, UsageEvent } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetGovernor } from "../budget/governor.js";
import type { LoadedConfig } from "../config/load.js";
import { EventLog, readUsage } from "../events/log.js";
import { type CallSpec, ModelLayer, type PiRuntime } from "./layer.js";

const MODEL = { id: "m1", reasoning: true, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };

function config(overrides: { effortMax?: "high" | "max"; tokenCap?: number } = {}): LoadedConfig {
  return {
    dir: "(test)",
    models: {
      providers: {
        acme: {
          routes: [
            { pi_provider: "faux-sub", auth: "oauth" },
            { pi_provider: "faux-key", auth: "api_key" },
          ],
          data_classes: ["public", "unpublished"],
          terms_checked: "unchecked",
        },
      },
      models: { "acme-m": { provider: "acme", id: "m1", tool_use: "untested" } },
      effort_map: { acme: { low: "low", medium: "medium", high: "high", max: overrides.effortMax ?? "max" } },
      routing: {},
      projects_default_data_class: "unpublished",
    },
    roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
    machines: { machines: {} },
    engine: {
      machine: "test",
      budget: {
        daily: { usd: { total: 10 }, tokens: { per_provider: { acme: overrides.tokenCap ?? 1_000_000 } } },
        run: { max_usd: 2, max_tokens: 100_000, max_turns: 5 },
      },
    },
  };
}

/** A faux provider that authenticates via OAuth, so the subscription route is exercised for real. */
function withOAuth(p: Provider): Provider {
  return {
    ...p,
    auth: {
      oauth: {
        name: "faux oauth",
        login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
        refresh: async (c) => c,
        toAuth: async (c) => ({ apiKey: c.access }),
      },
    },
  } as Provider;
}

let home: string;
let log: EventLog;
let sub: ReturnType<typeof fauxProvider>;
let key: ReturnType<typeof fauxProvider>;
let pi: PiRuntime;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-models-"));
  log = new EventLog(home);
  sub = fauxProvider({ provider: "faux-sub", models: [MODEL] });
  key = fauxProvider({ provider: "faux-key", models: [MODEL] });
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  await stores.oauth.modify("faux-sub", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  models.oauth.setProvider(withOAuth(sub.provider));
  models.api_key.setProvider(key.provider);
  pi = { models, stores };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function setup(cfg = config(), runId = "r1") {
  const governor = new BudgetGovernor(cfg.engine.budget, log);
  const layer = new ModelLayer(cfg, pi, log);
  const run = await governor.startRun("triage", runId);
  const spec: CallSpec = { alias: "acme-m", effort: "low", role: "triage", dataClass: "unpublished", run };
  return { governor, layer, run, spec };
}

const ctx = { messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }] };

async function drain(s: AssistantMessageEventStream): Promise<{ types: string[]; final: AssistantMessage }> {
  const types: string[] = [];
  for await (const e of s) types.push(e.type);
  return { types, final: await s.result() };
}

const usage = async () => (await readUsage(home)).records;
const allEvents = async (): Promise<EngineEvent[]> => {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(join(home, "events.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EngineEvent);
};

describe("ModelLayer routing", () => {
  it("uses the subscription route first and records a notional-cost usage event", async () => {
    const { layer, spec } = await setup();
    sub.setResponses([fauxAssistantMessage([fauxText("hi there")])]);
    const { types, final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("stop");
    expect(types).toContain("text_delta");
    const [u] = await usage();
    expect(u).toMatchObject<Partial<UsageEvent>>({
      provider: "acme",
      route: "faux-sub",
      auth: "oauth",
      model: "m1",
      alias: "acme-m",
      role: "triage",
      effort: "low",
      machine: "test",
      run: "r1",
      stopReason: "stop",
      error: null,
    });
    expect(u!.cost.kind).toBe("notional");
    expect(key.state.callCount).toBe(0);
  });

  it("falls back to the API key on a usage-limit error before any content, recording both attempts", async () => {
    const { layer, spec } = await setup();
    sub.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 usage limit reached" })]);
    key.setResponses([fauxAssistantMessage([fauxText("from api key")])]);
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("stop");
    const records = await usage();
    expect(records.map((r) => [r.route, r.auth, r.cost.kind, r.error])).toEqual([
      ["faux-sub", "oauth", "notional", "429 usage limit reached"],
      ["faux-key", "api_key", "billed", null],
    ]);
  });

  it("does not fall back on errors that would fail on every route", async () => {
    const { layer, spec } = await setup();
    sub.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request: unknown parameter" })]);
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toContain("400 invalid request");
    expect(key.state.callCount).toBe(0);
  });

  it("does not fall back once content has streamed (no duplicate answers)", async () => {
    const { layer, spec } = await setup();
    sub.setResponses([fauxAssistantMessage([fauxText("partial answer")], { stopReason: "error", errorMessage: "502 bad gateway" })]);
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("error");
    expect(key.state.callCount).toBe(0);
    expect(await usage()).toHaveLength(1);
  });

  it("skips the subscription route when not logged in, without recording a call", async () => {
    await pi.stores.oauth.delete("faux-sub");
    const { layer, spec } = await setup();
    key.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("stop");
    expect((await usage()).map((r) => r.route)).toEqual(["faux-key"]);
    expect(sub.state.callCount).toBe(0);
  });

  it("explains every route's failure when none succeeds", async () => {
    await pi.stores.oauth.delete("faux-sub");
    const { layer, spec } = await setup();
    key.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })]);
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toBe(
      "no route for acme-m succeeded:\n" +
        "  - faux-sub/oauth: not logged in (run: re login faux-sub oauth)\n" +
        "  - faux-key/api_key: auth failure: 401 invalid api key",
    );
  });
});

describe("ModelLayer policy", () => {
  it("refuses data classes the provider may not receive, logs the refusal, and calls nothing (invariant 9)", async () => {
    const { layer, spec } = await setup();
    const { final } = await drain(await layer.stream({ ...spec, dataClass: "restricted" }, ctx));
    expect(final.errorMessage).toMatch(/^refused: provider 'acme' may not receive 'restricted' data/);
    expect(sub.state.callCount + key.state.callCount).toBe(0);
    const [ev] = await allEvents();
    expect(ev).toMatchObject({ type: "approval", decision: "denied", by: "policy" });
  });

  it("moves to the API key when the subscription's daily token cap is used up", async () => {
    const { governor, layer, spec } = await setup(config({ tokenCap: 100 }));
    await governor.record({
      ...(await import("../events/log.js")).envelope("earlier", "test"),
      type: "usage", provider: "acme", route: "faux-sub", auth: "oauth", model: "m1", role: "triage", effort: "low",
      nativeEffort: {}, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { usd: 0, kind: "notional" },
      durationMs: 1, stopReason: "stop", error: null,
    });
    key.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.stopReason).toBe("stop");
    expect(sub.state.callCount).toBe(0);
  });

  it("stops at the per-run turn cap without calling the model", async () => {
    const { layer, run, spec } = await setup();
    run.turns = 5;
    const { final } = await drain(await layer.stream(spec, ctx));
    expect(final.errorMessage).toMatch(/^run budget reached: model calls in run r1: 5 turns of 5 cap/);
    expect(sub.state.callCount + key.state.callCount).toBe(0);
  });

  it("maps engine effort through effort_map before calling pi-ai", async () => {
    const { layer, spec } = await setup(config({ effortMax: "high" }));
    let seen: unknown;
    sub.setResponses([(_c, options) => ((seen = options?.reasoning), fauxAssistantMessage([fauxText("ok")]))]);
    await drain(await layer.stream({ ...spec, effort: "max" }, ctx));
    expect(seen).toBe("high");
    expect((await usage())[0]!.effort).toBe("max");
  });

  it("treats an 'off' mapping as no reasoning, overriding whatever level the agent passes", async () => {
    const cfg = config();
    cfg.models.effort_map.acme!.low = "off";
    const { layer, spec } = await setup(cfg);
    let seen: unknown = "unset";
    sub.setResponses([(_c, options) => ((seen = options?.reasoning), fauxAssistantMessage([fauxText("ok")]))]);
    await drain(await layer.stream(spec, ctx, { reasoning: "high" }));
    expect(seen).toBeUndefined();
  });

  it("rejects unknown aliases up front", async () => {
    const { layer, spec } = await setup();
    expect(() => layer.streamFn({ ...spec, alias: "nope" })).toThrow("unknown model alias 'nope' (known: acme-m)");
  });
});

describe("ModelLayer + pi-agent-core", () => {
  it("runs an agent tool loop with every turn recorded", async () => {
    const { layer, spec } = await setup();
    sub.setResponses([
      fauxAssistantMessage([fauxToolCall("add", { a: 17, b: 25 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("42")]),
    ]);
    const AddParams = Type.Object({ a: Type.Integer(), b: Type.Integer() });
    const add: AgentTool<typeof AddParams> = {
      name: "add",
      label: "Add",
      description: "Add two integers",
      parameters: AddParams,
      execute: async (_id, { a, b }) => ({ content: [{ type: "text", text: String(a + b) }], details: {} }),
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: "Use tools for arithmetic.",
        model: pi.models.oauth.getModel("faux-sub", "m1")!,
        tools: [add],
      },
      streamFn: layer.streamFn(spec),
    });
    await agent.prompt("17 + 25?");
    const last = agent.state.messages.at(-1) as AssistantMessage;
    expect(last.content).toEqual([expect.objectContaining({ type: "text", text: "42" })]);
    expect((await usage()).map((u) => u.stopReason)).toEqual(["toolUse", "stop"]);
  });
});
