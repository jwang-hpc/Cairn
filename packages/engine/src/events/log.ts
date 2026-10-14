import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineEvent, UsageEvent, validate, type EngineEvent as EngineEventT, type UsageEvent as UsageEventT } from "@cairn/shared";
import { ENGINE_VERSION } from "../version.js";

export const EVENTS_FILE = "events.jsonl";
export const USAGE_FILE = "usage.jsonl";

/** Envelope fields for a new event (DR-0004 seam 3). */
export function envelope(run: string, machine: string, now: Date = new Date()) {
  return { v: 1 as const, ts: now.toISOString(), id: randomUUID(), run, machine, engine: ENGINE_VERSION };
}

/** Thrown when code tries to log an event that doesn't match the schema. Nothing is written. */
export class InvalidEventError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`invalid event: ${errors.join("; ")}`);
    this.name = "InvalidEventError";
  }
}

/**
 * Append-only normalized event log. All events go to events.jsonl; usage events are also written to
 * usage.jsonl, which the budget governor and provenance read. Writes are serialized in-process so
 * concurrent appends never interleave.
 */
export class EventLog {
  #chain: Promise<void> = Promise.resolve();
  #ready: Promise<void> | undefined;

  constructor(readonly home: string) {}

  append(event: EngineEventT): Promise<void> {
    const result = validate(EngineEvent, event);
    if (!result.ok) return Promise.reject(new InvalidEventError(result.errors));
    const line = `${JSON.stringify(event)}\n`;
    const write = async () => {
      this.#ready ??= mkdir(this.home, { recursive: true, mode: 0o700 }).then(() => undefined);
      await this.#ready;
      await appendFile(join(this.home, EVENTS_FILE), line, { mode: 0o600 });
      if (event.type === "usage") await appendFile(join(this.home, USAGE_FILE), line, { mode: 0o600 });
    };
    const run = this.#chain.then(write, write);
    this.#chain = run.catch(() => {});
    return run;
  }
}

export interface UsageRead {
  records: UsageEventT[];
  /** 1-based line numbers of lines that failed to parse or validate. */
  badLines: number[];
}

/** Read usage records with `from <= ts < to`. Corrupt lines are skipped and reported, not fatal. */
export async function readUsage(home: string, window: { from?: Date; to?: Date } = {}): Promise<UsageRead> {
  let text: string;
  try {
    text = await readFile(join(home, USAGE_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { records: [], badLines: [] };
    throw e;
  }
  const from = window.from?.getTime() ?? -Infinity;
  const to = window.to?.getTime() ?? Infinity;
  const records: UsageEventT[] = [];
  const badLines: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines.push(i + 1);
      return;
    }
    const r = validate(UsageEvent, parsed);
    if (!r.ok) {
      badLines.push(i + 1);
      return;
    }
    const t = Date.parse(r.value.ts);
    if (t >= from && t < to) records.push(r.value);
  });
  return { records, badLines };
}
