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
  };
}

export type Api = ReturnType<typeof api>;
