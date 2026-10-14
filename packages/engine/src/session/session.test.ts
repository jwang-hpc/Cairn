import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunner, git, type Sandbox, type SandboxOptions, specForRole } from "@cairn/launcher";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { provenance as P, type EngineEvent } from "@cairn/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../api/api.js";
import { runCli } from "../cli.js";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { Ledger } from "../ledger/ledger.js";
import type { PiRuntime } from "../models/layer.js";
import { Delegations, type SessionEvent, SessionHub } from "./delegate.js";
import { COMPACT, runTurn, type SessionContext } from "./orchestrator.js";
import { SessionStore } from "./store.js";
import { ProjectView } from "./view.js";

const config = (projects: string): LoadedConfig => ({
  dir: "(test)",
  models: {
    providers: { acme: { routes: [{ pi_provider: "faux-key", auth: "api_key" }], data_classes: ["public", "unpublished"], terms_checked: "unchecked" } },
    models: { "acme-m": { provider: "acme", id: "m1", tool_use: "untested" } },
    effort_map: { acme: { low: "low", medium: "medium", high: "high", max: "max" } },
    routing: { orchestrator: { worker: "acme-m@medium" }, analysis: { worker: "acme-m@low" } },
    projects_default_data_class: "unpublished",
  },
  roles: {
    roles: { analysis: { mounts: { read: ["logic/", "evidence/"], write: ["analysis/"] }, network: [], executor_tools: [] } },
    defaults: { secrets: "none", egress: "deny" },
  },
  machines: { machines: {} },
  engine: { machine: "test", projects_dir: projects, budget: { daily: { usd: { total: 10 }, tokens: {} }, run: { max_usd: 2, max_tokens: 1_000_000, max_turns: 20 } } },
});

