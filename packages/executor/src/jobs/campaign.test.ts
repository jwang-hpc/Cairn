import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobRecord, MachineConfig } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalTransport, type RunResult, type Transport } from "../remote/transport.js";
import { campaignOutputs, campaignPoints, pointCount } from "./campaign.js";
import { autoApproval, lintJob } from "./lint.js";
import { type JobLedger, JobService } from "./service.js";

let root: string;
let worktree: string;
let scratch: string;
let evidence: Map<string, Buffer>;

class Switchable implements Transport {
  readonly host = "local";
  open = true;
  readonly inner = new LocalTransport();
  async run(script: string, opts?: { timeoutMs?: number }): Promise<RunResult> {
    if (!this.open) return { code: 255, out: "", err: "Control socket connect: No such file or directory", ms: 1 };
    return this.inner.run(script, opts);
  }
  async alive() {
    return this.open;
  }
}
let transport: Switchable;

const machines = (): Record<string, MachineConfig> => ({
  workstation: { host: "workstation", scheduler: "none", scratch, max: { cores: 8, walltime: "01:00:00" }, auto_approve_below: { cores: 32, hours: 4 } },
  hpc: { host: "hpc", scheduler: "slurm", scratch, partitions: ["batch"], max: { walltime: "04:00:00" } },
});
const service = () =>
  new JobService({
    home: join(root, "home"),
    machines: machines(),
    transport: () => transport,
    ledger: async (): Promise<JobLedger> => ({
      async write(_job: JobRecord, _prov, _summary, files = []) {
        for (const f of files) evidence.set(f.path, f.content);
      },
    }),
  });

