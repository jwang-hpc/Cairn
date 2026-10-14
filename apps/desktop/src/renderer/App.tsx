// The app (DR-0014): a chat with the orchestrator at the centre of each project, with the outline and files on the
// left, Literature / Results / Approvals as tabs, and a preview drawer for whatever is opened. Engine events (session
// replies and worker steps, job state changes, usage) update what they affect.
import type { JobRecord } from "@cairn/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CairnBridge, EngineConnection, Proposal } from "../shared/bridge.js";
import { api, type Draft, type FileEntry, type PaperNote, type ProjectSummary, type SessionMeta, type Status } from "./api.js";
import { Composer, type DrawerItem, RecapCard, SessionBar, Thread } from "./chat.js";
import { Drawer, type DrawerContent } from "./drawer.js";
import type { JobAction } from "./jobs.js";
import { ApprovalsView, LiteratureView, type Outline, problemText, ResultsView, Sidebar } from "./panels.js";
import { applyEvent, type ChatState, emptyChat, needsYou, recap, upsertProposal } from "./session.js";
import { type GateStep, Header } from "./views.js";

type Tab = "chat" | "literature" | "results" | "approvals";
const message = (e: unknown) => (e as Error).message;

export function App(props: { bridge: CairnBridge }) {
  const a = useMemo(() => api(props.bridge), [props.bridge]);
  const [connection, setConnection] = useState<EngineConnection>({ state: "connecting", detail: "starting" });
  const [status, setStatus] = useState<Status>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string>();
  const [tab, setTab] = useState<Tab>("chat");
  const [error, setError] = useState<string>();

  // project data
  const [outline, setOutline] = useState<Outline>();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [literature, setLiterature] = useState<{ notes: PaperNote[]; references: number }>({ notes: [], references: 0 });
  // chat
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [chat, setChat] = useState<ChatState>(emptyChat());
  const [draft, setDraft] = useState("");
  const [cardBusy, setCardBusy] = useState(false);
  // drawer
  const [drawer, setDrawer] = useState<DrawerItem>();
  const [content, setContent] = useState<DrawerContent>();
  const [jobBusy, setJobBusy] = useState(false);
  const [gateBusy, setGateBusy] = useState<GateStep>();
  const [drawerError, setDrawerError] = useState<string>();

  const projectRef = useRef(project);
  const chatRef = useRef(chat);
  const drawerRef = useRef(drawer);
  projectRef.current = project;
  chatRef.current = chat;
  drawerRef.current = drawer;

  // ---------- loading ----------
  const loadStatus = useCallback(() => a.status().then(setStatus, () => {}), [a]);
  const loadJobs = useCallback(async () => {
    const p = projectRef.current;
    if (p) setJobs(await a.jobs(p).catch(() => []));
  }, [a]);
  const loadGate = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    setDrafts(await a.drafts(p).catch(() => []));
  }, [a]);
  const loadOutline = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    const [problem, cl, hypotheses, tree, list] = await Promise.all([
      a.file(p, "logic/problem.md").then((f) => (f.kind === "text" ? problemText(f.text) : ""), () => ""),
      a.claims(p).catch(() => []),
      a.hypotheses(p).catch(() => []),
      a.tree(p).catch(() => ""),
      a.files(p).catch(() => ({ files: [], truncated: false })),
    ]);
    setOutline({ problem, claims: cl, hypotheses, tree });
    setFiles(list.files);
  }, [a]);
  const loadLiterature = useCallback(async () => {
    const p = projectRef.current;
    if (p) setLiterature(await a.literature(p).catch(() => ({ notes: [], references: 0 })));
  }, [a]);
  const openSession = useCallback(
    async (id: string) => {
      const p = projectRef.current;
      if (!p) return;
      const view = await a.session(p, id);
      setChat((c) => ({ ...c, view, live: c.view?.session.id === id ? c.live : undefined }));
    },
    [a],
  );
  const loadSessions = useCallback(
    async (open: boolean) => {
      const p = projectRef.current;
      if (!p) return;
      const r = await a.sessions(p).catch(() => ({ sessions: [], workers: { running: 0, queued: 0 } }));
      setSessions(r.sessions);
      if (open && r.sessions[0]) await openSession(r.sessions[0].id);
    },
    [a, openSession],
  );

  // ---------- connection and events ----------
  useEffect(() => {
    let usageTimer: ReturnType<typeof setTimeout> | undefined;
    void props.bridge.connection().then(setConnection);
    const off = props.bridge.subscribe({
      connection: setConnection,
      event: (e) => {
        if (e.type === "job") {
          if (e.project === projectRef.current) void loadJobs();
          const d = drawerRef.current;
          if (d?.kind === "job" && d.id === e.id) void a.job(e.id).then((j) => setContent({ kind: "job", ...j }), () => {});
        } else if (e.type === "engine") {
          if (e.event.type === "usage") {
            clearTimeout(usageTimer);
            usageTimer = setTimeout(() => void loadStatus(), 1000);
          }
        } else if (e.project === projectRef.current) {
          setChat((c) => applyEvent(c, e));
          if (e.type === "worker_step") {
            const d = drawerRef.current;
            if (d?.kind === "log" && d.proposal === e.proposal) setContent((c) => (c?.kind === "log" ? { ...c, steps: [...c.steps, { at: e.at, step: e.step }] } : c));
          }
          if (e.type === "proposal" && ["done", "failed", "needs_input", "stopped", "recorded"].includes(e.proposal.state)) {
            // What a worker or a recorded decision changed: jobs, drafts, files, the outline.
            void loadJobs();
            void loadGate();
            void loadOutline();
          }
        }
      },
    });
    return () => {
      off();
      clearTimeout(usageTimer);
    };
  }, [props.bridge, a, loadJobs, loadGate, loadOutline, loadStatus]);

  useEffect(() => {
    if (connection.state !== "connected") return;
    void loadStatus();
    void a.projects().then(
      (ps) => {
        setProjects(ps);
        setProject((p) => p ?? ps.find((x) => x.current)?.name ?? ps[0]?.name);
      },
      (e: unknown) => setError(message(e)),
    );
  }, [connection.state, a, loadStatus]);

  useEffect(() => {
    setChat(emptyChat());
    setDrawer(undefined);
    setContent(undefined);
    setThumbs({});
    setError(undefined);
    if (!project) return;
    void loadOutline();
    void loadJobs();
    void loadGate();
    void loadLiterature();
    void loadSessions(true);
  }, [project, loadOutline, loadJobs, loadGate, loadLiterature, loadSessions]);

  // ---------- chat ----------
  const sendNow = useCallback(
    async (text: string) => {
      const p = projectRef.current;
      if (!p) return;
      try {
        let id = chatRef.current.view?.session.id;
        if (!id) {
          id = (await a.newSession(p)).id;
          await openSession(id);
        }
        setChat((c) => ({ ...c, live: { message: text, text: "", tools: [], startedAt: Date.now() } }));
        const r = await a.send(p, id, text);
        if (r.error) setError(r.error);
        await openSession(id);
        void loadSessions(false);
      } catch (e) {
        setError(message(e));
      } finally {
        setChat((c) => ({ ...c, live: undefined }));
        // Messages typed meanwhile go next, in order.
        const next = chatRef.current.queued[0];
        if (next !== undefined) {
          setChat((c) => ({ ...c, queued: c.queued.slice(1) }));
          void sendNow(next);
        }
      }
    },
    [a, openSession, loadSessions],
  );
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError(undefined);
    if (chatRef.current.live) setChat((c) => ({ ...c, queued: [...c.queued, text] }));
    else void sendNow(text);
  };
  const newChat = async () => {
    if (!project) return;
    const s = await a.newSession(project);
    await loadSessions(false);
    await openSession(s.id);
  };
  const onProposal = async (pid: string, action: "launch" | "dismiss" | "stop") => {
    const p = projectRef.current;
    const id = chatRef.current.view?.session.id;
    if (!p || !id) return;
    setCardBusy(true);
    try {
      const updated: Proposal = await a.proposal(p, id, pid, action);
      setChat((c) => (c.view ? { ...c, view: { ...c.view, proposals: upsertProposal(c.view.proposals, updated) } } : c));
      if (updated.state === "recorded") void loadOutline();
    } catch (e) {
      setError(message(e));
    } finally {
      setCardBusy(false);
    }
  };
  const answer = (prefix: string) => {
    setTab("chat");
    setDraft((d) => (d ? d : prefix));
    setTimeout(() => document.getElementById("message")?.focus(), 0);
  };

  // ---------- drawer ----------
  const open = useCallback(
    async (item: DrawerItem) => {
      const p = projectRef.current;
      if (!p) return;
      setDrawer(item);
      setContent(undefined);
      setDrawerError(undefined);
      try {
        if (item.kind === "file") setContent({ kind: "file", file: await a.file(p, item.path) });
        else if (item.kind === "job") setContent({ kind: "job", ...(await a.job(item.id)) });
        else if (item.kind === "draft") {
          const d = (await a.drafts(p)).find((x) => x.ref === item.ref);
          setContent(d ? { kind: "draft", draft: d } : { kind: "error", message: `no draft ${item.ref} on the project's branches` });
        } else if (item.kind === "claim") {
          const c = (await a.claims(p)).find((x) => x.id === item.id);
          setContent(c ? { kind: "claim", claim: c } : { kind: "error", message: `no claim ${item.id}` });
        } else {
          const running = chatRef.current.view?.proposals.some((x) => x.id === item.proposal && (x.state === "running" || x.state === "queued")) ?? false;
          setContent({ kind: "log", title: item.title, steps: await a.steps(item.run), running });
        }
      } catch (e) {
        setContent({ kind: "error", message: message(e) });
      }
    },
    [a],
  );
  const wantThumb = useCallback(
    (path: string) => {
      const p = projectRef.current;
      if (!p) return;
      setThumbs((t) => (t[path] ? t : { ...t, [path]: "" }));
      void a.file(p, path).then(
        (f) => f.kind === "image" && setThumbs((t) => ({ ...t, [path]: `data:${f.mime};base64,${f.base64}` })),
        () => {},
      );
    },
    [a],
  );
  const actOnJob = async (action: JobAction, text?: string) => {
    if (content?.kind !== "job") return;
    const id = content.job.id;
    setJobBusy(true);
    setDrawerError(undefined);
    try {
      if (action === "approve") await a.approve(id, text);
      else if (action === "deny") await a.deny(id, text ?? "");
      else await a[action](id);
    } catch (e) {
      setDrawerError(message(e));
    } finally {
      setJobBusy(false);
      void loadJobs();
      void a.job(id).then((j) => setContent({ kind: "job", ...j }), () => {});
    }
  };
  const gateStep = async (step: GateStep, note?: string) => {
    const p = projectRef.current;
    if (!p || content?.kind !== "draft") return;
    const ref = content.draft.ref;
    setGateBusy(step);
    setDrawerError(undefined);
    try {
      if (step === "check") {
        const r = await a.check(p, ref);
        setContent((c) => (c?.kind === "draft" ? { ...c, check: { ok: r.ok, text: r.text } } : c));
      } else if (step === "review") {
        const r = await a.review(p, ref);
        setContent((c) => (c?.kind === "draft" ? { ...c, review: r.text } : c));
      } else {
        const r = await a.approveClaim(p, ref, note);
        await loadGate();
        void loadOutline();
        void open({ kind: "claim", id: r.id });
        return;
      }
      await loadGate();
    } catch (e) {
      setDrawerError(message(e));
    } finally {
      setGateBusy(undefined);
    }
  };
  const stopFromLog = () => {
    const d = drawerRef.current;
    if (d?.kind === "log") void onProposal(d.proposal, "stop");
  };

  // ---------- render ----------
  const view = chat.view;
  const running = (view?.proposals ?? [])
    .filter((x) => x.state === "running")
    .map((x) => ({ id: x.id, title: x.title, step: chat.steps[x.id]?.at(-1)?.step ?? "starting…", since: x.updated }));
  const queuedWorkers = (view?.proposals ?? []).filter((x) => x.state === "queued").length;
  const waiting = needsYou(view, jobs, drafts);
  const tabButton = (t: Tab, label: string, badge?: number) => (
    <button key={t} type="button" role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
      {label}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );

  return (
    <div className="app">
      <Header connection={connection} status={status} />
      {connection.state === "failed" && (
        <p className="error banner">
          {connection.detail}{" "}
          <button type="button" className="btn" onClick={() => void props.bridge.reconnect().then(setConnection)}>
            Retry
          </button>
        </p>
      )}
      <div className={`layout${drawer ? "" : " no-drawer"}`}>
        <Sidebar projects={projects} project={project} onProject={setProject} outline={outline} files={files} onOpen={(i) => void open(i)} />
        <section className="center">
          <div className="tabs" role="tablist">
            {tabButton("chat", "Chat")}
            {tabButton("literature", "Literature")}
            {tabButton("results", "Results")}
            {tabButton("approvals", "Approvals", waiting)}
          </div>
          {error && (
            <p className="error inline">
              {error}{" "}
              <button type="button" className="btn link" onClick={() => setError(undefined)}>
                Dismiss
              </button>
            </p>
          )}
          {tab === "chat" && (
            <>
              <SessionBar sessions={sessions} current={view?.session.id} onSelect={(id) => void openSession(id)} onNew={() => void newChat()} busy={chat.live !== undefined} />
              <div className="view">
                <RecapCard recap={recap(view, jobs, drafts)} />
                <Thread chat={chat} busyCards={cardBusy} onAction={(pid, act) => void onProposal(pid, act)} onOpen={(i) => void open(i)} onAnswer={answer} />
              </div>
              <Composer draft={draft} onDraft={setDraft} onSend={send} answering={chat.live !== undefined} queued={chat.queued} running={running} queuedWorkers={queuedWorkers} />
            </>
          )}
          {tab === "literature" && (
            <div className="view">
              <LiteratureView notes={literature.notes} references={literature.references} onOpen={(i) => void open(i)} />
            </div>
          )}
          {tab === "results" && (
            <div className="view">
              <ResultsView files={files} thumbs={thumbs} onOpen={(i) => void open(i)} onWantThumb={wantThumb} />
            </div>
          )}
          {tab === "approvals" && (
            <div className="view">
              <ApprovalsView
                jobs={jobs}
                drafts={drafts}
                proposals={view?.proposals ?? []}
                onOpen={(i) => void open(i)}
                onRecord={(pid) => void onProposal(pid, "launch")}
                onDismiss={(pid) => void onProposal(pid, "dismiss")}
                onAnswer={answer}
              />
            </div>
          )}
        </section>
        <Drawer
          item={drawer}
          content={content}
          onClose={() => setDrawer(undefined)}
          job={{ busy: jobBusy, error: drawerError, onAction: (x, t) => void actOnJob(x, t) }}
          gate={{ busy: gateBusy, error: drawerError, onStep: (s, n) => void gateStep(s, n) }}
          onStop={stopFromLog}
        />
      </div>
    </div>
  );
}

