import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "@cairn/executor";
import { git } from "@cairn/launcher";
import { provenance as P } from "@cairn/shared";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { LoadedConfig } from "../config/load.js";
import { Engine } from "../engine.js";
import { envelope } from "../events/log.js";
import { openJobService } from "../jobs/jobs.js";
import { Ledger } from "../ledger/ledger.js";
import { runPanel } from "../panel/panel.js";
import { type Api, createApi } from "./api.js";
import { readApiInfo, removeApiInfo, serveApi, writeApiInfo } from "./serve.js";

// The real M5 acceptance output (workstation, 2026-10-14), as in the claim gate tests.
const EJOB = "20261014-1251-c30f";
const CSV = "n,primes,seconds\n100000,9592,0.00518620199727593\n200000,17984,0.01025094700162299\n400000,33860,0.017140839001513086\n";
const R = `evidence/raw/EXP-001/${EJOB}/results.csv`;
const row2 = "100000,9592,0.00518620199727593";
const row4 = "400000,33860,0.017140839001513086";
const claim = (proof = `Job \`${EJOB}\`: 9592 primes below 100000 in 0.0052 s; 33,860 below 400000 in 0.0171 s.`) =>
  [
    "## C??: Pure-Python sieve time grows about linearly with N",
    "- **Statement**: In pure Python, sieve-based prime counting time grows roughly in proportion to N over this range.",
    "- **Conditions**: N from 100000 to 400000, one core on the workstation.",
    "- **Sources**:",
    `  - 100000 ← ${R}:2 «${row2}» [input]`,
    `  - 400000 ← ${R}:4 «${row4}» [input]`,
    `  - 9592 ← ${R}:2 «${row2}» [result]`,
    `  - 0.0052 ← ${R}:2 «${row2}» [result]`,
    `  - 33,860 ← ${R}:4 «${row4}» [result]`,
    `  - 0.0171 ← ${R}:4 «${row4}» [result]`,
    "- **Status**: supported",
    "- **Provenance**: ai-suggested",
    "- **Falsification**: Time rising faster than linearly in N on repeated runs.",
    `- **Proof**: ${proof}`,
    "- **Dependencies**: []",
    "- **Tags**: python, sieve",
    "",
  ].join("\n");
const REVIEW_JSON = JSON.stringify({
  dimensions: { evidence_relevance: { score: 4, strengths: [], weaknesses: [], suggestions: [] } },
  findings: [{ severity: "major", issue: "single run", suggestion: "repeat the job" }],
  verdict: "revise",
  summary: "Supported numerically, thin method.",
});
const BRANCH_REF = "agent/analysis-1:staging/claims/sieve.md";

const providers = ["public", "unpublished"] as const;
const config = (root: string): LoadedConfig => ({
  dir: "(test)",
  models: {
    providers: {
      acme: { routes: [{ pi_provider: "faux-a", auth: "api_key" }], data_classes: [...providers], terms_checked: "unchecked" },
      beta: { routes: [{ pi_provider: "faux-b", auth: "api_key" }], data_classes: [...providers], terms_checked: "unchecked" },
      rev: { routes: [{ pi_provider: "faux-r", auth: "api_key" }], data_classes: [...providers], terms_checked: "unchecked" },
    },
    models: {
      "acme-m": { provider: "acme", id: "a1", tool_use: "untested" },
      "beta-m": { provider: "beta", id: "b1", tool_use: "untested" },
      "rev-m": { provider: "rev", id: "r1", tool_use: "untested" },
    },
    effort_map: Object.fromEntries(["acme", "beta", "rev"].map((v) => [v, { low: "low", medium: "medium", high: "high", max: "max" }])),
    routing: { analysis: { reviewer: "rev-m@high" } },
    projects_default_data_class: "unpublished",
  },
  roles: { roles: {}, defaults: { secrets: "none", egress: "deny" } },
  machines: { machines: { workstation: { host: "workstation", scheduler: "none", scratch: join(root, "scratch") }, hpc: { host: "hpc", scheduler: "slurm" } } },
  engine: { machine: "test", projects_dir: join(root, "projects"), budget: { daily: { usd: { total: 10 }, tokens: {} }, run: { max_usd: 2, max_tokens: 1_000_000, max_turns: 20 } } },
});

let root: string;
let engine: Engine;
let demo: Ledger;
let api: Api;
let logs: string[];
const BASE = "http://127.0.0.1:4321";
const local = { transport: () => new LocalTransport() };

