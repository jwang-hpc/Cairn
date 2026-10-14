// `container` CLI argv for agent containers, built from a ContainerSpec and checked against an ALLOWLIST of
// flags. Anything not known to be safe is refused, so new or dangerous flags (--ssh, --publish-socket,
// bare `-e KEY`, --virtualization, --cap-add, -v, -p, custom kernels/runtimes) fail closed.
import { posix, resolve, sep } from "node:path";
import { AGENT_USER, type ContainerSpec, ENV_ALLOWED, OUTBOX, SKILLS, WORK } from "./policy.js";

export class UnsafeArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArgvError";
  }
}

/** Flags with a specific, documented danger; refused with a clearer message than "not allowed". */
const KNOWN_DANGEROUS: Record<string, string> = {
  "--ssh": "forwards the host SSH agent into the container (invariants 1, 4)",
  "--publish-socket": "exposes a host socket",
  "--env-file": "may inherit host environment (invariant 1)",
  "--virtualization": "exposes host virtualization",
  "--cap-add": "adds Linux capabilities",
  "-v": "use --mount with checked sources",
  "--volume": "use --mount with checked sources",
  "-p": "publishes ports",
  "--publish": "publishes ports",
  "-k": "custom kernel",
  "--kernel": "custom kernel",
  "--init-image": "custom init image",
  "--runtime": "custom runtime",
  "--dns": "agents get no DNS (--no-dns)",
  "--masked-path": "can clear default masked paths",
  "--read-only-path": "can clear default read-only paths",
  "--rosetta": "not needed",
};

/**
 * Kernel boot arguments every agent VM gets, and the only ones allowed. ipv6.disable=1: no IPv6 in the agent, so no
 * link-local path to services on the Mac that the IPv4 pf guard can't see (open question 12, escape test 4c).
 */
export const AGENT_KERNEL_ARGS = ["ipv6.disable=1"] as const;

export interface ArgvPolicy {
  /** Host directories mount sources must lie under (worktree, skills, outbox). */
  roots: string[];
  /** The agent's network; --network must equal it. */
  network: string;
}

const within = (path: string, root: string) => {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r + sep);
};

function parseMount(value: string): { type?: string; source?: string; target?: string; readonly: boolean; extra: string[] } {
  const out: { type?: string; source?: string; target?: string; readonly: boolean; extra: string[] } = { readonly: false, extra: [] };
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const val = eq === -1 ? undefined : part.slice(eq + 1);
    if (key === "type" || key === "source" || key === "target") {
      if (val === undefined) out.extra.push(part);
      else out[key] = val;
    } else if (key === "readonly" && val === undefined) out.readonly = true;
    else out.extra.push(part);
  }
  return out;
}

/** `container run` argv for a spec. Validated before it is returned. */
export function toRunArgv(spec: ContainerSpec, policy: ArgvPolicy): string[] {
  for (const m of spec.mounts) {
    if (m.source.includes(",") || m.target.includes(",")) throw new UnsafeArgvError(`mount path contains a comma: ${m.source}`);
  }
  const argv = [
    "run", "-d",
    "--name", spec.name,
    ...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--user", spec.user,
    "--no-dns", "--network", spec.network, "--init",
    ...AGENT_KERNEL_ARGS.flatMap((a) => ["--kernel-arg", a]),
    "-w", spec.workdir,
    "--cpus", String(spec.resources.cpus), "--memory", spec.resources.memory,
    ...spec.mounts.flatMap((m) => ["--mount", `type=bind,source=${m.source},target=${m.target}${m.readonly ? ",readonly" : ""}`]),
    ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "--entrypoint", spec.entrypoint,
    spec.image,
    ...spec.args,
  ];
  validateRunArgv(argv, policy);
  return argv;
}

