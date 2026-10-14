import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "@cairn/launcher";
import { provenance as P } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "./ledger.js";

let base: string;
let clock: Date;
const now = () => clock;
const create = () => Ledger.create({ projectsDir: base, name: "lossy-io", title: "Lossy compression for HPC I/O", dataClass: "unpublished" }, now);
const hyp = {
  title: "Error-bounded compression cuts checkpoint time",
  statement: "SZ3 at 1e-3 relative error reduces checkpoint write time on Lustre.",
  prediction: "At least 3x lower write time at 512 nodes.",
  falsification: "Write time reduction below 1.5x at 512 nodes with identical striping.",
  baseline: "Uncompressed HDF5 writes with default striping.",
  decisive_experiment: "E01: weak scaling 64-512 nodes, 5 repeats.",
  kill_criteria: "Compression overhead exceeds I/O savings at 128 nodes.",
};
const log = (dir: string, fmt: string) => git(dir, ["log", `--format=${fmt}`]);

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-ledger-"));
  clock = new Date(2026, 9, 14, 9, 30);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Ledger.create / open", () => {
  it("creates an ARA project at the repo root with one tagged user commit", async () => {
    const l = await create();
    const paper = await readFile(join(l.dir, "PAPER.md"), "utf8");
    expect(paper).toMatch(/^---\ntitle: Lossy compression for HPC I\/O\n/);
    expect(paper).toContain("cairn_project: lossy-io");
    expect(paper).toContain("data_class: unpublished");
    for (const f of ["logic/hypotheses.md", "logic/claims.md", "trace/exploration_tree.yaml", "staging/observations.yaml", "evidence/README.md", "engine/decisions.md", "lit/refs.bib"]) {
      await expect(readFile(join(l.dir, f), "utf8")).resolves.toBeTypeOf("string");
    }
    expect((await log(l.dir, "%s|%(trailers:key=Cairn-Provenance,valueonly)")).trim()).toBe("ledger: create project lossy-io: Lossy compression for HPC I/O|user");
    const reopened = await Ledger.open(l.dir);
    expect([reopened.name, reopened.dataClass]).toEqual(["lossy-io", "unpublished"]);
  });

  it("refuses bad names, duplicates, and non-projects", async () => {
    await expect(Ledger.create({ projectsDir: base, name: "../x", title: "t", dataClass: "public" })).rejects.toThrow(/project name/);
    await create();
    await expect(create()).rejects.toThrow(/already exists/);
    await expect(Ledger.open(base)).rejects.toThrow(/not a Cairn project/);
  });
});

describe("exploration tree", () => {
  it("appends typed nodes (nested under parents), enforces required fields, and renders as text", async () => {
    const l = await create();
    const q = await l.addNode({ type: "question", title: "Does compression pay off at scale?", description: "I/O dominates checkpoints." }, P.user);
    const e = await l.addNode({ type: "experiment", title: "SZ3 on 64 nodes", result: "2.1x faster writes", evidence: ["evidence/tables/t1.csv"], parent: q }, P.aiExecuted("claude-sonnet-5-5", "high"));
    const d = await l.addNode(
      { type: "dead_end", title: "Lossless zstd", hypothesis: "zstd alone is enough", failure_mode: "1.1x ratio on floats", lesson: "Use error-bounded lossy compressors", parent: q, also_depends_on: [e] },
      P.aiSuggested("claude-sonnet-5-5", "high"),
    );
    expect([q, e, d]).toEqual(["N01", "N02", "N03"]);
    const tree = await l.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children!.map((c) => c.id)).toEqual(["N02", "N03"]);
    expect(tree[0]!.children![1]).toMatchObject({ type: "dead_end", timestamp: "2026-10-14T09:30", also_depends_on: ["N02"] });
    expect(await readFile(join(l.dir, "trace/exploration_tree.yaml"), "utf8")).toMatch(/^# Exploration tree/); // header comment kept
    expect(await l.renderTree()).toBe(
      [
        "N01 question  Does compression pay off at scale?  [user]",
        "├── N02 experiment  SZ3 on 64 nodes  [ai-executed(claude-sonnet-5-5, high)]",
        "└── ✗ N03 dead_end  Lossless zstd  [ai-suggested(claude-sonnet-5-5, high)]",
        "    ⤷ also depends on N02",
      ].join("\n"),
    );
    await expect(l.addNode({ type: "dead_end", title: "x", hypothesis: "h", lesson: "l" }, P.user)).rejects.toThrow("dead_end node needs 'failure_mode'");
    await expect(l.addNode({ type: "question", title: "x", description: "d", parent: "N99" }, P.user)).rejects.toThrow("unknown node N99");
  });

  it("commits AI-originated writes as the Cairn agent and user writes as the user", async () => {
    const l = await create();
    await l.addNode({ type: "question", title: "q", description: "d" }, P.aiSuggested("gpt-6.1-sol", "medium"));
    await l.addNode({ type: "question", title: "q2", description: "d" }, P.user);
    const lines = (await log(l.dir, "%an|%(trailers:key=Cairn-Provenance,valueonly)")).split("\n").map((s) => s.trim()).filter(Boolean);
    expect(lines[0]).not.toMatch(/^Cairn agent/);
    expect(lines[0]).toMatch(/\|user$/);
    expect(lines[1]).toBe("Cairn agent|ai-suggested(gpt-6.1-sol, medium)");
  });
});

