import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobRecord } from "@cairn/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CairnBridge, EngineRequest, Proposal } from "../shared/bridge.js";
import { api, type Draft, type SessionView, type TranscriptEntry } from "./api.js";
import { Composer, ProposalCard, Thread } from "./chat.js";
import { clampDrawer, Drawer, parseCsv, wideDrawer } from "./drawer.js";
import { ApprovalsView, LiteratureView, problemText, ResultsView } from "./panels.js";
import { applyEvent, type ChatState, emptyChat, needsYou, recap, thread, toolSummary } from "./session.js";

const at = "2026-10-14T20:00:00.000Z";
const P = (over: Partial<Proposal> = {}): Proposal => ({ id: "P1", kind: "task", role: "coder", title: "Repeat EXP-001 five times", task: "Run it 5×", state: "proposed", created: at, updated: at, ...over });
const view = (proposals: Proposal[], transcript: TranscriptEntry[] = []): SessionView => ({
  session: { id: "20261014-2000-ab12", project: "m5-demo", title: "Is C01 robust?", created: at, updated: at, turns: 1 },
  summary: null,
  proposals,
  transcript,
  workers: { running: 0, queued: 0 },
});
const job = (state: string): JobRecord => ({ id: "20261014-2213-7c1e", project: "m5-demo", experiment: "EXP-001", target: "workstation", state, created: at, manifest: { script: "run.sh", description: "five repeats", resources: { cores: 1, walltime: "00:05:00" }, outputs: [] } }) as unknown as JobRecord;
const draft = (approved = false): Draft => ({ ref: "agent/analysis-1:staging/claims/x.md", branch: "agent/analysis-1", title: "Revised claim", sha256: "a".repeat(64), md: "## C??: x\n", ...(approved ? { approved: { claim: "C02", at, by: "user-revised" } } : {}) });
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("session state (live events, thread, recap)", () => {
  it("applies the open session's events and ignores others", () => {
    let s: ChatState = { ...emptyChat(), view: view([P()]), live: { message: "why?", text: "", tools: [], startedAt: 0 } };
    s = applyEvent(s, { type: "turn_tool", project: "m5-demo", session: "20261014-2000-ab12", name: "read_file", detail: "{}" });
    s = applyEvent(s, { type: "turn_delta", project: "m5-demo", session: "20261014-2000-ab12", text: "Mostly " });
    s = applyEvent(s, { type: "turn_delta", project: "m5-demo", session: "20261014-2000-ab12", text: "one run." });
    s = applyEvent(s, { type: "proposal", project: "m5-demo", session: "20261014-2000-ab12", proposal: P({ state: "running", run: "r1" }) });
    s = applyEvent(s, { type: "worker_step", project: "m5-demo", session: "20261014-2000-ab12", proposal: "P1", run: "r1", at, step: "running: python3 bench.py" });
    const other = applyEvent(s, { type: "turn_delta", project: "m5-demo", session: "other", text: "x" });
    expect(other).toBe(s);
    expect(s.live).toMatchObject({ text: "Mostly one run.", tools: [{ name: "read_file" }] });
    expect(s.view!.proposals).toEqual([P({ state: "running", run: "r1" })]);
    expect(s.steps.P1).toEqual([{ at, step: "running: python3 bench.py" }]);
  });

  it("folds tool use into the answer after it and shows each card once", () => {
    const t: TranscriptEntry[] = [
      { at, kind: "user", text: "why?" },
      { at, kind: "tool", run: "r", name: "read_file", text: "ok", isError: false },
      { at, kind: "tool", run: "r", name: "search", text: "ok", isError: false },
      { at, kind: "proposal", proposal: P() },
      { at, kind: "assistant", text: "One run.", run: "r", ms: 2100, usd: 0 },
      { at, kind: "proposal", proposal: P({ state: "queued" }) },
    ];
    expect(thread(t).map((i) => i.kind)).toEqual(["user", "card", "assistant"]);
    expect(thread(t)[2]).toMatchObject({ kind: "assistant", tools: [{ name: "read_file" }, { name: "search" }] });
    expect(toolSummary([{ name: "read_file" }, { name: "read_file" }, { name: "search" }, { name: "propose_task" }])).toBe("read 2 files · searched 1 · proposed 1");
  });

  it("recap and 'needs you' come from the cards and the project, without a model", () => {
    const v = view([P({ state: "done" }), P({ id: "P2", kind: "decision", title: "Hold C01", state: "proposed" }), P({ id: "P3", state: "needs_input" })]);
    expect(recap(v, [job("pending_approval")], [draft()])).toEqual({
      done: ["P1 done: Repeat EXP-001 five times"],
      next: ["P3 has questions for you", "1 job waiting for your approval", "1 claim draft waiting for the gate", "P2 is proposed, not launched: Hold C01"],
    });
    expect(needsYou(v, [job("pending_approval"), job("running")], [draft(), draft(true)])).toBe(4); // job, draft, decision P2, questions P3
  });
});

