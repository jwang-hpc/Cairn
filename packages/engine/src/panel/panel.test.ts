import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@cairn/launcher";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { provenance as P, type DataClass, type EngineEvent } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { readUsage } from "../events/log.js";
import { Ledger } from "../ledger/ledger.js";
import { judgePanel, PanelError, readPanel, renderPanel, runPanel, validateSpec } from "./panel.js";

const config = (betaClasses: DataClass[] = ["public", "unpublished", "restricted"]): LoadedConfig => ({
  dir: "(test)",
  models: {
    providers: {
      acme: { routes: [{ pi_provider: "faux-a", auth: "api_key" }], data_classes: ["public", "unpublished"], terms_checked: "unchecked" },
      beta: { routes: [{ pi_provider: "faux-b", auth: "api_key" }], data_classes: betaClasses, terms_checked: "unchecked" },
    },
    models: {
      "acme-m": { provider: "acme", id: "a1", tool_use: "untested" },
      "acme-big": { provider: "acme", id: "a2", tool_use: "untested" },
      "beta-m": { provider: "beta", id: "b1", tool_use: "untested" },
    },
    effort_map: { acme: { low: "low", medium: "medium", high: "high", max: "max" }, beta: { low: "low", medium: "medium", high: "high", max: "max" } },
    routing: {},
    projects_default_data_class: "unpublished",
  },
  roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
  machines: { machines: {} },
  engine: { machine: "test", budget: { daily: { usd: { total: 10 }, tokens: {} }, run: { max_usd: 2, max_tokens: 1_000_000, max_turns: 20 } } },
});

let base: string;
let engine: Engine;
let ledger: Ledger;
const prompts: { model: string; text: string }[] = [];

/** Fake vendor whose answers name the model and quote which labels the prompt contained. */
function vendor(provider: string, ids: string[]) {
  const f = fauxProvider({ provider, models: ids.map((id) => ({ id, reasoning: true })) });
  const answer = (ctx: unknown, _o: unknown, _s: unknown, model: { id: string }) => {
    const text = JSON.stringify(ctx);
    prompts.push({ model: model.id, text });
    const me = /You are (Model [A-J])/.exec(text)?.[1] ?? "synthesizer";
    return fauxAssistantMessage([fauxText(`### Position\n${model.id} as ${me} says compression helps.`)]);
  };
  f.setResponses(Array.from({ length: 20 }, () => answer));
  return f;
}

