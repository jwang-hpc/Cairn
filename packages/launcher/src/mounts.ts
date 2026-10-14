// Host-side mount preparation. The argv allowlist checks paths as strings; this checks what they point to:
// a mount source that is (or passes through) a symlink resolving outside its root is refused, so a committed
// `logic -> ~/.ssh` symlink in a project can't expose host files (invariant 2).
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ContainerSpec, Mount } from "./policy.js";

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

/**
 * Resolve and check every mount source against its root, create missing directories, drop missing read-only
 * files. Returns a spec whose mount sources are real paths.
 *
 * roots: worktree (role mounts), skills, outbox. Each mount must stay inside the root it was derived from.
 */
export async function prepareMounts(spec: ContainerSpec, roots: { worktree: string; skills: string; outbox: string }): Promise<PreparedMounts> {
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
  return { spec: { ...spec, mounts }, skipped, roots: [real.worktree, real.skills, real.outbox] };
}