const files = (manifest: object, script = "echo ok\n") => [
  { path: "job.json", content: Buffer.from(JSON.stringify(manifest)) },
  { path: "run.sh", content: Buffer.from(script) },
];
const base = { script: "run.sh", resources: { cores: 2, walltime: "00:10:00" }, outputs: ["results.csv"] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-campaign-"));
  worktree = join(root, "wt");
  scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  evidence = new Map();
  transport = new Switchable();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("campaign grid and lint (DR-0011)", () => {
  it("every combination is a point, the first parameter varying slowest; outputs are per point plus the summaries", () => {
    const spec = { parameters: { n: [100, 200], trial: [1, 2, 3] }, point_walltime: "00:01:00" };
    expect(pointCount(spec)).toBe(6);
    expect(campaignPoints(spec).map((p) => p.values)).toEqual([
      { n: 100, trial: 1 }, { n: 100, trial: 2 }, { n: 100, trial: 3 }, { n: 200, trial: 1 }, { n: 200, trial: 2 }, { n: 200, trial: 3 },
    ]);
    expect(campaignOutputs({ ...base, outputs: ["results.csv", "log.txt"], campaign: { parameters: { n: [1, 2] }, point_walltime: "00:01:00" } })).toEqual([
      "campaign.csv", "campaign-results.csv", "points/0000/results.csv", "points/0000/log.txt", "points/0001/results.csv", "points/0001/log.txt",
    ]);
  });

  it("lints the grid against the machine and the budget; a campaign never auto-approves", () => {
    const ok = lintJob({ target: "workstation", machine: machines().workstation!, files: files({ ...base, campaign: { parameters: { n: [1, 2, 3, 4] }, point_walltime: "00:02:00", parallel: 2, retries: 1 } }) });
    expect(ok.lint.errors).toEqual([]);
    expect(ok.lint.campaign).toEqual({ points: 4, parallel: 2, retries: 1, point_walltime_s: 120, estimate_s: 240 });
    expect(autoApproval("workstation", machines().workstation!, ok.lint, true)).toEqual({ ok: false, reason: "a campaign is always approved by you (DR-0011)" });
    const tight = lintJob({ target: "workstation", machine: machines().workstation!, files: files({ ...base, resources: { cores: 1, walltime: "00:05:00" }, campaign: { parameters: { n: [1, 2, 3, 4] }, point_walltime: "00:02:00" } }) });
    expect(tight.lint.warnings).toContain("the budget (walltime 00:05:00) covers about 2 of 4 points at their limit; the campaign starts no point it could not finish");
    const bad = (m: object, target = "workstation") => lintJob({ target, machine: machines()[target]!, files: files({ ...base, ...m }) }).lint.errors;
    // Slurm: each point is an array task with the job's resources, and the walltime is a deadline from submission.
    const slurm = (m: object) => lintJob({ target: "hpc", machine: machines().hpc!, files: files({ ...base, ...m }) }).lint;
    const arr = slurm({ resources: { cores: 2, walltime: "24:00:00" }, campaign: { parameters: { n: [1, 2, 3, 4] }, point_walltime: "01:00:00", parallel: 8, retries: 1 } });
    expect(arr.errors).toEqual([]); // more tasks at once than cores, and a deadline beyond one job's max: both fine
    expect(arr.campaign).toEqual({ points: 4, parallel: 8, retries: 1, point_walltime_s: 3600, estimate_s: 3600, task_walltime_s: 7260 });
    expect(arr.node_hours).toBe(8.067); // the most the approval allows: 4 tasks × 1 node × 2 h 1 min
    expect(slurm({ resources: { cores: 1, walltime: "12:00:00" }, campaign: { parameters: { n: [1] }, point_walltime: "02:00:00", retries: 1 } }).errors).toEqual([
      "a point's array task (04:01:00: 2 attempts of 02:00:00 plus a minute) exceeds hpc max 04:00:00",
    ]);
    expect(slurm({ campaign: { parameters: { n: [1] }, point_walltime: "00:10:00" } }).errors).toEqual([
      "a point's array task (00:11:00: 1 attempt of 00:10:00 plus a minute) does not fit the campaign's deadline (resources.walltime 00:10:00)",
    ]);
    expect(lintJob({ target: "pbs", machine: { host: "p", scheduler: "pbs", scratch }, files: files({ ...base, campaign: { parameters: { n: [1] }, point_walltime: "00:01:00" } }) }).lint.errors).toContain(
      "campaigns run on workstations and Slurm machines (pbs uses pbs)",
    );
    expect(bad({ campaign: { parameters: { n: [1] }, point_walltime: "00:01:00", parallel: 4 } })).toContain("campaign.parallel 4 exceeds the job's 2 cores");
    expect(bad({ campaign: { parameters: { n: [1] }, point_walltime: "00:10:00" } })).toContain("campaign.point_walltime 00:10:00 does not fit the campaign's budget (resources.walltime 00:10:00)");
    expect(bad({ campaign: { parameters: { a: Array.from({ length: 40 }, (_, i) => i), b: Array.from({ length: 40 }, (_, i) => i) }, point_walltime: "00:00:01" } })).toContain("campaign has 1600 points (at most 1000)");
    expect(bad({ campaign: { parameters: { "bad name": [1] }, point_walltime: "00:00:01" } }).join("\n")).toMatch(/job\.json/);
    expect(bad({ campaign: { parameters: { n: ["a;rm -rf /"] }, point_walltime: "00:00:01" } }).join("\n")).toMatch(/job\.json/);
    const planted = (path: string) =>
      lintJob({ target: "workstation", machine: machines().workstation!, files: [...files({ ...base, campaign: { parameters: { n: [1] }, point_walltime: "00:00:01" } }), { path, content: Buffer.from("n\n1\n") }] }).lint.errors;
    expect(planted("points/0000/results.csv")).toEqual(["points/0000/results.csv: the campaign writes this path; rename the file"]);
    expect(planted("campaign.csv")).toEqual(["campaign.csv: the campaign writes this path; rename the file"]);
    expect(planted("results.csv")).toEqual(["results.csv is a declared output; a copy in every point would pass for that point's result"]);
    expect(planted("inputs/results.csv")).toEqual([]);
  });
});

describe("the approval card", () => {
  it("shows a Slurm campaign as a job array with a deadline and the most node-hours it may use", async () => {
    const d = join(worktree, "experiments", "EXP-003");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "run.sh"), "echo ok > results.csv\n");
    await writeFile(join(d, "job.json"), JSON.stringify({ ...base, resources: { cores: 2, walltime: "24:00:00" }, campaign: { parameters: { n: [1, 2, 3, 4] }, point_walltime: "01:00:00", parallel: 8, retries: 1 } }));
    const svc = service();
    const { job, auto } = await svc.submit({ project: "demo", worktree, experiment: "EXP-003", target: "hpc", author: { kind: "user" } });
    expect(auto.ok).toBe(false);
    const card = (await svc.card(job.id)).split("\n");
    expect(card).toContain("resources:   per point: 1 node × 2 cores, deadline 24:00:00 after submission (at most 8.067 node-hours if every task runs to its limit)");
    expect(card).toContain("campaign:    4 points (n × 4), a Slurm job array: 8 at a time, 1 retry per point");
    expect(card).toContain("             each point ≤ 01:00:00 (task limit 02:01:00); without queue waits the grid needs about 01:00:00");
  });
});