/** Sandbox stand-in (as in worker/run.test.ts): tools run on the host with /work, /outbox, /skills mapped. */
const fakeLaunch = async (opts: SandboxOptions): Promise<Sandbox> => {
  const r = opts.request;
  const map = (s: string) => s.replace(/(^|[\s"'=])\/(work|outbox|skills)(?=\/|\b)/g, (_m, pre: string, d: string) => `${pre}${{ work: r.worktree, outbox: r.outboxDir, skills: r.skillsDir }[d]}`);
  return {
    agentId: r.agentId,
    name: `cairn-${r.agentId}`,
    network: { name: "cairn-net-fake", gateway: "192.0.2.1", subnet: "192.0.2.0/24" },
    spec: specForRole({ ...r, network: "cairn-net-fake" }),
    skipped: [],
    exec: (command, o = {}) => {
      const [bin, ...args] = command;
      return cliRunner(bin === "python3" ? "/usr/bin/python3" : bin === "bash" ? "/bin/bash" : bin!).run(args.map(map), { ...o, ...(o.input ? { input: map(o.input) } : {}) });
    },
    close: async () => {},
  };
};

let base: string;
let engine: Engine;
let faux: ReturnType<typeof fauxProvider>;
let ledger: Ledger;
let store: SessionStore;
let ctx: SessionContext;
// The faux provider sees the request as a transcript whose system messages carry the prompt.
const sees = (c: unknown, text: string) => JSON.stringify(c).includes(text);
const isWorker = (c: unknown) => sees(c, "You are a Cairn analysis agent");

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "cairn-session-"));
  faux = fauxProvider({ provider: "faux-key", models: [{ id: "m1", reasoning: false }] });
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  models.api_key.setProvider(faux.provider);
  engine = new Engine(config(join(base, "projects")), { configDir: "(test)", home: join(base, "home") }, { models, stores } satisfies PiRuntime);
  ledger = await Ledger.create({ projectsDir: join(base, "projects"), name: "demo", title: "Sieve scaling", dataClass: "unpublished" });
  // Committed evidence, a committed file outside the readable paths, a binary figure, and one uncommitted file.
  await ledger.writeArtifacts(
    [
      { path: "evidence/tables/EXP-001/t.csv", content: "n,primes\n100000,9592\n" },
      { path: "evidence/raw/EXP-001/fig.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
    ],
    P.aiExecuted("m1", "low"),
    "evidence",
  );
  await mkdir(join(ledger.dir, "src"), { recursive: true });
  await writeFile(join(ledger.dir, "src", "secret.py"), "KEY = 'primes'\n");
  await git(ledger.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "add", "src/secret.py"]);
  await git(ledger.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "src", "--trailer", "Cairn-Provenance: user"]);
  await writeFile(join(ledger.dir, "logic", "draft-notes.md"), "uncommitted primes notes\n");
  store = new SessionStore(engine.paths.home);
  ctx = { engine, ledger, store };
});
afterEach(async () => {
  COMPACT.atTokens = 40_000;
  COMPACT.keepTokens = 12_000;
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the orchestrator's view of the project (read-only, as committed)", () => {
  it("reads only committed files under its read paths", async () => {
    const view = new ProjectView(ledger, ["PAPER.md", "logic/", "evidence/tables/", "analysis/"]);
    const listed = await view.list();
    expect(listed).toContain("PAPER.md");
    expect(listed).toContain("evidence/tables/EXP-001/t.csv");
    expect(listed).not.toContain("src/secret.py");
    expect(listed).not.toContain("logic/draft-notes.md");
    expect(await view.readFile("evidence/tables/EXP-001/t.csv")).toMatch(/lines 1-3 of 3\)\n {4}1 {2}n,primes\n {4}2 {2}100000,9592/);
    await expect(view.readFile("logic/draft-notes.md")).rejects.toThrow(/no logic\/draft-notes\.md in the project \(as committed\)/);
    await expect(view.readFile("src/secret.py")).rejects.toThrow(/not readable here/);
    await expect(view.readFile("../../etc/passwd")).rejects.toThrow(/leaves the project/);
    await expect(view.readFile("/etc/passwd")).rejects.toThrow(/inside the project/);
    expect(await new ProjectView(ledger, ["evidence/"]).readFile("evidence/raw/EXP-001/fig.png")).toMatch(/binary file \(7 bytes\); not shown/);
    expect(await view.search("PRIMES")).toMatch(/^evidence\/tables\/EXP-001\/t\.csv:1:n,primes$/m);
    expect(await view.search("primes")).not.toMatch(/secret|draft-notes/);
    expect(await view.search("primes", "src")).toMatch(/^nothing readable under src/);
  });
});

