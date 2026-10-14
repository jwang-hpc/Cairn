import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunner, git, type Sandbox, type SandboxOptions } from "@cairn/launcher";
import { provenance as P } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDraft } from "../claims/draft.js";
import { ledgerReader } from "../claims/reader.js";
import { checkSupport } from "../claims/support.js";
import { Ledger } from "../ledger/ledger.js";
import { HostParserRunner, loadRegistry, PARSERS_DIR, parseEvidence, parsersFor, SandboxParserRunner } from "./parse.js";

const JOB = "20261014-1251-c30f";
const CSV = "n,primes,seconds\n100000,9592,0.00518620199727593\n200000,17984,0.01025094700162299\n400000,33860,0.017140839001513086\n";
const MANIFEST = JSON.stringify({ job: JOB, author: { kind: "agent", run: "r", agent: "coder-1", role: "coder", model: "claude-sonnet-5-5", effort: "high" } });
const host = new HostParserRunner({ python: "/usr/bin/python3" });

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-parse-test-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("parsers", () => {
  it("csv_summary: per-column statistics and ratios to the first row, computed by code", async () => {
    const r = await host.run("csv_summary", { name: "results.csv", content: Buffer.from(CSV) });
    expect(r.manifest).toMatchObject({ parser: "csv_summary", version: 1, notes: [] });
    const files = Object.fromEntries(r.outputs.map((o) => [o.path, o.content.toString()]));
    expect(files["results.summary.csv"]).toBe(
      [
        "column,count,min,max,mean,first,last,last_over_first",
        "n,3,100000,400000,233333.33333333334,100000,400000,4",
        "primes,3,9592,33860,20478.666666666668,9592,33860,3.530025020850709",
        "seconds,3,0.00518620199727593,0.017140839001513086,0.010859329333470669,0.00518620199727593,0.017140839001513086,3.3050851105522634",
        "",
      ].join("\n"),
    );
    expect(files["results.ratios.csv"]).toBe("n,primes,seconds\n1,1,1\n2,1.8748957464553795,1.976580743867542\n4,3.530025020850709,3.3050851105522634\n");
  });

  it("registry: CSVs are parsed, the parser's own outputs are not", async () => {
    const reg = await loadRegistry();
    expect(parsersFor(reg, "results.csv")).toEqual(["csv_summary"]);
    expect(parsersFor(reg, "results.summary.csv")).toEqual([]);
    expect(parsersFor(reg, "stdout.log")).toEqual([]);
  });

  it("refuses a parser whose manifest doesn't match what it wrote", async () => {
    const dir = join(base, "parsers");
    await mkdir(dir);
    await writeFile(join(dir, "liar.py"), "import json,sys,os\nopen(os.path.join(sys.argv[2],'extra.csv'),'w').write('x')\nprint(json.dumps({'parser':'liar','version':1,'outputs':[],'notes':[]}))\n");
    await expect(new HostParserRunner({ python: "/usr/bin/python3", dir }).run("liar", { name: "a.csv", content: Buffer.from("x") })).rejects.toThrow(/manifest doesn't match/);
  });

  it("SandboxParserRunner: only the input and the parser are mounted; python runs isolated in the sandbox", async () => {
    let request: SandboxOptions["request"] | undefined;
    let command: readonly string[] | undefined;
    // Stand-in for the container: /work mapped to the staging dir, python on the host.
    const launch = async (o: SandboxOptions): Promise<Sandbox> => {
      request = o.request;
      const map = (s: string) => s.replace(/^\/work/, o.request.worktree);
      return {
        agentId: o.request.agentId, name: `cairn-${o.request.agentId}`, network: { name: "n", gateway: "192.168.240.1", subnet: "192.168.240.0/24" }, skipped: [],
        spec: {} as Sandbox["spec"],
        exec: (cmd) => {
          command = cmd;
          return cliRunner("/usr/bin/python3").run(cmd.slice(1).map(map));
        },
        close: async () => {},
      };
    };
    const r = await new SandboxParserRunner({ image: "cairn-agent:dev", launch }).run("csv_summary", { name: "results.csv", content: Buffer.from(CSV) });
    expect(r.outputs.map((o) => o.path)).toEqual(["results.ratios.csv", "results.summary.csv"]);
    expect(request?.roles.roles.parser).toEqual({ mounts: { read: ["in/", "code/"], write: ["out/"] }, network: [], executor_tools: [] });
    expect(command).toEqual(["python3", "-I", "/work/code/csv_summary.py", "/work/in/results.csv", "/work/out"]);
  });

  it("parser code and registry live in packages/engine/parsers", () => {
    expect(PARSERS_DIR.endsWith(join("packages", "engine", "parsers"))).toBe(true);
  });
});

describe("parseEvidence → claim (DR-0007: derived numbers come from code)", () => {
  it("writes tables next to the job's evidence, tagged like that evidence, and a claim can cite a derived number", async () => {
    const ledger = await Ledger.create({ projectsDir: base, name: "demo", title: "Demo", dataClass: "unpublished" });
    const raw = `evidence/raw/EXP-001/${JOB}`;
    await ledger.writeArtifacts(
      [
        { path: `${raw}/results.csv`, content: CSV },
        { path: `${raw}/MANIFEST.json`, content: MANIFEST },
        { path: `${raw}/logs/stdout.log`, content: "a,b\n1,2\n" },
        { path: `${raw}/job/bench.py`, content: "print(1)\n" },
      ],
      P.aiExecuted("claude-sonnet-5-5", "high"),
      "results",
    );
    const done = await parseEvidence(ledger, { experiment: "EXP-001" }, host);
    const tables = `evidence/tables/EXP-001/${JOB}`;
    expect(done).toEqual([{ job: JOB, inputs: [{ path: `${raw}/results.csv`, parser: "csv_summary", outputs: [`${tables}/results.ratios.csv`, `${tables}/results.summary.csv`], notes: [] }] }]);
    expect((await git(ledger.dir, ["log", "-1", "--format=%s|%(trailers:key=Cairn-Provenance,valueonly,separator=)"])).trim()).toBe(
      `ledger: tables for EXP-001 job ${JOB} (csv_summary)|ai-executed(claude-sonnet-5-5, high)`,
    );
    const parsed = JSON.parse(await readFile(join(ledger.dir, tables, "PARSED.json"), "utf8")) as { input: string; input_sha256: string; parser: string }[];
    expect(parsed).toMatchObject([{ input: `${raw}/results.csv`, parser: "csv_summary", input_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect((await ledger.check()).ok).toBe(true);

    const row = "seconds,3,0.00518620199727593,0.017140839001513086,0.010859329333470669,0.00518620199727593,0.017140839001513086,3.3050851105522634";
    const draft = parseDraft(
      [
        "## C??: Sieve time grows a little slower than N",
        "- **Statement**: Over this range, pure-Python sieve time grows somewhat less than proportionally to N.",
        "- **Conditions**: N grows 4x on one workstation core.",
        "- **Sources**:",
        `  - 4 ← ${tables}/results.summary.csv:2 «n,3,100000,400000,233333.33333333334,100000,400000,4» [input]`,
        `  - 3.3x ← ${tables}/results.summary.csv:4 «${row}» [result]`,
        "- **Status**: supported",
        "- **Falsification**: A repeat run where time grows more than N does.",
        "- **Proof**: Time grows 3.3x while N grows 4x.",
      ].join("\n"),
    );
    const r = await checkSupport(draft, ledgerReader(ledger));
    expect(r.errors).toEqual([]);
    expect(r.sources.map((s) => `${s.value}:${s.status}`)).toEqual(["4:ok", "3.3x:rounded"]);
  });

  it("refuses non-experiment names and missing evidence", async () => {
    const ledger = await Ledger.create({ projectsDir: base, name: "demo", title: "Demo", dataClass: "unpublished" });
    await expect(parseEvidence(ledger, { experiment: "../x" }, host)).rejects.toThrow(/name like EXP-001/);
    await expect(parseEvidence(ledger, { experiment: "EXP-009" }, host)).rejects.toThrow(/no committed evidence under evidence\/raw\/EXP-009\//);
  });
});
