import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@cairn/launcher";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type DataClass, provenance as P } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { Ledger } from "../ledger/ledger.js";
import { reviewDraft } from "./gate.js";
import { parseReview, rigorCriteria } from "./review.js";

const JOB = "20261014-1251-c30f";
const CSV = "n,primes,seconds\n100000,9592,0.00518620199727593\n200000,17984,0.01025094700162299\n400000,33860,0.017140839001513086\n";
const R = `evidence/raw/EXP-001/${JOB}/results.csv`;
const row2 = "100000,9592,0.00518620199727593";
const row4 = "400000,33860,0.017140839001513086";
const draft = (proof = `Job \`${JOB}\`: 9592 primes below 100000 in 0.0052 s; 33,860 below 400000 in 0.0171 s.`) =>
  [
    "## C??: Pure-Python sieve time grows about linearly with N",
    "- **Statement**: In pure Python, sieve-based prime counting time grows roughly in proportion to N over this range.",
    "- **Conditions**: N from 100000 to 400000, one core on the workstation.",
    "- **Sources**:",
    `  - 100000 ← ${R}:2 «${row2}» [input]`,
    `  - 400000 ← ${R}:4 «${row4}» [input]`,
    `  - 9592 ← ${R}:2 «${row2}» [result]`,
    `  - 0.0052 ← ${R}:2 «${row2}» [result]`,
    `  - 33,860 ← ${R}:4 «${row4}» [result]`,
    `  - 0.0171 ← ${R}:4 «${row4}» [result]`,
    "- **Status**: supported",
    "- **Provenance**: ai-suggested",
    "- **Falsification**: Time rising faster than linearly in N on repeated runs.",
    `- **Proof**: ${proof}`,
    "- **Dependencies**: []",
    "- **Tags**: python, sieve",
    "",
  ].join("\n");

const REVIEW_JSON = JSON.stringify({
  dimensions: {
    evidence_relevance: { score: 4, strengths: ["numbers come from the run"], weaknesses: ["three points only"], suggestions: [] },
    falsifiability: { score: 3, strengths: [], weaknesses: ["no threshold"], suggestions: ["state a slope bound"] },
    scope_calibration: { score: 3, strengths: [], weaknesses: ["one machine"], suggestions: [] },
    methodological_rigor: { score: 2, strengths: [], weaknesses: ["single run, no repeats"], suggestions: ["repeat 5x"] },
  },
  findings: [{ severity: "major", issue: "single run", suggestion: "repeat the job" }],
  verdict: "revise",
  summary: "Supported numerically, thin method.",
});

let base: string;
let engine: Engine;
let ledger: Ledger;
let prompts: string[];