describe("a campaign on the workstation runner (bash, process groups, no model)", () => {
  it("runs every point unattended: retries failures, stops overruns, summarizes; reconcile fetches it on wake", async () => {
    const d = join(worktree, "experiments", "EXP-001");
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, "run.sh"),
      [
        'case "$P_kind" in',
        '  ok) printf "n,sq\\n%s,%s\\n" "$P_n" "$((P_n * P_n))" > results.csv ;;',
        "  bad) echo nope >&2; exit 3 ;;",
        "  slow) sleep 30 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(d, "job.json"),
      JSON.stringify({ ...base, resources: { cores: 3, walltime: "00:05:00" }, campaign: { parameters: { n: [2, 3, 4], kind: ["ok", "bad", "slow"] }, point_walltime: "00:00:02", parallel: 3, retries: 1 } }),
    );
    const svc = service();
    const { job } = await svc.submit({ project: "demo", worktree, experiment: "EXP-001", target: "workstation", author: { kind: "user" } });
    expect(job.lint.campaign?.points).toBe(9);
    expect(await svc.card(job.id)).toMatch(/campaign: {4}9 points \(n × 3, kind × 3\), 3 at a time, 1 retry per point/);
    await svc.approve(job.id);

    let r = await svc.refresh(job.id);
    const t0 = Date.now();
    while (!["completed", "failed"].includes(r.state) && Date.now() - t0 < 40_000) {
      await new Promise((res) => setTimeout(res, 300));
      r = await svc.refresh(job.id);
    }
    expect(r.state).toBe("failed"); // not every point succeeded
    expect(r.history.at(-1)?.note).toMatch(/9 of 9 points done, 6 not ok/);

    // The laptop "wakes" with no SSH session: reconcile waits; once open, it fetches.
    transport.open = false;
    expect((await svc.reconcile({ project: "demo" })).unreachable).toEqual([{ job: job.id, reason: expect.any(String) }]);
    transport.open = true;
    const rec = await svc.reconcile({ project: "demo" });
    expect(rec.fetched.map((j) => j.id)).toEqual([job.id]);

    const ev = (p: string) => evidence.get(`evidence/raw/EXP-001/${job.id}/${p}`)?.toString("utf8");
    const index = ev("campaign.csv")!.trim().split("\n");
    expect(index[0]).toBe("point,n,kind,status,exit,attempts,seconds");
    expect(index.slice(1).map((l) => l.split(",").slice(0, 6).join(","))).toEqual([
      "0,2,ok,ok,0,1", "1,2,bad,failed,3,2", "2,2,slow,timeout,143,2",
      "3,3,ok,ok,0,1", "4,3,bad,failed,3,2", "5,3,slow,timeout,143,2",
      "6,4,ok,ok,0,1", "7,4,bad,failed,3,2", "8,4,slow,timeout,143,2",
    ]);
    expect(ev("campaign-results.csv")).toBe("point,n,kind,n,sq\n0,2,ok,2,4\n3,3,ok,3,9\n6,4,ok,4,16\n");
    expect(ev("points/0003/results.csv")).toBe("n,sq\n3,9\n");
    expect(ev("points/0001/results.csv")).toBeUndefined();
    expect((await svc.reconcile({ project: "demo" })).fetched).toEqual([]); // fetched once
  }, 60_000);

  it("a point cannot pull an outside file into the summary through a link", async () => {
    const secret = join(scratch, "secret.txt");
    await writeFile(secret, "n,sq\nSECRET,1\n");
    const d = join(worktree, "experiments", "EXP-002");
    await mkdir(d, { recursive: true });
    // Lint refuses a literal link to an outside path; a target read from a data file gets past it, so the driver checks too.
    await writeFile(join(d, "target.txt"), `${secret}\n`);
    await writeFile(join(d, "run.sh"), 'if [ "$P_n" = 1 ]; then printf "n,sq\\n1,1\\n" > results.csv; else ln -s "$(cat target.txt)" results.csv; ln -s "$(cat target.txt)" .result; fi\n');
    await writeFile(join(d, "job.json"), JSON.stringify({ ...base, campaign: { parameters: { n: [1, 2] }, point_walltime: "00:00:10", parallel: 2 } }));
    const svc = service();
    const { job } = await svc.submit({ project: "demo", worktree, experiment: "EXP-002", target: "workstation", author: { kind: "user" } });
    expect(job.lint.errors).toEqual([]);
    await svc.approve(job.id);
    let r = await svc.refresh(job.id);
    for (let i = 0; i < 100 && !["completed", "failed"].includes(r.state); i++) {
      await new Promise((res) => setTimeout(res, 200));
      r = await svc.refresh(job.id);
    }
    const fetched = await svc.fetch(job.id);
    expect(fetched.results?.refused).toEqual([{ path: "points/0001/results.csv", reason: "symlink" }]);
    const ev = (p: string) => evidence.get(`evidence/raw/EXP-002/${job.id}/${p}`)?.toString("utf8");
    expect(ev("campaign-results.csv")).toBe("point,n,n,sq\n0,1,1,1\n");
    expect(ev("campaign.csv")).toMatch(/^point,n,status,exit,attempts,seconds\n0,1,ok,0,1,\d+\n1,2,ok,0,1,\d+\n$/);
    expect([...evidence.values()].some((c) => c.includes("SECRET"))).toBe(false);
    expect(await readFile(secret, "utf8")).toBe("n,sq\nSECRET,1\n"); // and nothing was written through the links
  }, 30_000);
});
