import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunner, git, type Sandbox, type SandboxOptions, specForRole } from "@cairn/launcher";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { EngineEvent } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { readUsage } from "../events/log.js";
import type { PiRuntime } from "../models/layer.js";
import { runTask } from "./task.js";

const config: LoadedConfig = {
  dir: "(test)",
  models: {
    providers: { acme: { routes: [{ pi_provider: "faux-key", auth: "api_key" }], data_classes: ["public", "unpublished"], terms_checked: "unchecked" } },
    models: { "acme-m": { provider: "acme", id: "m1", tool_use: "untested" } },
    effort_map: { acme: { low: "low", medium: "medium", high: "high", max: "max" } },
    routing: { analysis: { worker: "acme-m@low" } },
    projects_default_data_class: "unpublished",
  },
  roles: {
    roles: { analysis: { mounts: { read: ["logic/"], write: ["analysis/"] }, network: [], executor_tools: [] } },
    defaults: { secrets: "none", egress: "deny" },
  },
  machines: { machines: {} },
  engine: { machine: "test", budget: { daily: { usd: { total: 10 }, tokens: {} }, run: { max_usd: 2, max_tokens: 100_000, max_turns: 10 } } },
};

let base: string;
let repo: string;
let home: string;
let skills: string;
let faux: ReturnType<typeof fauxProvider>;
let engine: Engine;
let closed: number;

