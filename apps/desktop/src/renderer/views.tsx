// Presentational views (props in, callbacks out; no engine access), so they render the same in tests.
import type { JobRecord } from "@cairn/shared";
import { useState } from "react";
import type { EngineConnection } from "../shared/bridge.js";
import type { ProjectSummary, Status } from "./api.js";
import { ACTION_LABEL, actionsFor, ago, groupJobs, type JobAction } from "./jobs.js";

const usd = (n: number) => `$${n.toFixed(2)}`;

export function Header(props: { connection: EngineConnection; status: Status | undefined }) {
  const c = props.connection;
  const s = props.status;
  const cap = s?.caps.daily.usd.total;
  return (
    <header className="header">
      <strong className="brand">Cairn</strong>
      <span className={`pill ${c.state}`} title={c.state === "connected" ? c.url : c.detail}>
        {c.state === "connected" ? `engine connected${c.startedByApp ? " (started by the app)" : ""}` : c.state === "connecting" ? "connecting…" : "engine unavailable"}
      </span>
      {s && (
        <span className="usage">
          {s.machine} · today {usd(s.today.usd.total)}
          {cap !== undefined ? ` of ${usd(cap)}` : ""} billed · {s.today.tokens.total.toLocaleString()} subscription tokens
        </span>
      )}
    </header>
  );
}

export function ProjectList(props: { projects: ProjectSummary[]; selected: string | undefined; onSelect: (name: string) => void }) {
  if (props.projects.length === 0) return <p className="muted">No projects yet. Create one with re project new.</p>;
  return (
    <nav className="projects" aria-label="Projects">
      {props.projects.map((p) => (
        <button key={p.name} type="button" className={p.name === props.selected ? "project selected" : "project"} onClick={() => props.onSelect(p.name)}>
          <span>{p.name}</span>
          <span className="tag">{p.dataClass}</span>
        </button>
      ))}
    </nav>
  );
}

function JobRow(props: { job: JobRecord; selected: boolean; onSelect: (id: string) => void }) {
  const j = props.job;
  return (
    <li>
      <button type="button" className={props.selected ? "job selected" : "job"} onClick={() => props.onSelect(j.id)}>
        <span className={`state ${j.state}`}>{j.state.replace("_", " ")}</span>
        <span className="job-main">
          {j.experiment} → {j.target}
        </span>
        <span className="muted">
          {j.id} · {ago(j.created)}
        </span>
      </button>
    </li>
  );
}

export function JobInbox(props: { jobs: JobRecord[]; selected: string | undefined; onSelect: (id: string) => void }) {
  const g = groupJobs(props.jobs);
  const section = (title: string, list: JobRecord[], empty: string) => (
    <section>
      <h2>
        {title} <span className="count">{list.length}</span>
      </h2>
      {list.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="jobs">
          {list.map((j) => (
            <JobRow key={j.id} job={j} selected={j.id === props.selected} onSelect={props.onSelect} />
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div className="inbox">
      {section("Waiting for your approval", g.waiting, "Nothing to approve.")}
      {section("In progress", g.active, "No jobs running.")}
      {section("Finished", g.done, "No finished jobs yet.")}
    </div>
  );
}

/** One job: its approval card (what will run, where, with what lint findings) and what can be done now. */
export function JobDetail(props: { job: JobRecord; card: string; busy: boolean; error: string | undefined; onAction: (a: JobAction, text?: string) => void }) {
  const [confirm, setConfirm] = useState<"approve" | "deny" | undefined>(undefined);
  const [text, setText] = useState("");
  const actions = actionsFor(props.job);
  const start = (a: JobAction) => {
    if (a === "approve" || a === "deny") {
      setConfirm(a);
      setText("");
    } else props.onAction(a);
  };
  return (
    <article className="detail">
      <h2>
        Job {props.job.id} <span className={`state ${props.job.state}`}>{props.job.state.replace("_", " ")}</span>
      </h2>
      {props.error && <p className="error">{props.error}</p>}
      <div className="actions">
        {actions.map((a) => (
          <button key={a} type="button" disabled={props.busy || confirm !== undefined} className={a === "approve" ? "primary" : a === "deny" || a === "cancel" ? "danger" : ""} onClick={() => start(a)}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {confirm && (
        <form
          className="confirm"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirm === "deny" && text.trim() === "") return;
            props.onAction(confirm, text.trim() || undefined);
            setConfirm(undefined);
          }}
        >
          <label>
            {confirm === "approve" ? "Note (optional)" : "Reason (required; it goes back to the agent)"}
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
          </label>
          <button type="submit" className={confirm === "approve" ? "primary" : "danger"} disabled={props.busy || (confirm === "deny" && text.trim() === "")}>
            {confirm === "approve" ? `Approve and launch on ${props.job.target}` : "Deny"}
          </button>
          <button type="button" onClick={() => setConfirm(undefined)}>
            Back
          </button>
        </form>
      )}
      <pre className="card">{props.card}</pre>
    </article>
  );
}
