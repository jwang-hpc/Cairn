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
    [{ rounds: ["critique"] }, /first round must be independent/],
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
