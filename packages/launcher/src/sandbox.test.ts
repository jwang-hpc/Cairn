import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RolesConfig } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchSandbox, PROXY_PORT } from "./sandbox.js";
import { type CommandRunner, ContainerRuntime, type RunResult } from "./runtime.js";

const ok = (stdout = "", code = 0): RunResult => ({ code, stdout, stderr: code ? "boom" : "", truncated: false, timedOut: false, durationMs: 1 });
const netJson = JSON.stringify([{ configuration: { mode: "hostOnly" }, status: { ipv4Gateway: "192.168.130.1", ipv4Subnet: "192.168.130.0/24" } }]);

const roles: RolesConfig = {
  roles: {
    analysis: { mounts: { read: ["logic/"], write: ["analysis/"] }, network: [], executor_tools: [] },
    coder: { mounts: { read: [], write: ["src/"] }, network: ["pypi.org"], executor_tools: [] },
  },
  defaults: { secrets: "none", egress: "deny" },
};

let base: string;
let calls: string[][];
let failOn: string | undefined;
const runner: CommandRunner = {
  async run(args) {
    calls.push([...args]);
    if (failOn && args[0] === failOn) return ok("", 1);
    return args[0] === "network" && args[1] === "inspect" ? ok(netJson) : ok();
  },
};
const request = (role: string) => ({
  agentId: "s1", role, roles, worktree: join(base, "wt"), skillsDir: join(base, "skills"), outboxDir: join(base, "outbox", "s1"), image: "cairn-agent:dev",
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-sbx-"));
  await mkdir(join(base, "wt", "logic"), { recursive: true });
  await mkdir(join(base, "skills"), { recursive: true });
  calls = [];
  failOn = undefined;
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("launchSandbox", () => {
  it("network -> container; no proxy for a role without egress; close tears down in order", async () => {
    let proxies = 0;
    const sb = await launchSandbox({ runtime: new ContainerRuntime(runner), request: request("analysis"), createProxy: () => (proxies++, { listen: async () => {}, close: async () => {} }) });
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["network create", "network inspect", "run -d"]);
    expect(proxies).toBe(0);
    expect(sb.spec.env.HTTPS_PROXY).toBeUndefined();
    await sb.exec(["true"]);
    await sb.close();
    await sb.close(); // idempotent
    expect(calls.slice(-2)).toEqual([["delete", "--force", "cairn-s1"], ["network", "delete", "cairn-net-s1"]]);
  });

  it("starts the proxy on the gateway after the container, with the role's allowlist", async () => {
    const seen: { allow?: readonly string[]; host?: string; port?: number; closed?: boolean } = {};
    const sb = await launchSandbox({
      runtime: new ContainerRuntime(runner),
      request: request("coder"),
      createProxy: (allow) => {
        seen.allow = allow;
        return { listen: async (host, port) => Object.assign(seen, { host, port }), close: async () => void (seen.closed = true) };
      },
    });
    expect(seen).toMatchObject({ allow: ["pypi.org"], host: "192.168.130.1", port: PROXY_PORT });
    expect(sb.spec.env.HTTPS_PROXY).toBe(`http://192.168.130.1:${PROXY_PORT}`);
    await sb.close();
    expect(seen.closed).toBe(true);
  });

  it("cleans up the network if the container fails to start", async () => {
    failOn = "run";
    await expect(launchSandbox({ runtime: new ContainerRuntime(runner), request: request("analysis") })).rejects.toThrow(/run cairn-s1 failed/);
    expect(calls.at(-1)).toEqual(["network", "delete", "cairn-net-s1"]);
    expect(calls.some((c) => c[0] === "delete")).toBe(false); // never started, nothing to delete
  });

  it("cleans up container and network if the proxy can't bind", async () => {
    await expect(
      launchSandbox({
        runtime: new ContainerRuntime(runner),
        request: request("coder"),
        createProxy: () => ({ listen: async () => { throw new Error("EADDRINUSE"); }, close: async () => {} }),
      }),
    ).rejects.toThrow("EADDRINUSE");
    expect(calls.slice(-2)).toEqual([["delete", "--force", "cairn-s1"], ["network", "delete", "cairn-net-s1"]]);
  });

  it("refuses an unknown role before touching the host", async () => {
    await expect(launchSandbox({ runtime: new ContainerRuntime(runner), request: request("root") })).rejects.toThrow("unknown role");
    expect(calls).toEqual([]);
  });
});
