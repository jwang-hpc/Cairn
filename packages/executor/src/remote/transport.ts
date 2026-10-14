// How the executor reaches a machine (DR-0006 amendment, spike 4): only through the SSH ControlMaster the user
// opened. Every call is mux-only — BatchMode on, every authentication method off, forwarding off — so without a
// live master nothing connects and nothing prompts. Scripts go to `sh -s` on stdin; nothing untrusted is ever
// placed on the ssh command line.
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface RunResult {
  /** Exit code; null if killed by the timeout. */
  code: number | null;
  out: string;
  err: string;
  ms: number;
}

export interface Transport {
  /** ssh alias (or "local" in tests). */
  readonly host: string;
  /** Run a POSIX sh script on the machine (script on stdin). */
  run(script: string, opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** Is the user's session to this machine open? */
  alive(): Promise<boolean>;
}

/** ssh exits 255 when it could not connect (no master, master expired, VPN down). */
export const SSH_CONNECT_FAILED = 255;
const HOST_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function muxOnlyOptions(controlDir: string): string[] {
  return [
    "ControlMaster=no",
    `ControlPath=${join(controlDir, "%C")}`,
    "BatchMode=yes",
    "ConnectTimeout=10",
    "ForwardAgent=no",
    "ForwardX11=no",
    "ClearAllForwardings=yes",
    "PubkeyAuthentication=no",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "GSSAPIAuthentication=no",
    "HostbasedAuthentication=no",
    "IdentityAgent=none",
  ].flatMap((o) => ["-o", o]);
}

function spawnCollect(cmd: string, args: string[], input: string, timeoutMs: number, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", (e) => err.push(Buffer.from(String(e))));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? null : code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8"), ms: Date.now() - t0 });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

export class SshTransport implements Transport {
  constructor(
    readonly host: string,
    /** Where the user's masters live (engine home ssh/, mode 0700). */
    readonly controlDir: string,
  ) {
    if (!HOST_ALIAS.test(host)) throw new Error(`bad ssh alias ${JSON.stringify(host)}`);
  }

  run(script: string, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    return spawnCollect("ssh", [...muxOnlyOptions(this.controlDir), this.host, "sh", "-s"], script, opts.timeoutMs ?? 120_000);
  }

  async alive(): Promise<boolean> {
    const r = await spawnCollect("ssh", ["-o", `ControlPath=${join(this.controlDir, "%C")}`, "-O", "check", this.host], "", 15_000);
    return r.code === 0;
  }
}

/** Runs scripts on this machine. Tests only: jobs never run unconfined on the host. */
export class LocalTransport implements Transport {
  readonly host = "local";
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  run(script: string, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    return spawnCollect("sh", ["-s"], script, opts.timeoutMs ?? 60_000, { env: this.env });
  }

  async alive(): Promise<boolean> {
    return true;
  }
}
