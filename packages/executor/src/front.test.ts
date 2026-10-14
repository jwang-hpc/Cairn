import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AuditEntry, createFront, serveFront } from "./front.js";

const token = randomBytes(32).toString("base64url");
function front() {
  const audit: AuditEntry[] = [];
  let reached = 0;
  const f = createFront({
    token,
    onAudit: (e) => audit.push(e),
    handler: async () => (reached++, new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  return { f, audit, reached: () => reached };
}
const req = (url: string, auth?: string) => new Request(url, { method: "POST", headers: auth ? { authorization: auth } : {}, body: "{}" });

describe("executor front", () => {
  it.each([
    ["no token", req("http://127.0.0.1/mcp"), 401, "missing bearer token"],
    ["wrong token", req("http://127.0.0.1/mcp", `Bearer ${randomBytes(32).toString("base64url")}`), 401, "invalid bearer token"],
    ["token prefix", req("http://127.0.0.1/mcp", `Bearer ${token.slice(0, -1)}`), 401, "invalid bearer token"],
    ["basic auth", req("http://127.0.0.1/mcp", `Basic ${token}`), 401, "invalid bearer token"],
    ["foreign Host (DNS rebinding)", req("http://attacker.example/mcp", `Bearer ${token}`), 403, "host not allowed: attacker.example"],
    ["gateway Host", req("http://192.168.128.1/mcp", `Bearer ${token}`), 403, "host not allowed: 192.168.128.1"],
    ["other path", req("http://127.0.0.1/admin", `Bearer ${token}`), 404, "not found"],
  ])("rejects %s, audits it, and never reaches MCP", async (_n, request, status, reason) => {
    const t = front();
    const res = await t.f.handle(request);
    expect(res.status).toBe(status);
    expect(t.reached()).toBe(0);
    expect(t.audit).toEqual([expect.objectContaining({ event: "reject", status, reason })]);
    expect(JSON.stringify(t.audit)).not.toContain(token);
  });

  it("passes an authorized request to the handler and audits it", async () => {
    const t = front();
    const res = await t.f.handle(req("http://localhost/mcp", `Bearer ${token}`));
    expect(res.status).toBe(200);
    expect(t.reached()).toBe(1);
    expect(t.audit).toEqual([expect.objectContaining({ event: "accept", status: 200 })]);
  });

  it("requires a strong token and survives a failing audit sink", async () => {
    expect(() => createFront({ token: "short", onAudit: () => {}, handler: async () => new Response() })).toThrow(/at least 32 bytes/);
    const f = createFront({ token, onAudit: () => { throw new Error("disk full"); }, handler: async () => new Response() });
    expect((await f.handle(req("http://127.0.0.1/mcp"))).status).toBe(401);
  });

  it.each(["0.0.0.0", "::", "192.168.128.1"])("refuses to serve on %s (loopback only)", async (host) => {
    await expect(serveFront(front().f, host)).rejects.toThrow(/loopback only/);
  });
});
