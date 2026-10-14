// The app's state: connection, status, projects, the selected project's jobs, the selected job. Engine events (job
// state changes, new usage) reload what they affect.
import type { JobRecord } from "@cairn/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CairnBridge, EngineConnection } from "../shared/bridge.js";
import { api, type ProjectSummary, type Status } from "./api.js";
import type { JobAction } from "./jobs.js";
import { Header, JobDetail, JobInbox, ProjectList } from "./views.js";

export function App(props: { bridge: CairnBridge }) {
  const a = useMemo(() => api(props.bridge), [props.bridge]);
  const [connection, setConnection] = useState<EngineConnection>({ state: "connecting", detail: "starting" });
  const [status, setStatus] = useState<Status>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string>();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<{ job: JobRecord; card: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const projectRef = useRef(project);
  const selectedRef = useRef(selected);
  projectRef.current = project;
  selectedRef.current = selected;

  const loadStatus = useCallback(() => a.status().then(setStatus, () => {}), [a]);
  const loadJobs = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      setJobs(await a.jobs(p));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [a]);
  const loadDetail = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return setDetail(undefined);
    try {
      setDetail(await a.job(id));
    } catch (e) {
      setError((e as Error).message);
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
          if (e.id === selectedRef.current) void loadDetail();
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
  }, [props.bridge, loadJobs, loadDetail, loadStatus]);

  // Once connected: status and projects; the current project is selected first.
  useEffect(() => {
    if (connection.state !== "connected") return;
    void loadStatus();
    void a.projects().then(
      (ps) => {
        setProjects(ps);
        setProject((p) => p ?? ps.find((x) => x.current)?.name ?? ps[0]?.name);
      },
      (e: Error) => setError(e.message),
    );
  }, [connection.state, a, loadStatus]);

  useEffect(() => {
    setSelected(undefined);
    setJobs([]);
    void loadJobs();
  }, [project, loadJobs]);
  useEffect(() => {
    setError(undefined);
    void loadDetail();
  }, [selected, loadDetail]);

  const act = async (action: JobAction, text?: string) => {
    if (!detail) return;
    const id = detail.job.id;
    setBusy(true);
    setError(undefined);
    try {
      if (action === "approve") await a.approve(id, text);
      else if (action === "deny") await a.deny(id, text ?? "");
      else await a[action](id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void loadJobs();
      void loadDetail();
    }
  };

  return (
    <div className="app">
      <Header connection={connection} status={status} />
      {connection.state === "failed" && (
        <p className="error banner">
          {connection.detail}. Start the engine with <code>re serve</code> in a terminal, then reopen the app.
        </p>
      )}
      <div className="body">
        <aside>
          <h2>Projects</h2>
          <ProjectList projects={projects} selected={project} onSelect={setProject} />
        </aside>
        <main>
          <JobInbox jobs={jobs} selected={selected} onSelect={setSelected} />
        </main>
        <section className="side">
          {detail ? <JobDetail key={detail.job.id} job={detail.job} card={detail.card} busy={busy} error={error} onAction={(x, t) => void act(x, t)} /> : <p className="muted">Select a job to see its approval card.</p>}
          {!detail && error && <p className="error">{error}</p>}
        </section>
      </div>
    </div>
  );
}
