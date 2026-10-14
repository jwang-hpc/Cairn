import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { git } from "@cairn/launcher";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provenance as P } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../ledger/ledger.js";
import { parseDraft, parseSource } from "./draft.js";
import { halfUnit, proseNumbers, sameNumber } from "./numbers.js";
import { ledgerReader } from "./reader.js";
import { checkSupport, renderReport } from "./support.js";

// The real M5 acceptance output (workstation, 2026-10-14).
const JOB = "20261014-1251-c30f";
const CSV = "n,primes,seconds\n100000,9592,0.00518620199727593\n200000,17984,0.01025094700162299\n400000,33860,0.017140839001513086\n";
const R = `evidence/raw/EXP-001/${JOB}/results.csv`;
const row2 = "100000,9592,0.00518620199727593";
const row4 = "400000,33860,0.017140839001513086";

const claim = (o: { proof?: string; sources?: string[]; statement?: string } = {}) =>
  [
    "## C??: Pure-Python sieve time grows about linearly with N",
    `- **Statement**: ${o.statement ?? "In pure Python, sieve-based prime counting time grows roughly in proportion to N over this range."}`,
    "- **Conditions**: N from 100000 to 400000, one core on the workstation, CPython.",
    "- **Sources**:",
    ...(o.sources ?? [
      `100000 ← ${R}:2 «${row2}» [input]`,
      `400000 ← ${R}:4 «${row4}» [input]`,
      `9592 ← ${R}:2 «${row2}» [result]`,
      `0.0052 ← ${R}:2 «${row2}» [result]`,
      `33,860 ← ${R}:4 «${row4}» [result]`,
      `0.0171 ← ${R}:4 «${row4}» [result]`,
    ]).map((s) => `  - ${s}`),
    "- **Status**: supported",
    "- **Provenance**: ai-suggested",
    "- **Falsification**: Time rising faster than linearly in N on repeated runs.",
    `- **Proof**: ${o.proof ?? `Job \`${JOB}\` on the workstation: 9592 primes below 100000 in 0.0052 s; 33,860 below 400000 in 0.0171 s.`}`,
    "- **Dependencies**: []",
    "- **Tags**: python, sieve",
    "",
  ].join("\n");

describe("numbers", () => {
  it("reads quantities from prose, not identifiers", () => {
    expect(proseNumbers(`EXP-001 job \`${JOB}\` on 2026-10-14: 9592 primes, 33,860 below 400000 in 0.0171 s (HY01, N05, see evidence/raw/x.csv); -3.5 and 1e-3`)).toEqual([
      "33,860",
      "9592",
      "400000",
      "0.0171",
      "-3.5",
      "1e-3",
    ]);
  });

  it("same number: exact, or the claim's rounding of the file's value; nothing else", () => {
    expect(sameNumber("9592", "9592")).toBe("exact");
    expect(sameNumber("33,860", "33860")).toBe("exact");
    expect(sameNumber("0.0052", "0.00518620199727593")).toBe("rounded");
    expect(sameNumber("0.0171", "0.017140839001513086")).toBe("rounded");
    expect(sameNumber("3x", "3.4")).toBe("rounded");
    expect(sameNumber("9593", "9592")).toBeUndefined();
    expect(sameNumber("0.0053", "0.00518620199727593")).toBeUndefined();
    expect(sameNumber("1e-3", "0.001")).toBe("exact");
    expect(halfUnit("0.0052")).toBeCloseTo(0.00005, 12);
  });
});

describe("parseDraft", () => {
  it("reads the ARA claim block and its sources", () => {
    const d = parseDraft(claim({ sources: [`9592 ← ${R}:2 «${row2}» [result]`, "512 ← [pending: the 512-node run]", `x ← N05:result «9592 primes» [result]`] }));
    expect(d.title).toBe("Pure-Python sieve time grows about linearly with N");
    expect(d.problems).toEqual([]);
    expect(d.sources).toEqual([
      { raw: `9592 ← ${R}:2 «${row2}» [result]`, value: "9592", ref: { kind: "file", path: R, line: 2 }, quote: row2, tag: "result" },
      { raw: "512 ← [pending: the 512-node run]", value: "512", pending: "the 512-node run" },
      { raw: "x ← N05:result «9592 primes» [result]", value: "x", ref: { kind: "node", node: "N05", field: "result" }, quote: "9592 primes", tag: "result" },
    ]);
  });

  it("reports what's missing or unreadable", () => {
    expect(parseSource("9592 evidence/x.csv:2")).toBeUndefined();
    expect(parseSource(`9592 ← ${R}:2 «${row2}»`)).toBeUndefined(); // no [input|result] tag
    const d = parseDraft("## C??: t\n- **Statement**: s\n- **Sources**:\n  - 1 ← x.csv:1 «1»\n- **Status**: proven\n");
    expect(d.problems).toEqual([
      "unreadable source entry: 1 ← x.csv:1 «1» (expected: <value> ← <file:line> «verbatim line» [input|result])",
      "missing Conditions",
      "missing Falsification",
      "missing Proof",
      "Status must be one of hypothesis, untested, testing, supported, weakened, refuted, withdrawn",
    ]);
    expect(parseDraft("no heading").problems).toContain('no claim heading ("## C??: <title>")');
  });
});

