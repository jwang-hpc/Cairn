// Cairn desktop app, main process (M8). Thin client (DR-0002): one window over the engine API. The renderer is
// sandboxed with context isolation and no Node; it reaches the engine only through window.cairn (preload), and every
// request is checked here and sent with a bearer token the renderer never sees. Built pages load from cairn-app://
// with a strict CSP; navigation, new windows, and permission requests are refused.
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain, protocol, session } from "electron";
import { type EngineConnection, type EngineEvent, IPC } from "../shared/bridge.js";
import { checkRequest, connectEngine, type EngineClient, engineHome, repoRoot } from "./engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const REPO = repoRoot(here);
const RENDERER_DIR = join(here, "..", "renderer");
const PRELOAD = join(here, "..", "preload", "preload.cjs");
/** Dev only: the Vite dev server (scripts/dev.mjs sets it). */
const DEV_URL = process.env.CAIRN_RENDERER_URL;
const SCHEME = "cairn-app";
const APP_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : `${SCHEME}://ui`;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
// Vite's dev server needs inline scripts (React refresh) and its websocket; only ever applied to DEV_URL.
const DEV_CSP = DEV_URL ? `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${new URL(DEV_URL).host}` : "";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// supportFetchAPI/corsEnabled: module scripts load through the fetch path; the page's CSP still allows no connections.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let win: BrowserWindow | undefined;
let client: EngineClient | undefined;
let stopEngine: (() => void) | undefined;
let connection: EngineConnection = { state: "connecting", detail: "looking for the engine" };
const eventsAbort = new AbortController();

function setConnection(c: EngineConnection): void {
  connection = c;
  win?.webContents.send(IPC.connectionChanged, c);
}

/** Only our own page, in its main frame, may talk to the engine. */
function fromApp(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  if (!win || !frame || frame !== win.webContents.mainFrame) return false;
  try {
    return new URL(frame.url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

async function serveRenderer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.host !== "ui") return new Response("not found", { status: 404 });
  const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^[/\\]+/, "");
  const file = join(RENDERER_DIR, rel);
  if (!file.startsWith(RENDERER_DIR + sep)) return new Response("not found", { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Cairn",
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, target) => {
    if (new URL(target).origin !== APP_ORIGIN) e.preventDefault();
  });
  win.on("closed", () => void (win = undefined));
  void win.loadURL(DEV_URL ?? `${SCHEME}://ui/index.html`);
}

async function followEvents(): Promise<void> {
  // Reconnect with backoff while the app runs; job and engine events go to the window as they come.
  for (let delay = 1000; !eventsAbort.signal.aborted; delay = Math.min(delay * 2, 30_000)) {
    if (client) {
      try {
        await client.events((e: EngineEvent) => win?.webContents.send(IPC.event, e), eventsAbort.signal);
        delay = 1000;
      } catch {
        if (eventsAbort.signal.aborted) return;
        if (!(await client.alive())) setConnection({ state: "failed", detail: "the engine API stopped answering" });
      }
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function connect(): Promise<void> {
  const home = engineHome(REPO, process.env);
  setConnection({ state: "connecting", detail: `looking for the engine in ${home}` });
  try {
    const r = await connectEngine({ repo: REPO, home, env: process.env });
    client = r.client;
    if (r.child) {
      const child = r.child;
      stopEngine = () => void child.kill("SIGTERM");
    }
    setConnection({ state: "connected", url: client.info.url, startedByApp: r.child !== undefined });
    void followEvents();
  } catch (e) {
    setConnection({ state: "failed", detail: (e as Error).message });
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => win?.focus());
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (DEV_URL) {
      session.defaultSession.webRequest.onHeadersReceived({ urls: [`${new URL(DEV_URL).origin}/*`] }, (d, cb) =>
        cb({ responseHeaders: { ...d.responseHeaders, "content-security-policy": [DEV_CSP] } }),
      );
    } else protocol.handle(SCHEME, serveRenderer);

    ipcMain.handle(IPC.connection, (e) => (fromApp(e) ? connection : { state: "failed", detail: "refused" }));
    ipcMain.handle(IPC.request, async (e, raw: unknown) => {
      if (!fromApp(e)) return { status: 403, body: { error: "refused: not the app's page" } };
      if (!client) return { status: 503, body: { error: connection.state === "failed" ? connection.detail : "not connected to the engine yet" } };
      let r;
      try {
        r = checkRequest(raw);
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
      try {
        return await client.request(r);
      } catch (err) {
        return { status: 502, body: { error: `engine unreachable: ${(err as Error).message}` } };
      }
    });
    createWindow();
    void connect();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    eventsAbort.abort();
    stopEngine?.();
  });
}
