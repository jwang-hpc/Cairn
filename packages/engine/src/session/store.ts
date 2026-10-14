// Research sessions on disk (DR-0014): <home>/sessions/<project>/<id>.json holds what the orchestrator continues from
// (its messages since the last summary, the summary, the proposals) and <id>.jsonl is the full transcript the user
// sees. Host only (0700 directory, 0600 files), never in the ledger: what should last goes into the ledger through
// a proposal the user accepts.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ProposalState = "proposed" | "queued" | "running" | "done" | "failed" | "needs_input" | "stopped" | "dismissed" | "recorded";

export interface DelegationOutcome {
  status: string;
  summary: string;
  /** Branch holding the worker's changes (agent/<id>), when it changed anything. */
  branch?: string;
  commit?: string;
  files: string[];
  questions: string[];
  /** Jobs it proposed (waiting for approval or further). */
  jobs: string[];
  /** Claim drafts it committed, as gate refs. */
  drafts: string[];
  /** It changed lit/: check and accept with re literature. */
  literature: boolean;
  error?: string;
  usd?: number;
}

export interface Proposal {
  /** P1, P2, … within the session. */
  id: string;
  kind: "task" | "decision";
  title: string;
  /** task: the worker role and what it should do. */
  role?: string;
  task?: string;
  files?: string[];
  /** decision: why. */
  rationale?: string;
  refs?: string[];
  state: ProposalState;
  created: string;
  updated: string;
  run?: string;
  outcome?: DelegationOutcome;
  /** decision: the D-number it was recorded as. */
  recorded?: string;
}

export interface SessionMeta {
  v: 1;
  id: string;
  project: string;
  title: string;
  created: string;
  updated: string;
  turns: number;
}

export interface SessionRecord extends SessionMeta {
  /** Summary of the turns no longer in `messages` (DR-0009 compaction). */
  summary?: string;
  messages: AgentMessage[];
  proposals: Proposal[];
}

export type TranscriptEntry =
  | { at: string; kind: "user"; text: string }
  | { at: string; kind: "assistant"; text: string; run: string; ms: number; usd?: number; error?: string }
  | { at: string; kind: "tool"; run: string; name: string; text: string; isError: boolean }
  | { at: string; kind: "proposal"; proposal: Proposal }
  | { at: string; kind: "system"; text: string };

export const SESSION_ID = /^\d{8}-\d{4}-[0-9a-f]{4}$/;
const pad = (n: number) => String(n).padStart(2, "0");

export class SessionStore {
  readonly root: string;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(home: string) {
    this.root = join(home, "sessions");
  }

  #dir(project: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error(`bad project name ${JSON.stringify(project)}`);
    return join(this.root, project);
  }
  #path(project: string, id: string, ext: "json" | "jsonl") {
    if (!SESSION_ID.test(id)) throw new Error(`no session ${JSON.stringify(id)}`);
    return join(this.#dir(project), `${id}.${ext}`);
  }

  async create(project: string, title = "Research session", now = new Date()): Promise<SessionRecord> {
    const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${randomBytes(2).toString("hex")}`;
    const at = now.toISOString();
    const rec: SessionRecord = { v: 1, id, project, title, created: at, updated: at, turns: 0, messages: [], proposals: [] };
    await mkdir(this.#dir(project), { recursive: true, mode: 0o700 });
    await this.save(rec);
    return rec;
  }

  async load(project: string, id: string): Promise<SessionRecord> {
    try {
      return JSON.parse(await readFile(this.#path(project, id, "json"), "utf8")) as SessionRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no session ${id} in ${project}`);
      throw e;
    }
  }

  /** Atomic write; one writer per session at a time (callers serialize turns). */
  async save(rec: SessionRecord): Promise<void> {
    const p = this.#path(rec.project, rec.id, "json");
    const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    await rename(tmp, p);
  }

  /**
   * Read, change, and save one session under its lock: a turn and a worker finishing at the same time must not
   * overwrite each other's changes.
   */
  update(project: string, id: string, change: (rec: SessionRecord) => void | Promise<void>): Promise<SessionRecord> {
    const key = `${project}/${id}`;
    const next = (this.#locks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const rec = await this.load(project, id);
      await change(rec);
      await this.save(rec);
      return rec;
    });
    this.#locks.set(key, next);
    return next;
  }

  /** Newest first. */
  async list(project: string): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir(project));
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      try {
        const { v, id, project: p, title, created, updated, turns } = JSON.parse(await readFile(join(this.#dir(project), n), "utf8")) as SessionRecord;
        out.push({ v, id, project: p, title, created, updated, turns });
      } catch {
        // a damaged record is skipped, not fatal
      }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Append transcript entries in call order (chained per session). */
  append(project: string, id: string, ...entries: TranscriptEntry[]): Promise<void> {
    const key = `${project}/${id}`;
    const p = this.#path(project, id, "jsonl");
    const next = (this.#tails.get(key) ?? Promise.resolve()).then(() => appendFile(p, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 }));
    this.#tails.set(key, next.catch(() => {}));
    return next;
  }

  async transcript(project: string, id: string): Promise<TranscriptEntry[]> {
    let text: string;
    try {
      text = await readFile(this.#path(project, id, "jsonl"), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TranscriptEntry];
        } catch {
          return [];
        }
      });
  }
}
