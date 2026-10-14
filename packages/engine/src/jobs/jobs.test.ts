import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService, LocalTransport } from "@cairn/executor";
import { git } from "@cairn/launcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../ledger/ledger.js";
import { jobLedger } from "./jobs.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-engine-jobs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("jobs in the project ledger", () => {
  it("records the job's life as tagged commits and lands results in evidence/raw/", async () => {
    const projects = join(root, "projects");
    const ledger = await Ledger.create({ projectsDir: projects, name: "demo", title: "Demo", dataClass: "unpublished" });
    const wt = join(root, "wt");
    await mkdir(join(wt, "experiments/EXP-001"), { recursive: true });
    await writeFile(join(wt, "experiments/EXP-001/run.sh"), "printf 'a\\n' > results.csv\nhead -c 4 /dev/zero > raw.bin\n");
    await writeFile(join(wt, "experiments/EXP-001/job.json"), JSON.stringify({ script: "run.sh", resources: { cores: 1, walltime: "00:01:00" }, outputs: ["results.csv", "raw.bin"] }));
    const svc = new JobService({
      home: join(root, "home"),
      machines: { workstation: { host: "workstation", scheduler: "none", scratch: join(root, "scratch") } },
      ledger: jobLedger(projects),
      transport: () => new LocalTransport(),
    });
    const author = { kind: "agent", run: "r1", agent: "coder-1", role: "coder", model: "gpt-6.1-sol", effort: "high" } as const;
    const { job } = await svc.submit({ project: "demo", worktree: wt, experiment: "EXP-001", target: "workstation", author });
    await svc.approve(job.id);
    for (let i = 0; i < 100 && (await svc.refresh(job.id)).state === "running"; i++) await new Promise((r) => setTimeout(r, 100));
    await svc.fetch(job.id);

    const dir = join(ledger.dir, "evidence/raw/EXP-001", job.id);
    expect(await readFile(join(dir, "results.csv"), "utf8")).toBe("a\n");
    expect(await readFile(join(dir, "raw.bin"))).toEqual(Buffer.alloc(4));
    expect(JSON.parse(await readFile(join(ledger.dir, "engine/jobs", `${job.id}.json`), "utf8"))).toMatchObject({ state: "completed", results: { files: ["results.csv", "raw.bin"] } });
    const log = await git(ledger.dir, ["log", "--reverse", "--format=%s|%(trailers:key=Cairn-Provenance,valueonly,separator=)|%an"]);
    const rows = log.trim().split("\n").slice(1).map((l) => {
      const [subject, prov, author] = l.replace(job.id, "<id>").replace(/\(\d+\)/, "(<pid>)").split("|");
      return `${subject}|${prov}|${author === "Cairn agent" ? "agent" : "user"}`;
    });
    expect(rows).toEqual([
      "ledger: job <id>: EXP-001 on workstation, awaiting approval|ai-suggested(gpt-6.1-sol, high)|agent",
      "ledger: job <id>: approved|user|user",
      "ledger: job <id>: started on workstation (<pid>)|ai-executed(gpt-6.1-sol, high)|agent",
      expect.stringMatching(/^ledger: job <id>: completed \(exit 0, finished .*\)\|ai-executed\(gpt-6.1-sol, high\)\|agent$/),
      "ledger: job <id>: results for EXP-001 (2 files)|ai-executed(gpt-6.1-sol, high)|agent",
    ]);
    expect(await ledger.check()).toMatchObject({ ok: true, problems: [] });
  });

  it("refuses bad project names", async () => {
    await expect(jobLedger(root)("../x")).rejects.toThrow(/bad project name/);
  });
});
