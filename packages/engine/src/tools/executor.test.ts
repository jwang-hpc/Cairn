import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorEndpoint, type ExecutorSession, JobService, LocalTransport } from "@cairn/executor";
import { McpClient, McpHttpError, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliRunner } from "@cairn/launcher";
import { agentToolName, connectExecutorTools, sandboxExperimentReader } from "./executor.js";

let root: string;
let home: string;
let service: JobService;
let written: string[];

const session = (over: Partial<ExecutorSession> = {}): ExecutorSession => ({
  project: "p",
  worktree: join(root, "wt"),
  branch: "agent/coder-1",
  agent: { run: "run-1", agent: "coder-1", role: "coder", model: "m1", effort: "low" },
  tools: ["jobs.submit", "jobs.status"],
  ...over,
});

async function connect(s: ExecutorSession, token: string, opts: { url?: string; header?: string } = {}) {
  const endpoint = createExecutorEndpoint({ service, session: s, token });
  const client = new McpClient({ name: "test", version: "0" });
  await client.connect(
    new StreamableHttpTransport({
      url: opts.url ?? "http://127.0.0.1/mcp",
      headers: opts.header === undefined ? { authorization: `Bearer ${token}` } : opts.header ? { authorization: opts.header } : {},
      fetch: (i, init) => endpoint.fetch(i, init),
    }),
  );
  return client;
}
const text = (r: { content: unknown[] }) => (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
const audit = async () => (await readFile(join(home, "audit.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-exec-tools-"));
  home = join(root, "home");
  await mkdir(join(root, "wt/experiments/EXP-001"), { recursive: true });
  await writeFile(join(root, "wt/experiments/EXP-001/run.sh"), "echo 42 > results.csv\n");
  await writeFile(join(root, "wt/experiments/EXP-001/job.json"), JSON.stringify({ script: "run.sh", resources: { cores: 1, walltime: "00:01:00" }, outputs: ["results.csv"] }));
  written = [];
  service = new JobService({
    home,
    machines: { workstation: { host: "workstation", scheduler: "none", scratch: join(root, "scratch"), max: { cores: 4 } } },
    transport: () => new LocalTransport(),
    ledger: async () => ({ write: async (_j, _p, summary, ev = []) => void written.push(summary, ...ev.map((e) => e.path)) }),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("executor tools over MCP (DR-0004 seam 4, DR-0005 escape seeds)", () => {
  it("wraps only the role's tools, with provider-safe names and the machine list in the description", async () => {
    const ex = await connectExecutorTools(service, session());
    try {
      expect(ex.tools.map((t) => t.name)).toEqual(["mcp_jobs_submit", "mcp_jobs_status"]);
      expect([...ex.names]).toEqual([["mcp_jobs_submit", "jobs.submit"], ["mcp_jobs_status", "jobs.status"]]);
      expect(ex.tools[0]!.description).toContain("- workstation: workstation, no scheduler; 1 node, ≤ 4 cores/node");
      const r = await ex.tools[0]!.execute("c1", { experiment: "EXP-001", target: "workstation" }, undefined, undefined);
      expect(JSON.stringify(r.content)).toMatch(/pending_approval \(EXP-001 on workstation\)/);
      await expect(ex.tools[0]!.execute("c2", { experiment: "EXP-404", target: "workstation" }, undefined, undefined)).rejects.toThrow(/no experiments\/EXP-404\//);
    } finally {
      await ex.close();
    }
    expect(agentToolName("jobs.fetch_results")).toBe("mcp_jobs_fetch_results");
  });

  it("no token, a wrong token, or a foreign Host never reaches MCP, and each attempt is audited", async () => {
    const token = randomBytes(32).toString("base64url");
    await expect(connect(session(), token, { header: "" })).rejects.toMatchObject({ status: 401 });
    await expect(connect(session(), token, { header: `Bearer ${randomBytes(32).toString("base64url")}` })).rejects.toBeInstanceOf(McpHttpError);
    await expect(connect(session(), token, { url: "http://attacker.example/mcp" })).rejects.toMatchObject({ status: 403 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await audit()).map((a) => `${a.actor} ${a.ok} ${String(a.detail).split(" (")[0]}`)).toEqual([
      "http false 401 missing bearer token",
      "http false 401 invalid bearer token",
      "http false 403 host not allowed: attacker.example",
    ]);
    expect(JSON.stringify(await audit())).not.toContain(token);
  });

  it("a tool outside the role's list is refused and audited; jobs of other projects are invisible", async () => {
    const token = randomBytes(32).toString("base64url");
    const client = await connect(session(), token);
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual(["jobs.submit", "jobs.status"]);
      const denied = await client.callTool("jobs.cancel", { job_id: "20261014-0000-beef" });
      expect(denied).toMatchObject({ isError: true });
      expect(text(denied)).toBe("jobs.cancel is not available to the coder role");
      const submitted = await client.callTool("jobs.submit", { experiment: "EXP-001", target: "workstation" });
      const id = /job (\S+): pending_approval/.exec(text(submitted))![1]!;
      const other = await connect(session({ project: "q" }), token);
      const seen = await other.callTool("jobs.status", { job_id: id });
      expect(seen).toMatchObject({ isError: true });
      expect(text(seen)).toBe(`no job ${id} in project q`);
      expect(text(await other.callTool("jobs.status", {}))).toBe("No jobs in this project yet.");
      await other.close();
    } finally {
      await client.close();
    }
    expect((await audit()).filter((a) => a.action === "tool jobs.cancel")).toMatchObject([{ actor: "agent:coder-1", ok: false, detail: "not allowed for role coder" }]);
  });

  it("agent flow: submit → (user approves out-of-band) → status → fetch_results into evidence/raw/", async () => {
    const token = randomBytes(32).toString("base64url");
    const coder = await connect(session(), token);
    const analysis = await connect(session({ agent: { run: "run-2", agent: "analysis-1", role: "analysis", model: "m1", effort: "low" }, tools: ["jobs.fetch_results"] }), token);
    try {
      const id = /job (\S+): pending_approval/.exec(text(await coder.callTool("jobs.submit", { experiment: "EXP-001", target: "workstation" })))![1]!;
      expect(text(await analysis.callTool("jobs.fetch_results", { experiment: "EXP-001" }))).toMatch(/no finished job for EXP-001/);
      await service.approve(id, "ok");
      let status = "";
      for (let i = 0; i < 100 && !/completed/.test(status); i++) {
        status = text(await coder.callTool("jobs.status", { job_id: id }));
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toContain(`job ${id}: completed (EXP-001 on workstation)`);
      const fetched = text(await analysis.callTool("jobs.fetch_results", { experiment: "EXP-001" }));
      expect(fetched).toContain(`Results fetched into evidence/raw/EXP-001/${id}/: results.csv.`);
      expect(written).toContain(`evidence/raw/EXP-001/${id}/results.csv`);
    } finally {
      await coder.close();
      await analysis.close();
    }
  });
});

describe("sandboxExperimentReader (jobs.submit reads inside the agent's sandbox)", () => {
  // Stand-in for container exec: python on the host with /work mapped to the worktree.
  const exec = (wt: string) => (command: readonly string[], o: { input?: string; timeoutMs?: number; maxOutputBytes?: number } = {}) =>
    cliRunner("/usr/bin/python3").run(command.slice(1), { ...o, ...(o.input ? { input: o.input.replaceAll("/work", wt) } : {}) });

  it("returns regular files; refuses symlinks, symlinked dirs, and names that aren't experiment names", async () => {
    const wt = join(root, "wt");
    await mkdir(join(wt, "experiments/EXP-001/lib"), { recursive: true });
    await writeFile(join(wt, "experiments/EXP-001/lib/util.py"), "x = 1\n");
    const read = sandboxExperimentReader(exec(wt));
    expect((await read("EXP-001")).map((f) => [f.path, f.content.toString()]).sort()).toEqual([
      ["job.json", expect.any(String)],
      ["lib/util.py", "x = 1\n"],
      ["run.sh", "echo 42 > results.csv\n"],
    ]);
    await symlink("/etc/hosts", join(wt, "experiments/EXP-001/hosts"));
    await expect(read("EXP-001")).rejects.toThrow("experiments/EXP-001/hosts is a symlink; job files must be regular files");
    await mkdir(join(wt, "experiments/EXP-002"));
    await symlink("/etc", join(wt, "experiments/EXP-002/etc"));
    await expect(read("EXP-002")).rejects.toThrow("experiments/EXP-002/etc is a symlink");
    await symlink("/etc", join(wt, "experiments/EXP-003"));
    await expect(read("EXP-003")).rejects.toThrow("experiments/EXP-003 is not a directory (symlinks are not followed)");
    await expect(read("../../etc")).rejects.toThrow(/must be a name like EXP-001/);
  });
});
