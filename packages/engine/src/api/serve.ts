// Puts the engine API on a loopback port (127.0.0.1 only, DR-0005 amendment) and tells the app where it is:
// <home>/api.json, mode 0600, { url, token, pid }, removed again on close.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Api } from "./api.js";

export const API_INFO_FILE = "api.json";
const BIND = "127.0.0.1";

export interface ApiInfo {
  /** Base URL; endpoints live under /api/. */
  url: string;
  token: string;
  pid: number;
}

export interface ServedApi {
  url: string;
  port: number;
  /** <home>/api.json */
  infoPath: string;
  /** Remove api.json, end event streams, stop listening. */
  close(): Promise<void>;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export async function readApiInfo(home: string): Promise<ApiInfo | undefined> {
  try {
    const v = JSON.parse(await readFile(join(home, API_INFO_FILE), "utf8")) as Partial<ApiInfo>;
    return typeof v.url === "string" && typeof v.token === "string" && typeof v.pid === "number" ? (v as ApiInfo) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write api.json (0600, via a private temp file and rename). Refuses while another live process's API is recorded
 * there: two engines serving one home would leave the app talking to whichever wrote last.
 */
export async function writeApiInfo(home: string, info: ApiInfo): Promise<string> {
  const path = join(home, API_INFO_FILE);
  const other = await readApiInfo(home);
  if (other && other.pid !== info.pid && alive(other.pid)) throw new Error(`another engine API is running (pid ${other.pid}, ${other.url}); see ${path}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return path;
}

/** Remove api.json if it still describes this API (another engine may have replaced it). */
export async function removeApiInfo(home: string, info: Pick<ApiInfo, "token">): Promise<void> {
  if ((await readApiInfo(home))?.token === info.token) await rm(join(home, API_INFO_FILE), { force: true });
}

const HOST_HEADER = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

async function respond(api: Api, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gone = new AbortController();
  res.once("close", () => gone.abort());
  // Only origin-form targets (/path?query) and plain host[:port] Host headers make it into a URL; anything else
  // becomes a host the API refuses (and audits).
  const ok = (req.url ?? "").startsWith("/") && HOST_HEADER.test(req.headers.host ?? "");
  const url = ok ? `http://${req.headers.host}${req.url}` : "http://refused.invalid/";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) for (const x of [v].flat()) if (x !== undefined) headers.append(k, x);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let response: Response;
  try {
    response = await api.handle(
      new Request(url, {
        method: req.method ?? "GET",
        headers,
        signal: gone.signal,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
      } as RequestInit),
    );
  } catch {
    response = new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  res.once("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      res.write(value);
    }
  } catch {
    // the stream was cancelled (client gone) or failed; end the response either way
  } finally {
    res.end();
  }
}

/** Serve the API on 127.0.0.1 (port 0: any free port) and write <home>/api.json for the app. */
export async function serveApi(api: Api, opts: { port?: number } = {}): Promise<ServedApi> {
  const server = createServer((req, res) => void respond(api, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, BIND, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
  const stop = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  api.expectPort(port);
  const url = `http://${BIND}:${port}`;
  let infoPath: string;
  try {
    infoPath = await writeApiInfo(api.home, { url, token: api.token, pid: process.pid });
  } catch (e) {
    await stop();
    throw e;
  }
  let closing: Promise<void> | undefined;
  return {
    url,
    port,
    infoPath,
    close: () =>
      (closing ??= (async () => {
        await removeApiInfo(api.home, { token: api.token });
        await api.close();
        await stop();
      })()),
  };
}
