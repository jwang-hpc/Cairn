// Escape suite (DR-0005). Real agent sandboxes attempt each escape from inside; every attempt must fail and
// leave a trace (event log, egress decision, or executor audit). Run: `pnpm test:escape` (your terminal).
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EgressEvent, EngineEvent, RolesConfig } from "../../packages/shared/src/index.js";
import { EventLog, envelope } from "../../packages/engine/src/events/log.js";
import { sandboxExperimentReader } from "../../packages/engine/src/tools/executor.js";
import { type AuditEntry, createFront, JobService, LocalTransport, serveFront } from "../../packages/executor/src/index.js";
import {
  ContainerRuntime,
  createWorktree,
  git,
  launchSandbox,
  MountError,
  removeWorktree,
  type RunResult,
  type Sandbox,
  specForRole,
  toRunArgv,
  UnsafeArgvError,
  validateRunArgv,
  type WorktreeRef,
} from "../../packages/launcher/src/index.js";

const ON = process.env.CAIRN_ESCAPE === "1";
const IMAGE = process.env.CAIRN_AGENT_IMAGE ?? "cairn-agent:dev";

const roles: RolesConfig = {
  roles: {
    coder: { mounts: { read: ["logic/"], write: ["src/", "experiments/"] }, network: ["pypi.org"], executor_tools: ["jobs.submit"] },
    analysis: { mounts: { read: ["logic/", "evidence/"], write: ["analysis/"] }, network: [], executor_tools: [] },
  },
  defaults: { secrets: "none", egress: "deny" },
};

