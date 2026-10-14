import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC } from "../shared/bridge.js";
import { checkRequest, connectEngine, EngineClient, readApiInfo, sseParser } from "./engine.js";

const TOKEN = "t".repeat(43);
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-app-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const writeInfo = (info: unknown) => writeFile(join(home, "api.json"), JSON.stringify(info));

/** A fake engine API: answers /api/status for the right token, records requests. */
function fakeApi(token = TOKEN) {
  const seen: { method: string; url: string; auth: string | null; body: string | null }[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("authorization");
    seen.push({ method: init.method ?? "GET", url, auth, body: typeof init.body === "string" ? init.body : null });
    if (auth !== `Bearer ${token}`) return new Response(JSON.stringify({ error: "invalid bearer token" }), { status: 401 });
    if (url.endsWith("/api/status")) return new Response(JSON.stringify({ machine: "mac" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, path: new URL(url).pathname }), { status: 200 });
  }) as typeof fetch;
  return { f, seen };
}

describe("api.json", () => {
  it("is read only when it names a loopback http API and a real token", async () => {
    expect(await readApiInfo(home)).toBeUndefined();
    await writeInfo({ url: "http://127.0.0.1:4321", token: TOKEN, pid: 9 });
    expect(await readApiInfo(home)).toEqual({ url: "http://127.0.0.1:4321", token: TOKEN, pid: 9 });
    for (const bad of [{ url: "http://evil.example:80", token: TOKEN }, { url: "https://127.0.0.1:1", token: TOKEN }, { url: "http://127.0.0.1:1", token: "short" }, { url: 5, token: TOKEN }]) {
      await writeInfo(bad);
      expect(await readApiInfo(home), JSON.stringify(bad)).toBeUndefined();
    }
    await writeFile(join(home, "api.json"), "{not json");
    expect(await readApiInfo(home)).toBeUndefined();
  });
});

describe("checkRequest (what the renderer may ask the main process to send)", () => {
  it("allows GET and POST under /api/ with a JSON object body", () => {
    expect(checkRequest({ method: "GET", path: "/api/status" })).toEqual({ method: "GET", path: "/api/status" });
    expect(checkRequest({ method: "GET", path: "/api/jobs?project=demo" }).path).toBe("/api/jobs?project=demo");
    expect(checkRequest({ method: "POST", path: "/api/jobs/20261014-1251-c30f/deny", body: { reason: "too big" } }).body).toEqual({ reason: "too big" });
  });
  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      { method: "PUT", path: "/api/status" },
      { method: "GET", path: "http://evil.example/api/status" },
      { method: "GET", path: "//evil.example/api/status" },
      { method: "GET", path: "/api/../admin" },
      { method: "GET", path: "/api/%2e%2e/x" },
      { method: "GET", path: "/other" },
      { method: "GET", path: "/api/events" },
      { method: "GET", path: "/api/status", body: {} },
      { method: "POST", path: "/api/x", body: [1] },
      { method: "POST", path: "/api/x", body: "s" },
      { method: "GET", path: `/api/${"a".repeat(600)}` },
      { method: "GET", path: "/api/jobs?project=<script>" },
    ];
    for (const b of bad) expect(() => checkRequest(b), JSON.stringify(b)).toThrow();
  });
});

