import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";

let base: string;
let engine: Engine;
const config = (projectsDir: string): LoadedConfig => ({
  dir: "(test)",
  models: { providers: {}, models: {}, effort_map: {}, routing: {}, projects_default_data_class: "unpublished" },
  roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
  machines: { machines: {} },
  engine: { machine: "test", projects_dir: projectsDir, budget: { daily: { usd: {}, tokens: {} }, run: { max_usd: 1, max_tokens: 1, max_turns: 1 } } },
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-cli-ledger-"));
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  engine = new Engine(config(join(base, "projects")), { configDir: "(test)", home: join(base, "home") }, {
    models: { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) },
    stores,
  });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function re(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: {} });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("re project new asks for the data class (DR-0013)", () => {
  it("never defaults it: an error without a terminal, a question with one", async () => {
    const r = await re("project", "new", "x", "--title", "X");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/say whether this project's data is open: --data-class public \| unpublished \| restricted/);
    expect(r.err).toMatch(/public {7}open data/);
    expect((await re("project", "list")).out).toBe("(no projects)");
    const asked: string[] = [];
    const answer = (a: string) => async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const login = { show: () => {}, ask: async (q: string) => (asked.push(q), a), choose: async () => "public" };
      const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), interactive: true, login }, { openEngine: async () => engine, env: {} });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const yes = await answer(" Public ")("project", "new", "open1", "--title", "Open data");
    expect(yes.code).toBe(0);
    expect(yes.out).toMatch(/^Is this project's data open\?/);
    expect(yes.out).toMatch(/created open1 \(public\)/);
    expect(asked).toEqual(["data class (public, unpublished, or restricted):"]);
    expect(await answer("")("project", "new", "blank", "--title", "B")).toMatchObject({ code: 2, err: expect.stringContaining("no data class given; nothing created") });
    expect(await answer("open")("project", "new", "typo", "--title", "T")).toMatchObject({ code: 2 });
    expect((await re("project", "list")).out).toBe("* open1  [public]");
  });
});

describe("re project / hypothesis / trace / tree / decision / ledger (M3 acceptance, offline)", () => {
  it("runs the M3 flow end to end and every write is tagged", async () => {
    expect((await re("project", "new", "lossy-io", "--title", "Lossy compression for HPC I/O", "--data-class", "unpublished")).out).toMatch(/^created lossy-io \(unpublished\) at .*projects\/lossy-io\ncurrent project: lossy-io$/);
    const add = await re(
      "hypothesis", "add", "--title", "SZ3 cuts checkpoint time",
      "--statement", "SZ3 at 1e-3 relative error reduces checkpoint write time on Lustre.",
      "--prediction", "3x lower write time at 512 nodes", "--falsification", "< 1.5x at 512 nodes",
      "--baseline", "uncompressed HDF5", "--experiment", "weak scaling 64-512 nodes", "--kill", "overhead > savings at 128 nodes",
    );
    expect(add).toMatchObject({ code: 0, out: "added HY01 (proposed), opened N01 in the exploration tree\napprove with: re hypothesis approve HY01" });
    expect((await re("hypothesis", "approve", "HY01", "--note", "fits the allocation")).out).toBe("approved HY01: decision D01, node N02");
    expect((await re("trace", "add", "experiment", "--title", "SZ3 at 64 nodes", "--result", "2.1x faster", "--evidence", "evidence/tables/t1.csv", "--parent", "N02")).out).toBe("added N03 (experiment)");
    expect((await re("trace", "add", "dead-end", "--title", "zstd only", "--hypothesis", "lossless is enough", "--failure", "1.1x ratio", "--lesson", "use error-bounded lossy", "--parent", "N01", "--depends", "N03")).out).toBe("added N04 (dead_end)");
    expect((await re("decision", "add", "--title", "Stripe count 8", "--refs", "N03")).out).toBe("added D02");

    expect((await re("tree")).out).toBe(
      [
        "N01 question  HY01: SZ3 cuts checkpoint time  [user]",
        "├── N02 decision  Pursue HY01: SZ3 cuts checkpoint time  [user]",
        "│   └── N03 experiment  SZ3 at 64 nodes  [user]",
        "└── ✗ N04 dead_end  zstd only  [user]",
        "    ⤷ also depends on N03",
      ].join("\n"),
    );
    expect((await re("hypothesis", "list")).out).toBe("HY01  approved  SZ3 cuts checkpoint time  [user] (N01 (" + (await readFile(join(base, "projects", "lossy-io", "logic", "hypotheses.md"), "utf8")).match(/Opened\*\*: N01 \(([^)]+)\)/)![1] + "))");
    expect(await re("ledger", "check")).toMatchObject({ code: 0, out: "ok: 8 ledger writes, 8 commits, all tagged" });
    expect((await re("project", "list")).out).toBe("* lossy-io  [unpublished]");
  });

  it("explains missing arguments and missing projects", async () => {
    expect(await re("tree")).toMatchObject({ code: 1, err: expect.stringContaining("no project selected") });
    await re("project", "new", "p1", "--title", "P1", "--data-class", "public");
    const r = await re("hypothesis", "add", "--title", "only a title");
    expect(r.code).toBe(2);
    expect(r.err).toContain("missing --statement, --prediction, --falsification, --baseline, --experiment, --kill");
    expect(await re("trace", "add", "theory", "--title", "x")).toMatchObject({ code: 2, err: expect.stringContaining("node type must be one of") });
    expect(await re("project", "new", "p2", "--title", "P2", "--data-class", "secret")).toMatchObject({ code: 2 });
    expect(await re("project", "use", "nope")).toMatchObject({ code: 1, err: expect.stringContaining("not a Cairn project") });
  });

  it("--project overrides the current project", async () => {
    await re("project", "new", "a", "--title", "A", "--data-class", "public");
    await re("project", "new", "b", "--title", "B", "--data-class", "public");
    await re("trace", "add", "question", "--title", "in a", "--description", "d", "--project", "a");
    expect((await re("tree", "--project", "a")).out).toContain("in a");
    expect((await re("tree")).out).toBe("(empty exploration tree)"); // current is b
  });
});
