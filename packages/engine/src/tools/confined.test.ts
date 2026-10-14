import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { cliRunner } from "@cairn/launcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clip, confinedTools, type ContainerExec, containerPath, DEFAULT_LIMITS } from "./confined.js";

/**
 * Stand-in for `container exec`: runs the tool's exact command on this machine with /work, /skills, and
 * /outbox mapped to temp dirs, so read/write/edit/bash/python behave for real without a container.
 */
let root: string;
const calls: string[][] = [];
const map = (s: string) => s.replace(/(^|[\s"'=])\/(work|skills|outbox)(?=\/|\b)/g, (_m, pre: string, dir: string) => `${pre}${root}/${dir}`);
const exec: ContainerExec = (command, opts = {}) => {
  calls.push([...command]);
  const [bin, ...args] = command;
  const host = bin === "python3" ? "/usr/bin/python3" : bin === "bash" ? "/bin/bash" : bin!;
  return cliRunner(host).run(args.map(map), { ...opts, ...(opts.input ? { input: map(opts.input) } : {}) });
};

let tools: Record<string, AgentTool<any>>;
const call = async (name: string, params: Record<string, unknown>) => {
  const r = await tools[name]!.execute("t1", params as never);
  return (r.content[0] as { text: string }).text;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-tools-"));
  await mkdir(join(root, "work", "src"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  await mkdir(join(root, "outbox"), { recursive: true });
  await writeFile(join(root, "work", "src", "main.py"), "x = 1\nprint(x)\n");
  calls.length = 0;
  tools = Object.fromEntries(confinedTools(exec).map((t) => [t.name, t]));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("containerPath", () => {
  it("resolves relative paths under /work and refuses escapes", () => {
    expect(containerPath("src/main.py", ["/work"])).toBe("/work/src/main.py");
    expect(containerPath("/outbox/req.json", ["/work", "/outbox"])).toBe("/outbox/req.json");
    expect(() => containerPath("../etc/passwd", ["/work"])).toThrow(/outside \/work/);
    expect(() => containerPath("/work/../root/.ssh/id_rsa", ["/work"])).toThrow(/outside/);
    expect(() => containerPath("/skills/x", ["/work", "/outbox"])).toThrow(/outside/);
    expect(() => containerPath("a\0b", ["/work"])).toThrow(/non-empty/);
  });
});

describe("confined tools (real commands, mapped paths)", () => {
  it("exposes exactly bash, read, write, edit, python", () => {
    expect(Object.keys(tools)).toEqual(["bash", "read", "write", "edit", "python"]);
  });

  it("read returns content and line ranges", async () => {
    expect(await call("read", { path: "src/main.py" })).toBe("x = 1\nprint(x)\n");
    expect(await call("read", { path: "src/main.py", offset: 2, limit: 1 })).toBe("print(x)");
    await expect(call("read", { path: "missing.txt" })).rejects.toThrow(/cannot read \/work\/missing.txt/);
  });

  it("write creates parents and passes the path as an argument, never into the script", async () => {
    expect(await call("write", { path: "analysis/deep/out.txt", content: "hello" })).toBe("wrote /work/analysis/deep/out.txt (5 characters)");
    expect(await readFile(join(root, "work", "analysis", "deep", "out.txt"), "utf8")).toBe("hello");
    await call("write", { path: "weird; touch PWNED $(id).txt", content: "ok" });
    await expect(readFile(join(root, "work", "PWNED"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls.at(-1)!.slice(0, 3)).toEqual(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"']);
    await expect(call("write", { path: "/skills/evil.md", content: "x" })).rejects.toThrow(/outside \/work, \/outbox/);
  });

  it("edit replaces a unique match, refuses ambiguous or missing ones, and supports replace_all", async () => {
    expect(await call("edit", { path: "src/main.py", old_string: "x = 1", new_string: "x = 2" })).toBe("edited /work/src/main.py (1 replacement)");
    expect(await readFile(join(root, "work", "src", "main.py"), "utf8")).toBe("x = 2\nprint(x)\n");
    await expect(call("edit", { path: "src/main.py", old_string: "x", new_string: "y" })).rejects.toThrow(/occurs 2 times/);
    await expect(call("edit", { path: "src/main.py", old_string: "nope", new_string: "y" })).rejects.toThrow(/not found/);
    expect(await call("edit", { path: "src/main.py", old_string: "x", new_string: "y", replace_all: true })).toBe("edited /work/src/main.py (2 replacements)");
    // "$&" in new_string is literal, not a regex back-reference.
    await call("edit", { path: "src/main.py", old_string: "y = 2", new_string: "y = '$&'" });
    expect(await readFile(join(root, "work", "src", "main.py"), "utf8")).toBe("y = '$&'\nprint(y)\n");
  });

  it("bash reports exit codes, stdout, and stderr", async () => {
    const out = await call("bash", { command: "cd /work && ls src; echo oops >&2; exit 3" });
    expect(out).toBe("exit code: 3\nstdout:\nmain.py\n\nstderr:\noops\n");
  });

  it("bash enforces the timeout", async () => {
    tools = Object.fromEntries(confinedTools(exec, { ...DEFAULT_LIMITS, maxTimeoutS: 1 }).map((t) => [t.name, t]));
    const t0 = Date.now();
    expect(await call("bash", { command: "sleep 5", timeout_s: 30 })).toBe("exit code: timeout");
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("python runs a program from stdin", async () => {
    const out = await call("python", { code: "import sys\nprint(sum(range(10)))\nprint('warn', file=sys.stderr)" });
    expect(out).toBe("exit code: 0\nstdout:\n45\n\nstderr:\nwarn\n");
  });

  it("long output keeps head and tail with an omission marker", async () => {
    const out = await call("python", { code: "print('START'); print('x'*100000); print('END')" });
    expect(out).toContain("START");
    expect(out).toContain("END");
    expect(out).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/);
    expect(out.length).toBeLessThan(DEFAULT_LIMITS.maxOutputChars + 200);
  });
});

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("abc", 10)).toBe("abc");
  });
});