describe("chat views", () => {
  const card = (p: Proposal, steps: { at: string; step: string }[] = []) => html(createElement(ProposalCard, { proposal: p, steps, busy: false, onAction: () => {}, onOpen: () => {}, onAnswer: () => {} }));

  it("cards offer what each state allows", () => {
    expect(card(P())).toMatch(/Coder · P1.*Repeat EXP-001 five times.*proposed.*Show the task.*>Launch<.*>Dismiss</);
    expect(card(P({ kind: "decision", rationale: "One run." }))).toMatch(/Decision · P1.*One run\..*>Record in ledger<.*>Dismiss</);
    const running = card(P({ state: "running", run: "r1" }), [{ at, step: "reading bench.py" }, { at, step: "running: python3 bench.py" }]);
    expect(running).toMatch(/running · .*class="step-now"><span class="pulse" aria-hidden="true"><\/span>running: python3 bench.py/);
    expect(running).toMatch(/Show 2 steps.*Open log.*>Stop</);
    const done = card(P({ state: "done", run: "r1", outcome: { status: "done", summary: "Proposed a job with 5 repeats.", files: ["experiments/EXP-001/bench.py (modified)"], questions: [], jobs: ["20261014-2213-7c1e (pending_approval)"], drafts: [], literature: false, usd: 0.03 } }));
    expect(done).toMatch(/done · \$0\.03.*Proposed a job with 5 repeats\..*Job 20261014-2213-7c1e \(pending_approval\).*1 file changed/);
    expect(done).not.toContain(">Launch<");
    expect(card(P({ state: "needs_input", outcome: { status: "needs_input", summary: "", files: [], questions: ["Which sizes?"], jobs: [], drafts: [], literature: false } }))).toMatch(/has questions.*Which sizes\?.*>Answer</);
    expect(card(P({ kind: "decision", state: "recorded", recorded: "D01" }))).toContain("Recorded as D01");
  });

  it("the thread shows the live answer and its new cards while the turn runs; the composer queues", () => {
    const chat = { ...emptyChat(), view: view([P({ id: "P2", title: "Live card" })], [{ at, kind: "user", text: "first" }, { at, kind: "assistant", text: "first answer", run: "r", ms: 1000 }]), live: { message: "second", text: "Partial…", tools: [], startedAt: 0 } };
    const t = html(createElement(Thread, { chat, busyCards: false, onAction: () => {}, onOpen: () => {}, onAnswer: () => {} }));
    expect(t).toMatch(/first.*first answer.*1\.0 s.*second.*Partial….*Live card/);
    const c = html(createElement(Composer, { draft: "more", onDraft: () => {}, onSend: () => {}, answering: true, queued: ["and then?"], running: [{ id: "P3", title: "x", step: "searching literature", since: at }], queuedWorkers: 1 }));
    expect(c).toMatch(/P3<\/b> searching literature.*1 of 3 worker slots in use · 1 queued.*Will send after the current answer: “and then\?”.*>Queue</);
  });
});

