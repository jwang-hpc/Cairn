import { describe, expect, it } from "vitest";
import { EngineConfig, MachinesConfig, ModelsConfig, RolesConfig } from "./config.js";
import { validate } from "./validate.js";

const models = {
  providers: {
    anthropic: {
      routes: [
        { pi_provider: "anthropic", auth: "oauth" },
        { pi_provider: "anthropic", auth: "api_key" },
      ],
      data_classes: ["public", "unpublished"],
      terms_checked: "unchecked",
    },
    openai: {
      routes: [
        { pi_provider: "openai-codex", auth: "oauth" },
        { pi_provider: "openai", auth: "api_key" },
      ],
      data_classes: ["public", "unpublished"],
      terms_checked: "unchecked",
    },
  },
  models: {
    "claude-haiku": { provider: "anthropic", id: "claude-haiku-5-5", tool_use: "untested" },
    "gpt-frontier": { provider: "openai", id: "gpt-6.1-sol", tool_use: "untested", context: 272000 },
  },
  effort_map: {
    anthropic: { low: "low", medium: "medium", high: "high", max: "max" },
    openai: { low: "low", medium: "medium", high: "high", max: "max" },
  },
  routing: {
    triage: { worker: "claude-haiku@low" },
    critique: { panel: ["claude-haiku@high", "gpt-frontier@high"], synthesizer: "gpt-frontier@high" },
  },
  projects_default_data_class: "unpublished",
};

const roles = {
  roles: {
    analysis: { mounts: { read: ["evidence/", "logic/"], write: ["analysis/"] }, network: [], executor_tools: ["jobs.fetch_results"] },
  },
  defaults: { secrets: "none", egress: "deny" },
};

const machines = {
  machines: {
    workstation: { host: "ws.example", scheduler: "none", auto_approve_below: { cores: 32, hours: 4 } },
    bebop: {
      host: "login.example",
      scheduler: "slurm",
      account: "alloc",
      partitions: ["bdwall"],
      max: { nodes: 4, walltime: "04:00:00" },
      doe: true,
      paths: { allowed_prefixes: ["/lcrc/project/x"] },
    },
  },
};

const engine = {
  machine: "mbp",
  budget: {
    daily: { usd: { total: 10, per_provider: { anthropic: 5, openai: 5 } }, tokens: { per_provider: { anthropic: 2000000 } } },
    run: { max_usd: 2, max_tokens: 500000, max_turns: 30 },
  },
};

describe("config schemas accept well-formed configs", () => {
  it.each([
    ["models", ModelsConfig, models],
    ["roles", RolesConfig, roles],
    ["machines", MachinesConfig, machines],
    ["engine", EngineConfig, engine],
  ] as const)("%s", (_name, schema, value) => {
    const r = validate(schema, value);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});

describe("config schemas reject broken configs with readable paths", () => {
  it("unknown auth kind in a route", () => {
    const bad = structuredClone(models);
    (bad.providers.openai.routes[0] as { auth: string }).auth = "password";
    const r = validate(ModelsConfig, bad);
    expect(r.ok ? [] : r.errors).toEqual(['providers.openai.routes[0].auth: must be one of "oauth", "api_key"']);
  });

  it("provider with no routes", () => {
    const bad = structuredClone(models);
    bad.providers.anthropic.routes = [];
    const r = validate(ModelsConfig, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("providers.anthropic.routes");
  });

  it("model ref without an effort level", () => {
    const bad = structuredClone(models);
    (bad.routing.triage as { worker: string }).worker = "claude-haiku";
    const r = validate(ModelsConfig, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("routing.triage.worker");
  });

  it("egress other than deny (invariant 3)", () => {
    const r = validate(RolesConfig, { ...roles, defaults: { secrets: "none", egress: "allow" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['defaults.egress: must be one of "deny"']);
  });

  it("placeholder scheduler and malformed walltime", () => {
    const bad = structuredClone(machines);
    (bad.machines.bebop as { scheduler: string }).scheduler = "<slurm|pbs>";
    bad.machines.bebop.max.walltime = "4h";
    const r = validate(MachinesConfig, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('machines.bebop.scheduler: must be one of "none", "slurm", "pbs"');
      expect(r.errors.some((e) => e.startsWith("machines.bebop.max.walltime:"))).toBe(true);
    }
  });

  it("typo'd key is reported, not ignored", () => {
    const r = validate(EngineConfig, { ...engine, budjet: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("(root): unknown key 'budjet'");
  });

  it("non-positive budget caps", () => {
    const bad = structuredClone(engine);
    bad.budget.run.max_turns = 0;
    const r = validate(EngineConfig, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("budget.run.max_turns");
  });
});
