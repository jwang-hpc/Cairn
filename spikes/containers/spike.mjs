// M0 spike 3 (throwaway): Node drives Apple `container` — one mounted dir, exec + output capture,
// no-network, and a single allowlisted domain via a host-side CONNECT proxy on an --internal network.
// Run in your own terminal:  node spike.mjs   (needs `container system start`; pulls one image)
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const IMAGE = "docker.io/curlimages/curl:8.11.1"; // pinned; alpine-based with curl + busybox sh
const ALLOW = ["pypi.org"]; // a coder-role entry from roles.example.yaml
const id = randomBytes(3).toString("hex");
const NET = `cairn-spike-net-${id}`;
const C_MOUNT = `cairn-spike-mount-${id}`;
const C_NONET = `cairn-spike-nonet-${id}`;
const C_PROXY = `cairn-spike-proxy-${id}`;
const C_NAT = `cairn-spike-nat-${id}`;

const results = [];
const timings = {};
const created = { containers: [], network: false };
const proxyLog = [];

/** Run `container` with an argument array (no shell). Returns { code, stdout, stderr }. */
async function ctr(args, { timeout = 120_000 } = {}) {
  try {
    const { stdout, stderr } = await run("container", args, { timeout, maxBuffer: 16 << 20 });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? e.message ?? "").trim() };
  }
}
const exec = (name, cmd, opts) => ctr(["exec", name, "sh", "-c", cmd], opts);