describe("hypotheses and decisions", () => {
  it("records a hypothesis with all DR-0007 fields and opens a question node", async () => {
    const l = await create();
    const { id, node } = await l.addHypothesis(hyp, P.user);
    expect([id, node]).toEqual(["HY01", "N01"]);
    const [h] = await l.hypotheses();
    expect(h).toEqual({ id: "HY01", ...hyp, status: "proposed", provenance: "user", opened: "N01 (2026-10-14)" });
    expect((await l.tree())[0]).toMatchObject({ id: "N01", type: "question", title: `HY01: ${hyp.title}`, status: "open" });
    await expect(l.addHypothesis({ ...hyp, kill_criteria: "" }, P.user)).rejects.toThrow(/kill_criteria/);
  });

  it("approval is a human gate: AI provenance is refused; user approval writes a decision node and decisions.md", async () => {
    const l = await create();
    await l.addHypothesis(hyp, P.aiSuggested("claude-opus-5-5", "high"));
    await expect(l.approveHypothesis("HY01", P.aiSuggested("claude-opus-5-5", "high"))).rejects.toThrow(/human decision/);
    const r = await l.approveHypothesis("HY01", P.user, "worth the allocation");
    expect(r).toEqual({ decision: "D01", node: "N02" });
    expect((await l.hypotheses())[0]!.status).toBe("approved");
    expect((await l.tree())[0]!.children![0]).toMatchObject({ id: "N02", type: "decision", choice: "Pursue HY01", evidence: ["N01"] });
    expect(await readFile(join(l.dir, "engine/decisions.md"), "utf8")).toContain(
      `## D01: Pursue HY01 — ${hyp.title}\n- **Date**: 2026-10-14\n- **By**: user\n- **Refs**: HY01, N02\n- **Note**: worth the allocation\n`,
    );
    await expect(l.approveHypothesis("HY01", P.user)).rejects.toThrow("HY01 is approved, not proposed");
    await expect(l.approveHypothesis("HY09", P.user)).rejects.toThrow("unknown hypothesis HY09");
  });

  it("refuses untagged or malformed provenance", async () => {
    const l = await create();
    for (const bad of ["ai-suggested", "agent", "", "ai-executed(m, turbo)"]) {
      await expect(l.addDecision("x", bad)).rejects.toBeInstanceOf(LedgerError);
    }
  });
});

describe("check and the claim gate", () => {
  it("passes when every write is tagged, and flags hand edits and untagged commits", async () => {
    const l = await create();
    await l.addHypothesis(hyp, P.user);
    await l.addDecision("Use Lustre stripe count 8", P.userRevised, ["HY01"]);
    expect(await l.check()).toMatchObject({ ok: true, problems: [], writes: 4, commits: 4 });
    expect((await l.writes()).map((w) => `${w.op}:${w.id ?? ""}:${w.provenance}`)).toEqual([
      "create::user", "add-node:N01:user", "add-hypothesis:HY01:user", "add-decision:D01:user-revised",
    ]);

    await writeFile(join(l.dir, "logic/problem.md"), "# Problem\nedited by hand\n");
    let c = await l.check();
    expect(c.ok).toBe(false);
    expect(c.problems.join("\n")).toContain("uncommitted changes outside the ledger");
    await git(l.dir, ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "manual"]);
    c = await l.check();
    expect(c.problems.join("\n")).toMatch(/commit [0-9a-f]{12} "manual" has no valid Cairn-Provenance/);
  });

  it("never commits a change to logic/claims.md (claim gate, invariant 5)", async () => {
    const l = await create();
    await writeFile(join(l.dir, "logic/claims.md"), "# Claims\n## C01: sneaked in\n");
    await expect(l.addNode({ type: "question", title: "q", description: "d" }, P.user)).rejects.toThrow(/claim gate/);
    expect((await l.writes()).map((w) => w.op)).toEqual(["create"]); // nothing logged for the refused write
    expect((await git(l.dir, ["log", "--oneline"])).trim().split("\n")).toHaveLength(1);
  });
});
