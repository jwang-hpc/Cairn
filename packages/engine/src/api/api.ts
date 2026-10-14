// The engine's local API for the desktop app (M8.1, DR-0002 amendment): HTTP for actions and reads, Server-Sent
// Events for updates. Web-standard (Request -> Response) so it is testable without sockets; serveApi() puts it on a
// loopback port. Every endpoint is a thin wrapper over the functions the CLI calls: the app is a thin client, and
// anything it can do, `re` can do.
//
// Security, as for the executor front (DR-0005, DR-0006): Host must be 127.0.0.1/localhost (with the bound port once
// known), a per-start bearer token (>= 32 bytes, constant-time compare) is required, and a request carrying an Origin
// header that isn't an allowed app origin is refused, so a web page in the user's browser can't drive approvals.
// Every refusal, and every state-changing request, goes to <home>/audit.log as actor "api". The token is never
// logged and never returned.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { JobError, type JobService, type JobServiceOptions } from "@cairn/executor";
import { EFFORT_LEVELS, type EffortLevel } from "@cairn/shared";
import { BudgetExceededError, type DailyTotals } from "../budget/governor.js";
import { approveDraft, BRANCH_DRAFT, checkDraft, readBranchDraft } from "../claims/commands.js";
import { listDrafts } from "../claims/drafts.js";
import { reviewDraft } from "../claims/gate.js";
import { renderReview, ReviewerError } from "../claims/review.js";
import { renderReport } from "../claims/support.js";
import type { Engine, Status } from "../engine.js";
import { jobListProject, machineSessions } from "../jobs/commands.js";
import { openJobService } from "../jobs/jobs.js";
import { listProjects, openCurrentProject, useProject } from "../ledger/commands.js";
import { type Ledger, LedgerError } from "../ledger/ledger.js";
import { renderTree } from "../ledger/tree.js";
import { listPanels } from "../panel/commands.js";
import { judgePanel, PanelError, panelView, readPanel, renderPanel } from "../panel/panel.js";
import { join } from "node:path";
import type { LiteratureService } from "@cairn/executor";
import { openLiteratureService } from "../literature/literature.js";
import { REPO_ROOT } from "../paths.js";
import { DelegationError, Delegations, runSteps, SessionHub } from "../session/delegate.js";
import { runTurn } from "../session/orchestrator.js";
import { type SessionMeta, SessionStore } from "../session/store.js";
import type { WorkerDeps } from "../worker/run.js";
import { type EventStream, eventStream } from "./events.js";

export interface ApiOptions {
  /** Bearer token (>= 32 bytes). Default: 32 random bytes, new every start. */
  token?: string;
  /** Origins allowed to call the API besides none/"null" (e.g. the packaged app's origin). Default: none. */
  origins?: readonly string[];
  /** For project selection (CAIRN_PROJECT), as in the CLI. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Jobs service overrides (tests inject a local transport). */
  jobs?: Partial<JobServiceOptions>;
  /** SSE polling intervals (ms). Defaults: events.jsonl 1000, job store 2000, heartbeat 15000. */
  poll?: { eventsMs?: number; jobsMs?: number; heartbeatMs?: number };
  /** Request body limit in bytes. Default 1 MiB. */
  maxBody?: number;
  /** Where unexpected errors are reported (default: stderr). Never sent to the client. */
  log?: (line: string) => void;
  /** Research sessions: worker deps overrides (tests inject a sandbox stand-in) and the per-project worker limit (3). */
  worker?: Partial<Omit<WorkerDeps, "engine" | "observe">>;
  maxWorkersPerProject?: number;
}

export interface Api {
  readonly token: string;
  /** Engine home (api.json, audit.log, events.jsonl). */
  readonly home: string;
  handle(request: Request): Promise<Response>;
  /** From now on Host must carry this port too (serveApi calls it once listening). */
  expectPort(port: number): void;
  /** End every open event stream and refuse further requests. */
  close(): Promise<void>;
}

