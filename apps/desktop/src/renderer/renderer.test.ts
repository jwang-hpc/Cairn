import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobRecord } from "@cairn/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CairnBridge, EngineRequest } from "../shared/bridge.js";
import { api, type Draft } from "./api.js";
import { gateState, sortDrafts } from "./claims.js";
import { actionsFor, ago, groupJobs } from "./jobs.js";
import { ClaimsList, DraftDetail, Header, JobDetail, JobInbox, LedgerView } from "./views.js";

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
      reconnect: async () => ({ state: "connecting", detail: "" }),
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
      request: async (r) => (sent.push(r), { status: 200, body: { job: {}, jobs: [], projects: [], drafts: [], claims: [], hypotheses: [], decisions: [], text: "" } }),
      connection: async () => ({ state: "connecting", detail: "" }),
      reconnect: async () => ({ state: "connecting", detail: "" }),
      subscribe: () => () => {},
    };
    const a = api(bridge);
    await Promise.all([a.status(), a.projects(), a.jobs("p"), a.job("j"), a.approve("j"), a.deny("j", "r"), a.submit("j"), a.refresh("j"), a.cancel("j"), a.fetch("j")]);
    await Promise.all([a.drafts("p"), a.claims("p"), a.check("p", "b:staging/claims/x.md"), a.review("p", "b:staging/claims/x.md"), a.approveClaim("p", "b:staging/claims/x.md")]);
    await Promise.all([a.hypotheses("p"), a.tree("p"), a.decisions("p")]);
    expect(sent.find((r) => r.path === "/api/claims/approve")).toEqual({ method: "POST", path: "/api/claims/approve", body: { project: "p", ref: "b:staging/claims/x.md" } });
    for (const r of sent) expect(routes.some((re) => re.test(`${r.method} ${r.path.split("?")[0]}`)), `${r.method} ${r.path}`).toBe(true);
  });
});

const draft = (over: Partial<Draft> = {}): Draft => ({ ref: "agent/analysis-1:staging/claims/sieve.md", branch: "agent/analysis-1", title: "Sieve time grows linearly", sha256: "a".repeat(64), md: "## C??: Sieve time grows linearly\n", ...over });
const REVIEW = { verdict: "revise" as const, summary: "thin", reviewer: "rev (r1, high)", at: "2026-10-14T20:00:00Z", text: "rigor review: REVISE — rev" };

describe("claim gate in the app (DR-0007)", () => {
  it("approval needs a review of this exact draft; an approved draft is done", () => {
    expect(gateState(draft())).toMatchObject({ stage: "not reviewed", canCheck: true, canReview: true, canApprove: false });
    expect(gateState(draft({ review: REVIEW }))).toMatchObject({ stage: "reviewed", canApprove: true, label: "reviewed: revise" });
    expect(gateState(draft({ review: REVIEW, approved: { claim: "C01", at: "2026-10-14T21:00:00Z", by: "user-revised" } }))).toMatchObject({ stage: "approved", canCheck: false, canApprove: false, label: "approved as C01" });
    const order = sortDrafts([draft({ ref: "a:x", approved: { claim: "C01", at: "x", by: "user-revised" } }), draft({ ref: "b:x" }), draft({ ref: "c:x", review: REVIEW })]).map((d) => d.ref);
    expect(order).toEqual(["c:x", "b:x", "a:x"]); // reviewed (ready for your decision), not reviewed, approved
  });

  it("the draft view offers the three steps; approve is disabled until a review is on file", () => {
    const html = (d: Draft) => renderToStaticMarkup(createElement(DraftDetail, { draft: d, check: { ok: false, text: "support check: FAILED" }, review: undefined, busy: undefined, error: undefined, onStep: () => {} }));
    const fresh = html(draft());
    expect(fresh).toContain("1. Support check");
    expect(fresh).toContain("2. Rigor review");
    expect(fresh).toMatch(/<button type="button" class="primary" disabled="" title="Approval needs a rigor review of this exact draft">3\. Approve…<\/button>/);
    expect(fresh).toContain('<pre class="card failed">support check: FAILED</pre>');
    expect(fresh).toContain("## C??: Sieve time grows linearly");
    expect(html(draft({ review: REVIEW }))).toMatch(/2\. Review again.*<button type="button" class="primary" title="">3\. Approve…/);
    const done = html(draft({ review: REVIEW, approved: { claim: "C01", at: "2026-10-14T21:00:00Z", by: "user-revised" } }));
    expect(done).toContain("approved as C01 (user-revised, 2026-10-14)");
    expect(done).not.toContain("1. Support check");
  });

  it("lists drafts and claims, and the ledger", () => {
    const list = renderToStaticMarkup(createElement(ClaimsList, { drafts: [draft({ review: REVIEW })], claims: [{ id: "C01", title: "Linear", fields: { Status: "supported", Provenance: "user-revised" } }], selected: undefined, onSelect: () => {}, onRefresh: () => {} }));
    expect(list).toMatch(/reviewed: revise.*Sieve time grows linearly.*agent\/analysis-1:staging\/claims\/sieve\.md/);
    expect(list).toMatch(/C01.*Linear.*supported · user-revised/);
    const ledger = renderToStaticMarkup(createElement(LedgerView, { hypotheses: [{ id: "HY01", title: "SZ3 helps", statement: "s", status: "approved", provenance: "user" }], tree: "N01 question", decisions: [{ id: "D01", title: "Approve HY01", fields: {} }] }));
    expect(ledger).toMatch(/HY01.*SZ3 helps.*approved · user/);
    expect(ledger).toContain("N01 question");
    expect(ledger).toContain("D01");
  });
});