/** A fake vendor that answers every call with the same text (no model names in it, so blindness is testable). */
function vendor(provider: string, id: string, text: string) {
  const f = fauxProvider({ provider, models: [{ id, reasoning: true }] });
  f.setResponses(Array.from({ length: 30 }, () => () => fauxAssistantMessage([fauxText(text)])));
  return f;
}
async function addEvidence(l: Ledger) {
  await l.writeArtifacts(
    [{ path: R, content: CSV }, { path: R.replace("results.csv", "MANIFEST.json"), content: JSON.stringify({ files: [{ path: "results.csv" }], logs: [] }) }],
    P.aiExecuted("m1", "high"),
    "results",
  );
}
/** An analysis agent's draft, committed on its branch of the project. */
async function branchDraft(l: Ledger, md: string) {
  const g = (...args: string[]) => git(l.dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  await g("checkout", "-q", "-b", "agent/analysis-1");
  await mkdir(join(l.dir, "staging/claims"), { recursive: true });
  await writeFile(join(l.dir, "staging/claims/sieve.md"), md);
  await g("add", "staging/claims/sieve.md");
  await g("commit", "-q", "-m", "draft");
  await g("checkout", "-q", "main");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-api-"));
  logs = [];
  const stores = { oauth: new InMemoryCredentialStore(), api_key: new InMemoryCredentialStore() };
  const models = { oauth: createModels({ credentials: stores.oauth }), api_key: createModels({ credentials: stores.api_key }) };
  for (const f of [vendor("faux-a", "a1", "### Position\nCompression helps."), vendor("faux-b", "b1", "### Position\nIt depends."), vendor("faux-r", "r1", `Here is my review:\n${REVIEW_JSON}`)]) {
    models.api_key.setProvider(f.provider);
  }
  engine = new Engine(config(root), { configDir: "(test)", home: join(root, "home") }, { models, stores });
  demo = await Ledger.create({ projectsDir: join(root, "projects"), name: "demo", title: "Demo", dataClass: "unpublished" });
  await Ledger.create({ projectsDir: join(root, "projects"), name: "other", title: "Other", dataClass: "public" });
  await mkdir(engine.paths.home, { recursive: true });
  await writeFile(join(engine.paths.home, "state.json"), JSON.stringify({ project: "demo" }));
  const exp = join(root, "wt/experiments/EXP-001");
  await mkdir(exp, { recursive: true });
  await writeFile(join(exp, "run.sh"), "echo 7 > results.csv\n");
  await writeFile(join(exp, "job.json"), JSON.stringify({ script: "run.sh", description: "seven", resources: { cores: 1, walltime: "00:01:00" }, outputs: ["results.csv", "absent.csv"] }));
  api = createApi(engine, { env: {}, jobs: local, log: (l) => logs.push(l), poll: { eventsMs: 20, jobsMs: 20, heartbeatMs: 40 } });
  api.expectPort(4321);
});
afterEach(async () => {
  await api.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Response bodies are checked field by field below; `any` keeps those checks readable.
type Json = Record<string, any>;
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, base = BASE): Promise<{ status: number; body: Json }> {
  const res = await api.handle(
    new Request(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${api.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);
async function re(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, { openEngine: async () => engine, env: {}, jobs: local });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const auditText = () => readFile(join(engine.paths.home, "audit.log"), "utf8").catch(() => "");
const audit = async () => (await auditText()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json);
const propose = async () =>
  (
    await openJobService(engine, local).submit({
      project: "demo",
      worktree: join(root, "wt"),
      experiment: "EXP-001",
      target: "workstation",
      author: { kind: "agent", run: "r1", agent: "coder-1", role: "coder", model: "m1", effort: "low" },
    })
  ).job;

describe("access (DR-0005: loopback Host, bearer token, no foreign Origin)", () => {
  const good = () => ({ authorization: `Bearer ${api.token}` });
  it.each([
    ["no token", BASE, () => ({}), 401, "missing bearer token"],
    ["a wrong token", BASE, () => ({ authorization: `Bearer ${"x".repeat(43)}` }), 401, "invalid bearer token"],
    ["the token minus a character", BASE, () => ({ authorization: `Bearer ${api.token.slice(0, -1)}` }), 401, "invalid bearer token"],
    ["Basic auth", BASE, () => ({ authorization: `Basic ${api.token}` }), 401, "invalid bearer token"],
    ["a foreign Host (DNS rebinding)", "http://attacker.example:4321", good, 403, "host not allowed: attacker.example:4321"],
    ["another port", "http://127.0.0.1:9999", good, 403, "host not allowed: 127.0.0.1:9999"],
    ["no port", "http://localhost", good, 403, "host not allowed: localhost"],
    ["a foreign Origin (a web page in the browser)", BASE, () => ({ ...good(), origin: "https://evil.example" }), 403, "origin not allowed: https://evil.example"],
  ])("refuses %s, audits it as actor api, and changes nothing", async (_n, base, headers, status, reason) => {
    const res = await api.handle(new Request(`${base}/api/project`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ name: "other" }) }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: reason });
    expect((await get("/api/project")).body.project.name).toBe("demo");
    expect(await audit()).toEqual([expect.objectContaining({ actor: "api", action: "http", ok: false, detail: `${status} ${reason} (POST /api/project)` })]);
    expect(await auditText()).not.toContain(api.token);
  });

  it("accepts the token from 127.0.0.1 or localhost, with no Origin, Origin null, or an allowed app origin; writes are audited", async () => {
    expect((await call("GET", "/api/status", undefined, {}, "http://localhost:4321")).status).toBe(200);
    expect((await call("GET", "/api/status", undefined, { origin: "null" })).status).toBe(200);
    const app = createApi(engine, { env: {}, jobs: local, origins: ["app://cairn"] });
    const res = await app.handle(new Request(`${BASE}/api/status`, { headers: { authorization: `Bearer ${app.token}`, origin: "app://cairn" } }));
    expect(res.status).toBe(200);
    expect((await app.handle(new Request(`${BASE}/api/status`, { headers: { authorization: `Bearer ${api.token}` } }))).status).toBe(401);
    await app.close();
    expect((await post("/api/project", { name: "other" })).status).toBe(200);
    expect(await audit()).toEqual([
      expect.objectContaining({ actor: "api", ok: false, detail: "401 invalid bearer token (GET /api/status)" }),
      expect.objectContaining({ actor: "api", ok: true, detail: "200 (POST /api/project)" }),
    ]);
  });

  it("needs a token of at least 32 bytes; the default is new every start", () => {
    expect(() => createApi(engine, { token: "short" })).toThrow(/at least 32 bytes/);
    const a = createApi(engine);
    expect(Buffer.from(a.token, "base64url").length).toBe(32);
    expect(a.token).not.toBe(api.token);
  });

  it("an unexpected error is a 500 with a generic message; details go to the log without the token", async () => {
    const status = engine.status.bind(engine);
    engine.status = async () => {
      throw new Error(`boom near ${api.token}`);
    };
    try {
      const r = await get("/api/status");
      expect(r).toEqual({ status: 500, body: { error: "internal error (details in the engine's log)" } });
      expect(logs.join("\n")).toContain("api: GET /api/status: Error: boom near [token]");
      expect(logs.join("\n")).not.toContain(api.token);
    } finally {
      engine.status = status;
    }
  });

  it("routing and bodies: 404, 405, bad JSON, wrong content type, too large", async () => {
    expect(await get("/api/nope")).toEqual({ status: 404, body: { error: "not found" } });
    expect((await call("DELETE", "/api/project")).status).toBe(405);
    expect(await call("POST", "/api/project", "{nope")).toEqual({ status: 400, body: { error: "the body is not valid JSON" } });
    expect(await call("POST", "/api/project", "[1]")).toEqual({ status: 400, body: { error: "the body must be a JSON object" } });
    expect((await call("POST", "/api/project", "name=other", { "content-type": "text/plain" })).status).toBe(415);
    const small = createApi(engine, { env: {}, maxBody: 64 });
    const res = await small.handle(new Request(`${BASE}/api/project`, { method: "POST", headers: { authorization: `Bearer ${small.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(100) }) }));
    expect(res.status).toBe(413);
  });
});

describe("projects and ledger reads (re project / hypothesis / tree / decision / claim list)", () => {
  it("lists projects with data class, shows and switches the current one, as the CLI sees it", async () => {
    expect((await get("/api/projects")).body.projects).toEqual([
      { name: "demo", dataClass: "unpublished", dir: demo.dir, current: true },
      { name: "other", dataClass: "public", dir: join(root, "projects", "other"), current: false },
    ]);
    expect((await get("/api/project")).body).toEqual({ project: { name: "demo", dataClass: "unpublished", dir: demo.dir } });
    expect((await post("/api/project", { name: "other" })).body.project.name).toBe("other");
    expect((await re("project")).out).toMatch(/^other {2}\[public\]/);
    expect(await post("/api/project", { name: "../demo" })).toEqual({ status: 400, body: { error: 'bad project name "../demo"' } });
    expect((await post("/api/project", { name: "ghost" })).status).toBe(404);
    expect(await post("/api/project", {})).toEqual({ status: 400, body: { error: "name is required" } });
  });

  it("hypotheses, the exploration tree (text and nodes), decisions and claims", async () => {
    await re("hypothesis", "add", "--title", "SZ3 helps", "--statement", "s", "--prediction", "p", "--falsification", "f", "--baseline", "b", "--experiment", "e", "--kill", "k");
    await re("hypothesis", "approve", "HY01", "--note", "go");
    expect((await get("/api/projects/demo/hypotheses")).body.hypotheses).toEqual([expect.objectContaining({ id: "HY01", title: "SZ3 helps", status: "approved" })]);
    const tree = (await get("/api/projects/demo/tree")).body;
    expect(tree.text).toBe((await re("tree")).out);
    expect(tree.nodes).toEqual([expect.objectContaining({ id: "N01", type: "question" })]);
    expect((await get("/api/projects/demo/decisions")).body.decisions).toEqual([expect.objectContaining({ id: "D01" })]);
    expect((await get("/api/projects/demo/claims")).body).toEqual({ project: "demo", claims: [] });
    expect((await get("/api/projects/ghost/tree")).status).toBe(404);
    expect((await get("/api/projects/..%2Fdemo/tree")).status).toBe(400);
  });
});

describe("project files and literature (the app's Results, Files, and preview drawer)", () => {
  it("lists committed files with sizes; reads text, images as base64, binaries as size only; refuses traversal", async () => {
    await demo.writeArtifacts(
      [
        { path: "evidence/tables/EXP-001/t.csv", content: "n,primes\n100000,9592\n" },
        { path: "evidence/raw/EXP-001/fig.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
        { path: "evidence/raw/EXP-001/blob.bin", content: new Uint8Array([1, 0, 2]) },
      ],
      P.aiExecuted("m1", "high"),
      "files",
    );
    await writeFile(join(demo.dir, "evidence", "uncommitted.csv"), "x\n");
    const list = (await get("/api/projects/demo/files?dir=evidence")).body;
    expect(list.files).toEqual(expect.arrayContaining([{ path: "evidence/tables/EXP-001/t.csv", bytes: 21 }, { path: "evidence/raw/EXP-001/fig.png", bytes: 4 }]));
    expect(JSON.stringify(list)).not.toContain("uncommitted");
    expect((await get(`/api/projects/demo/file?path=${encodeURIComponent("evidence/tables/EXP-001/t.csv")}`)).body.file).toEqual({ path: "evidence/tables/EXP-001/t.csv", bytes: 21, kind: "text", text: "n,primes\n100000,9592\n" });
    expect((await get(`/api/projects/demo/file?path=${encodeURIComponent("evidence/raw/EXP-001/fig.png")}`)).body.file).toEqual({ path: "evidence/raw/EXP-001/fig.png", bytes: 4, kind: "image", mime: "image/png", base64: "iVBORw==" });
    expect((await get(`/api/projects/demo/file?path=${encodeURIComponent("evidence/raw/EXP-001/blob.bin")}`)).body.file).toEqual({ path: "evidence/raw/EXP-001/blob.bin", bytes: 3, kind: "binary" });
    expect((await get(`/api/projects/demo/file?path=${encodeURIComponent("evidence/uncommitted.csv")}`)).status).toBe(404);
    expect((await get(`/api/projects/demo/file?path=${encodeURIComponent("evidence")}`)).status).toBe(404);
    expect((await get(`/api/projects/demo/file?path=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(400);
    expect((await get("/api/projects/demo/file")).status).toBe(400);
    expect((await get("/api/projects/demo/literature")).body).toEqual({ project: "demo", notes: [], references: 0 });
  });
});

describe("jobs (re job / re machine): agents propose, the user approves", () => {
  it("list → card → deny needs a reason → approve → refresh → fetch", async () => {
    const job = await propose();
    expect((await get("/api/jobs")).body).toEqual({ project: "demo", jobs: [expect.objectContaining({ id: job.id, state: "pending_approval" })] });
    expect((await get("/api/jobs?all=1")).body.project).toBeNull();
    expect((await get("/api/jobs?project=other")).body).toEqual({ project: "other", jobs: [] });
    expect((await get("/api/jobs?project=ghost")).status).toBe(404);
    const shown = (await get(`/api/jobs/${job.id}`)).body;
    expect(shown.job.id).toBe(job.id);
    expect(shown.card).toBe((await re("job", "show", job.id)).out);
    expect(await post(`/api/jobs/${job.id}/deny`, {})).toEqual({ status: 400, body: { error: "a denial needs a reason (it goes back to the agent)" } });
    expect(await post(`/api/jobs/${job.id}/submit`)).toEqual({ status: 409, body: { error: `job ${job.id} is pending_approval; only approved jobs are launched` } });

    const approved = await post(`/api/jobs/${job.id}/approve`, { note: "fine" });
    expect(approved.status).toBe(200);
    expect(approved.body.job).toMatchObject({ state: "running", approval: { by: "user", note: "fine" } });
    expect(await post(`/api/jobs/${job.id}/approve`)).toEqual({ status: 409, body: { error: `job ${job.id} is running, not pending approval` } });
    let state = "";
    for (let i = 0; i < 100 && state !== "completed"; i++) {
      state = (await post(`/api/jobs/${job.id}/refresh`)).body.job.state;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe("completed");
    const fetched = (await post(`/api/jobs/${job.id}/fetch`)).body.job;
    expect(fetched.results).toMatchObject({ dir: `evidence/raw/EXP-001/${job.id}`, files: ["results.csv"], missing: ["absent.csv"] });
    expect(await readFile(join(demo.dir, `evidence/raw/EXP-001/${job.id}/results.csv`), "utf8")).toBe("7\n");
  });

  it("deny and cancel; unknown and malformed ids are 404", async () => {
    const a = await propose();
    const b = await propose();
    expect((await post(`/api/jobs/${a.id}/deny`, { reason: "too long" })).body.job).toMatchObject({ state: "denied", denial: { reason: "too long" } });
    expect((await post(`/api/jobs/${b.id}/cancel`)).body.job.state).toBe("cancelled");
    expect(await post(`/api/jobs/${b.id}/cancel`)).toEqual({ status: 409, body: { error: `job ${b.id} is already cancelled` } });
    expect(await get("/api/jobs/20260101-0000-dead")).toEqual({ status: 404, body: { error: "no job 20260101-0000-dead" } });
    expect((await get("/api/jobs/not-an-id")).status).toBe(404);
  });

  it("machines with their SSH session state", async () => {
    expect((await get("/api/machines")).body.machines).toEqual([
      { name: "workstation", host: "workstation", scheduler: "none", scratch: join(root, "scratch"), doe: false, session: "open" },
      { name: "hpc", host: "hpc", scheduler: "slurm", scratch: null, doe: false, session: "open" },
    ]);
  });
});

describe("panels (blind until judged)", () => {
  it("list → show (blind: labels only) → judge → unblinded", async () => {
    const rec = await runPanel(engine, demo, { question: "Pursue it?", rounds: ["independent"], members: [{ alias: "acme-m", effort: "high" }, { alias: "beta-m", effort: "high" }] });
    expect((await get("/api/panels")).body).toEqual({ project: "demo", panels: [{ id: rec.id, created: rec.created, modes: ["independent"], hypothesis: null, judged: false, question: "Pursue it?" }] });
    const blind = (await get(`/api/panels/${rec.id}`)).body;
    expect(blind.judged).toBe(false);
    expect(blind.text).toContain("(blind until `re panel judge`)");
    expect(blind.text).toContain("Compression helps.");
    expect(blind.panel.members).toEqual([{ label: "Model A" }, { label: "Model B" }]);
    expect(JSON.stringify(blind)).not.toMatch(/acme|beta|"a1"|"b1"/);

    const judged = await post(`/api/panels/${rec.id}/judge`, { prefer: ["B"], note: "better risks" });
    expect(judged.body.judged).toBe(true);
    expect(judged.body.text).toContain("prefer Model B · better risks");
    expect(judged.body.panel.members.map((m: Json) => m.alias).sort()).toEqual(["acme-m", "beta-m"]);
    expect((await re("panel", "show", rec.id)).out).toBe(judged.body.text);
    expect((await post(`/api/panels/${rec.id}/judge`, { prefer: "A" })).status).toBe(409);
    expect((await get("/api/panels?project=other")).body.panels).toEqual([]);
    expect(await get("/api/panels/20260101-0000-dead")).toEqual({ status: 404, body: { error: "no panel 20260101-0000-dead in demo" } });
    expect((await get("/api/panels/nope")).status).toBe(404);
  });

  it("refuses a judgment naming no member", async () => {
    const rec = await runPanel(engine, demo, { question: "Q", rounds: ["independent"], members: [{ alias: "acme-m", effort: "high" }, { alias: "beta-m", effort: "high" }] });
    expect(await post(`/api/panels/${rec.id}/judge`, { prefer: ["Z"] })).toEqual({ status: 400, body: { error: "--prefer Z: no such member (have A, B)" } });
    expect((await post(`/api/panels/${rec.id}/judge`, { prefer: 3 })).status).toBe(400);
  });
});

describe("the claim gate (check → review → approve)", () => {
  beforeEach(async () => {
    await addEvidence(demo);
  });

  it("check: inline drafts and branch drafts; never a host file path", async () => {
    const ok = (await post("/api/claims/check", { draft: claim() })).body;
    expect(ok).toMatchObject({ project: "demo", ok: true });
    expect(ok.text).toMatch(/^support check: PASSED/);
    const bad = await post("/api/claims/check", { draft: claim().replace("9592 primes below", "9593 primes below") });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, report: { errors: ["Proof: 9593 is not backed by a checked source"] } });
    await branchDraft(demo, claim());
    expect((await post("/api/claims/check", { ref: BRANCH_REF })).body.ok).toBe(true);
    expect(await post("/api/claims/check", { ref: "agent/nope:staging/claims/sieve.md" })).toEqual({ status: 404, body: { error: "no staging/claims/sieve.md on branch agent/nope of demo" } });
    expect((await post("/api/claims/check", { ref: "/etc/passwd" })).status).toBe(400);
    expect((await post("/api/claims/check", { ref: BRANCH_REF, draft: claim() })).status).toBe(400);
    expect((await post("/api/claims/check", {})).status).toBe(400);
  });

  it("drafts: what the agents committed, and where each stands (not reviewed → reviewed → approved)", async () => {
    expect((await get("/api/projects/demo/drafts")).body).toEqual({ project: "demo", drafts: [] });
    await branchDraft(demo, claim());
    const listed = async () => (await get("/api/projects/demo/drafts")).body.drafts as Json[];
    expect(await listed()).toEqual([
      { ref: BRANCH_REF, branch: "agent/analysis-1", title: "Pure-Python sieve time grows about linearly with N", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), md: claim() },
    ]);
    await post("/api/claims/review", { ref: BRANCH_REF });
    expect((await listed())[0]).toMatchObject({ review: { verdict: "revise", summary: "Supported numerically, thin method.", reviewer: "rev-m (r1, high)", text: expect.stringMatching(/^rigor review: REVISE/) } });
    expect((await listed())[0]!.approved).toBeUndefined();
    await post("/api/claims/approve", { ref: BRANCH_REF, note: "ok" });
    expect((await listed())[0]).toMatchObject({ approved: { claim: "C01", by: "user-revised" } });
    expect((await re("claim", "drafts")).out).toBe(`${BRANCH_REF}  [approved as C01]  Pure-Python sieve time grows about linearly with N`);
    expect((await get("/api/projects/nope/drafts")).status).toBe(404);
  });

  it("review needs a passing check; approve needs a review of this exact draft", async () => {
    const wrong = claim().replace("9592 primes below", "9593 primes below");
    const refused = await post("/api/claims/review", { draft: wrong });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "the support check fails; fix the draft before asking for a review", report: { ok: false } });
    expect(await post("/api/claims/approve", { draft: claim() })).toEqual({
      status: 409,
      body: { error: "no rigor review of this exact draft (re claim review); a changed draft needs a new review" },
    });
    expect((await post("/api/claims/review", { draft: claim(), effort: "extreme" })).status).toBe(400);
    const reviewed = (await post("/api/claims/review", { draft: claim() })).body;
    expect(reviewed.review).toMatchObject({ verdict: "revise", reviewer: { alias: "rev-m", model: "r1", effort: "high" } });
    expect(reviewed.text).toContain("Supported numerically, thin method.");
    const a = (await post("/api/claims/approve", { draft: claim(), note: "notebook" })).body;
    expect(a).toMatchObject({ project: "demo", id: "C01", provenance: "user-revised", gate: "engine/claims/C01/" });
    expect((await get("/api/projects/demo/claims")).body.claims).toEqual([expect.objectContaining({ id: "C01", title: "Pure-Python sieve time grows about linearly with N" })]);
    // A draft the user says is their own (like a file with --own in the CLI) enters as `user`.
    const own = claim(`Job \`${EJOB}\`: 9592 primes below 100000.`);
    await post("/api/claims/review", { draft: own });
    expect((await post("/api/claims/approve", { draft: own, own: true })).body.provenance).toBe("user");
    expect((await post("/api/claims/approve", { draft: own, own: "yes" })).status).toBe(400);
  });

  it("a reviewer the project's data class rules out is a 502 with the refusal, not a crash", async () => {
    const secret = await Ledger.create({ projectsDir: join(root, "projects"), name: "secret", title: "S", dataClass: "restricted" });
    await addEvidence(secret);
    const r = await post("/api/claims/review", { draft: claim(), project: "secret" });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/^reviewer call failed: refused: provider 'rev' may not receive 'restricted' data/);
  });
});

