// Job store (engine home jobs/<id>/): the record plus a snapshot of the files the human approves. The snapshot,
// not the agent's worktree, is what gets submitted, so the files can't change between approval and launch.
// State changes from different processes (an agent's executor session, `re job approve` in a terminal) are
// serialized by a lock file.
import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { EXPERIMENT_PATTERN, JOB_ID_PATTERN, type JobFile, type JobRecord } from "@cairn/shared";
import { type JobFileContent, LIMITS } from "./lint.js";

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export const EXPERIMENT_RE = new RegExp(EXPERIMENT_PATTERN);
const EXP_RE = EXPERIMENT_RE;
const ID_RE = new RegExp(JOB_ID_PATTERN);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** sha256 over (path, content hash) pairs in path order: identical job files share it. */
export function fingerprint(files: JobFileContent[]): string {
  return sha256([...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\0${sha256(f.content)}\n`).join(""));
}

export const describeFiles = (files: JobFileContent[]): JobFile[] =>
  [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ path: f.path, bytes: f.content.length, sha256: sha256(f.content) }));

/**
 * Read <worktree>/experiments/<experiment>/ on the host without following symlinks (user submissions and tests).
 * Agent submissions read inside the agent's sandbox instead (SubmitRequest.read): a worktree the agent can change
 * while we read is a race on the host, but harmless where only the worktree is mounted. Here every file is opened
 * O_NOFOLLOW and must be the same inode lstat saw, which closes the simple swaps. Reading stops early past twice
 * the lint limits, so a huge directory can't be loaded.
 */
export async function snapshotExperiment(worktree: string, experiment: string): Promise<JobFileContent[]> {
  if (!EXP_RE.test(experiment)) throw new JobError(`experiment must be a name like EXP-001, not ${JSON.stringify(experiment)}`);
  const root = await realpath(worktree);
  const dir = join(root, "experiments", experiment);
  for (const p of [join(root, "experiments"), dir]) {
    const s = await lstat(p).catch(() => undefined);
    if (!s) throw new JobError(`no experiments/${experiment}/ in the worktree`);
    if (!s.isDirectory()) throw new JobError(`${relative(root, p)} is not a directory (symlinks are not followed)`);
  }
  const files: JobFileContent[] = [];
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const name of (await readdir(d)).sort()) {
      const p = join(d, name);
      const s = await lstat(p);
      const rel = relative(dir, p).split(sep).join("/");
      if (s.isSymbolicLink()) throw new JobError(`experiments/${experiment}/${rel} is a symlink; job files must be regular files`);
      if (s.isDirectory()) await walk(p);
      else if (s.isFile()) {
        total += s.size;
        if (files.length >= LIMITS.files * 2 || total > LIMITS.totalBytes * 2) throw new JobError(`experiments/${experiment}/ is too large for a job (limits: ${LIMITS.files} files, ${LIMITS.totalBytes} bytes)`);
        files.push({ path: rel, content: await readNoFollow(p, s, `experiments/${experiment}/${rel}`) });
      } else throw new JobError(`experiments/${experiment}/${rel} is not a regular file`);
    }
  };
  await walk(dir);
  return files;
}

async function readNoFollow(p: string, seen: { dev: number; ino: number }, label: string): Promise<Buffer> {
  let h;
  try {
    h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new JobError(`${label} changed while it was read (${(e as NodeJS.ErrnoException).code}); job files must be regular files`);
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.dev !== seen.dev || st.ino !== seen.ino) throw new JobError(`${label} changed while it was read; job files must be regular files`);
    return await h.readFile();
  } finally {
    await h.close();
  }
}

export class JobStore {
  readonly root: string;
  constructor(home: string) {
    this.root = join(home, "jobs");
  }

  #dir(id: string): string {
    if (!ID_RE.test(id)) throw new JobError(`bad job id ${JSON.stringify(id)}`);
    return join(this.root, id);
  }

  /** Built in a temporary directory and renamed into place, so readers never see a half-made job. */
  async create(record: JobRecord, files: JobFileContent[]): Promise<void> {
    const dir = this.#dir(record.id);
    const tmp = join(this.root, `.tmp-${record.id}-${randomBytes(4).toString("hex")}`);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(tmp, { mode: 0o700 });
    try {
      for (const f of files) {
        const p = join(tmp, "files", f.path);
        await mkdir(dirname(p), { recursive: true, mode: 0o700 });
        await writeFile(p, f.content, { mode: 0o600 });
      }
      await writeFile(join(tmp, "job.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, dir);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  async get(id: string): Promise<JobRecord> {
    const text = await readFile(join(this.#dir(id), "job.json"), "utf8").catch(() => undefined);
    if (text === undefined) throw new JobError(`no job ${id}`);
    return JSON.parse(text) as JobRecord;
  }

  /** Every complete job; anything unreadable is skipped rather than failing the whole list. */
  async list(): Promise<JobRecord[]> {
    const ids = (await readdir(this.root).catch(() => [] as string[])).filter((x) => ID_RE.test(x)).sort();
    const jobs = await Promise.all(ids.map((id) => this.get(id).catch(() => undefined)));
    return jobs.filter((j): j is JobRecord => j !== undefined);
  }

  /** The approved snapshot; refuses if it no longer matches the record (tampered or damaged). */
  async files(record: JobRecord): Promise<JobFileContent[]> {
    const dir = join(this.#dir(record.id), "files");
    const files = await Promise.all(record.files.map(async (f) => ({ path: f.path, content: await readFile(join(dir, f.path)) })));
    if (fingerprint(files) !== record.fingerprint) throw new JobError(`job ${record.id}: snapshot does not match its fingerprint; refusing to use it`);
    return files;
  }

  /** Read-modify-write under the store lock. */
  async update(id: string, fn: (r: JobRecord) => JobRecord | Promise<JobRecord>): Promise<JobRecord> {
    return this.withLock(async () => {
      const next = await fn(await this.get(id));
      await this.#write(next);
      return next;
    });
  }

  async #write(record: JobRecord): Promise<void> {
    const p = join(this.#dir(record.id), "job.json");
    await writeFile(`${p}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(`${p}.tmp`, p);
  }

  /**
   * Exclusive claim on one job for a long operation (launch, fetch, cancel) without holding the store lock across
   * remote calls. Throws if another process holds it.
   */
  async claim<T>(id: string, op: string, fn: () => Promise<T>): Promise<T> {
    const p = join(this.#dir(id), ".claim");
    let h;
    try {
      h = await open(p, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = await readFile(p, "utf8").catch(() => "?");
      const age = await stat(p).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age < 30 * 60_000) throw new JobError(`job ${id} is busy (${held.trim()}); try again shortly`);
      await rm(p, { force: true });
      h = await open(p, "wx", 0o600);
    }
    await h.writeFile(`${op} by pid ${process.pid}`);
    await h.close();
    try {
      return await fn();
    } finally {
      await rm(p, { force: true });
    }
  }

  /** Cross-process lock (O_EXCL lock file) for short read-modify-writes; a lock older than staleMs is abandoned. */
  async withLock<T>(fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, ".lock");
    const t0 = Date.now();
    for (;;) {
      try {
        const h = await open(lock, "wx", 0o600);
        await h.writeFile(String(process.pid));
        await h.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > (opts.staleMs ?? 30_000)) await rm(lock, { force: true });
        else if (Date.now() - t0 > (opts.timeoutMs ?? 30_000)) throw new JobError(`job store is busy (lock ${lock}); try again`);
        else await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }
}
