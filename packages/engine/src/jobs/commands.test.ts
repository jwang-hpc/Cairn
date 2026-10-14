import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "@cairn/executor";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { Ledger } from "../ledger/ledger.js";
import { openJobService } from "./jobs.js";

let root: string;
let engine: Engine;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-job-cli-"));
  const cfg: LoadedConfig = {
    dir: "(test)",
    models: { providers: {}, models: {}, effort_map: {}, routing: {}, projects_default_data_class: "unpublished" },
    roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
    machines: { machines: { workstation: { host: "workstation", scheduler: "none", scratch: join(root, "scratch") }, hpc: { host: "hpc", scheduler: "slurm" } } },
    engine: { machine: "test", projects_dir: join(root, "projects"), budget: { daily: { usd: { total: 1 }, tokens: {} }, run: { max_usd: 1, max_tokens: 1000, max_turns: 2 } } },
  };
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  engine = new Engine(cfg, { configDir: "(test)", home: join(root, "home") }, { models: { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) }, stores });
  await Ledger.create({ projectsDir: join(root, "projects"), name: "demo", title: "Demo", dataClass: "unpublished" });
  await mkdir(engine.paths.home, { recursive: true });
  await writeFile(join(engine.paths.home, "state.json"), JSON.stringify({ project: "demo" }));
  const exp = join(root, "wt/experiments/EXP-001");
  await mkdir(exp, { recursive: true });
  await writeFile(join(exp, "run.sh"), "echo 7 > results.csv\n");
  await writeFile(join(exp, "job.json"), JSON.stringify({ script: "run.sh", description: "seven", resources: { cores: 1, walltime: "00:01:00" }, outputs: ["results.csv", "absent.csv"] }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const local = { transport: () => new LocalTransport() };
async function re(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: {}, jobs: local });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const propose = async () =>
  (
    await openJobService(engine, local).submit({
      project: "demo",
      worktree: join(root, "wt"),
      experiment: "EXP-001",
      target: "workstation",
      author: { kind: "agent", run: "r1", agent: "coder-1", role: "coder", model: "m1", effort: "low" },
    })
  ).job;

describe("re job / re machine (DR-0006: agents propose, you approve)", () => {
  it("list → show → approve → status → fetch", async () => {
    const job = await propose();
    const list = await re("job", "list");
    expect(list.out).toMatch(new RegExp(`^${job.id}  pending_approval\\s+EXP-001 → workstation\\s+agent coder-1 \\(m1\\)`));
    expect(list.out).toContain(`1 waiting for you: re job show ${job.id}`);
    expect((await re("job", "show", job.id)).out).toContain("── run.sh (entry point) ──\necho 7 > results.csv");

    const approved = await re("job", "approve", job.id, "--note", "fine");
    expect(approved).toMatchObject({ code: 0 });
    expect(approved.out).toMatch(new RegExp(`^approved ${job.id}\\nstarted on workstation: \\d+ in .*/cairn/demo/${job.id}`));
    let status = "";
    for (let i = 0; i < 100 && !/completed/.test(status); i++) {
      status = (await re("job", "status", job.id)).out;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toContain(`fetch results: re job fetch ${job.id}`);
    const fetched = await re("job", "fetch", job.id);
    expect(fetched.out).toBe(
      [`fetched 1 file into demo/evidence/raw/EXP-001/${job.id}/ (committed to the ledger)`, `  results: evidence/raw/EXP-001/${job.id}/ — results.csv`, "  missing: absent.csv"].join("\n"),
    );
    expect((await re("job", "list", "--all")).out).toMatch(new RegExp(`${job.id}  completed .* demo  agent coder-1`));
  });

  it("deny needs a reason; errors are clean", async () => {
    const job = await propose();
    expect(await re("job", "deny", job.id)).toMatchObject({ code: 1, err: "re job: usage: re job deny <id> --reason R" });
    expect(await re("job", "deny", job.id, "--reason", "too long")).toMatchObject({ code: 0, out: `denied ${job.id}: too long` });
    expect(await re("job", "approve", job.id)).toMatchObject({ code: 1, err: `re job: job ${job.id} is denied, not pending approval` });
    expect(await re("job", "show", "20260101-0000-dead")).toMatchObject({ code: 1, err: "re job: no job 20260101-0000-dead" });
    expect(await re("job", "show")).toMatchObject({ code: 1, err: "re job: usage: re job show <id>" });
    expect((await re("job", "frob")).code).toBe(2);
  });

  it("machine list shows sessions and missing scratch", async () => {
    const m = await re("machine", "list");
    expect(m.out.split("\n")).toEqual([
      expect.stringMatching(/^workstation\s+ssh workstation\s+none\s+scratch .*\/scratch\s+session open$/),
      expect.stringMatching(/^hpc\s+ssh hpc\s+slurm\s+NO SCRATCH \(set machines.yaml scratch\)\s+session open$/),
    ]);
  });
});