describe("panels and drawer", () => {
  it("outline, results, literature, approvals", () => {
    expect(problemText("# Problem\n\n<!-- template -->\n\nHow does sieve time scale with N?\n\nMore.")).toBe("How does sieve time scale with N?");
    const r = html(createElement(ResultsView, { files: [{ path: "evidence/figures/t.png", bytes: 10 }, { path: "evidence/tables/EXP-001/s.csv", bytes: 99 }, { path: "logic/claims.md", bytes: 5 }], thumbs: { "evidence/figures/t.png": "data:image/png;base64,AA==" }, onOpen: () => {}, onWantThumb: () => {} }));
    expect(r).toMatch(/Figures · 1.*src="data:image\/png;base64,AA==".*Tables · 1.*evidence\/tables\/EXP-001\/s\.csv/);
    expect(r).not.toContain("logic/claims.md");
    expect(html(createElement(LiteratureView, { notes: [{ path: "lit/notes/a.md", key: "liang2023sz3", paper: "doi:x", relevance: 9, title: "SZ3", year: 2023 }], references: 9, onOpen: () => {} }))).toMatch(/9 references.*>9<.*SZ3.*liang2023sz3.*2023/);
    const ap = html(createElement(ApprovalsView, { jobs: [job("pending_approval")], drafts: [draft()], proposals: [P({ id: "P2", kind: "decision", title: "Hold C01" })], onOpen: () => {}, onRecord: () => {}, onDismiss: () => {}, onAnswer: () => {} }));
    expect(ap).toMatch(/Needs you · 3.*20261014-2213-7c1e · EXP-001 → workstation.*Review and decide.*Revised claim.*Take it through the gate.*Hold C01.*Record in ledger/);
  });

  it("the drawer is resizable within limits, and widens to two thirds of the window", () => {
    expect([clampDrawer(100, 1600), clampDrawer(700, 1600), clampDrawer(1500, 1600)]).toEqual([320, 700, 1000]); // 1600 - 240 sidebar - 360 chat
    expect(wideDrawer(1600)).toBe(1000);
    expect(wideDrawer(1200)).toBe(600);
    expect(clampDrawer(500, 700)).toBe(320); // a small window keeps the minimum
    const noop = { busy: false, error: undefined, onAction: () => {} };
    const d = html(createElement(Drawer, { item: { kind: "file", path: "t.csv" }, content: undefined, onClose: () => {}, width: 400, wide: false, onResize: () => {}, onToggleWide: () => {}, job: noop, gate: { busy: undefined, error: undefined, onStep: () => {} }, onStop: () => {} }));
    expect(d).toMatch(/role="separator" aria-orientation="vertical" aria-label="Resize the preview" aria-valuenow="400" tabindex="0"/);
    expect(d).toMatch(/>Widen<\/button><button type="button" class="btn">Close</);
  });

  it("parses CSV with quotes, and the drawer renders tables and images", () => {
    expect(parseCsv('n,label\n1,"a, b"\r\n2,"say ""hi"""\n')).toEqual([["n", "label"], ["1", "a, b"], ["2", 'say "hi"']]);
    const noop = { busy: false, error: undefined, onAction: () => {} };
    const gate = { busy: undefined, error: undefined, onStep: () => {} };
    const table = html(createElement(Drawer, { item: { kind: "file", path: "t.csv" }, content: { kind: "file", file: { path: "t.csv", bytes: 1, kind: "text", text: "n,s\n100000,0.00519\n" } }, onClose: () => {}, width: 400, wide: false, onResize: () => {}, onToggleWide: () => {}, job: noop, gate, onStop: () => {} }));
    expect(table).toMatch(/<th>n<\/th><th>s<\/th>.*<td class="num">100000<\/td><td class="num">0\.00519<\/td>/);
    const img = html(createElement(Drawer, { item: { kind: "file", path: "f.svg" }, content: { kind: "file", file: { path: "f.svg", bytes: 1, kind: "image", mime: "image/svg+xml", base64: "PHN2Zy8+" } }, onClose: () => {}, width: 400, wide: false, onResize: () => {}, onToggleWide: () => {}, job: noop, gate, onStop: () => {} }));
    expect(img).toContain('<img class="preview-img" src="data:image/svg+xml;base64,PHN2Zy8+"');
  });
});

describe("contract with the engine API (session and file routes)", () => {
  it("only calls routes the engine has", async () => {
    const routes = [...(await readFile(join(import.meta.dirname, "..", "..", "..", "..", "packages", "engine", "src", "api", "api.ts"), "utf8")).matchAll(/\["(GET|POST)", "(\/api\/[^"]*)"/g)].map(
      (m) => new RegExp(`^${m[1]} ${m[2]!.replace(/:[a-z]+/g, "[^/]+")}$`),
    );
    const sent: EngineRequest[] = [];
    const bridge: CairnBridge = {
      request: async (r) => (sent.push(r), { status: 200, body: { session: {}, sessions: [], proposal: {}, steps: [], file: {}, files: [], notes: [] } }),
      connection: async () => ({ state: "connecting", detail: "" }),
      reconnect: async () => ({ state: "connecting", detail: "" }),
      subscribe: () => () => {},
    };
    const a = api(bridge);
    await Promise.all([a.sessions("p"), a.newSession("p"), a.session("p", "s"), a.send("p", "s", "hi"), a.proposal("p", "s", "P1", "launch"), a.proposal("p", "s", "P1", "stop"), a.steps("r"), a.files("p", "evidence"), a.file("p", "a/b.csv"), a.literature("p")]);
    for (const r of sent) expect(routes.some((re) => re.test(`${r.method} ${r.path.split("?")[0]}`)), `${r.method} ${r.path}`).toBe(true);
    expect(sent.find((r) => r.path.includes("/file?"))?.path).toBe("/api/projects/p/file?path=a%2Fb.csv");
  });
});
