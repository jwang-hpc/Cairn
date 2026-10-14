// Role policy -> container spec (DR-0004 seam 6: permissions are data; DR-0005: confinement).
// Pure: no filesystem or runtime access. The runtime (M2.2) resolves symlinks and creates missing dirs.
import { join, posix } from "node:path";
import type { RoleConfig, RolesConfig } from "@cairn/shared";

/** Fixed in-container locations. */
export const WORK = "/work";
export const SKILLS = "/skills";
export const OUTBOX = "/outbox";
/** Agents never run as root inside the container. */
export const AGENT_USER = "1000:1000";

export interface Mount {
  /** Absolute host path. */
  source: string;
  /** Absolute container path. */
  target: string;
  readonly: boolean;
  /** Role paths ending in "/" are directories; others are single files. */
  kind: "dir" | "file";
}

export interface ContainerSpec {
  name: string;
  image: string;
  /** The agent's own --internal network (never "default"). */
  network: string;
  mounts: Mount[];
  /** Explicit KEY=VALUE only; keys from ENV_ALLOWED. */
  env: Record<string, string>;
  user: string;
  workdir: string;
  entrypoint: "sleep";
  args: ["infinity"];
  resources: { cpus: number; memory: string };
  labels: Record<string, string>;
  /** Domains the engine's egress proxy must allow for this agent (empty = no egress at all). */
  egressDomains: string[];
}

export interface LaunchRequest {
  agentId: string;
  role: string;
  roles: RolesConfig;
  /** Absolute host paths. */
  worktree: string;
  skillsDir: string;
  outboxDir: string;
  /** Image reference, ideally pinned by digest. */
  image: string;
  /** Name of the agent's --internal network, created by the runtime. */
  network: string;
  /** Engine-owned CONNECT proxy on that network's gateway. Required iff the role has egress domains. */
  proxyUrl?: string;
  /** Values for role path placeholders such as <id> and <member>. */
  vars?: Record<string, string>;
  resources?: { cpus?: number; memory?: string };
}

/** Environment variable names an agent container may receive. Everything else is refused (invariant 1). */
export const ENV_ALLOWED = new Set([
  "HOME",
  "LANG",
  "PYTHONDONTWRITEBYTECODE",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
]);

export const DEFAULT_RESOURCES = { cpus: 2, memory: "2g" } as const;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VAR_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Split a role's `network:` entries into domains (contain a dot) and named services (e.g. literature-proxy). */
export function egressFor(role: RoleConfig): { domains: string[]; services: string[] } {
  const domains: string[] = [];
  const services: string[] = [];
  for (const entry of role.network) (entry.includes(".") ? domains : services).push(entry.toLowerCase());
  return { domains, services };
}

function substitute(path: string, vars: Record<string, string>, where: string): string {
  return path.replace(/<([a-z]+)>/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new PolicyError(`${where}: placeholder <${name}> has no value`);
    if (!VAR_VALUE.test(value)) throw new PolicyError(`${where}: placeholder <${name}> value ${JSON.stringify(value)} is not a plain name`);
    return value;
  });
}

/** Validate a worktree-relative role path; returns its normalized form and kind. */
function rolePath(raw: string, where: string): { rel: string; kind: "dir" | "file" } {
  if (raw.includes("\0") || raw.includes(",")) throw new PolicyError(`${where}: invalid character in ${JSON.stringify(raw)}`);
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new PolicyError(`${where}: ${JSON.stringify(raw)} must be relative to the worktree`);
  const kind = raw.endsWith("/") ? "dir" : "file";
  const rel = posix.normalize(raw).replace(/\/+$/, "");
  if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../") || rel.split("/").includes("..")) {
    throw new PolicyError(`${where}: ${JSON.stringify(raw)} escapes or names the whole worktree; list explicit subpaths`);
  }
  if (rel.split("/")[0] === ".git") throw new PolicyError(`${where}: ${JSON.stringify(raw)} would expose git internals`);
  return { rel, kind };
}

/** Build the container spec for one agent from its role policy. Throws PolicyError on anything unsafe. */
export function specForRole(req: LaunchRequest): ContainerSpec {
  if (!AGENT_ID.test(req.agentId)) throw new PolicyError(`agent id ${JSON.stringify(req.agentId)} must match ${AGENT_ID}`);
  const role = req.roles.roles[req.role];
  if (!role) throw new PolicyError(`unknown role '${req.role}' (known: ${Object.keys(req.roles.roles).join(", ")})`);
  if (req.roles.defaults.secrets !== "none") {
    throw new PolicyError(`secrets: ${req.roles.defaults.secrets} is not supported; agent containers get no credentials (invariant 1)`);
  }
  if (!req.network || req.network === "default") {
    throw new PolicyError("an agent must run on its own --internal network, never 'default' (invariant 3)");
  }
  for (const [label, p] of [["worktree", req.worktree], ["skillsDir", req.skillsDir], ["outboxDir", req.outboxDir]] as const) {
    if (!p.startsWith("/")) throw new PolicyError(`${label} must be an absolute host path`);
  }

  // Role mounts: write wins over read for the same path.
  const vars = { id: req.agentId, ...req.vars };
  const modes = new Map<string, { kind: "dir" | "file"; readonly: boolean }>();
  for (const [access, list] of [["read", role.mounts.read], ["write", role.mounts.write]] as const) {
    for (const raw of list) {
      const where = `roles.${req.role}.mounts.${access}`;
      const { rel, kind } = rolePath(substitute(raw, vars, where), where);
      const prev = modes.get(rel);
      if (prev && prev.kind !== kind) throw new PolicyError(`${where}: ${rel} is listed both as a file and a directory`);
      modes.set(rel, { kind, readonly: access === "read" ? (prev?.readonly ?? true) : false });
    }
  }
  const mounts: Mount[] = [...modes]
    .map(([rel, m]) => ({ source: join(req.worktree, rel), target: posix.join(WORK, rel), readonly: m.readonly, kind: m.kind }))
    // Parents before children so nested mounts layer correctly.
    .sort((a, b) => a.target.split("/").length - b.target.split("/").length || a.target.localeCompare(b.target));
  mounts.push(
    { source: req.skillsDir, target: SKILLS, readonly: true, kind: "dir" },
    { source: req.outboxDir, target: OUTBOX, readonly: false, kind: "dir" },
  );

  // Egress: deny by default; domains only through the engine's proxy (DR-0005 amendment).
  const { domains, services } = egressFor(role);
  if (services.length > 0) {
    throw new PolicyError(`roles.${req.role}.network: named services not available yet: ${services.join(", ")}`);
  }
  if (domains.length > 0 && !req.proxyUrl) {
    throw new PolicyError(`roles.${req.role}.network allows ${domains.join(", ")} but no egress proxy was provided`);
  }
  const env: Record<string, string> = { HOME: "/tmp", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
  if (domains.length > 0 && req.proxyUrl) {
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) env[k] = req.proxyUrl;
  }

  return {
    name: `cairn-${req.agentId}`,
    image: req.image,
    network: req.network,
    mounts,
    env,
    user: AGENT_USER,
    workdir: WORK,
    entrypoint: "sleep",
    args: ["infinity"],
    resources: { cpus: req.resources?.cpus ?? DEFAULT_RESOURCES.cpus, memory: req.resources?.memory ?? DEFAULT_RESOURCES.memory },
    labels: { "cairn.agent": req.agentId, "cairn.role": req.role },
    egressDomains: domains,
  };
}
