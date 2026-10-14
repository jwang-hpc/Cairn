// Engine-owned egress proxy for one agent network (DR-0005 amendment). Agents have no DNS and no route out;
// the only way out is an HTTPS CONNECT tunnel through this proxy to an allowlisted domain. Every decision is
// reported so it lands in the event log.
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";

export interface EgressDecision {
  decision: "allow" | "deny";
  /** What was asked for: "host:port" for CONNECT, "METHOD url" for plain HTTP. */
  target: string;
  reason: string;
}

export interface EgressProxyOptions {
  /** Allowed domains; subdomains match too ("pypi.org" allows "files.pypi.org"). */
  allow: readonly string[];
  /** Allowed destination ports. Default: 443 only. */
  ports?: readonly number[];
  /** Name resolution on the host. Default: dns.lookup. */
  resolve?: (host: string) => Promise<string>;
  /** Open the upstream connection to an already-vetted IP. */
  connect?: (ip: string, port: number) => Promise<Duplex>;
  onDecision?: (d: EgressDecision) => void;
}

/** Addresses an allowlisted name must never resolve to (SSRF / DNS-rebinding guard). */
const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv4");
// No ::ffff:0:0/96 rule: BlockList already checks IPv4-mapped IPv6 addresses against the IPv4 rules, and
// such a rule would also match (and block) every plain IPv4 address.
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  NON_PUBLIC.addSubnet(net, bits, "ipv6");
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return !NON_PUBLIC.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function matchAllowlist(host: string, allow: readonly string[]): boolean {
  const h = normalizeHost(host);
  return allow.some((d) => {
    const a = normalizeHost(d);
    return h === a || h.endsWith(`.${a}`);
  });
}

const defaultResolve = async (host: string) => (await lookup(host, { verbatim: true })).address;
const defaultConnect = (ip: string, port: number) =>
  new Promise<Duplex>((resolve, reject) => {
    const s = netConnect({ host: ip, port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });

export class EgressProxy {
  readonly server: Server;
  readonly #allow: readonly string[];
  readonly #ports: readonly number[];
  readonly #resolve: (host: string) => Promise<string>;
  readonly #connect: (ip: string, port: number) => Promise<Duplex>;
  readonly #onDecision: (d: EgressDecision) => void;

  constructor(opts: EgressProxyOptions) {
    this.#allow = opts.allow.map(normalizeHost);
    this.#ports = opts.ports ?? [443];
    this.#resolve = opts.resolve ?? defaultResolve;
    this.#connect = opts.connect ?? defaultConnect;
    this.#onDecision = opts.onDecision ?? (() => {});
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.handleConnect(req.url ?? "", socket, head));
    this.server.on("clientError", (_e, socket) => socket.destroy());
  }

  /** Listen on one specific address (the agent network's gateway). Wildcard addresses are refused. */
  listen(host: string, port = 0): Promise<{ url: string; port: number }> {
    if (!isIP(host) || host === "0.0.0.0" || host === "::") {
      return Promise.reject(new Error(`egress proxy must bind one specific IP, not ${JSON.stringify(host)}`));
    }
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        resolve({ url: `http://${host.includes(":") ? `[${host}]` : host}:${p}`, port: p });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  #decide(d: EgressDecision): EgressDecision {
    try {
      this.#onDecision(d);
    } catch {
      // Logging failures must not open or wedge the proxy.
    }
    return d;
  }

  /** Plain HTTP (non-CONNECT) is never forwarded. */
  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const d = this.#decide({ decision: "deny", target: `${req.method} ${req.url}`, reason: "plain HTTP is not allowed; use HTTPS" });
    res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(`${d.reason}\n`);
  }

  /** Vet a CONNECT target; tunnel if allowed. Exposed for tests (no socket binding needed). */
  async handleConnect(target: string, client: Duplex, head: Buffer = Buffer.alloc(0)): Promise<EgressDecision> {
    const deny = (reason: string) => {
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`);
      return this.#decide({ decision: "deny", target, reason });
    };
    client.on("error", () => {});

    const m = /^(.+):(\d{1,5})$/.exec(target);
    if (!m) return deny("malformed CONNECT target");
    const [, rawHost, rawPort] = m;
    const port = Number(rawPort);
    if (!this.#ports.includes(port)) return deny(`port ${port} is not allowed`);
    const host = normalizeHost(rawHost!);
    if (isIP(host) || host.startsWith("[")) return deny("IP addresses are not allowed; use a domain name");
    if (!matchAllowlist(host, this.#allow)) return deny(`${host} is not on this role's allowlist`);

    let ip: string;
    try {
      ip = await this.#resolve(host);
    } catch (e) {
      return deny(`could not resolve ${host}: ${(e as Error).message}`);
    }
    if (!isPublicAddress(ip)) return deny(`${host} resolves to non-public address ${ip}`);

    let upstream: Duplex;
    try {
      upstream = await this.#connect(ip, port); // the vetted IP, never a second lookup
    } catch (e) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return this.#decide({ decision: "deny", target, reason: `upstream connect failed: ${(e as Error).message}` });
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.pipe(client).pipe(upstream);
    return this.#decide({ decision: "allow", target, reason: `${host} -> ${ip}` });
  }
}