async function setup(dataClass: DataClass = "unpublished") {
  const cfg: LoadedConfig = {
    dir: "(test)",
    models: {
      providers: { rev: { routes: [{ pi_provider: "faux-r", auth: "api_key" }], data_classes: ["public", "unpublished"], terms_checked: "unchecked" } },
      models: { "rev-m": { provider: "rev", id: "r1", tool_use: "untested" } },
      effort_map: { rev: { low: "low", medium: "medium", high: "high", max: "max" } },
      routing: { analysis: { reviewer: "rev-m@high" } },
      projects_default_data_class: "unpublished",
    },
    roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
    machines: { machines: {} },
    engine: { machine: "test", projects_dir: base, budget: { daily: { usd: { total: 10 }, tokens: {} }, run: { max_usd: 2, max_tokens: 1_000_000, max_turns: 20 } } },
  };
  const f = fauxProvider({ provider: "faux-r", models: [{ id: "r1", reasoning: true }] });
  f.setResponses(
    Array.from({ length: 10 }, () => (ctx: unknown) => {
      prompts.push(JSON.stringify(ctx));
      return fauxAssistantMessage([fauxText(`Here is my review:\n${REVIEW_JSON}`)]);
    }),
  );
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  models.api_key.setProvider(f.provider);
  engine = new Engine(cfg, { configDir: "(test)", home: join(base, "home") }, { models, stores });
  ledger = await Ledger.create({ projectsDir: base, name: "demo", title: "Sieve study", dataClass });
  await ledger.writeArtifacts(
    [{ path: R, content: CSV }, { path: R.replace("results.csv", "MANIFEST.json"), content: JSON.stringify({ files: [{ path: "results.csv" }], logs: [] }) }],
    P.aiExecuted("claude-sonnet-5-5", "high"),
    "results",
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-gate-"));
  prompts = [];
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const log = async () => (await git(ledger.dir, ["log", "-1", "--format=%s|%(trailers:key=Cairn-Provenance,valueonly,separator=)"])).trim();

describe("the claim gate (DR-0007): check → review → approve", () => {
  it("a supported, reviewed draft enters logic/claims.md only through the user's approval", async () => {
    await setup();
    const md = draft();
    const { report, review } = await reviewDraft(engine, ledger, md, { now: () => new Date("2026-10-14T18:00:00Z") });
    expect(report.ok).toBe(true);
    expect(review).toMatchObject({ verdict: "revise", reviewer: { alias: "rev-m", model: "r1", effort: "high" }, summary: "Supported numerically, thin method." });
    expect(review?.dimensions.methodological_rigor?.score).toBe(2);
    expect(await log()).toMatch(/^ledger: rigor review of claim draft [0-9a-f]{16}: revise \(Pure-Python sieve.*\)\|ai-suggested\(r1, high\)$/);
    // The reviewer saw the ARA criteria verbatim, the support report, and the cited file itself.
    expect(prompts[0]).toContain("#### D1. Evidence Relevance");
    expect(prompts[0]).toContain("support check: PASSED");
    expect(prompts[0]).toContain("400000,33860,0.017140839001513086");

    const a = await ledger.approveClaim(md, { note: "good enough for the notebook" });
    expect(a).toMatchObject({ id: "C01", provenance: "user-revised" });
    const claims = await readFile(join(ledger.dir, "logic/claims.md"), "utf8");
    expect(claims).toContain("## C01: Pure-Python sieve time grows about linearly with N");
    expect(claims).toContain(`  - 9592 ← ${R}:2 «${row2}» [result]`);
    expect(claims).toContain("- **Provenance**: user-revised");
    expect(claims).toMatch(/- \*\*Last revised\*\*: \d{4}-\d{2}-\d{2} \(approved through the claim gate: engine\/claims\/C01\/\)/);
    expect(await log()).toBe("ledger: claim C01: Pure-Python sieve time grows about linearly with N|user-revised");
    const gate = JSON.parse(await readFile(join(ledger.dir, "engine/claims/C01/gate.json"), "utf8")) as { support: { ok: boolean }; review: { verdict: string }; approved: { by: string; note: string } };
    expect(gate).toMatchObject({ support: { ok: true }, review: { verdict: "revise" }, approved: { by: "user-revised", note: "good enough for the notebook" } });
    expect((await ledger.claims()).map((c) => c.id)).toEqual(["C01"]);
    expect(await ledger.check()).toMatchObject({ ok: true });
  });

  it("refuses: no review, a draft changed after its review, a failing support check, claims.md edited by hand", async () => {
    await setup();
    const md = draft();
    await expect(ledger.approveClaim(md)).rejects.toThrow(/no rigor review of this exact draft/);
    await reviewDraft(engine, ledger, md);
    await expect(ledger.approveClaim(md.replace("Tags**: python", "Tags**: py"))).rejects.toThrow(/no rigor review of this exact draft/);

    const wrong = draft(`Job \`${JOB}\`: 9593 primes below 100000.`);
    const r = await reviewDraft(engine, ledger, wrong);
    expect(r.review).toBeUndefined(); // no review for a draft that fails the code check
    expect(prompts).toHaveLength(1);
    await expect(ledger.approveClaim(wrong)).rejects.toThrow(/the support check fails \(Proof: 9593 is not backed by a checked source\)/);

    await writeFile(join(ledger.dir, "logic/claims.md"), "# Claims\n## C01: sneaked in\n");
    await expect(ledger.approveClaim(md)).rejects.toThrow(/has changes made outside the gate/);
    await expect(ledger.writeArtifacts([{ path: "logic/claims.md", content: "x" }], P.user, "x")).rejects.toThrow(/artifacts may only be written under/);
  });

  it("#4 provenance comes from how the draft arrived, never from its text", async () => {
    await setup();
    const md = draft().replace("- **Provenance**: ai-suggested", "- **Provenance**: user");
    await reviewDraft(engine, ledger, md);
    const a = await ledger.approveClaim(md);
    expect(a.provenance).toBe("user-revised");
    expect(await readFile(join(ledger.dir, "logic/claims.md"), "utf8")).toContain("- **Provenance**: user-revised");
    const own = draft("Job `20261014-1251-c30f`: 9592 primes below 100000.");
    await reviewDraft(engine, ledger, own);
    expect((await ledger.approveClaim(own, { own: true })).provenance).toBe("user");
  });

  it("#9 a failed commit leaves no half-written claim; commits hold only their own paths", async () => {
    await setup();
    const md = draft();
    await reviewDraft(engine, ledger, md);
    await writeFile(join(ledger.dir, ".git", "index.lock"), ""); // another git process holds the index
    await expect(ledger.approveClaim(md)).rejects.toThrow();
    await rm(join(ledger.dir, ".git", "index.lock"));
    expect(await readFile(join(ledger.dir, "logic/claims.md"), "utf8")).not.toContain("C01");
    expect((await git(ledger.dir, ["status", "--porcelain"])).trim()).toBe("");
    // Something else staged in the index stays out of the gate's commit.
    await writeFile(join(ledger.dir, "notes.txt"), "unrelated\n");
    await git(ledger.dir, ["add", "notes.txt"]);
    await ledger.approveClaim(md);
    expect((await git(ledger.dir, ["show", "--name-only", "--format=", "HEAD"])).trim().split("\n").sort()).toEqual(["engine/claims/C01/draft.md", "engine/claims/C01/gate.json", "engine/ledger.jsonl", "logic/claims.md"]);
    expect((await git(ledger.dir, ["status", "--porcelain"])).trim()).toBe("A  notes.txt");
  });

  it("the reviewer is a model call under the project's data class: a restricted project refuses a provider not allowed", async () => {
    await setup("restricted");
    await expect(reviewDraft(engine, ledger, draft())).rejects.toThrow(/may not receive 'restricted' data/);
    expect(prompts).toEqual([]);
  });
});

describe("review parsing and the vendored criteria", () => {
  it("takes the JSON object out of the reviewer's text; keeps anything else raw as unparsed", () => {
    expect(parseReview(`ok\n${REVIEW_JSON}\nthanks`).verdict).toBe("revise");
    expect(parseReview("I think it's fine.")).toMatchObject({ verdict: "unparsed", raw: "I think it's fine." });
  });

  it("uses D1, D2, D3 and D6 of the ARA rigor-reviewer verbatim (not D4, D5: those are artifact-level)", async () => {
    const c = await rigorCriteria();
    expect(c.source).toMatch(/^ara@[0-9a-f]+\/rigor-reviewer\/SKILL.md$/);
    for (const d of ["#### D1. Evidence Relevance", "#### D2. Falsifiability Quality", "#### D3. Scope Calibration", "#### D6. Methodological Rigor"]) expect(c.text).toContain(d);
    expect(c.text).not.toContain("#### D4.");
    expect(c.text).not.toContain("#### D5.");
  });
});