describe("a research session turn", () => {
  it("reads, proposes a card (nothing runs), answers; transcript, record, and event log keep it", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "evidence/tables/EXP-001/t.csv" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("propose_task", { role: "analysis", title: "Repeat the timing five times", task: "Run EXP-001 five times and report the spread.", files: ["evidence/tables/EXP-001/t.csv"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("The table has one run (9592 primes below 100000). I proposed P1 to repeat it."),
    ]);
    const rec = await store.create("demo");
    const seen: string[] = [];
    const r = await runTurn(ctx, rec, "Is the timing result robust?", { proposal: (p) => seen.push(p.id), tool: (n) => seen.push(n) });
    expect(r.error).toBeNull();
    expect(r.text).toMatch(/I proposed P1/);
    expect(seen).toEqual(["read_file", "propose_task", "P1"]);
    expect(r.proposals).toMatchObject([{ id: "P1", kind: "task", role: "analysis", state: "proposed", title: "Repeat the timing five times" }]);
    const saved = await store.load("demo", rec.id);
    expect(saved).toMatchObject({ turns: 1, title: "Is the timing result robust?", proposals: [{ id: "P1", state: "proposed" }] });
    expect(saved.messages.length).toBeGreaterThanOrEqual(5);
    expect((await store.transcript("demo", rec.id)).map((e) => e.kind)).toEqual(["user", "tool", "proposal", "tool", "assistant"]);
    const events = (await readFile(join(engine.paths.home, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as EngineEvent).filter((e) => e.run === r.run);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["message", "tool_call", "tool_result", "usage"]));
    expect(await store.list("demo")).toMatchObject([{ id: rec.id, turns: 1 }]);
  });

  it("continues where it left off, and condenses older turns when the chat grows", async () => {
    const rec = await store.create("demo");
    faux.setResponses([fauxAssistantMessage("First answer.")]);
    await runTurn(ctx, rec, "first question");
    // The next turn sees the earlier exchange.
    faux.setResponses([(c: unknown) => fauxAssistantMessage(sees(c, "first question") ? "I remember." : "I forgot.")]);
    expect((await runTurn(ctx, rec, "second")).text).toBe("I remember.");
    // Compaction: the older turns become a summary; the new turn's system prompt carries it.
    COMPACT.atTokens = 1;
    COMPACT.keepTokens = 1;
    faux.setResponses([fauxAssistantMessage("SUMMARY: asked first and second; nothing launched."), (c: unknown) => fauxAssistantMessage(sees(c, "SUMMARY: asked first") ? "summary seen" : "no summary")]);
    expect((await runTurn(ctx, rec, "third")).text).toBe("summary seen");
    const saved = await store.load("demo", rec.id);
    expect(saved.summary).toBe("SUMMARY: asked first and second; nothing launched.");
    expect(JSON.stringify(saved.messages)).not.toContain("first question");
    expect((await store.transcript("demo", rec.id)).filter((e) => e.kind === "user").map((e) => (e as { text: string }).text)).toEqual(["first question", "second", "third"]);
  });
});

