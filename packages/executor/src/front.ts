// Authenticated HTTP front for the executor's MCP servers (DR-0005, DR-0006; M0 spike 2 findings).
// Checks Host, path, and a per-session bearer token before anything reaches MCP, and audits every
// rejection. Web-standard (Request -> Response) so it is testable without sockets; serveFront() puts it
// on a loopback port. The MCP servers themselves arrive in M5.
import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface AuditEntry {
  ts: string;
  event: "reject" | "accept";
  status: number;
  reason: string;
  method: string;
  path: string;
}

export interface FrontOptions {
  /** Per-session bearer token issued by the engine (>= 32 bytes of entropy). */
  token: string;
  /** Host names the front answers to. Default: 127.0.0.1, localhost. */
  allowedHosts?: readonly string[];
  /** Path the MCP endpoint lives at. Default: /mcp. */
  path?: string;
  /** Appended to engine/audit.log by the caller (DR-0006). Never receives token values. */
  onAudit: (entry: AuditEntry) => void;
  /** Handles authorized requests (the MCP transport in M5). */
  handler: (request: Request) => Promise<Response>;
}

export interface Front {
  handle(request: Request): Promise<Response>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function createFront(opts: FrontOptions): Front {
  if (Buffer.byteLength(opts.token) < 32) throw new Error("executor token must be at least 32 bytes");
  const expected = Buffer.from(opts.token);
  const hosts = new Set(opts.allowedHosts ?? ["127.0.0.1", "localhost"]);
  const mcpPath = opts.path ?? "/mcp";
  const audit = (event: AuditEntry["event"], status: number, reason: string, req: Request, path: string) => {
    try {
      opts.onAudit({ ts: new Date().toISOString(), event, status, reason, method: req.method, path });
    } catch {
      // An audit sink failure must not open the front; requests still get their verdict.
    }
  };

  const tokenOk = (header: string | null): boolean => {
    const m = /^Bearer ([^\s]+)$/.exec(header ?? "");
    if (!m) return false;
    const got = Buffer.from(m[1]!);
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  return {
    async handle(request) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return json(400, { error: "bad request" });
      }
      const reject = (status: number, reason: string, headers?: Record<string, string>) => {
        audit("reject", status, reason, request, url.pathname);
        return json(status, { error: reason }, headers);
      };
      if (!hosts.has(url.hostname)) return reject(403, `host not allowed: ${url.hostname}`);
      if (url.pathname !== mcpPath) return reject(404, "not found");
      const auth = request.headers.get("authorization");
      if (!auth) return reject(401, "missing bearer token", { "www-authenticate": "Bearer" });
      if (!tokenOk(auth)) return reject(401, "invalid bearer token", { "www-authenticate": 'Bearer error="invalid_token"' });
      const res = await opts.handler(request);
      audit("accept", res.status, "authorized", request, url.pathname);
      return res;
    },
  };
}

/** Serve a front on one loopback address. Anything else (0.0.0.0, ::, LAN, gateway) is refused (DR-0005). */
export function serveFront(front: Front, host = "127.0.0.1", port = 0): Promise<{ url: string; port: number; close(): Promise<void>; server: Server }> {
  if (host !== "127.0.0.1" && host !== "::1") return Promise.reject(new Error(`executor front binds loopback only, not ${host}`));
  if (!isIP(host)) return Promise.reject(new Error("host must be an IP"));
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const x of [v].flat()) if (x !== undefined) headers.append(k, x);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await front.handle(
      new Request(`http://${req.headers.host ?? host}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
      } as RequestInit),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ url: `http://${host}:${p}/mcp`, port: p, server, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
