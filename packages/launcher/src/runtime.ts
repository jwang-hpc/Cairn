// Apple `container` driver. Every invocation is an argv array (no shell); `run` argv is always allowlisted.
import { spawn } from "node:child_process";
import { type ArgvPolicy, toExecArgv, toRunArgv } from "./argv.js";
import type { ContainerSpec } from "./policy.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True if output was cut at maxOutputBytes. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  /** Per-stream cap; extra output is discarded (tool output must not flood model context). */
  maxOutputBytes?: number;
}

/** Runs the `container` CLI. Injectable so unit tests never need a runtime. */
export interface CommandRunner {
  run(args: readonly string[], opts?: RunOptions): Promise<RunResult>;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT = 256 * 1024;

export function cliRunner(binary = "container"): CommandRunner {
  return {
    run(args, opts = {}) {
      const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
      return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outLen = 0;
        let errLen = 0;
        let truncated = false;
        let timedOut = false;
        const take = (chunks: Buffer[], len: number, d: Buffer): number => {
          const room = max - len;
          if (room <= 0) {
            truncated = true;
            return len;
          }
          if (d.length > room) truncated = true;
          chunks.push(d.subarray(0, room));
          return len + Math.min(d.length, room);
        };
        child.stdout.on("data", (d: Buffer) => (outLen = take(out, outLen, d)));
        child.stderr.on("data", (d: Buffer) => (errLen = take(err, errLen, d)));
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ code: 127, stdout: "", stderr: `${binary}: ${e.message}`, truncated, timedOut, durationMs: Date.now() - t0 });
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({
            code: code ?? (signal ? 128 : 1),
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            truncated,
            timedOut,
            durationMs: Date.now() - t0,
          });
        });
        child.stdin.on("error", () => {}); // process may exit before reading stdin
        child.stdin.end(opts.input ?? "");
      });
    },
  };
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly result?: RunResult,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

const oneLine = (s: string) => s.trim().split("\n").at(-1) ?? "";

export interface NetworkInfo {
  name: string;
  gateway: string;
  subnet: string;
}

export class ContainerRuntime {
  constructor(readonly runner: CommandRunner = cliRunner()) {}

  async #ok(args: readonly string[], what: string, opts?: RunOptions): Promise<RunResult> {
    const r = await this.runner.run(args, opts);
    if (r.code !== 0) throw new RuntimeError(`${what} failed (exit ${r.code}): ${oneLine(r.stderr || r.stdout)}`, r);
    return r;
  }

  /** Host-only network for one agent; returns its gateway (where the egress proxy listens). */
  async createInternalNetwork(name: string): Promise<NetworkInfo> {
    if (!/^cairn-net-[a-z0-9-]+$/.test(name)) throw new RuntimeError(`network name must be cairn-net-<agent id>: ${name}`);
    await this.#ok(["network", "create", "--internal", name], `network create ${name}`);
    const info = await this.inspectNetwork(name);
    if (info.mode !== "hostOnly") {
      await this.deleteNetwork(name).catch(() => {});
      throw new RuntimeError(`network ${name} is ${info.mode}, expected hostOnly`);
    }
    return { name, gateway: info.gateway, subnet: info.subnet };
  }

  async inspectNetwork(name: string): Promise<NetworkInfo & { mode: string }> {
    const r = await this.#ok(["network", "inspect", name], `network inspect ${name}`);
    const [info] = JSON.parse(r.stdout) as { configuration?: { mode?: string }; status?: { ipv4Gateway?: string; ipv4Subnet?: string } }[];
    const gateway = info?.status?.ipv4Gateway;
    const subnet = info?.status?.ipv4Subnet;
    if (!gateway || !subnet) throw new RuntimeError(`network ${name} has no IPv4 gateway`);
    return { name, gateway, subnet, mode: info?.configuration?.mode ?? "unknown" };
  }

  async deleteNetwork(name: string): Promise<void> {
    await this.#ok(["network", "delete", name], `network delete ${name}`);
  }

  /** Start an agent container. The argv is built and allowlisted by toRunArgv. */
  async start(spec: ContainerSpec, policy: ArgvPolicy): Promise<RunResult> {
    return this.#ok(toRunArgv(spec, policy), `run ${spec.name}`, { timeoutMs: 180_000 });
  }

  /** Run a command in the agent's container. Non-zero exit codes are results, not errors. */
  exec(name: string, command: readonly string[], opts: RunOptions & { workdir?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
    const { workdir, env, ...run } = opts;
    return this.runner.run(toExecArgv(name, command, { ...(workdir ? { workdir } : {}), ...(env ? { env } : {}) }), run);
  }

  async stop(name: string): Promise<void> {
    await this.#ok(["stop", name], `stop ${name}`, { timeoutMs: 60_000 });
  }

  /** Stop and delete; tolerant of already-gone containers so cleanup can always run. */
  async remove(name: string): Promise<void> {
    await this.runner.run(["delete", "--force", name], { timeoutMs: 60_000 });
  }
}