describe("the API and the CLI write the same ledger (one set of engine functions)", () => {
  const subjects = async (l: Ledger, id: string) =>
    (await git(l.dir, ["log", "--reverse", "--format=%s|%(trailers:key=Cairn-Provenance,valueonly,separator=)"]))
      .split("\n")
      .filter((s) => s.includes(id))
      .map((s) => s.replaceAll(id, "<job>").replace(/\(\d+\)/, "(<pid>)"));

  it("job approve: same commits, provenance and audit as `re job approve`", async () => {
    const viaCli = await propose();
    const viaApi = await propose();
    expect((await re("job", "approve", viaCli.id, "--note", "fine")).code).toBe(0);
    expect((await post(`/api/jobs/${viaApi.id}/approve`, { note: "fine" })).body.job.state).toBe("running");
    expect(await subjects(demo, viaCli.id)).toEqual([
      "ledger: job <job>: EXP-001 on workstation, awaiting approval|ai-suggested(m1, low)",
      "ledger: job <job>: approved (fine)|user",
      "ledger: job <job>: started on workstation (<pid>)|ai-executed(m1, low)",
    ]);
    expect(await subjects(demo, viaApi.id)).toEqual(await subjects(demo, viaCli.id));
    const approvals = (await audit()).filter((a) => a.action === "approve");
    expect(approvals.map((a) => [a.actor, a.job, a.detail])).toEqual([["user", viaCli.id, "fine"], ["user", viaApi.id, "fine"]]);
  });

  it("claim approve of a branch draft: same claims.md and commit as `re claim approve`, and own is ignored for branch refs", async () => {
    const twin = await Ledger.create({ projectsDir: join(root, "projects"), name: "twin", title: "Demo", dataClass: "unpublished" });
    for (const l of [demo, twin]) {
      await addEvidence(l);
      await branchDraft(l, claim());
    }
    expect((await re("claim", "review", BRANCH_REF, "--project", "demo")).code).toBe(0);
    expect((await post("/api/claims/review", { ref: BRANCH_REF, project: "twin" })).status).toBe(200);
    const cli = await re("claim", "approve", BRANCH_REF, "--project", "demo", "--own", "--note", "ok");
    expect(cli.out).toMatch(/^approved: C01 in logic\/claims.md \(user-revised\)/);
    const viaApi = await post("/api/claims/approve", { ref: BRANCH_REF, project: "twin", own: true, note: "ok" });
    expect(viaApi.body).toMatchObject({ id: "C01", provenance: "user-revised" });
    expect(await readFile(join(twin.dir, "logic/claims.md"), "utf8")).toBe(await readFile(join(demo.dir, "logic/claims.md"), "utf8"));
    const head = (l: Ledger) => git(l.dir, ["show", "--name-only", "--format=%s|%(trailers:key=Cairn-Provenance,valueonly,separator=)", "HEAD"]);
    expect(await head(twin)).toBe(await head(demo));
    const gate = async (l: Ledger) => (JSON.parse(await readFile(join(l.dir, "engine/claims/C01/gate.json"), "utf8")) as Json).approved;
    expect({ ...(await gate(twin)), at: "" }).toEqual({ ...(await gate(demo)), at: "" });
    expect((await twin.check()).ok).toBe(true);
  });
});

