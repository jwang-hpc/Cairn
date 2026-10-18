// The app's only door to the engine (DR-0002: the app is a thin client over the engine API). The renderer never
// sees the API's bearer token or URL: it asks the main process, which checks each request and forwards it.

/** A request the renderer may send: GET or POST under /api/, JSON body. */
export interface EngineRequest {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

export interface EngineResponse {
  status: number;
  /** Parsed JSON (the API always answers JSON; errors are { error: string }). */
  body: unknown;
}

export type EngineConnection =
  | { state: "connecting"; detail: string }
  | { state: "connected"; url: string; startedByApp: boolean }
  | { state: "failed"; detail: string };

/** A proposal card in a research session (engine: packages/engine/src/session/store.ts). */
export interface Proposal {
  id: string;
  kind: "task" | "decision";
  title: string;
  role?: string;
  task?: string;
  files?: string[];
  rationale?: string;
  refs?: string[];
  state: "proposed" | "queued" | "running" | "done" | "failed" | "needs_input" | "stopped" | "dismissed" | "recorded";
  created: string;
  updated: string;
  run?: string;
  recorded?: string;
  outcome?: {
    status: string;
    summary: string;
    branch?: string;
    commit?: string;
    files: string[];
    questions: string[];
    jobs: string[];
    drafts: string[];
    literature: boolean;
    error?: string;
    usd?: number;
  };
}

/** Research-session events (DR-0014), pushed by the engine as they happen. */
export type SessionEvent =
  | { type: "turn_delta"; project: string; session: string; text: string }
  | { type: "turn_tool"; project: string; session: string; name: string; detail: string }
  | { type: "turn_end"; project: string; session: string; run: string; usd: number; error: string | null }
  | { type: "proposal"; project: string; session: string; proposal: Proposal }
  | { type: "worker_step"; project: string; session: string; proposal: string; run: string; at: string; step: string };

/** Server-sent events from GET /api/events, as the engine sends them. */
export type EngineEvent =
  | { type: "job"; id: string; state: string; project: string }
  | { type: "engine"; event: { type?: string; run?: string; [k: string]: unknown } }
  | SessionEvent;

/** window.cairn, exposed by the preload script. */
export interface CairnBridge {
  request(r: EngineRequest): Promise<EngineResponse>;
  connection(): Promise<EngineConnection>;
  /** Try to connect again (after a failure: e.g. the config was fixed, or re serve was started by hand). */
  reconnect(): Promise<EngineConnection>;
  /** Subscribe to engine events and connection changes; returns an unsubscribe function. */
  subscribe(handlers: { event?: (e: EngineEvent) => void; connection?: (c: EngineConnection) => void }): () => void;
}

export const IPC = {
  request: "cairn:request",
  connection: "cairn:connection",
  reconnect: "cairn:reconnect",
  event: "cairn:event",
  connectionChanged: "cairn:connection-changed",
} as const;
