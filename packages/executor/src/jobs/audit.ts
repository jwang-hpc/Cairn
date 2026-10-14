// engine/audit.log (DR-0006): every executor action, accepted or refused, with raw remote output. JSONL in the
// engine home (host only, mode 0600). Appends fail loudly: an action that can't be audited doesn't happen.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditRecord {
  ts: string;
  /** "user", "auto", "agent:<id>", or "http" (front rejections). */
  actor: string;
  action: string;
  ok: boolean;
  job?: string;
  project?: string;
  target?: string;
  detail?: string;
  /** Raw remote output, clipped. */
  raw?: string;
}

export const AUDIT_RAW_MAX = 20_000;

export class AuditLog {
  /** Appends are chained so entries land in call order, even when callers don't await (the HTTP front). */
  #tail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  append(rec: Omit<AuditRecord, "ts"> & { ts?: string }): Promise<void> {
    const raw = rec.raw !== undefined && rec.raw.length > AUDIT_RAW_MAX ? `${rec.raw.slice(0, AUDIT_RAW_MAX)}\n[clipped ${rec.raw.length - AUDIT_RAW_MAX} chars]` : rec.raw;
    const line = JSON.stringify({ ts: rec.ts ?? new Date().toISOString(), ...rec, ...(raw !== undefined ? { raw } : {}) });
    const next = this.#tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${line}\n`, { mode: 0o600 });
    });
    this.#tail = next.catch(() => {});
    return next;
  }
}
