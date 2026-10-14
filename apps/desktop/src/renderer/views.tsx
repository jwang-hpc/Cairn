// Presentational views (props in, callbacks out; no engine access), so they render the same in tests.
import type { JobRecord } from "@cairn/shared";
import { useState } from "react";
import type { EngineConnection } from "../shared/bridge.js";
import type { Draft, Entry, Hypothesis, ProjectSummary, Status } from "./api.js";
import { gateState, sortDrafts } from "./claims.js";
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

export type Tab = "jobs" | "claims" | "ledger";

export function Tabs(props: { tab: Tab; onTab: (t: Tab) => void; waiting: { jobs: number; drafts: number } }) {
  const item = (t: Tab, label: string, n?: number) => (
    <button key={t} type="button" role="tab" aria-selected={props.tab === t} className={props.tab === t ? "tab selected" : "tab"} onClick={() => props.onTab(t)}>
      {label}
      {n ? <span className="badge">{n}</span> : null}
    </button>
  );
  return (
    <div className="tabs" role="tablist">
      {item("jobs", "Jobs", props.waiting.jobs)}
      {item("claims", "Claims", props.waiting.drafts)}
      {item("ledger", "Ledger")}
    </div>
  );
}

/** Drafts the agents committed (with where each stands in the gate), and the claims already in logic/claims.md. */
export function ClaimsList(props: { drafts: Draft[]; claims: Entry[]; selected: string | undefined; onSelect: (key: string) => void; onRefresh: () => void }) {
  const drafts = sortDrafts(props.drafts);
  return (
    <div className="inbox">
      <section>
        <h2>
          Drafts <span className="count">{drafts.filter((d) => !d.approved).length}</span>{" "}
          <button type="button" className="small" onClick={props.onRefresh}>
            Refresh
          </button>
        </h2>
        {drafts.length === 0 ? (
          <p className="muted">No claim drafts. An analysis agent commits them under staging/claims/ on its branch.</p>
        ) : (
          <ul className="jobs">
            {drafts.map((d) => {
              const g = gateState(d);
              return (
                <li key={d.ref}>
                  <button type="button" className={props.selected === `draft:${d.ref}` ? "job selected" : "job"} onClick={() => props.onSelect(`draft:${d.ref}`)}>
                    <span className={`state gate-${g.stage.replace(" ", "-")}`}>{g.label}</span>
                    <span className="job-main">{d.title}</span>
                    <span className="muted">{d.ref}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section>
        <h2>
          Claims in logic/claims.md <span className="count">{props.claims.length}</span>
        </h2>
        {props.claims.length === 0 ? (
          <p className="muted">No claims yet. Only the gate writes them.</p>
        ) : (
          <ul className="jobs">
            {props.claims.map((c) => (
              <li key={c.id}>
                <button type="button" className={props.selected === `claim:${c.id}` ? "job selected" : "job"} onClick={() => props.onSelect(`claim:${c.id}`)}>
                  <span className="state">{c.id}</span>
                  <span className="job-main">{c.title}</span>
                  <span className="muted">
                    {c.fields.Status ?? "?"} · {c.fields.Provenance ?? "?"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export type GateStep = "check" | "review" | "approve";

/** One draft through the gate: the draft itself, the check, the review, and the approval. */
export function DraftDetail(props: {
  draft: Draft;
  check: { ok: boolean; text: string } | undefined;
  review: string | undefined;
  busy: GateStep | undefined;
  error: string | undefined;
  onStep: (s: GateStep, note?: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const d = props.draft;
  const g = gateState(d);
  const review = props.review ?? d.review?.text;
  return (
    <article className="detail">
      <h2>{d.title}</h2>
      <p className="muted">
        {d.ref} · {g.label}
        {d.approved ? ` (${d.approved.by}, ${d.approved.at.slice(0, 10)})` : ""}
      </p>
      {props.error && <p className="error">{props.error}</p>}
      {!d.approved && (
        <div className="actions">
          <button type="button" disabled={props.busy !== undefined} onClick={() => props.onStep("check")}>
            {props.busy === "check" ? "Checking…" : "1. Support check"}
          </button>
          <button type="button" disabled={props.busy !== undefined} onClick={() => props.onStep("review")} title="A model reviews the claim (advice only); this uses the reviewer's quota">
            {props.busy === "review" ? "Waiting for the reviewer…" : d.review ? "2. Review again" : "2. Rigor review"}
          </button>
          <button type="button" className="primary" disabled={props.busy !== undefined || !g.canApprove || confirm} onClick={() => setConfirm(true)} title={g.canApprove ? "" : "Approval needs a rigor review of this exact draft"}>
            3. Approve…
          </button>
        </div>
      )}
      {confirm && (
        <form
          className="confirm"
          onSubmit={(e) => {
            e.preventDefault();
            props.onStep("approve", note.trim() || undefined);
            setConfirm(false);
          }}
        >
          <p>
            The claim enters logic/claims.md as the next C-number, marked <strong>user-revised</strong> (an agent wrote the draft; you approved it). Support is checked again at
            approval.
          </p>
          <label>
            Note (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
          <button type="submit" className="primary" disabled={props.busy !== undefined}>
            Approve into logic/claims.md
          </button>
          <button type="button" onClick={() => setConfirm(false)}>
            Back
          </button>
        </form>
      )}
      {props.check && <pre className={props.check.ok ? "card" : "card failed"}>{props.check.text}</pre>}
      {review && <pre className="card">{review}</pre>}
      <h3>Draft</h3>
      <pre className="card">{d.md}</pre>
    </article>
  );
}

export function ClaimDetail(props: { claim: Entry }) {
  const c = props.claim;
  return (
    <article className="detail">
      <h2>
        {c.id}: {c.title}
      </h2>
      <dl className="fields">
        {Object.entries(c.fields).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

/** Hypotheses, the exploration tree, and decisions, as the ledger has them. */
export function LedgerView(props: { hypotheses: Hypothesis[]; tree: string; decisions: Entry[] }) {
  return (
    <div className="inbox">
      <section>
        <h2>
          Hypotheses <span className="count">{props.hypotheses.length}</span>
        </h2>
        {props.hypotheses.length === 0 ? (
          <p className="muted">No hypotheses yet.</p>
        ) : (
          <ul className="plain">
            {props.hypotheses.map((h) => (
              <li key={h.id}>
                <strong>{h.id}</strong> {h.title} <span className="muted">· {h.status} · {h.provenance}</span>
                {h.statement && <div className="muted">{h.statement}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Exploration tree</h2>
        <pre className="card">{props.tree || "(empty)"}</pre>
      </section>
      <section>
        <h2>
          Decisions <span className="count">{props.decisions.length}</span>
        </h2>
        {props.decisions.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="plain">
            {props.decisions.map((d) => (
              <li key={d.id}>
                <strong>{d.id}</strong> {d.title}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
