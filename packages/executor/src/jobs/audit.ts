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
  constructor(readonly path: string) {}

  async append(rec: Omit<AuditRecord, "ts"> & { ts?: string }): Promise<void> {
    const raw = rec.raw !== undefined && rec.raw.length > AUDIT_RAW_MAX ? `${rec.raw.slice(0, AUDIT_RAW_MAX)}\n[clipped ${rec.raw.length - AUDIT_RAW_MAX} chars]` : rec.raw;
    const line = JSON.stringify({ ts: rec.ts ?? new Date().toISOString(), ...rec, ...(raw !== undefined ? { raw } : {}) });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${line}\n`, { mode: 0o600 });
  }
}