describe("delegation (the user's click; at most 3 workers per project)", () => {
  const hubEvents: SessionEvent[] = [];
  const delegations = () => {
    const hub = new SessionHub();
    hub.subscribe((e) => hubEvents.push(e));
    return new Delegations({ engine, store, hub, ledgerFor: async () => ledger, worker: { skillsDir: join(base, "skills"), launch: fakeLaunch }, maxPerProject: 3 });
  };
  beforeEach(async () => {
    hubEvents.length = 0;
    await mkdir(join(base, "skills"), { recursive: true });
  });

  async function sessionWith(n: number, kind: "task" | "decision" = "task") {
    const rec = await store.create("demo");
    const calls = Array.from({ length: n }, (_, i) =>
      kind === "task" ? fauxToolCall("propose_task", { role: "analysis", title: `Task ${i + 1}`, task: `Write analysis/out${i + 1}.md` }) : fauxToolCall("propose_decision", { title: "Repeat timings before any claim", rationale: "One run cannot rule out superlinear growth.", refs: ["C01"] }),
    );
    faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("Proposed.")]);
    await runTurn(ctx, rec, "plan");
    return rec;
  }

  it("a decision is recorded in the ledger as user-revised; a task runs a worker and reports back to its card", async () => {
    const d = delegations();
    const dec = await sessionWith(1, "decision");
    expect(await d.launch({ project: "demo", session: dec.id, proposal: "P1" })).toMatchObject({ state: "recorded", recorded: "D01" });
    expect((await ledger.decisions())[0]).toMatchObject({ id: "D01", title: "Repeat timings before any claim" });
    expect(await git(ledger.dir, ["log", "-1", "--format=%(trailers:key=Cairn-Provenance,valueonly)"])).toMatch(/user-revised/);

    const rec = await sessionWith(1);
    faux.setResponses([
      (c: unknown) => (isWorker(c) ? fauxAssistantMessage(fauxToolCall("write", { path: "analysis/out1.md", content: "spread: unknown\n" }), { stopReason: "toolUse" }) : fauxAssistantMessage("?")),
      fauxAssistantMessage(fauxText("Wrote analysis/out1.md.")),
    ]);
    expect((await d.launch({ project: "demo", session: rec.id, proposal: "P1" })).state).toBe("queued");
    await expect(d.launch({ project: "demo", session: rec.id, proposal: "P1" })).rejects.toThrow(/P1 is (queued|running), not waiting for launch/);
    await d.idle();
    const p = (await store.load("demo", rec.id)).proposals[0]!;
    expect(p).toMatchObject({ state: "done", run: expect.any(String), outcome: { status: "done", files: ["analysis/out1.md (added)"], branch: expect.stringMatching(/^agent\/analysis-/), drafts: [], literature: false } });
    expect(hubEvents.filter((e) => e.type === "proposal").map((e) => (e as { proposal: { state: string } }).proposal.state)).toEqual(["recorded", "queued", "running", "done"]);
    expect(hubEvents.filter((e) => e.type === "worker_step").map((e) => (e as { step: string }).step)).toContain("writing analysis/out1.md");
    expect((await store.transcript("demo", rec.id)).filter((e) => e.kind === "proposal").map((e) => (e as { proposal: { state: string } }).proposal.state)).toEqual(["proposed", "queued", "running", "done"]);
  });

  it("runs three at once and queues the rest; stop works on queued and running workers; dismiss only before launch", async () => {
    const d = delegations();
    const rec = await sessionWith(5);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    faux.setResponses(Array.from({ length: 10 }, () => async (c: unknown) => {
      if (!isWorker(c)) return fauxAssistantMessage("?");
      started++;
      await gate;
      return fauxAssistantMessage("done");
    }));
    for (const id of ["P1", "P2", "P3", "P4"]) await d.launch({ project: "demo", session: rec.id, proposal: id });
    await expect.poll(() => started, { timeout: 5000 }).toBe(3);
    expect(d.activity("demo")).toEqual({ running: 3, queued: 1 });
    expect((await d.stop({ project: "demo", session: rec.id, proposal: "P4" })).state).toBe("stopped");
    await d.stop({ project: "demo", session: rec.id, proposal: "P1" });
    release();
    await d.idle();
    const states = Object.fromEntries((await store.load("demo", rec.id)).proposals.map((p) => [p.id, p.state]));
    expect(states).toEqual({ P1: "stopped", P2: "done", P3: "done", P4: "stopped", P5: "proposed" });
    expect((await d.dismiss({ project: "demo", session: rec.id, proposal: "P5" })).state).toBe("dismissed");
    await expect(d.dismiss({ project: "demo", session: rec.id, proposal: "P2" })).rejects.toThrow(/only a proposal waiting for launch/);
    expect(started).toBe(3);
  });
});