describe("EngineClient", () => {
  it("sends the token, JSON bodies, and parses JSON answers", async () => {
    const api = fakeApi();
    const c = new EngineClient({ url: "http://127.0.0.1:4321", token: TOKEN }, api.f);
    expect(await c.request({ method: "POST", path: "/api/jobs/x/approve", body: { note: "ok" } })).toEqual({ status: 200, body: { ok: true, path: "/api/jobs/x/approve" } });
    expect(api.seen[0]).toEqual({ method: "POST", url: "http://127.0.0.1:4321/api/jobs/x/approve", auth: `Bearer ${TOKEN}`, body: '{"note":"ok"}' });
    expect(await c.alive()).toBe(true);
    expect(await new EngineClient({ url: "http://127.0.0.1:4321", token: "x".repeat(43) }, api.f).alive()).toBe(false);
  });

  it("turns the event stream into job and engine events", async () => {
    const chunks = [": heartbeat\n\n", 'event: job\ndata: {"type":"job","id":"j1","state":"running","project":"demo"}\n', "\nevent: engine\r\ndata: ", '{"type":"engine","event":{"type":"usage"}}\r\n\r\n', "event: other\ndata: {}\n\n", "event: job\ndata: not-json\n\n"];
    const f = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const got: unknown[] = [];
    await new EngineClient({ url: "http://127.0.0.1:1", token: TOKEN }, f).events((e) => got.push(e), new AbortController().signal);
    expect(got).toEqual([{ type: "job", id: "j1", state: "running", project: "demo" }, { type: "engine", event: { type: "usage" } }]);
  });

  it("parses SSE split anywhere, with multi-line data", () => {
    const got: [string, string][] = [];
    const feed = sseParser((e, d) => got.push([e, d]));
    for (const ch of "event: a\ndata: 1\ndata: 2\n\ndata: plain\n\n") feed(ch);
    expect(got).toEqual([["a", "1\n2"], ["message", "plain"]]);
  });
});

describe("connectEngine", () => {
  function fakeChild(onStart?: () => void) {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const killed: string[] = [];
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (s: string) => (killed.push(s), true) });
    onStart?.();
    return { child, killed };
  }

  it("uses a live engine from api.json without starting one", async () => {
    await writeInfo({ url: "http://127.0.0.1:4321", token: TOKEN });
    let started = 0;
    const r = await connectEngine({ repo: "/repo", home, env: {}, fetchFn: fakeApi().f, start: () => (started++, fakeChild().child) });
    expect(r.child).toBeUndefined();
    expect(r.client.info.url).toBe("http://127.0.0.1:4321");
    expect(started).toBe(0);
  });

  it("starts re serve when there is none (or api.json is stale) and waits for its api.json", async () => {
    await writeInfo({ url: "http://127.0.0.1:4321", token: "s".repeat(43) }); // stale: that token is refused
    const NEW = "n".repeat(43);
    const { child } = fakeChild();
    let polls = 0;
    const r = await connectEngine({
      repo: "/repo",
      home,
      env: {},
      fetchFn: fakeApi(NEW).f,
      start: () => child,
      sleep: async () => {
        if (++polls === 2) await writeInfo({ url: "http://127.0.0.1:5555", token: NEW });
      },
    });
    expect(r.child).toBe(child);
    expect(r.client.info).toEqual({ url: "http://127.0.0.1:5555", token: NEW });
  });

  it("reports an engine that exits, and stops one that never comes up", async () => {
    const dead = fakeChild();
    const p = connectEngine({
      repo: "/repo",
      home,
      env: {},
      fetchFn: fakeApi().f,
      start: () => dead.child,
      sleep: async () => {
        dead.child.stderr?.emit("data", Buffer.from("re serve: binding a local port was refused\n"));
        dead.child.emit("exit", 1);
      },
    });
    await expect(p).rejects.toThrow(/re serve exited \(1\): re serve: binding a local port was refused/);
    const slow = fakeChild();
    await expect(connectEngine({ repo: "/repo", home, env: {}, fetchFn: fakeApi().f, start: () => slow.child, waitMs: 1, sleep: async () => new Promise((r) => setTimeout(r, 5)) })).rejects.toThrow(/did not come up/);
    expect(slow.killed).toEqual(["SIGTERM"]);
  });
});

describe("preload", () => {
  it("spells the IPC channels exactly as the main process does", async () => {
    const src = await readFile(join(import.meta.dirname, "..", "preload", "preload.cts"), "utf8");
    for (const ch of Object.values(IPC)) expect(src).toContain(`"${ch}"`);
    expect(src).toContain('contextBridge.exposeInMainWorld("cairn", bridge)');
  });
});