/** A refusal or bad request from the API layer itself. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const HOSTS = new Set(["127.0.0.1", "localhost"]);
const DEFAULT_MAX_BODY = 1 << 20;

// Engine errors carry no codes; their messages are stable (tests pin them), so they map to statuses here.
const NOT_FOUND = /^(no job |bad job id|no panel |bad panel id|no project selected|not a Cairn project|no staging\/claims\/\S+ on branch |unknown hypothesis |unknown node )/;
const CONFLICT =
  /(, not pending approval$|; only approved jobs are launched$| was already launched$| is already \w+$| has not been launched$|; fetch its results after it finishes$| was already judged |^no rigor review|^the review on file is for a different draft|^the support check fails|changes made outside the gate|changed outside the claim gate| is busy|^could not (reach|cancel on|fetch from) |^project already exists| is \w+, not proposed$)/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
const msg = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

type Body = Record<string, unknown>;

function optString(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ApiError(400, `${key} must be a string`);
  return v;
}
function needString(b: Body, key: string, why = `${key} is required`): string {
  const v = optString(b, key);
  if (v === undefined || v.trim() === "") throw new ApiError(400, why);
  return v;
}
function optBool(b: Body, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ApiError(400, `${key} must be true or false`);
  return v;
}
/** ?all, ?all=1, ?all=true */
const flag = (v: string | null) => v !== null && ["", "1", "true", "yes"].includes(v.toLowerCase());

async function readBody(request: Request, max: number): Promise<Body> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, `request body over ${max} bytes`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(415, "send JSON (content-type: application/json)");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ApiError(400, "the body is not valid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ApiError(400, "the body must be a JSON object");
  return v as Body;
}

type Tally = DailyTotals["usd"];
const plainTally = (t: Tally) => ({ total: t.total, byProvider: Object.fromEntries(t.byProvider), byRole: Object.fromEntries(t.byRole) });

/** Today's usage against the caps, per unit (billed USD, subscription tokens) and provider, as `re status` shows it. */
function usageView({ today, caps }: Pick<Status, "today" | "caps">) {
  const unit = (t: Tally, c: { total?: number; per_provider?: Record<string, number> }) => {
    const providers = [...new Set([...t.byProvider.keys(), ...Object.keys(c.per_provider ?? {})])].sort();
    return {
      used: t.total,
      cap: c.total ?? null,
      byProvider: Object.fromEntries(providers.map((p) => [p, { used: t.byProvider.get(p) ?? 0, cap: c.per_provider?.[p] ?? null }])),
      byRole: Object.fromEntries(t.byRole),
    };
  };
  return { day: today.day, usd: unit(today.usd, caps.daily.usd), tokens: unit(today.tokens, caps.daily.tokens), run: caps.run, badLines: today.badLines };
}

interface Ctx {
  params: string[];
  query: URLSearchParams;
  request: Request;
  body(): Promise<Body>;
}
type Handler = (c: Ctx) => Promise<unknown>;

