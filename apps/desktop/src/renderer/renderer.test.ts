import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobRecord } from "@cairn/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CairnBridge, EngineRequest } from "../shared/bridge.js";
import { api } from "./api.js";
import { actionsFor, ago, groupJobs } from "./jobs.js";
import { Header, JobDetail, JobInbox } from "./views.js";

const job = (over: Partial<JobRecord>): JobRecord =>
  ({
    v: 1,
    id: "20261014-1251-c30f",
    project: "demo",
    experiment: "EXP-001",
    target: "workstation",
    state: "pending_approval",
    created: "2026-10-14T12:51:00Z",
    author: { kind: "agent", run: "r1", agent: "coder-1", role: "coder", model: "m1", effort: "low" },
    manifest: { script: "run.sh", resources: { cores: 1, walltime: "00:01:00" }, outputs: [] },
    files: [],
    fingerprint: "f",
    lint: { ok: true, findings: [] },
    history: [],
    ...over,
  }) as JobRecord;

describe("job inbox logic", () => {
  it("groups jobs by what they need from the user, newest first", () => {
    const g = groupJobs([
      job({ id: "a", state: "completed" }),
      job({ id: "b", state: "pending_approval", created: "2026-10-14T10:00:00Z" }),
      job({ id: "c", state: "pending_approval", created: "2026-10-14T11:00:00Z" }),
      job({ id: "d", state: "running" }),
      job({ id: "e", state: "denied" }),
      job({ id: "f", state: "lost" }),
    ]);
    expect([g.waiting, g.active, g.done].map((l) => l.map((j) => j.id))).toEqual([["c", "b"], ["d", "f"], ["a", "e"]]);
  });

  it("offers the actions `re job` allows in each state", () => {
    const remote = { host: "w", dir: "/s", id: "1", submitted: "2026-10-14T12:52:00Z" };
    const results = { at: "x", dir: "evidence/raw/EXP-001/j", files: [], referenced: [], missing: [], refused: [] };
    expect(actionsFor(job({ state: "pending_approval" }))).toEqual(["approve", "deny"]);
    expect(actionsFor(job({ state: "approved", error: "no open session" }))).toEqual(["submit", "cancel"]);
    expect(actionsFor(job({ state: "approved" }))).toEqual(["refresh"]);
    expect(actionsFor(job({ state: "running", remote }))).toEqual(["refresh", "cancel"]);
    expect(actionsFor(job({ state: "completed", remote }))).toEqual(["fetch", "refresh"]);
    expect(actionsFor(job({ state: "completed", remote, results }))).toEqual([]);
    expect(actionsFor(job({ state: "denied" }))).toEqual([]);
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-14T13:00:00Z");
    expect([ago("2026-10-14T12:59:30Z", now), ago("2026-10-14T12:30:00Z", now), ago("2026-10-14T09:00:00Z", now), ago("2026-10-10T09:00:00Z", now)]).toEqual(["just now", "30 min ago", "4 h ago", "2026-10-10"]);
  });
});

describe("views", () => {
  it("the inbox shows what waits for approval first", () => {
    const html = renderToStaticMarkup(createElement(JobInbox, { jobs: [job({ id: "j1" }), job({ id: "j2", state: "running" })], selected: "j1", onSelect: () => {} }));
    expect(html.indexOf("Waiting for your approval")).toBeLessThan(html.indexOf("In progress"));
    expect(html).toMatch(/class="job selected".*pending approval.*EXP-001 → workstation/);
    expect(html).toContain("No finished jobs yet.");
  });

  it("a job shows its approval card and the allowed actions; approving launches", () => {
    const html = renderToStaticMarkup(createElement(JobDetail, { job: job({}), card: "JOB 20261014-1251-c30f\nscript: run.sh", busy: false, error: "no session", onAction: () => {} }));
    expect(html).toContain("Approve and launch");
    expect(html).toContain(">Deny<");
    expect(html).toContain('<pre class="card">JOB 20261014-1251-c30f\nscript: run.sh</pre>');
    expect(html).toContain('<p class="error">no session</p>');
  });

  it("the header says whether the engine is there, and today's spend against the cap", () => {
    const status = { machine: "mac", today: { usd: { total: 1.5, byProvider: {}, byRole: {} }, tokens: { total: 12000, byProvider: {}, byRole: {} } }, caps: { daily: { usd: { total: 10 } } }, providers: [] };
    expect(renderToStaticMarkup(createElement(Header, { connection: { state: "connected", url: "http://127.0.0.1:1", startedByApp: true }, status }))).toMatch(
      /engine connected \(started by the app\).*mac · today \$1\.50 of \$10\.00 billed · 12,000 subscription tokens/,
    );
    expect(renderToStaticMarkup(createElement(Header, { connection: { state: "failed", detail: "x" }, status: undefined }))).toContain("engine unavailable");
  });
});

describe("api (over window.cairn)", () => {
  it("builds the engine API paths and surfaces errors", async () => {
    const sent: EngineRequest[] = [];
    const bridge: CairnBridge = {
      request: async (r) => {
        sent.push(r);
        return r.path.endsWith("/deny") ? { status: 400, body: { error: "a denial needs a reason" } } : { status: 200, body: { job: { id: "x" }, jobs: [], projects: [] } };
      },
      connection: async () => ({ state: "connecting", detail: "" }),
      subscribe: () => () => {},
    };
    const a = api(bridge);
    await a.jobs("my project");
    await a.approve("20261014-1251-c30f", "looks fine");
    await expect(a.deny("20261014-1251-c30f", "")).rejects.toThrow("a denial needs a reason");
    expect(sent).toEqual([
      { method: "GET", path: "/api/jobs?project=my%20project" },
      { method: "POST", path: "/api/jobs/20261014-1251-c30f/approve", body: { note: "looks fine" } },
      { method: "POST", path: "/api/jobs/20261014-1251-c30f/deny", body: { reason: "" } },
    ]);
  });

  it("only calls routes the engine API has (contract with packages/engine/src/api/api.ts)", async () => {
    const routes = [...(await readFile(join(import.meta.dirname, "..", "..", "..", "..", "packages", "engine", "src", "api", "api.ts"), "utf8")).matchAll(/\["(GET|POST)", "(\/api\/[^"]*)"/g)].map(
      (m) => new RegExp(`^${m[1]} ${m[2]!.replace(/:[a-z]+/g, "[^/]+")}$`),
    );
    const sent: EngineRequest[] = [];
    const bridge: CairnBridge = {
      request: async (r) => (sent.push(r), { status: 200, body: { job: {}, jobs: [], projects: [] } }),
      connection: async () => ({ state: "connecting", detail: "" }),
      subscribe: () => () => {},
    };
    const a = api(bridge);
    await Promise.all([a.status(), a.projects(), a.jobs("p"), a.job("j"), a.approve("j"), a.deny("j", "r"), a.submit("j"), a.refresh("j"), a.cancel("j"), a.fetch("j")]);
    for (const r of sent) expect(routes.some((re) => re.test(`${r.method} ${r.path.split("?")[0]}`)), `${r.method} ${r.path}`).toBe(true);
  });
});