/** Sandbox stand-in: no container; tools run on the host with /work, /outbox, /skills mapped (no mount enforcement). */
const fakeLaunch = async (opts: SandboxOptions): Promise<Sandbox> => {
  const r = opts.request;
  const spec = specForRole({ ...r, network: "cairn-net-fake" });
  const map = (s: string) =>
    s.replace(/(^|[\s"'=])\/(work|outbox|skills)(?=\/|\b)/g, (_m, pre: string, d: string) => `${pre}${{ work: r.worktree, outbox: r.outboxDir, skills: r.skillsDir }[d]}`);
  return {
    agentId: r.agentId,
    name: `cairn-${r.agentId}`,
    network: { name: "cairn-net-fake", gateway: "192.0.2.1", subnet: "192.0.2.0/24" },
    spec,
    skipped: [],
    exec: (command, o = {}) => {
      const [bin, ...args] = command;
      const host = bin === "python3" ? "/usr/bin/python3" : bin === "bash" ? "/bin/bash" : bin!;
      return cliRunner(host).run(args.map(map), { ...o, ...(o.input ? { input: map(o.input) } : {}) });
    },
    close: async () => void closed++,
  };
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-worker-"));
  repo = join(base, "project");
  home = join(base, "home");
  skills = join(base, "skills");
  await mkdir(join(repo, "logic"), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(join(repo, "logic", "claims.md"), "# claims\n");
  await git(repo, ["init", "--quiet", "-b", "main"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"]);
  faux = fauxProvider({ provider: "faux-key", models: [{ id: "m1", reasoning: false }] });
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  models.api_key.setProvider(faux.provider);
  engine = new Engine(config, { configDir: "(test)", home }, { models, stores } satisfies PiRuntime);
  closed = 0;
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const deps = () => ({ engine, skillsDir: skills, launch: fakeLaunch });
const events = async (): Promise<EngineEvent[]> =>
  (await readFile(join(home, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as EngineEvent);

describe("runTask / runWorker (offline: faux model, host-mapped sandbox, real git)", () => {
  it("agent edits its worktree; result judged by diff + report.json; changes committed on agent/<id>", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "logic/claims.md" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write", { path: "analysis/result.txt", content: "answer=42\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("write", { path: "/outbox/report.json", content: JSON.stringify({ status: "done", summary: "Computed the answer." }) })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Finished.")]),
    ]);
    const { result, worktree, commit, kept } = await runTask(deps(), { repo, role: "analysis", task: "Compute the answer into analysis/result.txt" });

    expect(result).toMatchObject({ status: "done", reportSource: "agent", violations: [], error: null });
    expect(result.report).toEqual({ status: "done", summary: "Computed the answer." });
    expect(result.files).toEqual([{ path: "analysis/result.txt", status: "added" }]);
    expect(result.diff).toContain("+answer=42");
    expect(result.usage).toHaveLength(4);
    expect(closed).toBe(1);

    // Engine wrote the task to the outbox, not into the worktree.
    expect(await readFile(join(home, "outbox", worktree.agentId, "task.md"), "utf8")).toBe("Compute the answer into analysis/result.txt");
    // Committed on the agent branch, worktree dir removed, main untouched.
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(kept).toBe(false);
    await expect(stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git(repo, ["show", `${worktree.branch}:analysis/result.txt`]))).toBe("answer=42\n");
    expect((await git(repo, ["log", "-1", "--format=%an|%s", worktree.branch])).trim()).toBe(`Cairn agent|agent ${worktree.agentId} (analysis): Computed the answer.`);
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");

    const ev = await events();
    expect(ev.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toEqual(["read", "write", "write"]);
    expect(ev.filter((e) => e.type === "tool_result")).toHaveLength(3);
    expect((ev.find((e) => e.type === "tool_result") as { text: string }).text).toBe("# claims\n");
    expect(ev.filter((e) => e.type === "usage")).toHaveLength(4);
    expect(new Set(ev.map((e) => e.run)).size).toBe(1);
    expect(JSON.parse(await readFile(result.transcriptPath, "utf8")).length).toBeGreaterThan(4);
  });

  it("flags changes outside the role's write paths and fails the run", async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "logic/claims.md", content: "# tampered\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const { result } = await runTask(deps(), { repo, role: "analysis", task: "t" });
    expect(result.status).toBe("failed");
    expect(result.violations).toEqual(["logic/claims.md"]);
  });

  it("synthesizes a report when the agent writes none", async () => {
    faux.setResponses([fauxAssistantMessage([fauxText("Nothing needed changing.")])]);
    const { result, commit } = await runTask(deps(), { repo, role: "analysis", task: "t" });
    expect(result).toMatchObject({ status: "done", reportSource: "engine", files: [] });
    expect(result.report.summary).toBe("Nothing needed changing.");
    expect(commit).toBeUndefined();
    // No changes: branch deleted too.
    expect((await git(repo, ["branch", "--list", "agent/*"])).trim()).toBe("");
  });

  it("a model failure fails the run and still tears the sandbox down", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request" })]);
    const { result } = await runTask(deps(), { repo, role: "analysis", task: "t" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("400 invalid request");
    expect(closed).toBe(1);
  });

  it("refuses unknown roles before creating anything", async () => {
    await expect(runTask(deps(), { repo, role: "root", task: "t" })).rejects.toThrow("unknown role 'root'");
    expect((await git(repo, ["worktree", "list"])).trim().split("\n")).toHaveLength(1);
    expect((await readUsage(home)).records).toEqual([]);
  });
});

describe("re run (CLI)", () => {
  it("runs a task file and prints status, changes, and how to review", async () => {
    const { runCli } = await import("../cli.js");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "analysis/notes.md", content: "ok\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Wrote notes.")]),
    ]);
    const taskFile = join(base, "task.md");
    await writeFile(taskFile, "Write analysis/notes.md");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["run", "--repo", repo, "--role", "analysis", "--task", taskFile], { out: (l) => out.push(l), err: (l) => err.push(l) }, {
      openEngine: async () => engine,
      worker: { launch: fakeLaunch, skillsDir: skills },
    });
    expect(code).toBe(0);
    expect(out[0]).toBe("status   done");
    expect(out).toContain("changed  analysis/notes.md (added)");
    expect(out.find((l) => l.startsWith("review   "))).toMatch(new RegExp(`^review   git -C .* diff [0-9a-f]{12}\\.\\.\\.agent/analysis-[0-9a-f]{6}   \\(commit [0-9a-f]{12}\\)$`));
    expect(err.filter((l) => l.startsWith("— m1 via faux-key/api_key"))).toHaveLength(2);
  });

  it("validates arguments", async () => {
    const { runCli } = await import("../cli.js");
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l) };
    expect(await runCli(["run", "--repo", repo, "--role", "analysis"], io, { openEngine: async () => engine })).toBe(2);
    expect(await runCli(["run", "--repo", repo, "--role", "analysis", "--task", join(base, "nope.md")], io, { openEngine: async () => engine })).toBe(2);
    expect(err.at(-1)).toMatch(/cannot read task file/);
  });
});