async function setup(cfg = config(), dataClass: DataClass = "unpublished") {
  const a = vendor("faux-a", ["a1", "a2"]);
  const b = vendor("faux-b", ["b1"]);
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  models.api_key.setProvider(a.provider);
  models.api_key.setProvider(b.provider);
  engine = new Engine(cfg, { configDir: "(test)", home: join(base, "home") }, { models, stores });
  ledger = await Ledger.create({ projectsDir: base, name: "p", title: "Compression study", dataClass });
  await ledger.addHypothesis(
    { title: "SZ3 helps", statement: "s", prediction: "p", falsification: "f", baseline: "b", decisive_experiment: "e", kill_criteria: "k" },
    P.user,
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-panel-"));
  prompts.length = 0;
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const spec = {
  question: "Should we pursue HY01?",
  hypothesis: "HY01",
  rounds: ["independent", "critique", "synthesis"] as ("independent" | "critique" | "synthesis")[],
  members: [{ alias: "acme-m", effort: "high" as const }, { alias: "beta-m", effort: "high" as const }],
  synthesizer: { alias: "acme-big", effort: "high" as const },
};

describe("runPanel (independent → critique → synthesis)", () => {
  it("stores every round under engine/panels/<id>, each output tagged with its own model", async () => {
    await setup();
    const rec = await runPanel(engine, ledger, spec);
    expect(rec.rounds.map((r) => [r.mode, r.outputs.map((o) => o.status).join(",")])).toEqual([
      ["independent", "ok,ok"], ["critique", "ok,ok"], ["synthesis", "ok"],
    ]);
    expect(rec.warnings).toEqual(["synthesizer shares vendor 'acme' with a member; not vendor-neutral (M4 amendment, open questions 7/8)"]);
    // One commit per output, each with its member's provenance; start/done by the user.
    const trailers = (await git(ledger.dir, ["log", "--reverse", "--format=%s%x1f%(trailers:key=Cairn-Provenance,valueonly,separator=)"]))
      .split("\n").filter((l) => l.startsWith("ledger: panel"));
    expect(trailers.map((l) => l.split("\x1f")[1])).toEqual([
      "user",
      ...rec.members.map((m) => `ai-suggested(${m.model}, high)`),
      ...rec.members.map((m) => `ai-suggested(${m.model}, high)`),
      "ai-suggested(a2, high)",
      "user",
    ]);
    expect((await ledger.check()).ok).toBe(true);
    // Packet carries the hypothesis and the tree; every member got the identical packet.
    const packet = await ledger.read(`engine/panels/${rec.id}/packet.md`);
    expect(packet).toContain("Hypothesis under review: HY01");
    expect(packet).toContain("Exploration tree");
    // Usage: 2 independent + 2 critique + 1 synthesis, all on the panel's run id.
    expect((await readUsage(engine.paths.home)).records.filter((u) => u.run === rec.id && u.role === "panel")).toHaveLength(5);
  });

  it("critique shows each member the others' answers by label only, never its own as 'other'", async () => {
    await setup();
    const rec = await runPanel(engine, ledger, { ...spec, rounds: ["independent", "critique"] });
    const critiques = prompts.filter((p) => p.text.includes("Other members' answers"));
    expect(critiques).toHaveLength(2);
    for (const m of rec.members) {
      const mine = critiques.find((c) => c.text.includes(`You are ${m.label}`))!;
      const others = mine.text.split("Other members' answers")[1]!;
      expect(others).not.toContain(`### ${m.label}`);
      // Labels only: no model ids or vendors leak into another member's view.
      const other = rec.members.find((x) => x.label !== m.label)!;
      expect(others).toContain(`### ${other.label}`);
    }
    for (const p of prompts) expect(p.text).not.toMatch(/acme-m|beta-m|"beta"|"acme"/);
  });

  it("stays blind until the user records a judgment, then shows who was who; replay reads the stored files", async () => {
    await setup();
    const rec = await runPanel(engine, ledger, { ...spec, rounds: ["independent"] });
    const { record, texts } = await readPanel(ledger, rec.id);
    const blind = renderPanel(record, texts);
    expect(blind).toContain("(blind until `re panel judge`)");
    expect(blind).not.toMatch(/acme-m|beta-m/);
    expect(blind).toContain("### Model A");
    const judged = await judgePanel(ledger, rec.id, { prefer: ["A"], note: "clearer risks" });
    const shown = renderPanel(judged, texts);
    expect(shown).toMatch(/Model A = (acme-m \(a1, acme, high\)|beta-m \(b1, beta, high\))/);
    expect(shown).toContain("prefer Model A · clearer risks");
    await expect(judgePanel(ledger, rec.id, { prefer: [] })).rejects.toThrow(/already judged/);
    await expect(judgePanel(ledger, rec.id, { prefer: ["Z"] })).rejects.toThrow(PanelError);
  });
});

describe("data governance (invariant 9)", () => {
  it("a restricted project is refused by a provider not allowed restricted data; the refusal is logged", async () => {
    await setup(config(), "restricted");
    const rec = await runPanel(engine, ledger, { ...spec, rounds: ["independent"], synthesizer: undefined } as never);
    const byVendor = Object.fromEntries(rec.rounds[0]!.outputs.map((o) => [rec.members.find((m) => m.label === o.label)!.provider, o]));
    expect(byVendor.acme).toMatchObject({ status: "refused" });
    expect(byVendor.acme!.error).toMatch(/^refused: provider 'acme' may not receive 'restricted' data/);
    expect(byVendor.beta).toMatchObject({ status: "ok" });
    expect(prompts.map((p) => p.model)).toEqual(["b1"]); // acme was never called
    const events = (await readFile(join(engine.paths.home, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as EngineEvent);
    expect(events.filter((e) => e.type === "approval" && e.decision === "denied" && e.by === "policy")).toHaveLength(1);
  });

  it("stops later rounds when every member is refused", async () => {
    await setup(config(["public"]), "restricted");
    const rec = await runPanel(engine, ledger, { ...spec, rounds: ["independent", "critique"] , synthesizer: undefined } as never);
    expect(rec.rounds).toHaveLength(1);
    expect(rec.warnings).toContain("round 1 (independent) produced no answers; later rounds not run");
    expect(prompts).toEqual([]);
  });
});

describe("validateSpec", () => {
  it.each([
    [{ members: [spec.members[0]!] }, /at least two members/],
    [{ rounds: ["critique"] }, /cannot open with critique/],
    [{ rounds: ["relay", "critique"] }, /critique needs an earlier independent round/],
    [{ rounds: ["independent", "redteam"] }, /redteam needs a venue/],
    [{ rounds: ["debate"], exchanges: 9 }, /exchanges must be 1-4/],
    [{ rounds: ["independent", "vote"] }, /unknown round .vote./],
    [{ rounds: ["independent", "synthesis", "critique"] }, /synthesis must be the last round/],
    [{ synthesizer: undefined }, /needs a synthesizer/],
    [{ synthesizer: { alias: "acme-m", effort: "low" } }, /also a panel member/],
    [{ members: [{ alias: "nope", effort: "high" }, spec.members[1]!] }, /unknown model alias 'nope'/],
    [{ question: " " }, /needs a question/],
  ])("rejects %j", async (patch, msg) => {
    await setup();
    expect(() => validateSpec(engine, { ...spec, ...patch } as never)).toThrow(msg);
  });

  it("warns on a single-vendor panel", async () => {
    await setup();
    expect(validateSpec(engine, { ...spec, members: [{ alias: "acme-m", effort: "high" }, { alias: "acme-m", effort: "low" }], synthesizer: { alias: "beta-m", effort: "high" } })).toEqual([
      "single-vendor panel (acme); DR-0013 default is members from different vendors",
    ]);
  });
});

describe("relay, debate, redteam (DR-0008)", () => {
  const two = { members: spec.members, synthesizer: spec.synthesizer };

  it("relay: A drafts, B revises, A finalizes — sequential, each step committed under its author", async () => {
    await setup();
    const rec = await runPanel(engine, ledger, { ...two, question: "Draft the experiment plan", rounds: ["relay"] });
    const steps = rec.rounds[0]!.outputs.map((o) => `${o.step}:${o.label}`);
    expect(steps).toEqual(["draft:Model A", "revision:Model B", "final:Model A"]);
    expect(rec.rounds[0]!.outputs.map((o) => o.file!.split("/").at(-1))).toEqual(["draft-A.md", "revision-B.md", "final-A.md"]);
    const revise = prompts.find((p) => p.text.includes("Revise Model A"))!;
    expect(revise.text).toContain("Draft by Model A");
    const final = prompts.find((p) => p.text.includes("Finalize"))!;
    expect(final.text).toContain("Revision by Model B");
    expect((await ledger.check()).ok).toBe(true);
  });

  it("debate: the proposer opens from its independent answer, N exchanges, both close with unresolved disagreements", async () => {
    await setup();
    const rec = await runPanel(engine, ledger, { ...two, question: "Is 1e-3 the right bound?", rounds: ["independent", "debate", "synthesis"], exchanges: 2 });
    expect(rec.rounds[1]!.outputs.map((o) => `${o.step}:${o.label}`)).toEqual([
      "x1-critic:Model B", "x1-proposer:Model A", "x2-critic:Model B", "x2-proposer:Model A", "closing:Model A", "closing:Model B",
    ]);
    // No separate opening call: the independent answer is the opening.
    expect(prompts.filter((p) => p.text.includes("the proposer in a debate. State the strongest"))).toHaveLength(0);
    const synth = prompts.find((p) => p.text.includes("You synthesize a research review panel"))!;
    expect(synth.text).toContain("Model B (x2-critic)");
    expect(synth.text).toContain("Model A (closing)");
  });

  it("redteam: a hostile review for the named venue that sees the panel's earlier work", async () => {
    await setup();
    const rec = await runPanel(engine, ledger, { ...two, question: "Is this ready for submission?", rounds: ["independent", "redteam"], venue: "SC" });
    expect(rec.rounds[1]!.outputs).toEqual([expect.objectContaining({ step: "review", label: "Model A", status: "ok" })]);
    const review = prompts.find((p) => p.text.includes("hostile but fair reviewer for SC"))!;
    expect(review.text).toContain("Panel work so far");
    expect(review.text).toContain("Model B, round 1 independent");
  });

  it("warns that relay/debate use only the first two members", async () => {
    await setup();
    const three = [...spec.members, { alias: "acme-big", effort: "low" as const }];
    expect(validateSpec(engine, { question: "q", rounds: ["relay"], members: three })).toContain(
      "relay and debate use the first two members (Model A and Model B); others sit those rounds out",
    );
  });
});

describe("re panel (CLI)", () => {
  it("run → list → show (blind) → judge (unblinded) → replay", async () => {
    const { runCli } = await import("../cli.js");
    await setup();
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(engine.paths.home, { recursive: true });
    await writeFile(join(engine.paths.home, "state.json"), JSON.stringify({ project: "p" }));
    (engine.config.engine as { projects_dir?: string }).projects_dir = base;
    const re = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: {} });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const run = await re("panel", "run", "--question", "Pursue HY01?", "--hypothesis", "HY01", "--rounds", "independent,critique,synthesis", "--members", "acme-m@high,beta-m@high", "--synth", "acme-big@high");
    expect(run.code).toBe(0);
    const id = /^panel (\S+)/.exec(run.out)![1]!;
    expect(run.out).toContain("round 2 critique: Model A ok; Model B ok");
    expect(run.out).toMatch(/5 model calls/);
    expect((await re("panel", "list")).out).toMatch(new RegExp(`^${id}  independent→critique→synthesis\\s+HY01  blind  Pursue HY01\\?`));
    expect((await re("panel", "show", id)).out).toContain("(blind until `re panel judge`)");
    const judged = await re("panel", "judge", id, "--prefer", "B", "--note", "better risks");
    expect(judged.out).toMatch(/Model A = (acme-m|beta-m)/);
    expect((await re("panel", "replay", id)).out).toContain("prefer Model B · better risks");
    expect(await re("panel", "run", "--members", "acme-m@high")).toMatchObject({ code: 2, err: expect.stringContaining("--question is required") });
    // An unknown hypothesis is a user error, reported before anything is written or any model is called.
    const panels = (await re("panel", "list")).out;
    expect(await re("panel", "run", "--question", "Q", "--hypothesis", "HY99", "--rounds", "independent", "--members", "acme-m@high,beta-m@high")).toMatchObject({ code: 1, err: expect.stringContaining("unknown hypothesis HY99") });
    expect((await re("panel", "list")).out).toBe(panels);
  });
});