describe("checkSupport against the committed ledger (DR-0007 step 1)", () => {
  let base: string;
  let ledger: Ledger;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "cairn-claims-"));
    ledger = await Ledger.create({ projectsDir: base, name: "demo", title: "Demo", dataClass: "unpublished" });
    await ledger.writeArtifacts([{ path: R, content: CSV }], P.aiExecuted("claude-sonnet-5-5", "high"), "results");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const check = (md: string) => checkSupport(parseDraft(md), ledgerReader(ledger), new Date("2026-10-14T18:00:00Z"));

  it("a correct claim passes, with a coverage report of every number", async () => {
    const r = await check(claim());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.sources.map((s) => `${s.value}:${s.status}`)).toEqual(["100000:ok", "400000:ok", "9592:ok", "0.0052:rounded", "33,860:ok", "0.0171:rounded"]);
    expect(r.coverage.map((c) => `${c.field}:${c.number}:${c.status}`)).toEqual([
      "Conditions:100000:exact",
      "Conditions:400000:exact",
      "Proof:33,860:exact",
      "Proof:9592:exact",
      "Proof:100000:exact",
      "Proof:0.0052:exact",
      "Proof:400000:exact",
      "Proof:0.0171:exact",
    ]);
    const text = renderReport(r);
    expect(text).toContain("support check: PASSED");
    expect(text).toContain("rounded  0.0052  evidence/raw/EXP-001/20261014-1251-c30f/results.csv:2 has 0.00518620199727593; 0.0052 is its rounding");
    expect(text).toContain("not checked:\n  - whether the Statement follows from these numbers (rigor review, then you)");
  });

  it("a wrong number is flagged by code alone: in the source and in the claim", async () => {
    const r = await check(
      claim({
        sources: [`100000 ← ${R}:2 «${row2}» [input]`, `400000 ← ${R}:4 «${row4}» [input]`, `9593 ← ${R}:2 «${row2}» [result]`, `0.0052 ← ${R}:2 «${row2}» [result]`, `33,860 ← ${R}:4 «${row4}» [result]`, `0.0171 ← ${R}:4 «${row4}» [result]`],
        proof: `Job \`${JOB}\`: 9593 primes below 100000 in 0.0052 s; 33,860 below 400000 in 0.0171 s.`,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      `source 9593: 9593 is not in ${R}:2 (numbers there: 100000, 9592, 0.00518620199727593)`,
      "Proof: 9593 is not backed by a checked source (its source failed)",
    ]);
  });

  it("a number with no source at all, or a wrong rounding, is flagged", async () => {
    expect((await check(claim({ proof: `Job \`${JOB}\`: 9592 primes below 100000 in 0.0052 s, 2.1x faster than before.` }))).errors).toEqual([
      "Proof: 2.1 is not backed by a checked source",
    ]);
    expect((await check(claim({ proof: "9592 primes below 100000 in 0.0053 s." }))).errors).toEqual(["Proof: 0.0053 is not backed by a checked source"]);
  });

  it("the quote must be the line cited, verbatim", async () => {
    const r = await check(claim({ sources: [`9592 ← ${R}:3 «${row2}» [result]`], proof: "9592 primes." }));
    expect(r.errors[0]).toBe(`source 9592: ${R}:3 reads «200000,17984,0.01025094700162299», not the quoted «${row2}» (the quote is at line 2)`);
  });

  it("results only from evidence/ or executor records; sources must be committed; pending can't pass", async () => {
    await writeFile(join(ledger.dir, "analysis.csv"), CSV);
    const r = await check(
      claim({
        sources: [`9592 ← experiments/EXP-001/out.csv:2 «${row2}» [result]`, `9592 ← evidence/raw/EXP-001/new/results.csv:2 «${row2}» [result]`, "33,860 ← [pending: rerun]"],
        proof: "9592 primes; 33,860 below.",
      }),
    );
    expect(r.errors).toEqual([
      "source 9592: experiments/EXP-001/out.csv: results must come from evidence/ or executor records (engine/jobs/)",
      "source 9592: evidence/raw/EXP-001/new/results.csv is not in the ledger (not committed)",
      "source 33,860 is pending (rerun); a claim with pending sources can't pass",
      "Conditions: 100000 is not backed by a checked source",
      "Conditions: 400000 is not backed by a checked source",
      "Proof: 33,860 is not backed by a checked source (its source is pending)",
      "Proof: 9592 is not backed by a checked source (its source failed)",
    ]);
    // A file sitting uncommitted in the working copy is invisible to the check.
    await writeFile(join(ledger.dir, R), CSV.replace("9592", "9593"));
    expect((await check(claim())).ok).toBe(true);
  });

  it("CRLF evidence (Python's csv default) and a quote that kept the carriage return still check out", async () => {
    const crlf = `evidence/raw/EXP-002/${JOB}/results.csv`;
    await ledger.writeArtifacts([{ path: crlf, content: CSV.replace(/\n/g, "\r\n") }], P.aiExecuted("m1", "high"), "crlf results");
    const r = await check(claim({ sources: [`9592 ← ${crlf}:2 «${row2}\r» [result]`], proof: "9592 primes." }));
    expect(r.sources.map((s) => `${s.value}:${s.status}:${s.detail}`)).toEqual([`9592:ok:${crlf}:2`]);
    expect(r.errors.filter((e) => e.startsWith("source") || e.startsWith("Proof"))).toEqual([]);
  });

  it("warns about numbers in the Statement and sources no number uses", async () => {
    const r = await check(claim({ statement: "Time grows about 3.3x from 100000 to 400000." }));
    expect(r.warnings).toContain("the Statement carries numbers (3.3, 100000, 400000); ARA keeps run numbers in Conditions and Proof");
    expect(r.errors).toEqual(["Statement: 3.3 is not backed by a checked source"]);
  });
});