describe("status and usage", () => {
  it("status as `re status` reads it, with plain objects for the per-provider tallies", async () => {
    const s = (await get("/api/status")).body;
    expect(s).toMatchObject({ machine: "test", paths: { home: engine.paths.home } });
    expect(s.providers.map((p: Json) => p.name)).toEqual(["acme", "beta", "rev"]);
    expect(s.today.usd).toEqual({ total: 0, byProvider: {}, byRole: {} });
  });

  it("usage: today's totals against the caps", async () => {
    expect((await get("/api/usage")).body).toEqual({
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      usd: { used: 0, cap: 10, byProvider: {}, byRole: {} },
      tokens: { used: 0, cap: null, byProvider: {}, byRole: {} },
      run: { max_usd: 2, max_tokens: 1_000_000, max_turns: 20 },
      badLines: [],
    });
    await addEvidence(demo);
    await post("/api/claims/review", { draft: claim() });
    expect(Object.keys((await get("/api/usage")).body.usd.byProvider)).toEqual(["rev"]);
  });
});

describe("GET /api/events (Server-Sent Events)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function open(signal?: AbortSignal) {
    return api.handle(new Request(`${BASE}/api/events`, { headers: { authorization: `Bearer ${api.token}` }, ...(signal ? { signal } : {}) }));
  }
  function reader(res: Response) {
    const r = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let ended = false;
    let pending: Promise<void> | undefined;
    const next = () =>
      (pending ??= r.read().then(({ done, value }) => {
        pending = undefined;
        if (done) ended = true;
        else text += dec.decode(value, { stream: true });
      }));
    const wait = async (ok: () => boolean, what: string) => {
      const deadline = Date.now() + 5000;
      while (!ok()) {
        if (ended) throw new Error(`stream ended while waiting for ${what}; got:\n${text}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got:\n${text}`);
        await Promise.race([next(), sleep(deadline - Date.now())]);
      }
    };
    return { until: (re: RegExp) => wait(() => re.test(text), String(re)), ended: () => wait(() => ended, "the end"), cancel: () => r.cancel() };
  }

  it("streams new events.jsonl lines, job state changes, and heartbeats", async () => {
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const r = reader(res);
    await r.until(/^: connected\n\n/);
    await engine.log.append({ ...envelope("run-1", "test"), type: "message", role: "user", text: "hello from the log" });
    await r.until(/event: engine\ndata: \{"type":"engine","event":\{.*"text":"hello from the log"/);
    const job = await propose();
    await r.until(new RegExp(`event: job\\ndata: \\{"type":"job","id":"${job.id}","state":"pending_approval","project":"demo"\\}`));
    await post(`/api/jobs/${job.id}/approve`);
    await r.until(new RegExp(`"id":"${job.id}","state":"running"`));
    await r.until(/: heartbeat\n\n/);
    await r.cancel();
  });

  it("ends when the client goes away or the API closes; refuses new streams after close", async () => {
    const ac = new AbortController();
    const a = reader(await open(ac.signal));
    await a.until(/: connected/);
    ac.abort();
    await a.ended();
    const b = reader(await open());
    await b.until(/: connected/);
    await api.close();
    await b.ended();
    expect((await open()).status).toBe(503);
  });

  it("needs the token like everything else", async () => {
    const res = await api.handle(new Request(`${BASE}/api/events`));
    expect(res.status).toBe(401);
  });
});