export function createApi(engine: Engine, opts: ApiOptions = {}): Api {
  const token = opts.token ?? randomBytes(32).toString("base64url");
  if (Buffer.byteLength(token) < 32) throw new Error("the API token must be at least 32 bytes");
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const expected = digest(token);
  const origins = new Set(opts.origins ?? []);
  const env = opts.env ?? process.env;
  const maxBody = opts.maxBody ?? DEFAULT_MAX_BODY;
  const poll = { eventsMs: opts.poll?.eventsMs ?? 1000, jobsMs: opts.poll?.jobsMs ?? 2000, heartbeatMs: opts.poll?.heartbeatMs ?? 15_000 };
  const scrub = (s: string) => s.split(token).join("[token]");
  const log = (line: string) => (opts.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(scrub(line));
  const jobs: JobService = openJobService(engine, opts.jobs);
  const streams = new Set<EventStream>();
  // Research sessions (DR-0014): one store, one event hub, one delegation runner per API.
  const sessions = new SessionStore(engine.paths.home);
  const hub = new SessionHub();
  let literature: Promise<LiteratureService> | undefined;
  const delegations = new Delegations({
    engine,
    store: sessions,
    hub,
    ledgerFor: (p) => openCurrentProject(engine, { project: p }, env),
    worker: { skillsDir: join(REPO_ROOT, "skills"), jobs, ...opts.worker },
    workerExtras: async () => (opts.worker?.literature ? {} : { literature: await (literature ??= openLiteratureService(engine)) }),
    maxPerProject: opts.maxWorkersPerProject ?? 3,
  });
  const turning = new Set<string>();
  let port: number | undefined;
  let closed = false;

  const audit = async (ok: boolean, detail: string) => {
    try {
      await jobs.audit.append({ actor: "api", action: "http", ok, detail: scrub(detail) });
    } catch (e) {
      log(`api: audit.log append failed: ${msg(e)}`);
    }
  };
  const tokenOk = (header: string | null) => {
    const m = /^Bearer ([^\s]+)$/.exec(header ?? "");
    // Hashing both sides makes the comparison constant-time whatever the length sent.
    return m !== null && timingSafeEqual(digest(m[1]!), expected);
  };
  const hostOk = (url: URL) => HOSTS.has(url.hostname) && (port === undefined || (url.port || "80") === String(port));

  /** The project named in the request (body, then ?project=), else the current one, as `--project` works in the CLI. */
  const ledgerFor = (c: Ctx, body: Body = {}): Promise<Ledger> => {
    const project = optString(body, "project") ?? c.query.get("project") ?? undefined;
    return openCurrentProject(engine, project !== undefined ? { project } : {}, env);
  };
  /** The draft text: inline markdown, or a draft committed on a branch of the project (never a host file path). */
  const draftOf = async (ledger: Ledger, body: Body): Promise<{ md: string; ref?: string }> => {
    const hasDraft = body.draft !== undefined && body.draft !== null;
    const hasRef = body.ref !== undefined && body.ref !== null;
    if (hasDraft === hasRef) throw new ApiError(400, "pass exactly one of draft (the claim's markdown) or ref (<branch>:staging/claims/<name>.md)");
    if (hasDraft) return { md: needString(body, "draft", "draft must be the claim's markdown") };
    const ref = needString(body, "ref");
    if (!BRANCH_DRAFT.test(ref)) throw new ApiError(400, "ref must be <branch>:staging/claims/<name>.md (the API reads drafts from the project's git, not from files)");
    return { md: await readBranchDraft(ledger, ref), ref };
  };
  const project = (l: Ledger) => ({ name: l.name, dataClass: l.dataClass, dir: l.dir });
  const sessionOf = async (l: Ledger, id: string) => {
    try {
      return await sessions.load(l.name, id);
    } catch {
      throw new ApiError(404, `no session ${id} in ${l.name}`);
    }
  };
  const meta = (r: SessionMeta) => ({ v: r.v, id: r.id, project: r.project, title: r.title, created: r.created, updated: r.updated, turns: r.turns });
  const proposalAction = (action: "launch" | "dismiss" | "stop"): Handler => async (c) => {
    const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
    await sessionOf(l, c.params[1]!);
    const ref = { project: l.name, session: c.params[1]!, proposal: c.params[2]! };
    return { proposal: await delegations[action](ref) };
  };
  const job = (c: Ctx) => c.params[0]!;

  const routes: [method: "GET" | "POST", pattern: string, handler: Handler][] = [
    ["GET", "/api/status", async () => {
      const s = await engine.status();
      return { ...s, today: { ...s.today, usd: plainTally(s.today.usd), tokens: plainTally(s.today.tokens) } };
    }],
    ["GET", "/api/usage", async () => usageView(await engine.usage())],

    // projects (re project ...)
    ["GET", "/api/projects", async () => ({ projects: await listProjects(engine) })],
    ["GET", "/api/project", async () => ({ project: project(await openCurrentProject(engine, {}, env)) })],
    ["POST", "/api/project", async (c) => ({ project: project(await useProject(engine, needString(await c.body(), "name"))) })],
    ["GET", "/api/projects/:name/hypotheses", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      return { project: l.name, hypotheses: await l.hypotheses() };
    }],
    ["GET", "/api/projects/:name/tree", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      const nodes = await l.tree();
      return { project: l.name, text: renderTree(nodes), nodes };
    }],
    ["GET", "/api/projects/:name/claims", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      return { project: l.name, claims: await l.claims() };
    }],
    ["GET", "/api/projects/:name/drafts", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      return { project: l.name, drafts: await listDrafts(l) };
    }],
    // research sessions (re chat; DR-0014)
    ["GET", "/api/projects/:name/sessions", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      return { project: l.name, sessions: await sessions.list(l.name), workers: delegations.activity(l.name) };
    }],
    ["POST", "/api/projects/:name/sessions", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      const title = optString(await c.body(), "title");
      return { session: meta(await sessions.create(l.name, title)) };
    }],
    ["GET", "/api/projects/:name/sessions/:id", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      const rec = await sessionOf(l, c.params[1]!);
      return { session: meta(rec), summary: rec.summary ?? null, proposals: rec.proposals, transcript: await sessions.transcript(l.name, rec.id), workers: delegations.activity(l.name) };
    }],
    ["POST", "/api/projects/:name/sessions/:id/messages", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      const text = needString(await c.body(), "text", "text must be the message");
      if (text.length > 20_000) throw new ApiError(400, "a message is at most 20,000 characters");
      const rec = await sessionOf(l, c.params[1]!);
      const key = `${l.name}/${rec.id}`;
      if (turning.has(key)) throw new ApiError(409, "the orchestrator is still answering the previous message");
      turning.add(key);
      const at = { project: l.name, session: rec.id };
      try {
        const r = await runTurn(
          { engine, ledger: l, store: sessions, jobs: async () => (await jobs.list({ project: l.name })).map((j) => ({ id: j.id, state: j.state, experiment: j.experiment, target: j.target })) },
          rec,
          text,
          {
            delta: (t) => hub.emit({ type: "turn_delta", ...at, text: t }),
            tool: (name, args) => hub.emit({ type: "turn_tool", ...at, name, detail: JSON.stringify(args ?? {}).slice(0, 200) }),
            proposal: (p) => hub.emit({ type: "proposal", ...at, proposal: p }),
          },
        );
        hub.emit({ type: "turn_end", ...at, run: r.run, usd: r.usd, error: r.error });
        return { text: r.text, run: r.run, usd: r.usd, ms: r.ms, error: r.error, proposals: r.proposals };
      } finally {
        turning.delete(key);
      }
    }],
    ["POST", "/api/projects/:name/sessions/:id/proposals/:pid/launch", proposalAction("launch")],
    ["POST", "/api/projects/:name/sessions/:id/proposals/:pid/dismiss", proposalAction("dismiss")],
    ["POST", "/api/projects/:name/sessions/:id/proposals/:pid/stop", proposalAction("stop")],
    ["GET", "/api/runs/:run/steps", async (c) => ({ run: c.params[0]!, steps: await runSteps(engine.paths.home, c.params[0]!) })],
    ["GET", "/api/projects/:name/decisions", async (c) => {
      const l = await openCurrentProject(engine, { project: c.params[0]! }, env);
      return { project: l.name, decisions: await l.decisions() };
    }],

    // jobs (re job ..., re machine list)
    ["GET", "/api/jobs", async (c) => {
      const all = flag(c.query.get("all"));
      const named = c.query.get("project");
      // An explicit project must exist (the CLI would quietly fall back to every project).
      if (named !== null && !all) await openCurrentProject(engine, { project: named }, env);
      const p = await jobListProject(engine, { all, ...(named !== null ? { project: named } : {}) }, env);
      return { project: p ?? null, jobs: await jobs.list(p ? { project: p } : {}) };
    }],
    ["GET", "/api/jobs/:id", async (c) => ({ job: await jobs.get(job(c)), card: await jobs.card(job(c)) })],
    ["POST", "/api/jobs/:id/approve", async (c) => ({ job: await jobs.approve(job(c), optString(await c.body(), "note")) })],
    ["POST", "/api/jobs/:id/deny", async (c) => ({ job: await jobs.deny(job(c), needString(await c.body(), "reason", "a denial needs a reason (it goes back to the agent)")) })],
    ["POST", "/api/jobs/:id/submit", async (c) => ({ job: await jobs.launch(job(c)) })],
    ["POST", "/api/jobs/:id/cancel", async (c) => ({ job: await jobs.cancel(job(c), "user") })],
    ["POST", "/api/jobs/:id/refresh", async (c) => ({ job: await jobs.refresh(job(c)) })],
    ["POST", "/api/jobs/:id/fetch", async (c) => ({ job: await jobs.fetch(job(c)) })],
    ["GET", "/api/machines", async () => ({ machines: await machineSessions(engine, opts.jobs) })],

    // panels (re panel list | show | judge)
    ["GET", "/api/panels", async (c) => {
      const l = await ledgerFor(c);
      return { project: l.name, panels: await listPanels(l) };
    }],
    ["GET", "/api/panels/:id", async (c) => {
      const l = await ledgerFor(c);
      const { record, texts } = await readPanel(l, c.params[0]!);
      return { project: l.name, judged: record.judgment !== undefined, text: renderPanel(record, texts), panel: panelView(record) };
    }],
    ["POST", "/api/panels/:id/judge", async (c) => {
      const body = await c.body();
      const l = await ledgerFor(c, body);
      const p = body.prefer;
      const prefer = typeof p === "string" ? p.split(",").map((x) => x.trim()).filter(Boolean) : p;
      if (!Array.isArray(prefer) || !prefer.every((x) => typeof x === "string")) throw new ApiError(400, "prefer must be a list of member labels, e.g. [\"A\"]");
      const note = optString(body, "note");
      await judgePanel(l, c.params[0]!, { prefer, ...(note ? { note } : {}) });
      const { record, texts } = await readPanel(l, c.params[0]!);
      return { project: l.name, judged: true, text: renderPanel(record, texts), panel: panelView(record) };
    }],

    // the claim gate (re claim check | review | approve)
    ["POST", "/api/claims/check", async (c) => {
      const body = await c.body();
      const l = await ledgerFor(c, body);
      const report = await checkDraft(l, (await draftOf(l, body)).md);
      return { project: l.name, ok: report.ok, report, text: renderReport(report) };
    }],
    ["POST", "/api/claims/review", async (c) => {
      const body = await c.body();
      const l = await ledgerFor(c, body);
      const { md } = await draftOf(l, body);
      const alias = optString(body, "model");
      const effort = optString(body, "effort");
      if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) throw new ApiError(400, `effort must be one of ${EFFORT_LEVELS.join(", ")}`);
      const r = await reviewDraft(engine, l, md, { ...(alias ? { alias } : {}), ...(effort ? { effort: effort as EffortLevel } : {}) });
      if (!r.review) throw new ApiError(409, "the support check fails; fix the draft before asking for a review", { report: r.report, text: renderReport(r.report) });
      return { project: l.name, report: r.report, review: r.review, text: renderReview(r.review) };
    }],
    ["POST", "/api/claims/approve", async (c) => {
      const body = await c.body();
      const l = await ledgerFor(c, body);
      const { md, ref } = await draftOf(l, body);
      const a = await approveDraft(l, md, ref, { note: optString(body, "note"), own: optBool(body, "own") });
      return { project: l.name, id: a.id, provenance: a.provenance, gate: `engine/claims/${a.id}/`, report: a.report, review: a.review };
    }],

    ["GET", "/api/events", async (c) => {
      let s: EventStream | undefined = undefined;
      s = eventStream({
        home: engine.paths.home,
        jobs: () => jobs.list(),
        subscribe: (push) => hub.subscribe((e) => push("session", e)),
        ...poll,
        signal: c.request.signal,
        onError: (e) => log(`api: events: ${msg(e)}`),
        onClose: () => void (s && streams.delete(s)),
      });
      streams.add(s);
      return new Response(s.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" },
      });
    }],
  ];
  const compiled = routes.map(([method, pattern, handler]) => ({ method, parts: pattern.split("/").slice(1), handler }));

  function failure(e: unknown, where: string): Response {
    if (e instanceof ApiError) return json(e.status, { error: e.message, ...e.extra });
    if (e instanceof JobError || e instanceof LedgerError || e instanceof PanelError) {
      return json(NOT_FOUND.test(e.message) ? 404 : CONFLICT.test(e.message) ? 409 : 400, { error: e.message });
    }
    if (e instanceof DelegationError) return json(/^no proposal/.test(e.message) ? 404 : 409, { error: e.message });
    // The reviewer model could not be asked or failed (provider refused the data class, route down): upstream.
    if (e instanceof ReviewerError) return json(502, { error: e.message });
    if (e instanceof BudgetExceededError) return json(429, { error: e.message });
    log(`api: ${where}: ${msg(e)}`);
    return json(500, { error: "internal error (details in the engine's log)" });
  }

  async function route(request: Request, url: URL, where: string): Promise<Response> {
    let segs: string[];
    try {
      segs = url.pathname.split("/").slice(1).map(decodeURIComponent);
    } catch {
      return json(400, { error: "bad path" });
    }
    const hits = compiled.filter((r) => r.parts.length === segs.length && r.parts.every((p, i) => p.startsWith(":") || p === segs[i]));
    // No two routes match the same path and method; a path that matches with another method is a 405.
    const hit = hits.find((r) => r.method === request.method);
    if (!hit) return hits.length > 0 ? json(405, { error: "method not allowed" }, { allow: [...new Set(hits.map((r) => r.method))].join(", ") }) : json(404, { error: "not found" });
    const params = hit.parts.flatMap((p, i) => (p.startsWith(":") ? [segs[i]!] : []));
    let body: Promise<Body> | undefined;
    try {
      const out = await hit.handler({ params, query: url.searchParams, request, body: () => (body ??= readBody(request, maxBody)) });
      return out instanceof Response ? out : json(200, out);
    } catch (e) {
      return failure(e, where);
    }
  }

  return {
    token,
    home: engine.paths.home,
    expectPort(p) {
      port = p;
    },
    async handle(request) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        await audit(false, `400 bad request URL (${request.method})`);
        return json(400, { error: "bad request" });
      }
      const where = `${request.method} ${clip(url.pathname)}`;
      const refuse = async (status: number, reason: string, headers?: Record<string, string>) => {
        await audit(false, `${status} ${reason} (${where})`);
        return json(status, { error: reason }, headers);
      };
      if (!hostOk(url)) return refuse(403, `host not allowed: ${clip(url.host)}`);
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== "null" && !origins.has(origin)) return refuse(403, `origin not allowed: ${clip(origin)}`);
      const auth = request.headers.get("authorization");
      if (!auth) return refuse(401, "missing bearer token", { "www-authenticate": "Bearer" });
      if (!tokenOk(auth)) return refuse(401, "invalid bearer token", { "www-authenticate": 'Bearer error="invalid_token"' });
      if (closed) return json(503, { error: "the engine API is shutting down" });
      const res = await route(request, url, where);
      if (request.method !== "GET" && request.method !== "HEAD") await audit(res.status < 400, `${res.status} (${where})`);
      return res;
    },
    async close() {
      closed = true;
      for (const s of [...streams]) s.close();
      streams.clear();
    },
  };
}