describe("sessions over the API and in re chat (what the app and the terminal use)", () => {
  beforeEach(async () => {
    await mkdir(join(base, "skills"), { recursive: true });
    await mkdir(engine.paths.home, { recursive: true });
    await writeFile(join(engine.paths.home, "state.json"), JSON.stringify({ project: "demo" }));
  });
  const worker = () => ({ skillsDir: join(base, "skills"), launch: fakeLaunch });
  const plan = () =>
    faux.setResponses([
      (c: unknown) =>
        isWorker(c)
          ? fauxAssistantMessage("?")
          : fauxAssistantMessage(fauxToolCall("propose_task", { role: "analysis", title: "Write the spread note", task: "Write analysis/spread.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("I proposed P1."),
      (c: unknown) => (isWorker(c) ? fauxAssistantMessage(fauxToolCall("write", { path: "analysis/spread.md", content: "n/a\n" }), { stopReason: "toolUse" }) : fauxAssistantMessage("?")),
      fauxAssistantMessage("Wrote it."),
    ]);

  it("API: create, message (events pushed live), launch, follow, steps", async () => {
    const api = createApi(engine, { env: {}, worker: worker(), poll: { eventsMs: 20, jobsMs: 20, heartbeatMs: 40 } });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await api.handle(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${api.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    try {
      const events = await api.handle(new Request("http://127.0.0.1/api/events", { headers: { authorization: `Bearer ${api.token}` } }));
      const reader = events.body!.getReader();
      const s = (await call("POST", "/api/projects/demo/sessions", { title: "Is C01 robust?" })).body.session;
      expect(s).toMatchObject({ project: "demo", title: "Is C01 robust?", turns: 0 });
      plan();
      const m = await call("POST", `/api/projects/demo/sessions/${s.id}/messages`, { text: "Repeat it?" });
      expect(m.body).toMatchObject({ text: "I proposed P1.", error: null, proposals: [{ id: "P1", state: "proposed" }] });
      let streamed = "";
      const dec = new TextDecoder();
      while (!streamed.includes('"type":"turn_end"')) streamed += dec.decode((await reader.read()).value);
      expect(streamed).toMatch(/event: session\ndata: \{"type":"proposal","project":"demo","session":"[^"]+","proposal":\{[^}]*"id":"P1","state":"proposed"/);
      expect(streamed).toMatch(/"type":"turn_delta"/);
      await reader.cancel();
      expect((await call("POST", `/api/projects/demo/sessions/${s.id}/messages`, {})).status).toBe(400);
      expect((await call("POST", `/api/projects/demo/sessions/${s.id}/proposals/P9/launch`)).status).toBe(404);
      expect((await call("POST", `/api/projects/demo/sessions/${s.id}/proposals/P1/launch`)).body.proposal.state).toBe("queued");
      expect((await call("POST", `/api/projects/demo/sessions/${s.id}/proposals/P1/launch`)).status).toBe(409);
      await expect.poll(async () => (await call("GET", `/api/projects/demo/sessions/${s.id}`)).body.proposals[0].state, { timeout: 10_000 }).toBe("done");
      const got = (await call("GET", `/api/projects/demo/sessions/${s.id}`)).body;
      expect(got.transcript.map((e: { kind: string }) => e.kind)).toEqual(["user", "proposal", "tool", "assistant", "proposal", "proposal", "proposal"]);
      const steps = (await call("GET", `/api/runs/${got.proposals[0].run}/steps`)).body.steps as { step: string }[];
      expect(steps.map((x) => x.step)).toContain("writing analysis/spread.md");
      expect((await call("GET", "/api/projects/demo/sessions")).body).toMatchObject({ sessions: [{ id: s.id, turns: 1 }], workers: { running: 0, queued: 0 } });
      expect((await call("GET", "/api/projects/demo/sessions/20990101-0000-ffff")).status).toBe(404);
    } finally {
      await api.close();
    }
  });

  it("re chat: say, show, launch (follows the worker), sessions", async () => {
    const re = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: {}, worker: worker() });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    plan();
    const said = await re("chat", "say", "Repeat", "it?");
    expect(said.code).toBe(0);
    expect(said.out).toMatch(/^orchestrator> I proposed P1\.\n {2}card P1 \[analysis\] Write the spread note {2}\(proposed\) {3}→ re chat launch P1$/);
    expect((await re("chat", "show")).out).toMatch(/you> Repeat it\?\n {2}card P1 .*\norchestrator> I proposed P1\.\nproposals:\n {2}P1 \[analysis\]/);
    const launched = await re("chat", "launch", "p1");
    expect(launched.code).toBe(0);
    expect(launched.out).toMatch(/^launched P1 \(analysis\): Write the spread note/);
    expect(launched.out).toContain("P1 · writing analysis/spread.md");
    expect(launched.out).toMatch(/P1 \[analysis\] Write the spread note {2}\(done\) — /);
    expect((await re("chat", "sessions")).out).toMatch(/^\d{8}-\d{4}-[0-9a-f]{4} .* {2}1 turns {2}Repeat it\?$/);
    expect(await re("chat", "launch", "P1")).toMatchObject({ code: 1, err: expect.stringMatching(/P1 is done, not waiting for launch/) });
    expect(await re("chat")).toMatchObject({ code: 1, err: expect.stringMatching(/needs a terminal/) });
  });
});
