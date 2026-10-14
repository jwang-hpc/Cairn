import type { RolesConfig } from "@cairn/shared";
import { describe, expect, it } from "vitest";
import { toExecArgv, toRunArgv, UnsafeArgvError, validateRunArgv } from "./argv.js";
import { type LaunchRequest, PolicyError, specForRole } from "./policy.js";

// Mirrors config/roles.example.yaml.
const roles: RolesConfig = {
  roles: {
    literature: { mounts: { read: ["lit/", "logic/"], write: ["lit/"] }, network: ["literature-proxy"], executor_tools: [] },
    coder: {
      mounts: { read: ["src/", "logic/experiments.md"], write: ["src/", "experiments/"] },
      network: ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"],
      executor_tools: ["jobs.submit", "jobs.status"],
    },
    analysis: { mounts: { read: ["evidence/", "logic/"], write: ["analysis/"] }, network: [], executor_tools: [] },
    panel: {
      mounts: { read: ["engine/panels/<id>/packet/"], write: ["engine/panels/<id>/responses/<member>/"] },
      network: [],
      executor_tools: [],
    },
  },
  defaults: { secrets: "none", egress: "deny" },
};

const base: LaunchRequest = {
  agentId: "a1b2c3",
  role: "analysis",
  roles,
  worktree: "/Users/x/proj/worktrees/a1b2c3",
  skillsDir: "/Users/x/Cairn/skills",
  outboxDir: "/Users/x/Cairn/.engine/outbox/a1b2c3",
  image: "ghcr.io/example/agent@sha256:abc",
  network: "cairn-net-a1b2c3",
};
const roots = (r: LaunchRequest) => ({ roots: [r.worktree, r.skillsDir, r.outboxDir], network: r.network });