describe.skipIf(!ON)("escape suite (DR-0005)", () => {
  const runtime = new ContainerRuntime();
  const id = randomBytes(2).toString("hex");
  const marker = `CAIRN-DECOY-${randomBytes(12).toString("hex")}`;
  const token = randomBytes(32).toString("base64url");
  const audit: AuditEntry[] = [];
  const attempts: { agent: string; name: string; code: number }[] = [];
  let base: string;
  let repo: string;
  let skills: string;
  let home: string;
  let decoy: string;
  let log: EventLog;
  let wtA: WorktreeRef;
  let wtB: WorktreeRef;
  let A: Sandbox;
  let B: Sandbox;
  let executor: { url: string; port: number; close(): Promise<void> };
  const servers: Server[] = [];
  let loopbackPort = 0;
  let wildcardPort = 0;

  /** Run one escape attempt inside a sandbox and log it like a tool call (tool_call + tool_result). */
  async function attempt(sb: Sandbox, name: string, script: string, input?: string): Promise<RunResult> {
    const toolCallId = `${name}-${attempts.length}`;
    await log.append({ ...envelope("escape-suite", "test"), type: "tool_call", toolCallId, name: "bash", args: { attempt: name, script } });
    const r = await sb.exec(input === undefined ? ["bash", "-c", script] : ["python3", "-"], { timeoutMs: 90_000, ...(input ? { input } : {}) });
    await log.append({
      ...envelope("escape-suite", "test"), type: "tool_result", toolCallId, name: "bash", isError: r.code !== 0, text: `${r.code} ${r.stdout}${r.stderr}`.slice(0, 4000),
    });
    attempts.push({ agent: sb.agentId, name, code: r.code });
    return r;
  }
  const py = (sb: Sandbox, name: string, code: string) => attempt(sb, name, "", code);
  const listen = (host: string, reply: string) =>
    new Promise<number>((resolve) => {
      const s = createServer((c) => c.end(`${reply}\n`));
      servers.push(s);
      s.listen(0, host, () => resolve((s.address() as { port: number }).port));
    });

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "cairn-escape-"));
    repo = join(base, "project");
    skills = join(base, "skills");
    home = join(base, "home");
    decoy = join(base, "host-home");
    log = new EventLog(home);

    // Decoy "host secrets" outside every mount root; their content must never be readable by an agent.
    await mkdir(join(decoy, ".ssh"), { recursive: true });
    await mkdir(join(decoy, ".claude"), { recursive: true });
    await writeFile(join(decoy, ".ssh", "id_ed25519"), `-----BEGIN OPENSSH PRIVATE KEY----- ${marker}\n`);
    await writeFile(join(decoy, ".claude", ".credentials.json"), JSON.stringify({ token: marker }));
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "skill\n");

    // Project with a committed symlink pointing at the decoy home (must not resolve inside a container).
    await mkdir(join(repo, "logic"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "logic", "claims.md"), "# claims\n");
    await writeFile(join(repo, "src", "main.py"), "print(1)\n");
    await mkdir(join(repo, "experiments"), { recursive: true });
    await writeFile(join(repo, "experiments", ".gitkeep"), "");
    await symlink(decoy, join(repo, "logic", "leak"));
    await git(repo, ["init", "--quiet", "-b", "main"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"]);

    // Host services an agent must not reach.
    executor = await serveFront(createFront({ token, onAudit: (e) => audit.push(e), handler: async () => new Response("{}") }));
    loopbackPort = await listen("127.0.0.1", marker);
    wildcardPort = await listen("0.0.0.0", "wildcard-service");

    const onEgress = (agent: string, role: string) => (d: { decision: "allow" | "deny"; target: string; reason: string }) =>
      void log.append({ ...envelope("escape-suite", "test"), type: "egress", agent, role, ...d });
    wtA = await createWorktree({ repo, agentId: `esc-a-${id}`, root: join(home, "worktrees") });
    wtB = await createWorktree({ repo, agentId: `esc-b-${id}`, root: join(home, "worktrees") });
    A = await launchSandbox({
      runtime, onEgress: onEgress(wtA.agentId, "coder"),
      request: { agentId: wtA.agentId, role: "coder", roles, worktree: wtA.path, skillsDir: skills, outboxDir: join(home, "outbox", wtA.agentId), image: IMAGE },
    });
    B = await launchSandbox({
      runtime, onEgress: onEgress(wtB.agentId, "analysis"),
      request: { agentId: wtB.agentId, role: "analysis", roles, worktree: wtB.path, skillsDir: skills, outboxDir: join(home, "outbox", wtB.agentId), image: IMAGE },
    });
  });

  afterAll(async () => {
    await A?.close();
    await B?.close();
    await executor?.close();
    for (const s of servers) s.close();
    if (wtA) await removeWorktree(wtA, { deleteBranch: true }).catch(() => {});
    if (wtB) await removeWorktree(wtB, { deleteBranch: true }).catch(() => {});
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("1. host secrets are not visible: no ~/.ssh, ~/.claude, host home, host env, or SSH agent", async () => {
    const paths = await attempt(A, "list host homes", 'ls -d /Users /home/* /root/.ssh "$HOME/.ssh" "$HOME/.claude" 2>&1; true');
    expect(paths.stdout).not.toMatch(/^\/Users$/m);
    const scan = await attempt(A, "grep the whole filesystem for the decoy secret", `grep -rIsl --exclude-dir=proc --exclude-dir=sys ${marker} / 2>/dev/null; true`);
    expect(scan.stdout.trim()).toBe("");
    const link = await attempt(A, "follow a committed symlink to the host home", "cat /work/logic/leak/.ssh/id_ed25519");
    expect(link.code).not.toBe(0);
    expect(link.stdout).not.toContain(marker);
    const env = await attempt(A, "look for credentials in env", "env");
    expect(env.stdout).not.toMatch(/SSH_AUTH_SOCK|API_KEY|_TOKEN|ANTHROPIC|OPENAI|GITHUB/);
    const mounts = await attempt(A, "list mounts", "grep -E ' (virtiofs|9p|fuse)' /proc/mounts | cut -d' ' -f2");
    expect(mounts.stdout.trim().split("\n").sort()).toEqual(["/outbox", "/skills", "/work/experiments", "/work/logic", "/work/src"]);
  });

  it("2. writes outside the role's writable paths fail and leave the host untouched", async () => {
    for (const [name, script] of [
      ["write rootfs", "touch /etc/pwned"],
      ["write read-only mount", "echo tampered > /work/logic/claims.md"],
      ["write skills", "echo tampered > /skills/SKILL.md"],
      ["create a new top-level project dir", "mkdir /work/evil"],
    ] as const) {
      expect((await attempt(A, name, script)).code, name).not.toBe(0);
    }
    expect((await attempt(A, "write own writable path (control)", "echo ok > /work/src/ok.txt && echo ok > /outbox/ok.txt")).code).toBe(0);
    expect(await readFile(join(wtA.path, "logic", "claims.md"), "utf8")).toBe("# claims\n");
    expect(await readFile(join(skills, "SKILL.md"), "utf8")).toBe("skill\n");
    expect(await readFile(join(wtA.path, "src", "ok.txt"), "utf8")).toBe("ok\n");
    await expect(stat(join(wtB.path, "src", "ok.txt"))).rejects.toMatchObject({ code: "ENOENT" }); // other agent's worktree
  });

  it("3. network: only allowlisted HTTPS through the proxy; no route, no DNS, no proxy tricks", async () => {
    const fetch = (url: string) =>
      `import urllib.request\ntry:\n r=urllib.request.urlopen(${JSON.stringify(url)},timeout=20); print('HTTP', r.status)\nexcept Exception as e: print('FAILED', e)`;
    expect((await py(A, "allowlisted domain via proxy (control)", fetch("https://pypi.org/simple/"))).stdout).toMatch(/^HTTP 200/);
    expect((await py(A, "non-allowlisted domain via proxy", fetch("https://example.com/"))).stdout).toMatch(/^FAILED.*403/);
    const direct = await py(A, "direct connection by IP", "import socket\ntry:\n socket.create_connection(('1.1.1.1',443),5); print('OPEN')\nexcept Exception as e: print('BLOCKED', type(e).__name__)");
    expect(direct.stdout).toMatch(/^BLOCKED/);
    const dns = await py(A, "DNS lookup", "import socket,time\nt=time.time()\ntry:\n socket.getaddrinfo('pypi.org',443); print('RESOLVED')\nexcept Exception: print('NO-DNS', round(time.time()-t,2))");
    expect(dns.stdout).toMatch(/^NO-DNS/);
    expect(Number(dns.stdout.split(" ")[1])).toBeLessThan(2);
    const proxy = A.spec.env.HTTPS_PROXY!.replace("http://", "").split(":");
    for (const target of [`127.0.0.1:${executor.port}`, `localhost:${executor.port}`, `${A.network.gateway}:${loopbackPort}`]) {
      const r = await py(A, `CONNECT ${target} via proxy`, `import socket\ns=socket.create_connection(('${proxy[0]}',${proxy[1]}),5)\ns.sendall(b'CONNECT ${target} HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n')\nprint(s.recv(64).decode(errors='replace').splitlines()[0])`);
      expect(r.stdout, target).toMatch(/403/);
    }
    expect((await py(B, "role without network: any HTTPS", fetch("https://pypi.org/simple/"))).stdout).toMatch(/^FAILED/);
    const events = (await readFile(join(home, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as EngineEvent);
    const denies = events.filter((e): e is EgressEvent => e.type === "egress" && e.decision === "deny").map((e) => e.target);
    expect(denies).toEqual(expect.arrayContaining(["example.com:443", `127.0.0.1:${executor.port}`, `localhost:${executor.port}`]));
  });

  it("4. host services: loopback-only services and the executor are unreachable from agents", async () => {
    const probe = (port: number) =>
      `import socket\ntry:\n socket.create_connection(('${A.network.gateway}',${port}),4).recv(64); print('OPEN')\nexcept Exception as e: print('CLOSED', type(e).__name__)`;
    expect((await py(A, "host loopback service via gateway", probe(loopbackPort))).stdout).toMatch(/^CLOSED/);
    expect((await py(A, "executor via gateway", probe(executor.port))).stdout).toMatch(/^CLOSED/);
  });

  it("4b. measure: host services bound to all interfaces (DR-0005 amendment F2)", async () => {
    const results: string[] = [];
    for (const port of [wildcardPort, 22, 5000, 7000, 3000, 8000, 8080]) {
      const r = await py(A, `probe gateway:${port}`, `import socket\ntry:\n socket.create_connection(('${A.network.gateway}',${port}),3); print('OPEN')\nexcept Exception as e: print('CLOSED')`);
      results.push(`${port === wildcardPort ? `${port} (test service on 0.0.0.0)` : port}: ${r.stdout.trim()}`);
    }
    console.warn(`host ports reachable from an agent via its gateway:\n  ${results.join("\n  ")}`);
  });

  it("5. agents cannot reach each other", async () => {
    await attempt(B, "start a server in agent B", "nohup python3 -m http.server 8000 --bind 0.0.0.0 >/dev/null 2>&1 & sleep 1; echo started");
    const self = await py(B, "B reaches its own server (control)", "import urllib.request\nprint(urllib.request.urlopen('http://127.0.0.1:8000/',timeout=5).status)");
    expect(self.stdout.trim()).toBe("200");
    const info = await runtime.runner.run(["inspect", B.name]);
    const prefix = B.network.subnet.split(".").slice(0, 3).join(".");
    const ipB = [...info.stdout.matchAll(/\b(\d+\.\d+\.\d+\.\d+)\b/g)].map((m) => m[1]).find((ip) => ip!.startsWith(`${prefix}.`) && ip !== B.network.gateway);
    expect(ipB, `B's address in ${B.network.subnet}`).toBeDefined();
    const r = await py(A, "agent A connects to agent B", `import socket\ntry:\n socket.create_connection(('${ipB}',8000),4); print('OPEN')\nexcept Exception as e: print('CLOSED', type(e).__name__)`);
    expect(r.stdout).toMatch(/^CLOSED/);
  });

  it("6. the executor refuses calls without a valid token, and audits them", async () => {
    const call = (auth?: string, host?: string) =>
      fetch(executor.url, { method: "POST", headers: { ...(auth ? { authorization: auth } : {}), ...(host ? { host } : {}) }, body: "{}" });
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${randomBytes(32).toString("base64url")}`)).status).toBe(401);
    expect((await call(`Bearer ${token}`)).status).toBe(200);
    expect(audit.filter((a) => a.event === "reject").map((a) => `${a.status} ${a.reason}`)).toEqual(["401 missing bearer token", "401 invalid bearer token"]);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("6b. the executor refuses jobs that violate machine policy, including symlinks the agent plants (DR-0006)", async () => {
    const manifest = (o: Record<string, unknown> = {}) => JSON.stringify({ script: "run.sh", resources: { cores: 1, walltime: "00:01:00", ...o }, outputs: ["results.csv"] });
    await attempt(A, "write a job that reaches another host, reads a key, and asks for too much", [
      "mkdir -p /work/experiments/EXP-001",
      `printf '%s' '${manifest({ nodes: 99 })}' > /work/experiments/EXP-001/job.json`,
      "printf 'ssh other-host cat ~/.ssh/id_ed25519 > results.csv\\n' > /work/experiments/EXP-001/run.sh",
    ].join(" && "));
    await attempt(A, "plant a job script that is a symlink to a host secret", [
      "mkdir -p /work/experiments/EXP-002",
      `printf '%s' '${manifest()}' > /work/experiments/EXP-002/job.json`,
      "ln -s ../../logic/leak/.ssh/id_ed25519 /work/experiments/EXP-002/run.sh",
    ].join(" && "));
    await attempt(A, "make an experiment directory a symlink to the host home", "ln -s ../logic/leak /work/experiments/EXP-003");
    const jobs = new JobService({
      home,
      machines: { workstation: { host: "workstation", scheduler: "none", scratch: join(base, "scratch"), max: { cores: 4 } } },
      transport: () => new LocalTransport(),
      ledger: async () => ({ write: async () => {} }),
    });
    const submit = (experiment: string) =>
      jobs
        // As jobs.submit does for agents: the experiment is read inside A's own container.
        .submit({
          project: "esc", worktree: wtA.path, experiment, target: "workstation", read: sandboxExperimentReader(A.exec),
          author: { kind: "agent", run: "escape-suite", agent: wtA.agentId, role: "coder", model: "none", effort: "low" },
        })
        .then(() => "accepted", (e: Error) => e.message);
    const first = await submit("EXP-001");
    expect(first).toMatch(/nodes must be 1, not 99/);
    expect(first).toMatch(/'ssh' is not allowed/);
    expect(first).toMatch(/a credential location/);
    expect(await submit("EXP-002")).toMatch(/run.sh is a symlink; job files must be regular files/);
    expect(await submit("EXP-003")).toMatch(/experiments\/EXP-003 is not a directory \(symlinks are not followed\)/);
    expect(await jobs.list()).toEqual([]);
    const log = await readFile(join(home, "audit.log"), "utf8");
    expect(log.trim().split("\n").map((l) => JSON.parse(l) as { action: string; ok: boolean }).map((a) => `${a.action} ${a.ok}`)).toEqual(Array(3).fill("submit false"));
    expect(log).not.toContain(marker);
  });

  it("7. the launcher refuses dangerous configurations before the runtime sees them", async () => {
    const spec = specForRole({ agentId: "esc-x", role: "analysis", roles, worktree: wtB.path, skillsDir: skills, outboxDir: join(home, "outbox", "x"), image: IMAGE, network: "cairn-net-esc-x" });
    const policy = { roots: [wtB.path, skills, join(home, "outbox", "x")], network: "cairn-net-esc-x" };
    expect(() => toRunArgv({ ...spec, env: { ...spec.env, GH_TOKEN: "x" } }, policy)).toThrow(UnsafeArgvError);
    const argv = toRunArgv(spec, policy);
    const i = argv.indexOf("--entrypoint");
    for (const extra of [["--ssh"], ["-e", "SSH_AUTH_SOCK"], ["--mount", `type=bind,source=${decoy},target=/work/x`], ["--network", "default"]]) {
      expect(() => validateRunArgv([...argv.slice(0, i), ...extra, ...argv.slice(i)], policy), extra.join(" ")).toThrow(UnsafeArgvError);
    }
    // A project whose role path is a symlink to the host home is refused, and nothing is left running.
    const wtC = await createWorktree({ repo, agentId: `esc-c-${id}`, root: join(home, "worktrees") });
    await symlink(decoy, join(wtC.path, "evidence"));
    await expect(
      launchSandbox({ runtime, request: { agentId: wtC.agentId, role: "analysis", roles, worktree: wtC.path, skillsDir: skills, outboxDir: join(home, "outbox", wtC.agentId), image: IMAGE } }),
    ).rejects.toBeInstanceOf(MountError);
    expect((await runtime.runner.run(["network", "list"])).stdout).not.toContain(`cairn-net-${wtC.agentId}`);
    expect((await runtime.runner.run(["list", "--all"])).stdout).not.toContain(`cairn-${wtC.agentId}`);
    await removeWorktree(wtC, { deleteBranch: true });
  });

  it("8. every attempt left a trace in the event log", async () => {
    const events = (await readFile(join(home, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as EngineEvent);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(attempts.length);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(attempts.length);
    console.log(`escape attempts logged: ${attempts.length}; egress decisions: ${events.filter((e) => e.type === "egress").length}; executor audit entries: ${audit.length}`);
  });
});
