// Host-side mount preparation. The argv allowlist checks paths as strings; this checks what they point to:
// a mount source that is (or passes through) a symlink resolving outside its root is refused, so a committed
// `logic -> ~/.ssh` symlink in a project can't expose host files (invariant 2).
import { chmod, copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { type ContainerSpec, type Mount, WORK } from "./policy.js";

export class MountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountError";
  }
}

const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Real path of the nearest existing ancestor (for paths that don't exist yet). */
async function realAncestor(p: string): Promise<string> {
  let cur = resolve(p);
  while (!(await exists(cur))) {
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return realpath(cur);
}

export interface PreparedMounts {
  spec: ContainerSpec;
  /** Mounts dropped because a read-only file doesn't exist yet. */
  skipped: Mount[];
  /** Real paths of the roots; pass these as ArgvPolicy.roots (sources are real paths too). */
  roots: string[];
}

export interface MountRoots {
  worktree: string;
  skills: string;
  outbox: string;
  /**
   * Host directory for staged copies of read-only role files (Apple container mounts directories only). Must not be
   * inside the outbox (that one is writable). Removed and recreated on every launch.
   */
  staging?: string;
}

/**
 * Resolve and check every mount source against its root, create missing directories, drop missing read-only
 * files. Returns a spec whose mount sources are real paths.
 *
 * roots: worktree (role mounts), skills, outbox. Each mount must stay inside the root it was derived from.
 */
export async function prepareMounts(spec: ContainerSpec, roots: MountRoots): Promise<PreparedMounts> {
  await mkdir(roots.outbox, { recursive: true, mode: 0o700 });
  const real = {
    worktree: await realpath(roots.worktree).catch(() => {
      throw new MountError(`worktree does not exist: ${roots.worktree}`);
    }),
    skills: await realpath(roots.skills).catch(() => {
      throw new MountError(`skills directory does not exist: ${roots.skills}`);
    }),
    outbox: await realpath(roots.outbox),
  };
  const rootFor = (m: Mount): string => {
    const src = resolve(m.source);
    if (inside(src, resolve(roots.skills))) return real.skills;
    if (inside(src, resolve(roots.outbox))) return real.outbox;
    if (inside(src, resolve(roots.worktree))) return real.worktree;
    throw new MountError(`mount source ${m.source} is not under the worktree, skills, or outbox`);
  };

  const mounts: Mount[] = [];
  const skipped: Mount[] = [];
  for (const m of spec.mounts) {
    const root = rootFor(m);
    // Every existing ancestor must resolve inside the root (catches symlinked parents).
    const anchor = await realAncestor(m.source);
    if (!inside(anchor, root)) throw new MountError(`${m.target}: ${m.source} resolves outside its root (${anchor})`);

    if (!(await exists(m.source))) {
      if (m.kind === "file") {
        if (m.readonly) {
          skipped.push(m);
          continue;
        }
        throw new MountError(`${m.target}: writable file mount ${m.source} does not exist`);
      }
      await mkdir(m.source, { recursive: true });
    }
    const target = await realpath(m.source);
    if (!inside(target, root)) throw new MountError(`${m.target}: ${m.source} is a symlink to ${target}, outside its root`);
    const st = await lstat(target);
    if (m.kind === "dir" && !st.isDirectory()) throw new MountError(`${m.target}: ${m.source} is not a directory`);
    if (m.kind === "file" && !st.isFile()) throw new MountError(`${m.target}: ${m.source} is not a regular file`);
    mounts.push({ ...m, source: target });
  }
  const staged = await stageFiles(mounts, roots);
  return { spec: { ...spec, mounts: staged.mounts }, skipped, roots: [real.worktree, real.skills, real.outbox, ...(staged.root ? [staged.root] : [])] };
}

/**
 * Apple container bind-mounts directories only (virtiofs), so a read-only role file (e.g. logic/experiments.md)
 * is copied into a per-agent staging directory and that directory is mounted read-only at the file's parent.
 * The agent sees exactly the role's files there, nothing else from the parent (DR-0005: mount subsets of the
 * worktree). Writable file mounts can't work this way and are refused.
 */
async function stageFiles(mounts: Mount[], roots: MountRoots): Promise<{ mounts: Mount[]; root?: string }> {
  const files = mounts.filter((m) => m.kind === "file");
  if (files.length === 0) return { mounts };
  const writable = files.find((m) => !m.readonly);
  if (writable) throw new MountError(`${writable.target}: writable file mounts are not supported (the container runtime mounts directories only); list a directory in roles.yaml`);
  if (!roots.staging) throw new MountError(`${files[0]!.target}: read-only file mounts need a staging directory`);
  const staging = resolve(roots.staging);
  if (inside(staging, resolve(roots.outbox)) || inside(staging, resolve(roots.worktree)) || inside(staging, resolve(roots.skills))) {
    throw new MountError(`staging directory ${staging} must not be inside the outbox, worktree, or skills`);
  }
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const realStaging = await realpath(staging);
  const dirs = mounts.filter((m) => m.kind === "dir");
  const covered = (target: string) => dirs.some((d) => target === d.target || target.startsWith(`${d.target}/`));
  const groups = new Map<string, Mount[]>();
  for (const f of files) {
    if (covered(f.target)) continue; // already visible through a directory mount
    const parent = posix.dirname(f.target);
    groups.set(parent, [...(groups.get(parent) ?? []), f]);
  }
  const staged: Mount[] = [];
  for (const [parent, group] of groups) {
    const rel = posix.relative(WORK, parent);
    if (rel === "" || rel.startsWith("..")) throw new MountError(`${group[0]!.target}: files directly under ${WORK} can't be staged; list a directory`);
    const dir = join(realStaging, ...rel.split("/"));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const f of group) {
      const dest = join(dir, posix.basename(f.target));
      await copyFile(f.source, dest);
      await chmod(dest, 0o444);
    }
    // Mount points for directory mounts nested under this parent (the staged mount is read-only).
    for (const d of dirs) if (d.target.startsWith(`${parent}/`)) await mkdir(join(dir, ...posix.relative(parent, d.target).split("/")), { recursive: true });
    staged.push({ source: dir, target: parent, readonly: true, kind: "dir", files: group.map((f) => posix.basename(f.target)) });
  }
  // Keep the role's order; a staged parent goes before any mount nested under it.
  const out = [...dirs];
  for (const m of staged) {
    const i = out.findIndex((d) => d.target.startsWith(`${m.target}/`));
    out.splice(i === -1 ? out.length : i, 0, m);
  }
  return { mounts: out, root: realStaging };
}