describe("re claim check (CLI)", () => {
  it("prints the report and exits 0 only when the claim passes", async () => {
    const { runCli } = await import("../cli.js");
    const { Engine } = await import("../engine.js");
    const { createModels, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const base = await mkdtemp(join(tmpdir(), "cairn-claim-cli-"));
    try {
      const ledger = await Ledger.create({ projectsDir: join(base, "projects"), name: "demo", title: "Demo", dataClass: "unpublished" });
      await ledger.writeArtifacts([{ path: R, content: CSV }], P.aiExecuted("m1", "high"), "results");
      const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
      const engine = new Engine(
        {
          dir: "(test)",
          models: { providers: {}, models: {}, effort_map: {}, routing: {}, projects_default_data_class: "unpublished" },
          roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
          machines: { machines: {} },
          engine: { machine: "t", projects_dir: join(base, "projects"), budget: { daily: { usd: { total: 1 }, tokens: {} }, run: { max_usd: 1, max_tokens: 1, max_turns: 1 } } },
        },
        { configDir: "(test)", home: join(base, "home") },
        { models: { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) }, stores },
      );
      const re = async (...argv: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: {} });
        return { code, out: out.join("\n"), err: err.join("\n") };
      };
      await writeFile(join(base, "ok.md"), claim());
      await writeFile(join(base, "bad.md"), claim().replace("9592 primes below", "9593 primes below"));
      const ok = await re("claim", "check", join(base, "ok.md"), "--project", "demo");
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(/^project demo\nsupport check: PASSED/);
      const bad = await re("claim", "check", join(base, "bad.md"), "--project", "demo", "--json");
      expect(bad.code).toBe(1);
      expect(JSON.parse(bad.out)).toMatchObject({ ok: false, errors: ["Proof: 9593 is not backed by a checked source"] });
      expect((await re("claim", "check")).code).toBe(2);
      // A draft an analysis agent committed on its branch is checked straight from git.
      const g = (...args: string[]) => git(ledger.dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      await g("checkout", "-q", "-b", "agent/analysis-1");
      await mkdir(join(ledger.dir, "staging/claims"), { recursive: true });
      await writeFile(join(ledger.dir, "staging/claims/sieve.md"), claim());
      await g("add", "staging/claims/sieve.md");
      await g("commit", "-q", "-m", "draft");
      await g("checkout", "-q", "main");
      expect((await re("claim", "check", "agent/analysis-1:staging/claims/sieve.md", "--project", "demo")).out).toMatch(/support check: PASSED/);
      expect(await re("claim", "check", "agent/nope:staging/claims/sieve.md", "--project", "demo")).toMatchObject({ code: 1, err: "re claim: no staging/claims/sieve.md on branch agent/nope of demo" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
