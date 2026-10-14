// The engine connection, in the main process only (no Electron imports here, so it is testable in Node). It finds
// a running engine API through <home>/api.json, or starts `re serve` and waits for it; holds the bearer token;
// forwards the renderer's requests after checking them; and turns GET /api/events into events.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EngineEvent, EngineRequest, EngineResponse } from "../shared/bridge.js";

export interface ApiInfo {
  url: string;
  token: string;
  pid?: number;
}

/** <repo>/apps/desktop/dist/main -> <repo>. The app runs from the repository for now (no packaging yet). */
export const repoRoot = (here: string) => resolve(here, "..", "..", "..", "..");

/** The engine home, as the engine resolves it (packages/engine/src/paths.ts): CAIRN_HOME, else <repo>/.engine. */
export const engineHome = (repo: string, env: NodeJS.ProcessEnv) => resolve(env.CAIRN_HOME ?? join(repo, ".engine"));

/** <home>/api.json written by `re serve`, if it is there and well-formed. */
export async function readApiInfo(home: string): Promise<ApiInfo | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(home, "api.json"), "utf8"));
  } catch {
    return undefined;
  }
  const r = raw as Partial<ApiInfo>;
  if (typeof r.url !== "string" || typeof r.token !== "string" || r.token.length < 32) return undefined;
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return undefined;
  }
  // The engine API only ever listens on loopback; anything else in api.json is not ours to send a token to.
  if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) return undefined;
  return { url: u.origin, token: r.token, ...(typeof r.pid === "number" ? { pid: r.pid } : {}) };
}

const PATH = /^\/api\/[A-Za-z0-9._~%/-]*$/;

/** What the renderer may ask for: GET or POST under /api/ (no events stream, no dot segments), a JSON object body. */
export function checkRequest(r: unknown): EngineRequest {
  const q = r as Partial<EngineRequest> | null;
  if (!q || (q.method !== "GET" && q.method !== "POST")) throw new Error("method must be GET or POST");
  if (typeof q.path !== "string" || q.path.length > 500) throw new Error("bad path");
  const [path, query = ""] = q.path.split("?", 2) as [string, string?];
  if (!PATH.test(path) || path.split("/").some((s) => s === "." || s === "..") || /%2e|%2f/i.test(path)) throw new Error(`bad path ${path}`);
  if (path === "/api/events") throw new Error("events come through subscribe()");
  if (query && !/^[A-Za-z0-9._~%=&+-]*$/.test(query)) throw new Error("bad query");
  if (q.body !== undefined && (typeof q.body !== "object" || q.body === null || Array.isArray(q.body))) throw new Error("body must be a JSON object");
  if (q.method === "GET" && q.body !== undefined) throw new Error("GET takes no body");
  return { method: q.method, path: q.path, ...(q.body !== undefined ? { body: q.body } : {}) };
}

export class EngineClient {
  constructor(
    readonly info: ApiInfo,
    readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(r: EngineRequest, signal?: AbortSignal): Promise<EngineResponse> {
    const res = await this.fetchFn(new URL(r.path, this.info.url), {
      method: r.method,
      headers: { authorization: `Bearer ${this.info.token}`, ...(r.body ? { "content-type": "application/json" } : {}) },
      ...(r.body ? { body: JSON.stringify(r.body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: `not JSON (HTTP ${res.status})` };
    }
    return { status: res.status, body };
  }

  /** True if the API answers with this token. */
  async alive(): Promise<boolean> {
    try {
      return (await this.request({ method: "GET", path: "/api/status" }, AbortSignal.timeout(5000))).status === 200;
    } catch {
      return false;
    }
  }

  /** Follow GET /api/events until the signal aborts or the stream ends (resolves then). */
  async events(onEvent: (e: EngineEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await this.fetchFn(new URL("/api/events", this.info.url), { headers: { authorization: `Bearer ${this.info.token}`, accept: "text/event-stream" }, signal });
    if (res.status !== 200 || !res.body) throw new Error(`events: HTTP ${res.status}`);
    const parser = sseParser((name, data) => {
      if (name !== "job" && name !== "engine" && name !== "session") return;
      try {
        onEvent(JSON.parse(data) as EngineEvent);
      } catch {
        // a malformed event is dropped, not fatal
      }
    });
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) parser(decoder.decode(chunk, { stream: true }));
  }
}

/** Incremental SSE parser (event + data fields; comments and heartbeats ignored). */
export function sseParser(emit: (event: string, data: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === "\r" ? 4 : 2));
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        const [k, ...rest] = line.split(":");
        const v = rest.join(":").replace(/^ /, "");
        if (k === "event") event = v;
        else if (k === "data") data.push(v);
      }
      if (data.length) emit(event, data.join("\n"));
    }
    if (buf.length > 1 << 20) buf = ""; // a runaway block: drop it rather than grow without bound
  };
}

export interface ConnectOptions {
  repo: string;
  home: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Start `re serve` (default: node <repo>/packages/engine/dist/bin.js serve). */
  start?: () => ChildProcess;
  /** How long to wait for a started engine to write api.json. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Connect to the engine: a live API in <home>/api.json is used as is; otherwise the app starts `re serve` itself
 * (and stops it when the app quits). The token stays in this process.
 */
export async function connectEngine(o: ConnectOptions): Promise<{ client: EngineClient; child?: ChildProcess }> {
  const fetchFn = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const existing = await readApiInfo(o.home);
  if (existing) {
    const c = new EngineClient(existing, fetchFn);
    if (await c.alive()) return { client: c };
  }
  const child = (o.start ?? (() => spawn(o.env.CAIRN_NODE ?? "node", [join(o.repo, "packages", "engine", "dist", "bin.js"), "serve"], { cwd: o.repo, env: o.env, stdio: ["ignore", "pipe", "pipe"] })))();
  let output = "";
  child.stdout?.on("data", (d: Buffer) => void (output = (output + d.toString()).slice(-4000)));
  child.stderr?.on("data", (d: Buffer) => void (output = (output + d.toString()).slice(-4000)));
  let exited: number | null | undefined;
  child.on("exit", (code) => void (exited = code));
  const deadline = Date.now() + (o.waitMs ?? 20_000);
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`re serve exited (${exited}): ${output.trim().split("\n").slice(-3).join(" / ")}`);
    const info = await readApiInfo(o.home);
    if (info && info.token !== existing?.token) {
      const c = new EngineClient(info, fetchFn);
      if (await c.alive()) return { client: c, child };
    }
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Error(`re serve did not come up within ${Math.round((o.waitMs ?? 20_000) / 1000)} s: ${output.trim().split("\n").slice(-3).join(" / ")}`);
}
