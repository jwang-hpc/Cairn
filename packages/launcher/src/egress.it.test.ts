// Real-socket egress check against Apple `container`. Skipped unless CAIRN_CONTAINER_IT=1.
//   CAIRN_CONTAINER_IT=1 pnpm vitest run packages/launcher/src/egress.it.test.ts
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RolesConfig } from "@cairn/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EgressDecision, EgressProxy } from "./egress.js";
import { prepareMounts } from "./mounts.js";
import { specForRole } from "./policy.js";
import { ContainerRuntime, type NetworkInfo } from "./runtime.js";

const IT = process.env.CAIRN_CONTAINER_IT === "1";
const IMAGE = process.env.CAIRN_AGENT_IMAGE ?? "docker.io/library/python:3.12-slim";
const PROXY_PORT = 3128; // one gateway per agent network, so a fixed port can't collide

describe.skipIf(!IT)("egress proxy on an agent network", () => {
  const rt = new ContainerRuntime();
  const id = `eg-${randomBytes(3).toString("hex")}`;
  const name = `cairn-${id}`;
  const decisions: EgressDecision[] = [];
  let base: string;
  let net: NetworkInfo | undefined;
  let proxy: EgressProxy | undefined;
  let started = false;
  const fetchUrl = (url: string) =>
    rt.exec(name, ["python3", "-c", `import urllib.request,sys\ntry:\n r=urllib.request.urlopen(${JSON.stringify(url)},timeout=20); print('HTTP', r.status)\nexcept Exception as e: print('FAILED', e)`], { timeoutMs: 60_000 });

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "cairn-eg-"));
    await mkdir(join(base, "wt", "src"), { recursive: true });
    await mkdir(join(base, "skills"), { recursive: true });
    const roles: RolesConfig = {
      roles: { coder: { mounts: { read: [], write: ["src/"] }, network: ["pypi.org"], executor_tools: [] } },
      defaults: { secrets: "none", egress: "deny" },
    };
    net = await rt.createInternalNetwork(`cairn-net-${id}`);
    const proxyUrl = `http://${net.gateway}:${PROXY_PORT}`;
    const spec = specForRole({
      agentId: id, role: "coder", roles, worktree: join(base, "wt"), skillsDir: join(base, "skills"), outboxDir: join(base, "outbox"), image: IMAGE, network: net.name, proxyUrl,
    });
    const prepared = await prepareMounts(spec, { worktree: join(base, "wt"), skills: join(base, "skills"), outbox: join(base, "outbox") });
    await rt.start(prepared.spec, { roots: prepared.roots, network: net.name });
    started = true;
    proxy = new EgressProxy({ allow: spec.egressDomains, onDecision: (d) => decisions.push(d) });
    await proxy.listen(net.gateway, PROXY_PORT);
  }, 600_000);

  afterAll(async () => {
    await proxy?.close();
    if (started) await rt.remove(name);
    if (net) await rt.deleteNetwork(net.name).catch(() => {});
    if (base) await rm(base, { recursive: true, force: true });
  }, 120_000);

  it("reaches the allowlisted domain through the proxy", async () => {
    const r = await fetchUrl("https://pypi.org/simple/");
    console.log(`pypi.org: ${r.stdout.trim()}`);
    expect(r.stdout).toMatch(/^HTTP 200/);
    expect(decisions).toContainEqual(expect.objectContaining({ decision: "allow", target: "pypi.org:443" }));
  }, 90_000);

  it("is refused a non-allowlisted domain, and the refusal is recorded", async () => {
    const r = await fetchUrl("https://example.com/");
    console.log(`example.com: ${r.stdout.trim()}`);
    expect(r.stdout).toMatch(/^FAILED.*403/);
    expect(decisions).toContainEqual({ decision: "deny", target: "example.com:443", reason: "example.com is not on this role's allowlist" });
  }, 90_000);

  it("is refused plain HTTP", async () => {
    const r = await fetchUrl("http://pypi.org/simple/");
    console.log(`http://pypi.org: ${r.stdout.trim()}`);
    expect(r.stdout).toMatch(/^FAILED.*403/);
  }, 90_000);
});
