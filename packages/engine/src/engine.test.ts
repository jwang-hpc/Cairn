import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { LoadedConfig } from "./config/load.js";
import { Engine } from "./engine.js";
import { readUsage } from "./events/log.js";
import type { PiRuntime } from "./models/layer.js";

const MODEL = { id: "m1", reasoning: true, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } };
const BIG = { id: "m2", reasoning: true, cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 } };

const config: LoadedConfig = {
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
      other: { routes: [{ pi_provider: "nowhere", auth: "api_key" }], data_classes: ["public"], terms_checked: "unchecked" },
    },
    // Pricier alias first: health checks must still pick the cheapest model.
    models: { "acme-big": { provider: "acme", id: "m2", tool_use: "untested" }, "acme-m": { provider: "acme", id: "m1", tool_use: "untested" } },
    effort_map: { acme: { low: "low", medium: "medium", high: "high", max: "max" } },
    routing: { triage: { worker: "acme-m@low" } },
    projects_default_data_class: "unpublished",
  },
  roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
  machines: { machines: {} },
  engine: {
    machine: "test",
    budget: {
      daily: { usd: { total: 10, per_provider: { acme: 5 } }, tokens: { per_provider: { acme: 1_000_000 } } },
      run: { max_usd: 2, max_tokens: 100_000, max_turns: 5 },
    },
  },
};

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
let sub: ReturnType<typeof fauxProvider>;
let key: ReturnType<typeof fauxProvider>;
let engine: Engine;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-engine-"));
  sub = fauxProvider({ provider: "faux-sub", models: [MODEL, BIG] });
  key = fauxProvider({ provider: "faux-key", models: [MODEL, BIG] });
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  await stores.oauth.modify("faux-sub", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }));
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  models.oauth.setProvider(withOAuth(sub.provider));
  models.api_key.setProvider(key.provider);
  const pi: PiRuntime = { models, stores };
  engine = new Engine(config, { configDir: "(test)", home }, pi);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  let streamed = "";
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), write: (c: string) => (streamed += c) },
    out,
    err,
    streamed: () => streamed,
  };
}

const cli = (argv: string[], c = capture()) => runCli(argv, c.io, { openEngine: async () => engine });

describe("re ask (M1 acceptance, offline)", () => {
  it("answers through a pi agent and records the call with model, effort, tokens, machine", async () => {
    sub.setResponses([fauxAssistantMessage([fauxText("Forty-two.")])]);
    const c = capture();
    expect(await cli(["ask", "--effort", "medium", "What", "is", "6x7?"], c)).toBe(0);
    expect(c.streamed()).toBe("Forty-two.\n");
    expect(c.err[0]).toMatch(/^— m1 via faux-sub\/oauth · effort medium · \d+ in \/ \d+ out · \$[\d.]+ notional · stop$/);

    const [u] = (await readUsage(home)).records;
    expect(u).toMatchObject({ model: "m1", effort: "medium", machine: "test", role: "triage", auth: "oauth" });
    expect(u!.tokens.output).toBeGreaterThan(0);

    const events = (await readFile(join(home, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e: { type: string; role?: string }) => `${e.type}:${e.role ?? ""}`)).toEqual([
      "message:user",
      "usage:triage",
      "message:assistant",
    ]);
  });

  it("reports every attempt and exits 1 when no route answers", async () => {
    sub.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 usage limit" })]);
    key.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })]);
    const c = capture();
    expect(await cli(["ask", "hello"], c)).toBe(1);
    expect(c.err.filter((l) => l.startsWith("— "))).toHaveLength(2);
    expect(c.err.at(-1)).toContain("no route for acme-m succeeded");
  });

  it("validates arguments", async () => {
    const c = capture();
    expect(await cli(["ask", "--effort", "xhigh", "hi"], c)).toBe(2);
    expect(c.err[0]).toBe("re ask: --effort must be one of low, medium, high, max");
    expect(await cli(["ask"], capture())).toBe(2);
    expect(await cli(["login", "anthropic", "password"], capture())).toBe(2);
  });
});

describe("re status", () => {
  it("shows routes, problems, and today's usage against caps", async () => {
    sub.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    await engine.ask("hi");
    const c = capture();
    expect(await cli(["status"], c)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("re 0.0.0 · machine test");
    expect(text).toContain("    ✓ faux-sub/oauth");
    expect(text).toContain("    ✓ faux-key/api_key");
    expect(text).toContain("✗ nowhere/api_key — pi-ai has no provider 'nowhere' (check models.yaml routes)");
    expect(text).toMatch(/sub\. tokens {3}total \d+ · acme \d+ \/ 1,000,000/);
    expect(text).toContain("per run       5 turns · 100,000 tokens · $2.00 billed");
  });

  it("--check calls each available route once and reports per route", async () => {
    sub.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    key.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const c = capture();
    expect(await cli(["status", "--check"], c)).toBe(0); // unset routes are skipped, not failed
    const text = c.out.join("\n");
    expect(text).toMatch(/✓ acme faux-sub\/oauth — m1 replied "ok"/);
    expect(text).toMatch(/✓ acme faux-key\/api_key — m1 replied "ok"/);
    expect(text).toContain("– other nowhere/api_key — skipped: pi-ai has no provider");
    expect((await readUsage(home)).records.map((u) => u.route)).toEqual(["faux-sub", "faux-key"]);
  });
});

describe("re status --check failures", () => {
  it("exits 1 when a set-up route fails, and does not fall back during a check", async () => {
    sub.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 usage limit" })]);
    key.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const c = capture();
    expect(await cli(["status", "--check"], c)).toBe(1);
    const text = c.out.join("\n");
    expect(text).toMatch(/✗ acme faux-sub\/oauth — no route for acme-m succeeded/);
    expect(text).toMatch(/✓ acme faux-key\/api_key — m1 replied "ok"/);
    expect(key.state.callCount).toBe(1); // only its own check, no fallback from the sub route
  });
});

describe("config errors", () => {
  it("prints every problem and exits 1", async () => {
    const empty = await mkdtemp(join(tmpdir(), "cairn-noconfig-"));
    const c = capture();
    expect(await runCli(["status"], c.io, { env: { CAIRN_CONFIG_DIR: empty, CAIRN_HOME: home } })).toBe(1);
    expect(c.err[0]).toContain("models.yaml: not found — copy models.example.yaml");
    await rm(empty, { recursive: true, force: true });
  });
});
