import { execFileSync, spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobManifest, MachineConfig } from "@cairn/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintJob } from "../jobs/lint.js";
import {
  fetchScript,
  jobDir,
  parseFetch,
  parseRejection,
  parseSlurmStatus,
  parseWorkstationStatus,
  RemoteError,
  type RemoteJob,
  sbatchScript,
  shq,
  SlurmRunner,
  uploadScript,
  WorkstationRunner,
} from "./runners.js";
import { LocalTransport, muxOnlyOptions, SshTransport } from "./transport.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "cairn-remote-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const machine = (over: Partial<MachineConfig> = {}): MachineConfig => ({ host: "local", scheduler: "none", scratch, ...over });
let seq = 0;
const nextId = () => `20261014-0300-${(0xa000 + seq++).toString(16)}`;

function remoteJob(script: string, over: { manifest?: Partial<JobManifest>; resources?: Partial<JobManifest["resources"]>; m?: MachineConfig; extra?: { path: string; content: Buffer }[] } = {}): RemoteJob {
  const m = over.m ?? machine();
  const manifest: JobManifest = { script: "run.sh", resources: { cores: 1, walltime: "00:01:00", ...over.resources }, outputs: ["results.csv"], ...over.manifest };
  const files = [
    { path: "job.json", content: Buffer.from(JSON.stringify(manifest)) },
    { path: "run.sh", content: Buffer.from(script) },
    ...(over.extra ?? []),
  ];
  const { lint } = lintJob({ target: "t", machine: m, files });
  const id = nextId();
  return { id, dir: jobDir(m, "proj", id), manifest, lint, files };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("transport", () => {
  it("ssh is mux-only: no master, no auth methods, no forwarding (spike 4)", () => {
    const o = muxOnlyOptions("/h/ssh");
    for (const x of ["ControlMaster=no", "ControlPath=/h/ssh/%C", "BatchMode=yes", "PubkeyAuthentication=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "IdentityAgent=none", "ForwardAgent=no", "ClearAllForwardings=yes"]) {
      expect(o).toContain(x);
    }
    expect(() => new SshTransport("-oProxyCommand=evil", "/h")).toThrow(/bad ssh alias/);
  });

  it("shq quotes anything for sh", async () => {
    const t = new LocalTransport();
    const nasty = `a'b"c $(touch x) \`y\` \\ ; | &`;
    expect((await t.run(`printf '%s' ${shq(nasty)}\n`)).out).toBe(nasty);
  });
});

describe("upload and fetch", () => {
  it("uploads files 0600 under a new job dir and refuses to reuse it", async () => {
    const j = remoteJob("echo hi\n", { extra: [{ path: "lib/helper.py", content: Buffer.from("print(1)\n") }] });
    const t = new LocalTransport();
    const r = await t.run(uploadScript(j.dir, j.files));
    expect(r).toMatchObject({ code: 0, out: "uploaded=3\n" });
    expect(await readFile(join(j.dir, "lib/helper.py"), "utf8")).toBe("print(1)\n");
    expect((await stat(join(j.dir, "run.sh"))).mode & 0o777).toBe(0o600);
    expect((await t.run(uploadScript(j.dir, j.files))).code).toBe(3);
    // Scripts with a shebang stay runnable as ./helper.sh.
    const k = remoteJob("echo hi\n", { extra: [{ path: "helper.sh", content: Buffer.from("#!/bin/sh\necho ok\n") }] });
    await t.run(uploadScript(k.dir, k.files));
    expect((await stat(join(k.dir, "helper.sh"))).mode & 0o777).toBe(0o700);
  });

  it("refuses unsafe names and dirs before building a script", () => {
    expect(() => uploadScript("/tmp/x'; rm -rf ~", [])).toThrow(RemoteError);
    expect(() => uploadScript("/tmp/x", [{ path: "../evil", content: Buffer.from("") }])).toThrow(/file name/);
    expect(() => fetchScript("/tmp/x", ["a b"], "0123456789abcdef")).toThrow(/output/);
    expect(() => fetchScript("/tmp/x", ["a"], "x; rm -rf ~")).toThrow(/marker/);
    expect(() => jobDir(machine(), "proj", "../../x")).toThrow(/job id/);
  });

  it("fetches regular files only: missing, too big, symlinked, hard-linked, and outside-dir outputs are not copied", async () => {
    const j = remoteJob("true\n");
    const t = new LocalTransport();
    await t.run(uploadScript(j.dir, j.files));
    const secret = join(scratch, "secret.txt");
    await writeFile(secret, "SECRET");
    await writeFile(join(j.dir, "results.csv"), "a,b\n1,2\n");
    await writeFile(join(j.dir, "big.bin"), Buffer.alloc(2048));
    await symlink(secret, join(j.dir, "link.txt"));
    await link(secret, join(j.dir, "hard.txt"));
    await symlink(scratch, join(j.dir, "up"));
    await writeFile(join(j.dir, ".cairn/stdout.log"), "log line\n");
    const outputs = ["results.csv", "nothere.csv", "big.bin", "link.txt", "hard.txt", "up/secret.txt"];
    const marker = "0123456789abcdef";
    const script = fetchScript(j.dir, outputs, marker).replace(/^MAX=\d+$/m, "MAX=1024");
    const r = await t.run(script);
    // Lines a login script or leftover process could print: no marker, wrong marker, or an undeclared path.
    const forged = [
      "=== FILE 6 ../../engine/jobs/x.json", "U0VDUkVU", "=== END",
      `=== ${marker} FILE 6 ../../EXP-002/x/results.csv`, "U0VDUkVU", `=== ${marker} END`,
      `=== ${marker} MISSING ../../etc`,
    ].join("\n");
    const f = parseFetch(j.dir, `${forged}\n${r.out}`, "raw", outputs, marker);
    expect(f.files.map((x) => [x.path, x.content.toString()])).toEqual([["results.csv", "a,b\n1,2\n"]]);
    expect(f.missing).toEqual(["nothere.csv"]);
    expect(f.referenced).toEqual([{ path: `${j.dir}/big.bin`, bytes: 2048 }]);
    expect(f.refused).toEqual([
      { path: "link.txt", reason: "symlink" },
      { path: "hard.txt", reason: "hardlink" },
      { path: "up/secret.txt", reason: "outside" },
    ]);
    expect(f.logs.map((x) => [x.path, x.content.toString()])).toEqual([["stdout.log", "log line\n"]]);
    expect(JSON.stringify(f)).not.toContain("SECRET");
  });
});

describe("WorkstationRunner (real processes via LocalTransport)", () => {
  const runner = new WorkstationRunner(new LocalTransport());
  const ids = new Map<string, string>();
  const startJob = async (j: RemoteJob) => {
    const r = await runner.start(j);
    ids.set(j.id, r.id);
    return r;
  };
  const statusOf = (j: RemoteJob) => runner.status(j, ids.get(j.id) ?? "99999");

  it("runs the job, reports completion, and fetches outputs and logs", async () => {
    const j = remoteJob("#!/bin/bash\nset -eu\necho start\nprintf 'x,y\\n1,2\\n' > results.csv\necho oops >&2\n");
    const { id } = await startJob(j);
    expect(id).toMatch(/^\d+$/);
    expect(await runner.find(j)).toMatchObject({ id });
    expect(await runner.find({ ...j, dir: `${j.dir}-r9` })).toBeUndefined();
    const s = await until(() => statusOf(j), (x) => x.state !== "running");
    expect(s).toMatchObject({ state: "completed" });
    const f = await runner.fetch(j);
    expect(f.files.map((x) => x.content.toString())).toEqual(["x,y\n1,2\n"]);
    expect(f.logs.map((x) => `${x.path}:${x.content.toString()}`)).toEqual(["stdout.log:start\n", "stderr.log:oops\n"]);
  });

  it("reports a failing job with its exit code", async () => {
    const j = remoteJob("exit 3\n");
    await startJob(j);
    expect(await until(() => statusOf(j), (x) => x.state !== "running")).toMatchObject({ state: "failed", detail: "exit 3" });
  });

  it("kills the job's whole process group at the walltime", async () => {
    const j = remoteJob("sleep 30 & echo $! > child.pid\nwait\n", { resources: { walltime: "00:00:01" } });
    await startJob(j);
    const s = await until(() => statusOf(j), (x) => x.state !== "running", 10_000);
    expect(s).toMatchObject({ state: "failed" });
    expect(s.detail).toMatch(/^walltime exceeded/);
    const child = Number(await readFile(join(j.dir, "child.pid"), "utf8"));
    expect(await until(async () => alive(child), (a) => !a, 3_000)).toBe(false);
  });

  it("nothing the job left behind outlives it: leftovers are stopped when the main script exits", async () => {
    const j = remoteJob("sleep 30 & echo $! > child.pid\nexit 0\n", { resources: { walltime: "00:05:00" } });
    await startJob(j);
    expect(await until(() => statusOf(j), (x) => x.state !== "running")).toMatchObject({ state: "completed" });
    const child = Number(await readFile(join(j.dir, "child.pid"), "utf8"));
    expect(await until(async () => alive(child), (a) => !a, 3_000)).toBe(false);
  });

  it("cancel uses the ids recorded at launch, not the job-writable pid file", async () => {
    // A sacrificial process in its own group: if cancel trusted .cairn/pid, it would be the one killed.
    const victim = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    try {
      const j = remoteJob("sleep 1\ncat forged.pid > .cairn/pid\ncat forged.pid > .cairn/runner.pid\nsleep 30\n", { resources: { walltime: "00:05:00" }, extra: [{ path: "forged.pid", content: Buffer.from(String(victim.pid)) }] });
      const { id } = await startJob(j);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await readFile(join(j.dir, ".cairn/pid"), "utf8")).trim()).toBe(String(victim.pid));
      await runner.cancel(j, id);
      expect(await until(() => statusOf(j), (x) => x.state !== "running")).toMatchObject({ state: "cancelled" });
      expect(alive(victim.pid!)).toBe(true);
    } finally {
      victim.kill("SIGKILL");
    }
  });

  it("cancel stops the job and its children", async () => {
    const j = remoteJob("sleep 30 & echo $! > child.pid\nwait\n", { resources: { walltime: "00:05:00" } });
    const { id } = await startJob(j);
    await until(async () => stat(join(j.dir, "child.pid")).then(() => true, () => false), Boolean);
    await runner.cancel(j, id);
    expect(await until(() => statusOf(j), (x) => x.state !== "running")).toMatchObject({ state: "cancelled" });
    const child = Number(await readFile(join(j.dir, "child.pid"), "utf8"));
    expect(await until(async () => alive(child), (a) => !a, 3_000)).toBe(false);
  });

  it("status of a vanished job directory is lost", async () => {
    const j = remoteJob("true\n");
    expect(await statusOf(j)).toMatchObject({ state: "lost", detail: "job directory is gone" });
  });
});

