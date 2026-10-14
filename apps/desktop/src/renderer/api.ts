// Typed calls over window.cairn. The renderer only knows paths and shapes; the main process holds the connection.
import type { JobRecord } from "@cairn/shared";
import type { CairnBridge, EngineResponse } from "../shared/bridge.js";

declare global {
  interface Window {
    cairn: CairnBridge;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Tally {
  total: number;
  byProvider: Record<string, number>;
  byRole: Record<string, number>;
}

/** The parts of GET /api/status the app shows. */
export interface Status {
  machine: string;
  today: { usd: Tally; tokens: Tally };
  caps: { daily: { usd: { total?: number } } };
  providers: { name: string; routes: { route: string; auth: string; problem: string | null }[] }[];
}

export interface ProjectSummary {
  name: string;
  dataClass: string;
  current: boolean;
}

/** A claim draft on a branch of the project (GET /api/projects/:name/drafts). */
export interface Draft {
  ref: string;
  branch: string;
  title: string;
  sha256: string;
  md: string;
  review?: { verdict: "ready" | "revise" | "reject" | "unparsed"; summary: string; reviewer: string; at: string; text: string };
  approved?: { claim: string; at: string; by: string };
}

/** An entry of logic/claims.md or engine/decisions.md. */
export interface Entry {
  id: string;
  title: string;
  fields: Record<string, string>;
}

export interface Hypothesis {
  id: string;
  title: string;
  statement: string;
  status: string;
  provenance: string;
}

function unwrap<T>(r: EngineResponse): T {
  if (r.status >= 400) {
    const err = (r.body as { error?: unknown } | null)?.error;
    throw new ApiError(typeof err === "string" ? err : `HTTP ${r.status}`, r.status);
  }
  return r.body as T;
}

export function api(bridge: CairnBridge) {
  const get = async <T>(path: string) => unwrap<T>(await bridge.request({ method: "GET", path }));
  const post = async <T>(path: string, body: Record<string, unknown> = {}) => unwrap<T>(await bridge.request({ method: "POST", path, body }));
  const job = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;
  const proj = (p: string, what: string) => `/api/projects/${encodeURIComponent(p)}/${what}`;
  return {
    status: () => get<Status>("/api/status"),
    projects: async () => (await get<{ projects: ProjectSummary[] }>("/api/projects")).projects,
    jobs: async (project: string) => (await get<{ jobs: JobRecord[] }>(`/api/jobs?project=${encodeURIComponent(project)}`)).jobs,
    job: (id: string) => get<{ job: JobRecord; card: string }>(job(id)),
    approve: async (id: string, note?: string) => (await post<{ job: JobRecord }>(`${job(id)}/approve`, note ? { note } : {})).job,
    deny: async (id: string, reason: string) => (await post<{ job: JobRecord }>(`${job(id)}/deny`, { reason })).job,
    submit: async (id: string) => (await post<{ job: JobRecord }>(`${job(id)}/submit`)).job,
    refresh: async (id: string) => (await post<{ job: JobRecord }>(`${job(id)}/refresh`)).job,
    cancel: async (id: string) => (await post<{ job: JobRecord }>(`${job(id)}/cancel`)).job,
    fetch: async (id: string) => (await post<{ job: JobRecord }>(`${job(id)}/fetch`)).job,
    // the claim gate (DR-0007): check (code), review (a model, advice only), approve (the user's decision)
    drafts: async (p: string) => (await get<{ drafts: Draft[] }>(proj(p, "drafts"))).drafts,
    claims: async (p: string) => (await get<{ claims: Entry[] }>(proj(p, "claims"))).claims,
    check: (p: string, ref: string) => post<{ ok: boolean; text: string }>("/api/claims/check", { project: p, ref }),
    review: (p: string, ref: string) => post<{ text: string }>("/api/claims/review", { project: p, ref }),
    approveClaim: (p: string, ref: string, note?: string) => post<{ id: string; provenance: string; gate: string }>("/api/claims/approve", { project: p, ref, ...(note ? { note } : {}) }),
    // ledger reads
    hypotheses: async (p: string) => (await get<{ hypotheses: Hypothesis[] }>(proj(p, "hypotheses"))).hypotheses,
    tree: async (p: string) => (await get<{ text: string }>(proj(p, "tree"))).text,
    decisions: async (p: string) => (await get<{ decisions: Entry[] }>(proj(p, "decisions"))).decisions,
  };
}

export type Api = ReturnType<typeof api>;
