// Typed calls over window.cairn. The renderer only knows paths and shapes; the main process holds the connection.
import type { JobRecord } from "@cairn/shared";
import type { CairnBridge, EngineResponse, Proposal } from "../shared/bridge.js";

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

export interface SessionMeta {
  id: string;
  project: string;
  title: string;
  created: string;
  updated: string;
  turns: number;
}

/** One line of a session's transcript (engine: session/store.ts). */
export type TranscriptEntry =
  | { at: string; kind: "user"; text: string }
  | { at: string; kind: "assistant"; text: string; run: string; ms: number; usd?: number; error?: string }
  | { at: string; kind: "tool"; run: string; name: string; text: string; isError: boolean }
  | { at: string; kind: "proposal"; proposal: Proposal }
  | { at: string; kind: "system"; text: string };

export interface SessionView {
  session: SessionMeta;
  summary: string | null;
  proposals: Proposal[];
  transcript: TranscriptEntry[];
  workers: { running: number; queued: number };
}

export interface FileEntry {
  path: string;
  bytes: number;
}

export type FileContent =
  | { path: string; bytes: number; kind: "text"; text: string }
  | { path: string; bytes: number; kind: "image" | "pdf"; mime: string; base64: string }
  | { path: string; bytes: number; kind: "binary" };

export interface PaperNote {
  path: string;
  key: string;
  paper: string;
  relevance?: number;
  title?: string;
  year?: number;
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
    // research sessions (DR-0014)
    sessions: (p: string) => get<{ sessions: SessionMeta[]; workers: { running: number; queued: number } }>(proj(p, "sessions")),
    newSession: async (p: string, title?: string) => (await post<{ session: SessionMeta }>(proj(p, "sessions"), title ? { title } : {})).session,
    session: (p: string, id: string) => get<SessionView>(proj(p, `sessions/${encodeURIComponent(id)}`)),
    send: (p: string, id: string, text: string) =>
      post<{ text: string; run: string; usd: number; ms: number; error: string | null; proposals: Proposal[] }>(proj(p, `sessions/${encodeURIComponent(id)}/messages`), { text }),
    proposal: async (p: string, id: string, pid: string, action: "launch" | "dismiss" | "stop") =>
      (await post<{ proposal: Proposal }>(proj(p, `sessions/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/${action}`))).proposal,
    steps: async (run: string) => (await get<{ steps: { at: string; step: string }[] }>(`/api/runs/${encodeURIComponent(run)}/steps`)).steps,
    // project files and literature
    files: (p: string, dir = "") => get<{ files: FileEntry[]; truncated: boolean }>(`${proj(p, "files")}${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
    file: async (p: string, path: string) => (await get<{ file: FileContent }>(`${proj(p, "file")}?path=${encodeURIComponent(path)}`)).file,
    literature: (p: string) => get<{ notes: PaperNote[]; references: number }>(proj(p, "literature")),
  };
}

export type Api = ReturnType<typeof api>;