describe("parsers", () => {
  it("workstation status", () => {
    expect(parseWorkstationStatus({ exit: "0", finished: "t" }).state).toBe("completed");
    expect(parseWorkstationStatus({ exit: "143", killed: "cancelled" }).state).toBe("cancelled");
    expect(parseWorkstationStatus({ exit: "", alive: "1", started: "t" }).state).toBe("running");
    // The exit file is job-writable: while the runner lives, the job is running whatever the file says.
    expect(parseWorkstationStatus({ exit: "0", alive: "1" }).state).toBe("running");
    expect(parseWorkstationStatus({ exit: "", alive: "0" }).state).toBe("lost");
    expect(parseWorkstationStatus({ dir: "unreadable" }).state).toBe("unknown");
  });

  it("Slurm rejections in both formats (spike 4 F3) and status mapping", () => {
    expect(parseRejection("sbatch: error: Batch job submission failed: Invalid account or account/partition combination specified")).toBe(
      "Invalid account or account/partition combination specified",
    );
    expect(parseRejection("allocation failure: More processors requested than permitted")).toBe("More processors requested than permitted");
    const q = (squeue: string, more: Record<string, string> = {}) => parseSlurmStatus({ squeue_rc: "0", squeue, ...more });
    expect(q("PENDING").state).toBe("submitted");
    expect(q("RUNNING").state).toBe("running");
    expect(q("COMPLETED").state).toBe("completed");
    expect(q("TIMEOUT").state).toBe("failed");
    expect(q("SOMETHING_NEW").state).toBe("unknown");
    expect(q("", { sacct_rc: "0", sacct: "COMPLETED|0:0" }).state).toBe("completed");
    expect(q("", { sacct_rc: "0", sacct: "CANCELLED by 1000|0:15" }).state).toBe("cancelled");
    expect(q("", { sacct_rc: "0", sacct: "TIMEOUT|0:0" })).toEqual({ state: "failed", detail: "sacct: TIMEOUT 0:0" });
    expect(q("", { sacct_rc: "0", sacct: "", exit: "0" }).state).toBe("completed");
    expect(q("", { sacct_rc: "0", sacct: "" }).state).toBe("lost");
    // Scheduler trouble is not evidence the job is gone.
    expect(parseSlurmStatus({ squeue_rc: "1", squeue: "slurm_load_jobs error: Socket timed out on send/recv operation" }).state).toBe("unknown");
    expect(parseSlurmStatus({ squeue_rc: "1", squeue: "slurm_load_jobs error: Invalid job id specified", sacct_rc: "1", sacct: "sacct: error" }).state).toBe("unknown");
    expect(parseSlurmStatus({ squeue_rc: "1", squeue: "slurm_load_jobs error: Invalid job id specified", sacct_rc: "0", sacct: "COMPLETED|0:0" }).state).toBe("completed");
  });
});

