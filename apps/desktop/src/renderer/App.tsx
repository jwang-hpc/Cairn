// The app's state: connection, status, projects, and for the selected project its jobs (M8.2), its claim drafts and
// claims (M8.3: the gate), and its ledger. Engine events (job state changes, new usage) reload what they affect.
import type { JobRecord } from "@cairn/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CairnBridge, EngineConnection } from "../shared/bridge.js";
import { api, type Draft, type Entry, type Hypothesis, type ProjectSummary, type Status } from "./api.js";
import type { JobAction } from "./jobs.js";
import { ClaimDetail, ClaimsList, DraftDetail, type GateStep, Header, JobDetail, JobInbox, LedgerView, ProjectList, type Tab, Tabs } from "./views.js";

const message = (e: unknown) => (e as Error).message;

export function App(props: { bridge: CairnBridge }) {
  const a = useMemo(() => api(props.bridge), [props.bridge]);
  const [connection, setConnection] = useState<EngineConnection>({ state: "connecting", detail: "starting" });
  const [status, setStatus] = useState<Status>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string>();
  const [tab, setTab] = useState<Tab>("jobs");
  const [error, setError] = useState<string>();

  // jobs
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [jobDetail, setJobDetail] = useState<{ job: JobRecord; card: string }>();
  const [jobBusy, setJobBusy] = useState(false);
  // claims
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [claims, setClaims] = useState<Entry[]>([]);
  const [selectedClaim, setSelectedClaim] = useState<string>();
  const [gate, setGate] = useState<{ ref: string; check?: { ok: boolean; text: string }; review?: string }>();
  const [gateBusy, setGateBusy] = useState<GateStep>();
  // ledger
  const [ledger, setLedger] = useState<{ hypotheses: Hypothesis[]; tree: string; decisions: Entry[] }>();

  const projectRef = useRef(project);
  const selectedJobRef = useRef(selectedJob);
  projectRef.current = project;
  selectedJobRef.current = selectedJob;

  const loadStatus = useCallback(() => a.status().then(setStatus, () => {}), [a]);
  const loadJobs = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      setJobs(await a.jobs(p));
    } catch (e) {
      setError(message(e));
    }
  }, [a]);
  const loadJobDetail = useCallback(async () => {
    const id = selectedJobRef.current;
    if (!id) return setJobDetail(undefined);
    try {
      setJobDetail(await a.job(id));
    } catch (e) {
      setError(message(e));
    }
  }, [a]);
  const loadClaims = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const [d, c] = await Promise.all([a.drafts(p), a.claims(p)]);
      setDrafts(d);
      setClaims(c);
    } catch (e) {
      setError(message(e));
    }
  }, [a]);
  const loadLedger = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const [hypotheses, tree, decisions] = await Promise.all([a.hypotheses(p), a.tree(p), a.decisions(p)]);
      setLedger({ hypotheses, tree, decisions });
    } catch (e) {
      setError(message(e));
    }
  }, [a]);

  // Connection and events.
  useEffect(() => {
    let usageTimer: ReturnType<typeof setTimeout> | undefined;
    void props.bridge.connection().then(setConnection);
    const off = props.bridge.subscribe({
      connection: setConnection,
      event: (e) => {
        if (e.type === "job") {
          if (e.project === projectRef.current) void loadJobs();
          if (e.id === selectedJobRef.current) void loadJobDetail();
        } else if (e.event.type === "usage") {
          clearTimeout(usageTimer);
          usageTimer = setTimeout(() => void loadStatus(), 1000);
        }
      },
    });
    return () => {
      off();
      clearTimeout(usageTimer);
    };
  }, [props.bridge, loadJobs, loadJobDetail, loadStatus]);

  // Once connected: status and projects; the current project is selected first.
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

  // A new project: clear selections, load jobs and drafts (both feed the tab badges), and the ledger if it's open.
  useEffect(() => {
    setSelectedJob(undefined);
    setSelectedClaim(undefined);
    setGate(undefined);
    setJobs([]);
    setDrafts([]);
    setClaims([]);
    setLedger(undefined);
    setError(undefined);
    void loadJobs();
    void loadClaims();
  }, [project, loadJobs, loadClaims]);
  useEffect(() => {
    if (tab === "ledger") void loadLedger();
    if (tab === "claims") void loadClaims();
  }, [tab, project, loadLedger, loadClaims]);
  useEffect(() => {
    setError(undefined);
    void loadJobDetail();
  }, [selectedJob, loadJobDetail]);

  const actOnJob = async (action: JobAction, text?: string) => {
    if (!jobDetail) return;
    const id = jobDetail.job.id;
    setJobBusy(true);
    setError(undefined);
    try {
      if (action === "approve") await a.approve(id, text);
      else if (action === "deny") await a.deny(id, text ?? "");
      else await a[action](id);
    } catch (e) {
      setError(message(e));
    } finally {
      setJobBusy(false);
      void loadJobs();
      void loadJobDetail();
    }
  };

  const draft = selectedClaim?.startsWith("draft:") ? drafts.find((d) => `draft:${d.ref}` === selectedClaim) : undefined;
  const claim = selectedClaim?.startsWith("claim:") ? claims.find((c) => `claim:${c.id}` === selectedClaim) : undefined;

  const gateStep = async (step: GateStep, note?: string) => {
    if (!draft || !project) return;
    const ref = draft.ref;
    setGateBusy(step);
    setError(undefined);
    try {
      if (step === "check") {
        const r = await a.check(project, ref);
        setGate((g) => ({ ...(g?.ref === ref ? g : {}), ref, check: { ok: r.ok, text: r.text } }));
      } else if (step === "review") {
        const r = await a.review(project, ref);
        setGate((g) => ({ ...(g?.ref === ref ? g : {}), ref, review: r.text }));
      } else {
        const r = await a.approveClaim(project, ref, note);
        setGate(undefined);
        setSelectedClaim(`claim:${r.id}`);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setGateBusy(undefined);
      void loadClaims();
    }
  };

  const side =
    tab === "jobs" ? (
      jobDetail ? (
        <JobDetail key={jobDetail.job.id} job={jobDetail.job} card={jobDetail.card} busy={jobBusy} error={error} onAction={(x, t) => void actOnJob(x, t)} />
      ) : (
        <p className="muted">Select a job to see its approval card.</p>
      )
    ) : tab === "claims" ? (
      draft ? (
        <DraftDetail
          key={draft.ref}
          draft={draft}
          check={gate?.ref === draft.ref ? gate.check : undefined}
          review={gate?.ref === draft.ref ? gate.review : undefined}
          busy={gateBusy}
          error={error}
          onStep={(s, n) => void gateStep(s, n)}
        />
      ) : claim ? (
        <ClaimDetail claim={claim} />
      ) : (
        <p className="muted">Select a draft to take it through the gate (support check, rigor review, your approval), or a claim to read it.</p>
      )
    ) : (
      <p className="muted">The ledger as committed in the project.</p>
    );

  return (
    <div className="app">
      <Header connection={connection} status={status} />
      {connection.state === "failed" && (
        <p className="error banner">
          {connection.detail}{" "}
          <button type="button" onClick={() => void props.bridge.reconnect().then(setConnection)}>
            Retry
          </button>
        </p>
      )}
      <div className="body">
        <aside>
          <h2>Projects</h2>
          <ProjectList projects={projects} selected={project} onSelect={setProject} />
        </aside>
        <main>
          <Tabs tab={tab} onTab={setTab} waiting={{ jobs: jobs.filter((j) => j.state === "pending_approval").length, drafts: drafts.filter((d) => !d.approved).length }} />
          {tab === "jobs" && <JobInbox jobs={jobs} selected={selectedJob} onSelect={setSelectedJob} />}
          {tab === "claims" && <ClaimsList drafts={drafts} claims={claims} selected={selectedClaim} onSelect={setSelectedClaim} onRefresh={() => void loadClaims()} />}
          {tab === "ledger" && (ledger ? <LedgerView {...ledger} /> : <p className="muted">Loading…</p>)}
          {tab !== "jobs" && !draft && error && <p className="error">{error}</p>}
        </main>
        <section className="side">
          {side}
          {tab === "jobs" && !jobDetail && error && <p className="error">{error}</p>}
        </section>
      </div>
    </div>
  );
}
