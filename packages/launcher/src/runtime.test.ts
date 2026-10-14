import type { RolesConfig } from "@cairn/shared";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROXY_PORT } from "./sandbox.js";
import { AGENT_NET_POOL, agentGateway, agentSubnet, type CommandRunner, ContainerRuntime, cliRunner, type RunResult, RuntimeError } from "./runtime.js";
import { specForRole } from "./policy.js";

const ok = (stdout = "", code = 0): RunResult => ({ code, stdout, stderr: code ? "boom" : "", truncated: false, timedOut: false, durationMs: 1 });

function fake(responses: Record<string, RunResult> = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(args) {
      calls.push([...args]);
      const key = Object.keys(responses).find((k) => args.join(" ").startsWith(k));
      return key ? responses[key]! : ok();
    },
  };
  return { runner, calls };
}

const netJson = (mode: string, n = 240) =>
  JSON.stringify([{ configuration: { mode }, status: { ipv4Gateway: `192.168.${n}.1`, ipv4Subnet: `192.168.${n}.0/24` } }]);

describe("ContainerRuntime (fake runner)", () => {
  it("creates a host-only network in the agent pool (fixed for the pf anchor) and returns its gateway", async () => {
    const f = fake({ "network inspect": ok(netJson("hostOnly")) });
    const net = await new ContainerRuntime(f.runner).createInternalNetwork("cairn-net-a1");
    expect(net).toEqual({ name: "cairn-net-a1", gateway: "192.168.240.1", subnet: "192.168.240.0/24" });
    expect(f.calls[0]).toEqual(["network", "create", "--internal", "--subnet", "192.168.240.0/24", "cairn-net-a1"]);
  });

  it("takes the next free /24 when one is in use, and refuses a network that came up elsewhere", async () => {
    const f = fake({ "network create --internal --subnet 192.168.240.0/24": ok("", 1), "network inspect": ok(netJson("hostOnly", 241)) });
    expect((await new ContainerRuntime(f.runner).createInternalNetwork("cairn-net-a2")).gateway).toBe("192.168.241.1");
    const g = fake({ "network inspect": ok(netJson("hostOnly", 128)) });
    await expect(new ContainerRuntime(g.runner).createInternalNetwork("cairn-net-a3")).rejects.toThrow(/came up as 192.168.128.0\/24/);
    expect(g.calls.at(-1)).toEqual(["network", "delete", "cairn-net-a3"]);
    const full = fake({ "network create": ok("", 1) });
    await expect(new ContainerRuntime(full.runner).createInternalNetwork("cairn-net-a4")).rejects.toThrow(/failed for every subnet in the agent pool 192.168.240.0\/20/);
    expect(full.calls).toHaveLength(16);
  });

  it("deletes and refuses a network that came up with internet access", async () => {
    const f = fake({ "network inspect": ok(netJson("nat")) });
    await expect(new ContainerRuntime(f.runner).createInternalNetwork("cairn-net-a1")).rejects.toThrow("is nat, expected hostOnly");
    expect(f.calls.at(-1)).toEqual(["network", "delete", "cairn-net-a1"]);
  });

  it("only runs allowlisted argv and surfaces failures with the CLI's message", async () => {
    const roles: RolesConfig = { roles: { r: { mounts: { read: ["logic/"], write: [] }, network: [], executor_tools: [] } }, defaults: { secrets: "none", egress: "deny" } };
    const spec = specForRole({ agentId: "a1", role: "r", roles, worktree: "/w", skillsDir: "/s", outboxDir: "/o", image: "img", network: "cairn-net-a1" });
    const f = fake({ run: ok("", 1) });
    const rt = new ContainerRuntime(f.runner);
    await expect(rt.start(spec, { roots: ["/w", "/s", "/o"], network: "cairn-net-a1" })).rejects.toThrow(RuntimeError);
    expect(f.calls[0]!.slice(0, 2)).toEqual(["run", "-d"]);
    await expect(rt.start(spec, { roots: ["/elsewhere"], network: "cairn-net-a1" })).rejects.toThrow(/outside allowed roots/);
    expect(f.calls).toHaveLength(1); // the unsafe start never reached the CLI
  });

  it("exec builds a confined argv and returns non-zero exits as results", async () => {
    const f = fake({ exec: ok("", 7) });
    const r = await new ContainerRuntime(f.runner).exec("cairn-a1", ["sh", "-c", "exit 7"], { workdir: "/work/src" });
    expect(r.code).toBe(7);
    expect(f.calls[0]).toEqual(["exec", "-i", "--user", "1000:1000", "-w", "/work/src", "cairn-a1", "sh", "-c", "exit 7"]);
  });

  it("remove is force-delete and never throws (cleanup must always run)", async () => {
    const f = fake({ delete: ok("", 1) });
    await expect(new ContainerRuntime(f.runner).remove("cairn-a1")).resolves.toBeUndefined();
    expect(f.calls[0]).toEqual(["delete", "--force", "cairn-a1"]);
  });
});

describe("cliRunner (real process, /bin/sh standing in for the CLI)", () => {
  const sh = cliRunner("/bin/sh");
  it("captures stdout, stderr, exit code, and stdin", async () => {
    expect(await sh.run(["-c", "cat; echo err >&2; exit 3"], { input: "abc" })).toMatchObject({ code: 3, stdout: "abc", stderr: "err\n", timedOut: false });
  });
  it("kills on timeout", async () => {
    const r = await sh.run(["-c", "sleep 5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(3000);
  });
  it("caps output", async () => {
    const r = await sh.run(["-c", "head -c 100000 /dev/zero | tr '\\0' x"], { maxOutputBytes: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });
  it("reports a missing binary as exit 127", async () => {
    expect((await cliRunner("/nonexistent/container").run(["list"])).code).toBe(127);
  });
});

describe("agent network pool and the pf anchor (open question 12)", () => {
  it("scripts/pf-agents.sh lets each pool subnet reach only its own gateway's proxy, and blocks the rest of the pool", () => {
    const script = fileURLToPath(new URL("../../../scripts/pf-agents.sh", import.meta.url));
    const rules = execFileSync("sh", [script, "rules"], { encoding: "utf8" }).trim().split("\n").filter((l) => !l.startsWith("#"));
    const expected = Array.from({ length: AGENT_NET_POOL.count }, (_, i) =>
      `pass in quick inet proto tcp from ${agentSubnet(i)} to ${agentGateway(i)} port ${PROXY_PORT} flags S/SA keep state`,
    );
    expect(rules).toEqual([...expected, `block return in quick inet from ${AGENT_NET_POOL.cidr} to any`]);
  });
});
