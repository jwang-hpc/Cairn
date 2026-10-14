// Integration test against a real Apple `container` runtime. Skipped unless CAIRN_CONTAINER_IT=1.
// Run in your own terminal (the Claude Code sandbox can't reach container-apiserver):
//   CAIRN_CONTAINER_IT=1 pnpm vitest run packages/launcher/src/runtime.it.test.ts
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RolesConfig } from "@cairn/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareMounts } from "./mounts.js";
import { specForRole } from "./policy.js";
import { ContainerRuntime, type NetworkInfo } from "./runtime.js";

const IT = process.env.CAIRN_CONTAINER_IT === "1";
const IMAGE = process.env.CAIRN_AGENT_IMAGE ?? "docker.io/library/python:3.12-slim";

describe.skipIf(!IT)("Apple container integration", () => {
  const rt = new ContainerRuntime();
  const id = `it-${randomBytes(3).toString("hex")}`;
  const name = `cairn-${id}`;
  let base: string;
  let worktree: string;
  let net: NetworkInfo | undefined;
  let started = false;
  const sh = (script: string, input?: string) => rt.exec(name, ["sh", "-c", script], { timeoutMs: 60_000, ...(input ? { input } : {}) });

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "cairn-it-"));
    worktree = join(base, "wt");
    await mkdir(join(worktree, "logic"), { recursive: true });
    await writeFile(join(worktree, "logic", "claims.md"), "read-only claim\n");
    await mkdir(join(base, "skills"), { recursive: true });
    const roles: RolesConfig = {
      roles: { analysis: { mounts: { read: ["logic/"], write: ["analysis/"] }, network: [], executor_tools: [] } },
      defaults: { secrets: "none", egress: "deny" },
    };
    net = await rt.createInternalNetwork(`cairn-net-${id}`);
    const spec = specForRole({
      agentId: id, role: "analysis", roles, worktree, skillsDir: join(base, "skills"), outboxDir: join(base, "outbox", id), image: IMAGE, network: net.name,
    });
    const prepared = await prepareMounts(spec, { worktree, skills: join(base, "skills"), outbox: join(base, "outbox", id) });
    await rt.start(prepared.spec, { roots: prepared.roots, network: net.name });
    started = true;
  }, 600_000);

  afterAll(async () => {
    if (started) await rt.remove(name);
    if (net) await rt.deleteNetwork(net.name).catch(() => {});
    if (base) await rm(base, { recursive: true, force: true });
  }, 120_000);

  it("runs as uid 1000 in /work with a writable HOME on tmpfs", async () => {
    const r = await sh('id -u; pwd; echo ok > "$HOME/probe" && cat "$HOME/probe"');
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1000", "/work", "ok"]);
  });

  it("reads the read-only mount but cannot write it", async () => {
    expect((await sh("cat logic/claims.md")).stdout).toBe("read-only claim\n");
    const w = await sh("echo tampered > logic/claims.md");
    expect(w.code).not.toBe(0);
    expect(await readFile(join(worktree, "logic", "claims.md"), "utf8")).toBe("read-only claim\n");
  });

  it("writes to the writable mount land on the host; the root fs is read-only", async () => {
    expect((await sh("echo result > analysis/out.txt")).code).toBe(0);
    expect(await readFile(join(worktree, "analysis", "out.txt"), "utf8")).toBe("result\n");
    expect((await sh("touch /etc/pwned")).code).not.toBe(0);
  });

  it("pipes stdin and returns exit codes", async () => {
    expect(await sh("cat; exit 7", "via stdin")).toMatchObject({ code: 7, stdout: "via stdin" });
  });

  it("sees no host paths and no host env", async () => {
    const paths = await sh("ls -d /Users /home/* /root/.ssh 2>/dev/null; true");
    expect(paths.stdout).not.toMatch(/\/Users/);
    const env = (await sh("env | cut -d= -f1 | sort")).stdout.split("\n");
    for (const k of ["SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN"]) expect(env).not.toContain(k);
  });

  // Probes wait out their own timeouts, so these need more than vitest's 5 s default.
  it("has no network", async () => {
    const py = "import socket,time\nt=time.time()\ntry:\n socket.create_connection(('1.1.1.1',443),5); print('OPEN')\nexcept Exception as e: print('BLOCKED', type(e).__name__, round(time.time()-t,1))";
    const r = await rt.exec(name, ["python3", "-c", py], { timeoutMs: 30_000 });
    console.log(`network probe: ${r.stdout.trim()}`);
    expect(r.stdout).toMatch(/^BLOCKED/);
  }, 60_000);

  it("has no DNS", async () => {
    const py = "import socket,time\nt=time.time()\ntry:\n socket.getaddrinfo('pypi.org',443); print('RESOLVED')\nexcept Exception as e: print('NO-DNS', type(e).__name__, round(time.time()-t,1))";
    const r = await rt.exec(name, ["python3", "-c", py], { timeoutMs: 45_000 });
    console.log(`dns probe: ${r.stdout.trim()}`);
    expect(r.stdout).toMatch(/^NO-DNS/);
  }, 60_000);
});