async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: String((await fn()) ?? "") });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const short = (s, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

async function startDetached(name, extra) {
  const t0 = Date.now();
  const r = await ctr(["run", "-d", "--name", name, "--entrypoint", "sleep", ...extra, IMAGE, "3600"]);
  if (r.code !== 0) throw new Error(`run ${name} failed: ${short(r.stderr || r.stdout, 300)}`);
  created.containers.push(name);
  timings[name] = Date.now() - t0;
  return r;
}

// Hardening every agent container would get (DR-0005): no DNS by default, read-only root, tmpfs /tmp,
// no capabilities, non-root user, explicit env only (never bare `-e KEY`, never --ssh).
const HARDEN = ["--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--user", "1000:1000"];

let workDir;
let proxy;
let localOnly; // a host listener on 127.0.0.1 that containers must NOT reach

try {
  // ---------- preflight ----------
  await check("container system is running", async () => {
    const r = await ctr(["system", "status"]);
    must(r.code === 0 && /status\s+running/.test(r.stdout), short(r.stderr || r.stdout));
    return short(r.stdout.split("\n").find((l) => l.startsWith("client.version")) ?? "");
  });
  await check(`pull ${IMAGE}`, async () => {
    const t0 = Date.now();
    const r = await ctr(["image", "pull", IMAGE], { timeout: 600_000 });
    must(r.code === 0, short(r.stderr || r.stdout, 300));
    return `${Date.now() - t0} ms`;
  });

  // ---------- network: --internal (host-only) ----------
  let gateway;
  await check("create --internal network", async () => {
    const r = await ctr(["network", "create", "--internal", NET]);
    must(r.code === 0, short(r.stderr || r.stdout));
    created.network = true;
    const info = JSON.parse((await ctr(["network", "inspect", NET])).stdout)[0];
    gateway = info?.status?.ipv4Gateway;
    must(gateway, `no gateway in ${JSON.stringify(info)}`);
    return `mode ${info.configuration?.mode}, subnet ${info.status.ipv4Subnet}, gateway ${gateway}`;
  });

  // ---------- 1. single mounted directory ----------
  workDir = await mkdtemp(join(tmpdir(), "cairn-worktree-"));
  await writeFile(join(workDir, "task.md"), "hello from the host\n");
  await check("start hardened container with one bind mount", async () => {
    await startDetached(C_MOUNT, [...HARDEN, "--network", NET, "--no-dns", "--mount", `type=bind,source=${workDir},target=/work`]);
    return `started in ${timings[C_MOUNT]} ms (VM boot included)`;
  });
  await check("exec captures stdout and the exit code", async () => {
    const out = await exec(C_MOUNT, "cat /work/task.md");
    must(out.code === 0 && out.stdout === "hello from the host", `stdout=${JSON.stringify(out.stdout)} code=${out.code}`);
    const fail = await exec(C_MOUNT, "echo oops >&2; exit 7");
    must(fail.code === 7, `expected exit 7, got ${fail.code}`);
    return `stdout ok; exit 7 propagated; stderr=${JSON.stringify(fail.stderr)}`;
  });
  await check("container writes land in the mounted dir only", async () => {
    const w = await exec(C_MOUNT, "echo from-container > /work/out.txt && id");
    must(w.code === 0, `write failed: ${short(w.stderr)}`);
    const host = await readFile(join(workDir, "out.txt"), "utf8");
    must(host.trim() === "from-container", `host saw ${JSON.stringify(host)}`);
    const root = await exec(C_MOUNT, "touch /etc/pwned");
    must(root.code !== 0, "root filesystem was writable");
    return `host sees out.txt; rootfs read-only; ${w.stdout}`;
  });
  await check("no host home or other host paths inside (invariant 2)", async () => {
    const r = await exec(C_MOUNT, "ls -d /Users /Users/* /home/* /root/.ssh /mnt/* 2>/dev/null; mount | grep -vE ' (proc|sysfs|tmpfs|devpts|mqueue|cgroup2?|overlay|securityfs|debugfs|tracefs|bpf|devtmpfs|hugetlbfs) ' | head -20");
    must(!/\/Users/.test(r.stdout), `host paths visible:\n${r.stdout}`);
    return `non-system mounts: ${short(r.stdout.split("\n").filter((l) => l.includes("/work") || /virtiofs|9p|fuse/.test(l)).join(" | ") || "(none besides /work)", 220)}`;
  });
  await check("no host environment leaks in", async () => {
    const r = await exec(C_MOUNT, "env | cut -d= -f1 | sort | tr '\\n' ' '");
    const hostOnly = ["HOME=" + process.env.HOME, "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "GH_TOKEN"].map((k) => k.split("=")[0]);
    const leaked = hostOnly.filter((k) => k !== "HOME" && r.stdout.split(" ").includes(k));
    must(leaked.length === 0, `leaked: ${leaked}`);
    return `env keys: ${short(r.stdout, 200)}`;
  });

  // ---------- 2. no network ----------
  localOnly = createTcpServer((s) => s.end("host-local-service\n"));
  await new Promise((r) => localOnly.listen(0, "127.0.0.1", r));
  const localPort = localOnly.address().port;
  await check("--network none (undocumented?)", async () => {
    const r = await ctr(["run", "--rm", "--network", "none", "--entrypoint", "true", IMAGE]);
    return r.code === 0 ? "supported" : `not supported: ${short(r.stderr || r.stdout)}`;
  });
  await check("internal network + --no-dns: no internet, no DNS", async () => {
    await startDetached(C_NONET, [...HARDEN, "--network", NET, "--no-dns"]);
    const dns = await exec(C_NONET, "curl -sS --max-time 5 https://example.com -o /dev/null", { timeout: 30_000 });
    const ip = await exec(C_NONET, "curl -sSk --max-time 5 https://1.1.1.1 -o /dev/null", { timeout: 30_000 });
    must(dns.code !== 0, "name lookup + fetch succeeded");
    must(ip.code !== 0, "direct IP fetch succeeded (internet route exists)");
    return `by name: ${short(dns.stderr, 80)} · by IP: ${short(ip.stderr, 80)}`;
  });
  await check("host services bound to 127.0.0.1 are unreachable", async () => {
    const r = await exec(C_NONET, `curl -sS --max-time 4 http://${gateway}:${localPort}/`, { timeout: 30_000 });
    must(r.code !== 0, `reached host loopback service: ${r.stdout}`);
    return short(r.stderr, 120);
  });

  // ---------- 3. one allowlisted domain via a host CONNECT proxy on the internal gateway ----------
  proxy = createServer((req, res) => {
    proxyLog.push({ decision: "deny", method: req.method, target: req.url, reason: "plain HTTP not allowed" });
    res.writeHead(403).end("plain HTTP not allowed\n");
  });
  proxy.on("connect", (req, client, head) => {
    const [host, port] = req.url.split(":");
    const allowed = Number(port) === 443 && ALLOW.some((d) => host === d || host.endsWith(`.${d}`));
    proxyLog.push({ decision: allowed ? "allow" : "deny", target: req.url });
    if (!allowed) return client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const upstream = netConnect(443, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await check(`host proxy listens only on the internal gateway ${gateway}:3128`, async () => {
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(3128, gateway, resolve);
    });
    return `allowlist: ${ALLOW.join(", ")}`;
  });
  const P = `http://${gateway}:3128`;
  await check("allowlisted domain works through the proxy", async () => {
    await startDetached(C_PROXY, [...HARDEN, "--network", NET, "--no-dns", "-e", `HTTPS_PROXY=${P}`, "-e", `https_proxy=${P}`]);
    const r = await exec(C_PROXY, "curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://pypi.org/simple/", { timeout: 60_000 });
    must(r.code === 0 && /^(200|301|302)$/.test(r.stdout), `code=${r.code} http=${r.stdout} err=${short(r.stderr)}`);
    return `pypi.org -> HTTP ${r.stdout}`;
  });
  await check("non-allowlisted domain is refused by the proxy (and logged)", async () => {
    const r = await exec(C_PROXY, "curl -sS --max-time 10 -o /dev/null https://example.com", { timeout: 60_000 });
    must(r.code !== 0, "example.com reachable");
    must(proxyLog.some((l) => l.decision === "deny" && l.target.startsWith("example.com")), "deny not logged");
    return short(r.stderr, 120);
  });
  await check("bypassing the proxy fails (no DNS, no route)", async () => {
    const r = await exec(C_PROXY, "curl -sS --noproxy '*' --max-time 5 -o /dev/null https://pypi.org/simple/", { timeout: 30_000 });
    must(r.code !== 0, "direct access worked without the proxy");
    return short(r.stderr, 120);
  });

  // ---------- control: default NAT network has internet (proves the denials above are real) ----------
  await check("control: default NAT network reaches the internet", async () => {
    await startDetached(C_NAT, ["--cap-drop", "ALL"]);
    const r = await exec(C_NAT, "curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://example.com", { timeout: 60_000 });
    must(r.code === 0, `control failed: ${short(r.stderr)}`);
    return `example.com -> HTTP ${r.stdout}`;
  });
} finally {
  for (const c of created.containers) {
    await ctr(["stop", c], { timeout: 60_000 });
    await ctr(["delete", c], { timeout: 60_000 });
  }
  if (created.network) await ctr(["network", "delete", NET]);
  proxy?.close();
  localOnly?.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
}

console.log(`\nM0 spike 3 — Apple container (${IMAGE})\n`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log("\nproxy decisions:");
for (const l of proxyLog) console.log(`  ${l.decision.padEnd(5)} ${l.method ?? "CONNECT"} ${l.target}`);
console.log(`\ncontainer start times (ms): ${JSON.stringify(timings)}`);
const leftover = (await ctr(["list", "--all"])).stdout.split("\n").filter((l) => l.includes(id));
console.log(leftover.length ? `\nWARNING leftover containers: ${leftover.join("; ")}` : "\ncleanup: no leftover containers");
await writeFile(new URL("./results.json", import.meta.url), JSON.stringify({ image: IMAGE, results, timings, proxyLog }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