describe("specForRole", () => {
  it("analysis: role subsets of the worktree, skills ro, outbox rw, no egress", () => {
    const s = specForRole(base);
    expect(s.mounts.map((m) => `${m.target}${m.readonly ? " (ro)" : " (rw)"}`)).toEqual([
      "/work/analysis (rw)",
      "/work/evidence (ro)",
      "/work/logic (ro)",
      "/skills (ro)",
      "/outbox (rw)",
    ]);
    expect(s.mounts[0]!.source).toBe("/Users/x/proj/worktrees/a1b2c3/analysis");
    expect(s.egressDomains).toEqual([]);
    expect(Object.keys(s.env).filter((k) => /proxy/i.test(k))).toEqual([]);
    expect(s).toMatchObject({ name: "cairn-a1b2c3", user: "1000:1000", workdir: "/work", network: "cairn-net-a1b2c3" });
  });

  it("coder: write wins over read, single-file mount, egress domains via the proxy", () => {
    const s = specForRole({ ...base, role: "coder", proxyUrl: "http://192.168.128.1:3128" });
    expect(s.mounts.slice(0, 3).map((m) => [m.target, m.readonly, m.kind])).toEqual([
      ["/work/experiments", false, "dir"],
      ["/work/src", false, "dir"],
      ["/work/logic/experiments.md", true, "file"],
    ]);
    expect(s.egressDomains).toEqual(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"]);
    expect(s.env.HTTPS_PROXY).toBe("http://192.168.128.1:3128");
  });

  it("coder without a proxy is refused rather than silently given no network", () => {
    expect(() => specForRole({ ...base, role: "coder" })).toThrow(/allows pypi\.org.*but no egress proxy/);
  });

  it("named egress services are refused (only domains are; literature goes through executor tools, M7)", () => {
    expect(() => specForRole({ ...base, role: "literature" })).toThrow("named services not available yet: literature-proxy");
  });

  it("resolves placeholders and rejects missing or unsafe values", () => {
    const s = specForRole({ ...base, role: "panel", vars: { member: "model-b" } });
    expect(s.mounts.map((m) => m.target).slice(0, 2)).toEqual([
      "/work/engine/panels/a1b2c3/packet",
      "/work/engine/panels/a1b2c3/responses/model-b",
    ]);
    expect(() => specForRole({ ...base, role: "panel" })).toThrow("placeholder <member> has no value");
    expect(() => specForRole({ ...base, role: "panel", vars: { member: "../../x" } })).toThrow(/is not a plain name/);
  });

  it.each([
    [["../secrets/"], /escapes or names the whole worktree/],
    [["a/../../b/"], /escapes or names the whole worktree/],
    [["./"], /escapes or names the whole worktree/],
    [["/etc/"], /must be relative to the worktree/],
    [[".git/"], /git internals/],
    [["a,b/"], /invalid character/],
  ])("rejects role path %j", (read, msg) => {
    const bad: RolesConfig = { ...roles, roles: { ...roles.roles, analysis: { ...roles.roles.analysis!, mounts: { read, write: [] } } } };
    expect(() => specForRole({ ...base, roles: bad })).toThrow(msg);
  });

  it("refuses credentials, the default network, bad ids, and unknown roles", () => {
    expect(() => specForRole({ ...base, roles: { ...roles, defaults: { secrets: "model-token", egress: "deny" } } })).toThrow(/invariant 1/);
    expect(() => specForRole({ ...base, network: "default" })).toThrow(/invariant 3/);
    expect(() => specForRole({ ...base, agentId: "../x" })).toThrow(PolicyError);
    expect(() => specForRole({ ...base, role: "root" })).toThrow("unknown role 'root'");
  });
});

describe("toRunArgv / validateRunArgv", () => {
  const spec = specForRole({ ...base, role: "coder", proxyUrl: "http://192.168.128.1:3128" });
  const req = { ...base, role: "coder" };
  const argv = toRunArgv(spec, roots(req));

  it("emits a hardened, fully allowlisted argv", () => {
    expect(argv.slice(0, 2)).toEqual(["run", "-d"]);
    for (const f of ["--read-only", "--no-dns", "--init"]) expect(argv).toContain(f);
    expect(argv.join(" ")).toContain("--kernel-arg ipv6.disable=1");
    expect(argv.join(" ")).toContain("--cap-drop ALL --user 1000:1000");
    expect(argv.join(" ")).toContain("--mount type=bind,source=/Users/x/Cairn/skills,target=/skills,readonly");
    expect(argv.slice(-4)).toEqual(["--entrypoint", "sleep", "ghcr.io/example/agent@sha256:abc", "infinity"]);
  });

  const tamper = (fn: (a: string[]) => string[]) => () => validateRunArgv(fn([...argv]), roots(req));
  const beforeImage = (extra: string[]) => (a: string[]) => {
    const i = a.indexOf("--entrypoint");
    return [...a.slice(0, i), ...extra, ...a.slice(i)];
  };

  it.each([
    ["--ssh", ["--ssh"], /--ssh is not allowed: forwards the host SSH agent/],
    ["--publish-socket", ["--publish-socket", "/tmp/x.sock:/x.sock"], /--publish-socket is not allowed/],
    ["bare -e (inherits host value)", ["-e", "ANTHROPIC_API_KEY"], /would inherit the host's value/],
    ["secret env var", ["-e", "OPENAI_API_KEY=sk-x"], /OPENAI_API_KEY is not allowed/],
    ["--env-file", ["--env-file", "/Users/x/.env"], /--env-file is not allowed/],
    ["-v bind", ["-v", "/Users/x/.ssh:/ssh"], /-v is not allowed/],
    ["mount outside roots", ["--mount", "type=bind,source=/Users/x/.ssh,target=/work/ssh"], /outside allowed roots/],
    ["mount traversal", ["--mount", "type=bind,source=/Users/x/proj/worktrees/a1b2c3/../../../.ssh,target=/work/s"], /outside allowed roots/],
    ["mount target outside /work", ["--mount", "type=bind,source=/Users/x/Cairn/skills,target=/etc,readonly"], /mount target must be under/],
    ["writable skills", ["--mount", "type=bind,source=/Users/x/Cairn/skills,target=/skills/x"], /skills must be mounted readonly/],
    ["--cap-add", ["--cap-add", "NET_ADMIN"], /--cap-add is not allowed/],
    ["--virtualization", ["--virtualization"], /--virtualization is not allowed/],
    ["unknown future flag", ["--host-network"], /not on the launcher's allowlist/],
    ["--flag=value form", ["--network=default"], /use '--network <value>'/],
    ["second network", ["--network", "default"], /must be the agent's network/],
    ["root user", ["--user", "0:0"], /agents run as 1000:1000/],
    ["other kernel argument", ["--kernel-arg", "init=/bin/sh"], /--kernel-arg init=\/bin\/sh is not allowed \(only ipv6.disable=1\)/],
    ["custom kernel", ["--kernel", "/tmp/vmlinux"], /--kernel is not allowed: custom kernel/],
  ])("refuses %s", (_name, extra, msg) => {
    expect(tamper(beforeImage(extra as string[]))).toThrow(msg);
  });

  it("requires every hardening flag and the sleep entrypoint", () => {
    for (const f of ["--read-only", "--no-dns"]) {
      expect(tamper((a) => a.filter((t) => t !== f))).toThrow(`missing required hardening flag ${f}`);
    }
    expect(tamper((a) => a.filter((t, i) => t !== "--kernel-arg" && a[i - 1] !== "--kernel-arg"))).toThrow("missing required hardening flag --kernel-arg");
    expect(tamper((a) => [...a.slice(0, -1), "sh", "-c", "curl evil"])).toThrow(/must be 'sleep infinity'/);
    expect(tamper((a) => a.map((t) => (t === "sleep" ? "sh" : t)))).toThrow(/entrypoint must be sleep/);
  });

  it("refuses mount paths that would break the mount spec", () => {
    const s = specForRole(base);
    s.mounts[0]!.source = "/Users/x/proj,type=bind,source=/Users/x/.ssh";
    expect(() => toRunArgv(s, roots(base))).toThrow(UnsafeArgvError);
  });
});

describe("toExecArgv", () => {
  it("runs as the agent user under /work with no inherited env", () => {
    expect(toExecArgv("cairn-a1b2c3", ["python3", "-c", "print(1)"], { workdir: "/work/src" })).toEqual([
      "exec", "-i", "--user", "1000:1000", "-w", "/work/src", "cairn-a1b2c3", "python3", "-c", "print(1)",
    ]);
    expect(() => toExecArgv("cairn-a1b2c3", ["ls"], { workdir: "/" })).toThrow(/workdir must be under/);
    expect(() => toExecArgv("cairn-a1b2c3", ["ls"], { env: { GH_TOKEN: "x" } })).toThrow(/GH_TOKEN is not allowed/);
    expect(() => toExecArgv("other", ["ls"])).toThrow(/cairn-<agent id>/);
  });
});
