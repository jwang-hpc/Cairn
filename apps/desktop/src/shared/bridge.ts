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

/** Server-sent events from GET /api/events, as the engine sends them. */
export type EngineEvent =
  | { type: "job"; id: string; state: string; project: string }
  | { type: "engine"; event: { type?: string; run?: string; [k: string]: unknown } };

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
