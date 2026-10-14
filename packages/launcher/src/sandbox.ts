// One agent sandbox: own --internal network, hardened container with role mounts, and (only if the role
// allows domains) an egress proxy on the network's gateway. close() always tears everything down.
import type { RolesConfig } from "@cairn/shared";
import { type EgressDecision, EgressProxy } from "./egress.js";
import { prepareMounts } from "./mounts.js";
import { type ContainerSpec, egressFor, type LaunchRequest, type Mount, specForRole } from "./policy.js";
import type { ContainerRuntime, NetworkInfo, RunOptions, RunResult } from "./runtime.js";

/** Fixed: each agent network has its own gateway IP, so ports can't collide. */
export const PROXY_PORT = 3128;

export interface ProxyLike {
  listen(host: string, port: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface SandboxOptions {
  runtime: ContainerRuntime;
  request: Omit<LaunchRequest, "network" | "proxyUrl">;
  onEgress?: (d: EgressDecision) => void;
  /** Injectable for tests (binding the gateway needs a real runtime). */
  createProxy?: (allow: readonly string[], onDecision: (d: EgressDecision) => void) => ProxyLike;
}

export interface Sandbox {
  agentId: string;
  name: string;
  network: NetworkInfo;
  spec: ContainerSpec;
  /** Role mounts dropped because a read-only file didn't exist. */
  skipped: Mount[];
  exec(command: readonly string[], opts?: RunOptions & { workdir?: string }): Promise<RunResult>;
  close(): Promise<void>;
}

export async function launchSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const { runtime, request } = opts;
  const roles: RolesConfig = request.roles;
  const role = roles.roles[request.role];
  // Validate the role before creating anything on the host.
  if (!role) throw new Error(`unknown role '${request.role}'`);
  const { domains } = egressFor(role);

  const network = await runtime.createInternalNetwork(`cairn-net-${request.agentId}`);
  let started = false;
  let proxy: ProxyLike | undefined;
  const name = `cairn-${request.agentId}`;
  const teardown = async () => {
    await proxy?.close().catch(() => {});
    if (started) await runtime.remove(name);
    await runtime.deleteNetwork(network.name).catch(() => {});
  };

  try {
    const proxyUrl = domains.length > 0 ? `http://${network.gateway}:${PROXY_PORT}` : undefined;
    const spec = specForRole({ ...request, network: network.name, ...(proxyUrl ? { proxyUrl } : {}) });
    const prepared = await prepareMounts(spec, { worktree: request.worktree, skills: request.skillsDir, outbox: request.outboxDir });
    await runtime.start(prepared.spec, { roots: prepared.roots, network: network.name });
    started = true;
    if (proxyUrl) {
      // The gateway address is bindable once a container is attached (M0 spike 3), so the proxy starts last.
      const onDecision = opts.onEgress ?? (() => {});
      proxy = opts.createProxy ? opts.createProxy(spec.egressDomains, onDecision) : new EgressProxy({ allow: spec.egressDomains, onDecision });
      await proxy.listen(network.gateway, PROXY_PORT);
    }
    let closed = false;
    return {
      agentId: request.agentId,
      name,
      network,
      spec: prepared.spec,
      skipped: prepared.skipped,
      exec: (command, o) => runtime.exec(name, command, o),
      close: async () => {
        if (closed) return;
        closed = true;
        await teardown();
      },
    };
  } catch (e) {
    await teardown();
    throw e;
  }
}
