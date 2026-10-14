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
/** The executor's record of what it fetched: only declared outputs can back a [result]. */
const MANIFEST = JSON.stringify({ files: [{ path: "results.csv" }], logs: [{ path: "stdout.log" }] });

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
    expect(proseNumbers(`EXP-001 job \`${JOB}\` on 2026-10-14: 9592 primes, 33,860 below 400000 in 0.0171 s (HY01, N05, see \`evidence/raw/x.csv\`); -3.5 and 1e-3`)).toEqual([
      "9592",
      "33,860",
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
    const d = parseDraft(claim({ sources: [`9592 ← ${R}:2 «${row2}» [result]`, "512 ← [pending: the 512-node run]", `64 ← N05:result «64 nodes» [input]`] }));
    expect(d.title).toBe("Pure-Python sieve time grows about linearly with N");
    expect(d.problems).toEqual([]);
    expect(d.sources).toEqual([
      { raw: `9592 ← ${R}:2 «${row2}» [result]`, value: "9592", ref: { kind: "file", path: R, line: 2 }, quote: row2, tag: "result" },
      { raw: "512 ← [pending: the 512-node run]", value: "512", pending: "the 512-node run" },
      { raw: "64 ← N05:result «64 nodes» [input]", value: "64", ref: { kind: "node", node: "N05", field: "result" }, quote: "64 nodes", tag: "input" },
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
    await ledger.writeArtifacts([{ path: R, content: CSV }, { path: R.replace("results.csv", "MANIFEST.json"), content: MANIFEST }], P.aiExecuted("claude-sonnet-5-5", "high"), "results");
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
    expect(r.coverage.map((c) => `${c.field}:${c.number}:${c.status}:${c.tag}`)).toEqual([
      "Conditions:100000:exact:input",
      "Conditions:400000:exact:input",
      "Proof:9592:exact:result",
      "Proof:100000:exact:input",
      "Proof:0.0052:rounded:result",
      "Proof:33,860:exact:result",
      "Proof:400000:exact:input",
      "Proof:0.0171:rounded:result",
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
        sources: [`9592 ← experiments/EXP-001/out.csv:2 «${row2}» [result]`, `9592 ← evidence/raw/EXP-001/20261014-0000-beef/results.csv:2 «${row2}» [result]`, "33,860 ← [pending: rerun]"],
        proof: "9592 primes; 33,860 below.",
      }),
    );
    expect(r.errors).toEqual([
      "source 9592: experiments/EXP-001/out.csv: results come only from a job's outputs (evidence/raw/<EXP>/<job>/) or parser tables (evidence/tables/)",
      "source 9592: evidence/raw/EXP-001/20261014-0000-beef/results.csv: no executor MANIFEST.json for job 20261014-0000-beef",
      "source 33,860 is pending (rerun); a claim with pending sources can't pass",
      "Conditions: 100000 is not backed by a checked source",
      "Conditions: 400000 is not backed by a checked source",
      "Proof: 9592 is not backed by a checked source (its source failed)",
      "Proof: 33,860 is not backed by a checked source (its source is pending)",
    ]);
    // A file sitting uncommitted in the working copy is invisible to the check.
    await writeFile(join(ledger.dir, R), CSV.replace("9592", "9593"));
    expect((await check(claim())).ok).toBe(true);
  });

  it("CRLF evidence (Python's csv default) and a quote that kept the carriage return still check out", async () => {
    const crlf = `evidence/raw/EXP-002/${JOB}/results.csv`;
    await ledger.writeArtifacts([{ path: crlf, content: CSV.replace(/\n/g, "\r\n") }, { path: crlf.replace("results.csv", "MANIFEST.json"), content: MANIFEST }], P.aiExecuted("m1", "high"), "crlf results");
    const r = await check(claim({ sources: [`9592 ← ${crlf}:2 «${row2}\r» [result]`], proof: "9592 primes." }));
    expect(r.sources.map((s) => `${s.value}:${s.status}:${s.detail}`)).toEqual([`9592:ok:${crlf}:2`]);
    expect(r.errors.filter((e) => e.startsWith("source") || e.startsWith("Proof"))).toEqual([]);
  });

  describe("review findings (M6.5): ways a wrong or unbacked number could have passed", () => {
    const J = `evidence/raw/EXP-001/${JOB}`;
    const proof = (p: string, sources: string[]) => check(claim({ proof: p, sources: [`100000 ← ${R}:2 «${row2}» [input]`, `400000 ← ${R}:4 «${row4}» [input]`, ...sources] }));
    const errs = async (p: string, sources: string[] = []) => (await proof(p, sources)).errors;

    it("#1 agent-written text is not a result: job/ files, MANIFEST.json, job records, undeclared files", async () => {
      await ledger.writeArtifacts(
        [
          { path: `${J}/job/fake.csv`, content: "n,primes\n100000,9593\n" },
          { path: `${J}/extra.csv`, content: "n,primes\n100000,9593\n" },
          { path: `engine/jobs/${JOB}.json`, content: '{\n  "description": "expect 9593 primes"\n}\n' },
          { path: `${J}/logs/stdout.log`, content: "9592 primes found\n" },
        ],
        P.aiExecuted("m1", "high"),
        "planted",
      );
      const e = await errs("9593 primes.", [`9593 ← ${J}/job/fake.csv:2 «100000,9593» [result]`, `9593 ← ${J}/extra.csv:2 «100000,9593» [result]`, `9593 ← engine/jobs/${JOB}.json:2 «  "description": "expect 9593 primes"» [result]`, `9593 ← ${J}/MANIFEST.json:1 «${MANIFEST}» [result]`]);
      expect(e.filter((x) => x.startsWith("source"))).toEqual([
        `source 9593: ${J}/job/fake.csv: job/ holds the files the agent wrote, not what the job produced; cite them as [input]`,
        `source 9593: ${J}/extra.csv: extra.csv is not an output the executor fetched for job ${JOB}`,
        `source 9593: engine/jobs/${JOB}.json: results come only from a job's outputs (evidence/raw/<EXP>/<job>/) or parser tables (evidence/tables/)`,
        `source 9593: ${J}/MANIFEST.json: MANIFEST.json is bookkeeping, not a result`,
      ]);
      // A declared log tail is an output; the coverage report shows each number's tag.
      const ok = await proof("9592 primes.", [`9592 ← ${J}/logs/stdout.log:1 «9592 primes found» [result]`]);
      expect(ok.errors).toEqual([]);
      expect(ok.coverage.find((c) => c.number === "9592")).toMatchObject({ tag: "result" });
      expect((await proof("9592 primes.", [`9592 ← ${R}:2 «${row2}» [input]`])).warnings).toContain("Proof: 9592 is backed only by an [input] source; if it is a measured value, cite the job's output");
    });

    it("#2 numbers can't hide in markup, separators, dates, dots, or invisible text", async () => {
      for (const p of ["_9593_ primes.", "9593/100000 primes.", "12.5GB/s and 9593 primes.", "[9593](evidence/x) primes.", "on 2026-10-14 9593 primes.", "...9593 primes.", "found `9593` primes."]) {
        expect(await errs(p), p).toContain("Proof: 9593 is not backed by a checked source");
      }
      for (const [p, what] of [["９５９２ primes.", "digits other than 0-9"], ["95\u200b92 primes.", "invisible formatting characters"], ["95<!-- -->92 primes.", "an HTML comment"]]) {
        expect((await errs(p!)).join("\n"), p).toContain(`Proof contains ${what}, which could hide a number`);
      }
      // Identifier-shaped code spans and ids are not quantities.
      expect(await errs(`Job \`${JOB}\` (\`evidence/raw/x.csv\`, Slurm \`24.11.5\`): 9592 primes below 100000.`, [`9592 ← ${R}:2 «${row2}» [result]`])).toEqual([]);
    });

    it("#3 the title is covered, and a source value is one number with a unit", async () => {
      const r = await check(claim().replace("## C??: Pure-Python sieve time grows about linearly with N", "## C??: Python sieve is 50x faster than C"));
      expect(r.errors).toContain("Title: 50 is not backed by a checked source");
      expect((await errs("9592 primes.", [`9592 (50x faster than C) ← ${R}:2 «${row2}» [result]`])).join("\n")).toContain("source value «9592 (50x faster than C)» must be one number with an optional unit");
    });

    it("#5 no double rounding: prose is compared with the file's number", async () => {
      await ledger.writeArtifacts([{ path: `${J}/stdout.csv`, content: "x\n3.46\n" }, { path: `${J}/MANIFEST.json`, content: JSON.stringify({ files: [{ path: "results.csv" }, { path: "stdout.csv" }], logs: [] }) }], P.aiExecuted("m1", "high"), "x");
      expect(await errs("speedup 3.5.", [`3.5 ← ${J}/stdout.csv:2 «3.46» [result]`])).toEqual([]);
      expect(await errs("speedup 4.", [`3.5 ← ${J}/stdout.csv:2 «3.46» [result]`])).toContain("Proof: 4 is not backed by a checked source");
    });

    it("#6 a CSV line's fields are separate numbers (8,512 is 8 and 512)", async () => {
      await ledger.writeArtifacts([{ path: `${J}/t.csv`, content: "a,b\n8,512\n" }, { path: `${J}/MANIFEST.json`, content: JSON.stringify({ files: [{ path: "results.csv" }, { path: "t.csv" }], logs: [] }) }], P.aiExecuted("m1", "high"), "x");
      expect((await errs("8512 ms.", [`8512 ← ${J}/t.csv:2 «8,512» [result]`]))[0]).toBe(`source 8512: 8512 is not in ${J}/t.csv:2 (numbers there: 8, 512)`);
    });

    it("#7 trace nodes: whole numbers inside the quote only, and never a result", async () => {
      await ledger.addNode({ type: "decision", title: "Scale", choice: "Use 1024 ranks", alternatives: ["512"], evidence: [] }, P.user);
      expect((await errs("102 ranks.", ["102 ← N01:choice «Use 102» [input]"]))[0]).toBe("source 102: 102 is not in N01.choice (numbers there: none)");
      expect(await errs("1024 ranks.", ["1024 ← N01:choice «Use 1024 ranks» [input]"])).toEqual([]);
      expect((await errs("1024 ranks.", ["1024 ← N01:choice «Use 1024 ranks» [result]"]))[0]).toMatch(/results come from evidence\/, not from trace nodes/);
    });

    it("#10 a directory is not a file", async () => {
      expect(await ledgerReader(ledger).read("evidence/raw")).toBeUndefined();
    });
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
      await ledger.writeArtifacts([{ path: R, content: CSV }, { path: R.replace("results.csv", "MANIFEST.json"), content: MANIFEST }], P.aiExecuted("m1", "high"), "results");
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
