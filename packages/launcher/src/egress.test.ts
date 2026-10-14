import { duplexPair, type Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { type EgressDecision, EgressProxy, isPublicAddress, matchAllowlist } from "./egress.js";

/** Collect everything written to one end of an in-memory socket. */
function reader(s: Duplex) {
  let buf = "";
  s.on("data", (d: Buffer) => (buf += d.toString()));
  return () => buf;
}
const tick = () => new Promise((r) => setTimeout(r, 10));

function proxy(opts: { resolveTo?: string | Error; connectFails?: boolean; allow?: string[] } = {}) {
  const decisions: EgressDecision[] = [];
  const upstreams: Duplex[] = [];
  const connected: string[] = [];
  const p = new EgressProxy({
    allow: opts.allow ?? ["pypi.org", "files.pythonhosted.org"],
    onDecision: (d) => decisions.push(d),
    resolve: async () => {
      if (opts.resolveTo instanceof Error) throw opts.resolveTo;
      return opts.resolveTo ?? "151.101.0.223";
    },
    connect: async (ip, port) => {
      if (opts.connectFails) throw new Error("ECONNREFUSED");
      connected.push(`${ip}:${port}`);
      const [proxySide, remote] = duplexPair();
      upstreams.push(remote);
      return proxySide;
    },
  });
  return { p, decisions, upstreams, connected };
}

async function connectThrough(p: EgressProxy, target: string) {
  const [proxySide, agentSide] = duplexPair();
  const read = reader(agentSide);
  const decision = await p.handleConnect(target, proxySide);
  await tick();
  return { decision, read, agentSide };
}

describe("EgressProxy CONNECT", () => {
  it("tunnels an allowlisted domain to the IP it vetted", async () => {
    const t = proxy();
    const { decision, read, agentSide } = await connectThrough(t.p, "pypi.org:443");
    expect(decision).toEqual({ decision: "allow", target: "pypi.org:443", reason: "pypi.org -> 151.101.0.223" });
    expect(t.connected).toEqual(["151.101.0.223:443"]);
    expect(read()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    const upstreamRead = reader(t.upstreams[0]!);
    agentSide.write("client hello");
    t.upstreams[0]!.write("server hello");
    await tick();
    expect(upstreamRead()).toBe("client hello");
    expect(read()).toContain("server hello");
  });

  it.each([
    ["example.com:443", "example.com is not on this role's allowlist"],
    ["evilpypi.org:443", "evilpypi.org is not on this role's allowlist"],
    ["pypi.org.evil.com:443", "pypi.org.evil.com is not on this role's allowlist"],
    ["pypi.org:80", "port 80 is not allowed"],
    ["pypi.org:22", "port 22 is not allowed"],
    ["1.1.1.1:443", "IP addresses are not allowed; use a domain name"],
    ["[::1]:443", "IP addresses are not allowed; use a domain name"],
    ["pypi.org", "malformed CONNECT target"],
  ])("denies %s", async (target, reason) => {
    const t = proxy();
    const { decision, read } = await connectThrough(t.p, target);
    expect(decision).toEqual({ decision: "deny", target, reason });
    expect(read()).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(t.connected).toEqual([]);
    expect(t.decisions).toHaveLength(1);
  });

  it("allows subdomains of an allowlisted domain, case- and trailing-dot-insensitive", async () => {
    for (const target of ["files.pypi.org:443", "PyPI.org.:443"]) {
      expect((await connectThrough(proxy().p, target)).decision.decision).toBe("allow");
    }
  });

  it.each(["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.64.1", "::1", "::ffff:127.0.0.1", "fd00::1"])(
    "denies an allowlisted name that resolves to non-public %s (SSRF / rebinding guard)",
    async (ip) => {
      const t = proxy({ resolveTo: ip });
      const { decision } = await connectThrough(t.p, "pypi.org:443");
      expect(decision).toMatchObject({ decision: "deny", reason: `pypi.org resolves to non-public address ${ip}` });
      expect(t.connected).toEqual([]);
    },
  );

  it("denies when resolution or the upstream connection fails", async () => {
    expect((await connectThrough(proxy({ resolveTo: new Error("ENOTFOUND") }).p, "pypi.org:443")).decision.reason).toBe(
      "could not resolve pypi.org: ENOTFOUND",
    );
    const failed = await connectThrough(proxy({ connectFails: true }).p, "pypi.org:443");
    expect(failed.decision).toMatchObject({ decision: "deny", reason: "upstream connect failed: ECONNREFUSED" });
    expect(failed.read()).toMatch(/^HTTP\/1\.1 502/);
  });

  it("keeps working when the decision logger throws", async () => {
    const p = new EgressProxy({ allow: ["pypi.org"], onDecision: () => { throw new Error("disk full"); } });
    const { decision } = await connectThrough(p, "example.com:443");
    expect(decision.decision).toBe("deny");
  });
});

describe("EgressProxy plain HTTP and binding", () => {
  it("refuses plain HTTP requests and logs them", () => {
    const t = proxy();
    let status = 0;
    let body = "";
    const res = { writeHead: (s: number) => ((status = s), res), end: (b: string) => (body = b) };
    t.p.handleRequest({ method: "GET", url: "http://example.com/" } as never, res as never);
    expect(status).toBe(403);
    expect(body).toContain("plain HTTP is not allowed");
    expect(t.decisions).toEqual([{ decision: "deny", target: "GET http://example.com/", reason: "plain HTTP is not allowed; use HTTPS" }]);
  });

  it.each(["0.0.0.0", "::", "localhost", ""])("refuses to listen on %j (must be one specific gateway IP)", async (host) => {
    await expect(proxy().p.listen(host)).rejects.toThrow(/must bind one specific IP/);
  });
});

describe("helpers", () => {
  it("isPublicAddress", () => {
    expect(isPublicAddress("151.101.0.223")).toBe(true);
    expect(isPublicAddress("2a04:4e42::223")).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true); // mapped public stays public
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false); // mapped private stays private
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.128.1", "100.64.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "not-an-ip"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });
  it("matchAllowlist", () => {
    expect(matchAllowlist("files.pythonhosted.org", ["files.pythonhosted.org"])).toBe(true);
    expect(matchAllowlist("pythonhosted.org", ["files.pythonhosted.org"])).toBe(false);
  });
});