describe("serveApi and `re serve` (api.json, loopback socket)", () => {
  it("api.json is 0600, refuses a second live engine, and is removed only by its owner", async () => {
    const home = engine.paths.home;
    const path = await writeApiInfo(home, { url: "http://127.0.0.1:1", token: "t1", pid: process.pid });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readApiInfo(home)).toEqual({ url: "http://127.0.0.1:1", token: "t1", pid: process.pid });
    await expect(writeApiInfo(home, { url: "http://127.0.0.1:2", token: "t2", pid: process.ppid })).rejects.toThrow(/another engine API is running \(pid \d+/);
    await removeApiInfo(home, { token: "someone else" });
    expect(await readApiInfo(home)).toBeDefined();
    await removeApiInfo(home, { token: "t1" });
    expect(await readApiInfo(home)).toBeUndefined();
    // A stale file from a crashed engine is replaced.
    await writeApiInfo(home, { url: "http://127.0.0.1:3", token: "t3", pid: 99_999_999 });
    await writeApiInfo(home, { url: "http://127.0.0.1:4", token: "t4", pid: process.pid });
    expect((await readApiInfo(home))?.token).toBe("t4");
  });

  it("serves on 127.0.0.1 with the token from api.json (skipped where binding a port is not allowed)", async (ctx) => {
    let served;
    try {
      served = await serveApi(api, { port: 0 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw e;
    }
    try {
      const info = await readApiInfo(engine.paths.home);
      expect(info).toEqual({ url: served.url, token: api.token, pid: process.pid });
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${info!.url}/api/status`)).status).toBe(401);
      const ok = await fetch(`${info!.url}/api/project`, { headers: { authorization: `Bearer ${info!.token}` } });
      expect(await ok.json()).toMatchObject({ project: { name: "demo" } });
      const events = await fetch(`${info!.url}/api/events`, { headers: { authorization: `Bearer ${info!.token}` } });
      const r = events.body!.getReader();
      expect(new TextDecoder().decode((await r.read()).value)).toContain(": connected");
      await served.close();
      expect((await r.read()).done).toBe(true);
      expect(await readApiInfo(engine.paths.home)).toBeUndefined();
    } finally {
      await served.close();
    }
  });

  it("re serve: --port must be a port; prints where api.json is, never the token (skipped where binding is not allowed)", async (ctx) => {
    expect(await re("serve", "--port", "http")).toMatchObject({ code: 2, err: "re serve: --port must be a port number (0-65535; 0 picks a free one)" });
    expect((await re("serve", "--port", "70000")).code).toBe(2);
    let info: Awaited<ReturnType<typeof readApiInfo>>;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["serve"], { out: (l) => out.push(l), err: (l) => err.push(l) }, {
      openEngine: async () => engine,
      env: {},
      jobs: local,
      serveUntil: async () => {
        info = await readApiInfo(engine.paths.home);
      },
    });
    if (code === 1 && /EPERM/.test(err.join("\n"))) {
      expect(err.join("\n")).toContain("hint: binding a local port was refused");
      return ctx.skip();
    }
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^engine API on http:\/\/127\.0\.0\.1:\d+ \(127\.0\.0\.1 only; HTTP \+ SSE\)$/);
    expect(out[1]).toBe(`url and token: ${join(engine.paths.home, "api.json")} (mode 0600; the token changes every start)`);
    expect(info!.token.length).toBeGreaterThanOrEqual(43);
    expect([...out, ...err].join("\n")).not.toContain(info!.token);
    expect(await readApiInfo(engine.paths.home)).toBeUndefined();
  });
});