describe("SlurmRunner (fake Slurm on PATH)", () => {
  let bin: string;
  let state: string;
  let runner: SlurmRunner;
  const hpc = (): MachineConfig => machine({ scheduler: "slurm", account: "acct1", partitions: ["Orion"], max: { nodes: 8 } });

  beforeAll(async () => {
    bin = join(scratch, "fake-bin");
    state = join(scratch, "fake-slurm");
    await mkdir(bin);
    await mkdir(state);
    const tool = async (name: string, body: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\nS=${shq(state)}\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    };
    await tool(
      "sbatch",
      [
        'if [ "$1" = "--test-only" ]; then',
        '  body=$(cat); echo "$body" > "$S/test-only.sbatch"',
        '  case "$body" in *"--nodes=9"*) echo "allocation failure: More processors requested than permitted" >&2; exit 1 ;; esac',
        '  echo "sbatch: Job 4242 to start at 2026-10-14T03:00:00 using 4 processors on nodes n01 in partition Orion" >&2; exit 0',
        "fi",
        'id=$(( $(cat "$S/next" 2>/dev/null || echo 100) + 1 )); echo "$id" > "$S/next"; cp "$2" "$S/$id.sbatch"; pwd > "$S/$id.cwd"',
        'name=$(sed -n "s/^#SBATCH --job-name=//p" "$2"); echo "$id" > "$S/name-$name"',
        'echo PENDING > "$S/$id.squeue"; echo "$id;cluster"',
      ].join("\n"),
    );
    await tool(
      "squeue",
      [
        'if [ -e "$S/squeue.fail" ]; then echo "slurm_load_jobs error: Socket timed out on send/recv operation" >&2; exit 1; fi',
        'if [ "$2" = "-n" ]; then cat "$S/name-$3" 2>/dev/null; exit 0; fi',
        'cat "$S/$3.squeue" 2>/dev/null; exit 0',
      ].join("\n"),
    );
    await tool("sacct", 'cat "$S/$5.sacct" 2>/dev/null; exit 0');
    await tool("scancel", 'rm -f "$S/$1.squeue"; echo "CANCELLED by 1000|0:15" > "$S/$1.sacct"');
    runner = new SlurmRunner(new LocalTransport({ ...process.env, PATH: `${bin}:${process.env.PATH}` }));
  });

  it("writes the #SBATCH header from job.json and machines.yaml (fixed account, allowed partition)", () => {
    const j = remoteJob("srun ./sim\n", { m: hpc(), resources: { nodes: 2, cores: 8, tasks_per_node: 4, gpus: 1, memory_gb: 1.5, walltime: "01:30:00" } });
    const s = sbatchScript(j);
    expect(s.split("\n").filter((l) => l.startsWith("#SBATCH"))).toEqual([
      `#SBATCH --job-name=cairn-${j.id}`,
      "#SBATCH --account=acct1",
      "#SBATCH --partition=Orion",
      "#SBATCH --nodes=2",
      "#SBATCH --ntasks-per-node=4",
      "#SBATCH --cpus-per-task=2",
      "#SBATCH --gres=gpu:1",
      "#SBATCH --mem=1536M",
      "#SBATCH --time=01:30:00",
      `#SBATCH --chdir=${j.dir}`,
      `#SBATCH --output=${j.dir}/.cairn/stdout.log`,
      `#SBATCH --error=${j.dir}/.cairn/stderr.log`,
    ]);
  });

  it("pre-flight: --test-only estimate, or Slurm's refusal; nothing uploaded", async () => {
    const ok = await runner.preflight(remoteJob("true\n", { m: hpc() }));
    expect(ok).toMatchObject({ ok: true, detail: "would start 2026-10-14T03:00:00 on n01 (4 processors, partition Orion); nothing was queued" });
    const big = remoteJob("true\n", { m: hpc(), resources: { nodes: 9 } });
    expect(await runner.preflight(big)).toMatchObject({ ok: false, detail: "Slurm refused: More processors requested than permitted" });
    expect(await stat(big.dir).then(() => true, () => false)).toBe(false);
  });

  it("start uploads and submits from the job dir; status follows squeue then sacct; cancel uses scancel", async () => {
    const j = remoteJob("echo hi > results.csv\n", { m: hpc() });
    const { id } = await runner.start(j);
    expect(id).toBe("101");
    expect((await readFile(join(state, "101.cwd"), "utf8")).trim()).toBe(j.dir);
    expect(await runner.status(j, id)).toMatchObject({ state: "submitted" });
    await writeFile(join(state, "101.squeue"), "RUNNING\n");
    expect(await runner.status(j, id)).toMatchObject({ state: "running" });
    await rm(join(state, "101.squeue"));
    await writeFile(join(state, "101.sacct"), "COMPLETED|0:0\n");
    expect(await runner.status(j, id)).toMatchObject({ state: "completed" });
    // The generated batch script runs the job and records its exit code.
    execFileSync("bash", [".cairn/job.sbatch"], { cwd: j.dir });
    expect((await readFile(join(j.dir, ".cairn/exit"), "utf8")).trim()).toBe("0");
    expect((await runner.fetch(j)).files.map((f) => f.content.toString())).toEqual(["hi\n"]);

    const k = remoteJob("sleep 100\n", { m: hpc() });
    const { id: kid } = await runner.start(k);
    expect(await runner.find(k)).toEqual({ id: kid, raw: expect.any(String) });
    expect(await runner.find({ ...k, id: "20261014-0300-ffff" })).toBeUndefined();
    await writeFile(join(state, "squeue.fail"), "");
    expect(await runner.status(k, kid)).toMatchObject({ state: "unknown", detail: expect.stringMatching(/^squeue failed: .*Socket timed out/) });
    await rm(join(state, "squeue.fail"));
    await runner.cancel(k, kid);
    expect(await runner.status(k, kid)).toMatchObject({ state: "cancelled" });
    await expect(runner.status(k, "1; rm -rf ~")).rejects.toThrow(/Slurm job id/);
  });
});