/** Throws UnsafeArgvError unless every token of a `container run` argv is on the allowlist. */
export function validateRunArgv(argv: readonly string[], policy: ArgvPolicy): void {
  if (argv[0] !== "run") throw new UnsafeArgvError(`expected 'run', got ${JSON.stringify(argv[0])}`);
  const seen = new Set<string>();
  let i = 1;
  const next = (flag: string) => {
    const v = argv[++i];
    if (v === undefined) throw new UnsafeArgvError(`${flag} needs a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("-")) break; // image
    const eq = tok.indexOf("=");
    const flag = tok.startsWith("--") && eq !== -1 ? tok.slice(0, eq) : tok;
    if (flag !== tok) throw new UnsafeArgvError(`use '${flag} <value>', not '${tok}'`);
    if (flag in KNOWN_DANGEROUS) throw new UnsafeArgvError(`${flag} is not allowed: ${KNOWN_DANGEROUS[flag]}`);
    seen.add(flag);
    switch (flag) {
      case "-d":
      case "--read-only":
      case "--no-dns":
      case "--init":
        break;
      case "--name":
        if (!/^cairn-[a-z0-9-]+$/.test(next(flag))) throw new UnsafeArgvError("container name must be cairn-<agent id>");
        break;
      case "--label":
        if (!/^cairn\.[a-z]+=[A-Za-z0-9._-]+$/.test(next(flag))) throw new UnsafeArgvError(`label must be cairn.<key>=<value>: ${argv[i]}`);
        break;
      case "--tmpfs":
        if (next(flag) !== "/tmp") throw new UnsafeArgvError("only /tmp may be a tmpfs");
        break;
      case "--cap-drop":
        if (next(flag) !== "ALL") throw new UnsafeArgvError("--cap-drop must be ALL");
        break;
      case "--user":
      case "-u": {
        const u = next(flag);
        if (u !== AGENT_USER) throw new UnsafeArgvError(`agents run as ${AGENT_USER}, not ${JSON.stringify(u)}`);
        break;
      }
      case "--network": {
        const n = next(flag);
        if (n !== policy.network) throw new UnsafeArgvError(`--network must be the agent's network ${policy.network}, got ${n}`);
        break;
      }
      case "-w":
      case "--workdir": {
        const w = next(flag);
        if (w !== WORK && !w.startsWith(`${WORK}/`)) throw new UnsafeArgvError(`workdir must be under ${WORK}`);
        break;
      }
      case "--cpus":
        if (!/^\d+(\.\d+)?$/.test(next(flag))) throw new UnsafeArgvError("--cpus must be a number");
        break;
      case "--memory":
      case "-m":
        if (!/^\d+[kKmMgG]?$/.test(next(flag))) throw new UnsafeArgvError("--memory must look like 2g");
        break;
      case "--mount": {
        const m = parseMount(next(flag));
        if (m.type !== "bind" || !m.source || !m.target || m.extra.length > 0) throw new UnsafeArgvError(`unsupported mount: ${argv[i]}`);
        if (!policy.roots.some((r) => within(m.source!, r))) throw new UnsafeArgvError(`mount source outside allowed roots: ${m.source}`);
        const t = posix.normalize(m.target);
        if (t !== m.target || ![WORK, SKILLS, OUTBOX].some((r) => t === r || t.startsWith(`${r}/`))) {
          throw new UnsafeArgvError(`mount target must be under ${WORK}, ${SKILLS}, or ${OUTBOX}: ${m.target}`);
        }
        if (t.startsWith(SKILLS) && !m.readonly) throw new UnsafeArgvError("skills must be mounted readonly");
        break;
      }
      case "-e":
      case "--env": {
        const kv = next(flag);
        const k = kv.indexOf("=") === -1 ? undefined : kv.slice(0, kv.indexOf("="));
        if (k === undefined) throw new UnsafeArgvError(`-e ${kv} would inherit the host's value (invariant 1); use KEY=VALUE`);
        if (!ENV_ALLOWED.has(k)) throw new UnsafeArgvError(`environment variable ${k} is not allowed in agent containers`);
        break;
      }
      case "--kernel-arg": {
        const a = next(flag);
        if (!(AGENT_KERNEL_ARGS as readonly string[]).includes(a)) throw new UnsafeArgvError(`--kernel-arg ${a} is not allowed (only ${AGENT_KERNEL_ARGS.join(", ")})`);
        break;
      }
      case "--entrypoint":
        if (next(flag) !== "sleep") throw new UnsafeArgvError("entrypoint must be sleep (tools run via exec)");
        break;
      default:
        throw new UnsafeArgvError(`${flag} is not on the launcher's allowlist`);
    }
  }
  const image = argv[i];
  if (!image) throw new UnsafeArgvError("missing image");
  const args = argv.slice(i + 1);
  if (args.length !== 1 || args[0] !== "infinity") throw new UnsafeArgvError(`container command must be 'sleep infinity', got ${JSON.stringify(args)}`);
  for (const required of ["--read-only", "--cap-drop", "--no-dns", "--network", "--tmpfs", "--kernel-arg"]) {
    if (!seen.has(required)) throw new UnsafeArgvError(`missing required hardening flag ${required}`);
  }
  if (!seen.has("--user") && !seen.has("-u")) throw new UnsafeArgvError("missing --user (agents never run as root)");
}

/** `container exec` argv: non-root, workdir under /work, explicit env only, never a TTY. */
export function toExecArgv(name: string, command: readonly string[], opts: { workdir?: string; env?: Record<string, string> } = {}): string[] {
  if (!/^cairn-[a-z0-9-]+$/.test(name)) throw new UnsafeArgvError("exec target must be a cairn-<agent id> container");
  if (command.length === 0) throw new UnsafeArgvError("empty command");
  const workdir = opts.workdir ?? WORK;
  if (workdir !== WORK && !workdir.startsWith(`${WORK}/`)) throw new UnsafeArgvError(`workdir must be under ${WORK}`);
  const env = Object.entries(opts.env ?? {});
  for (const [k] of env) if (!ENV_ALLOWED.has(k)) throw new UnsafeArgvError(`environment variable ${k} is not allowed in agent containers`);
  return ["exec", "-i", "--user", AGENT_USER, "-w", workdir, ...env.flatMap(([k, v]) => ["-e", `${k}=${v}`]), name, ...command];
}
