// The panels around the chat (DR-0014): the left sidebar (projects, outline, files) and the Literature, Results, and
// Approvals tabs. Presentational: data and callbacks come from App.
import type { JobRecord } from "@cairn/shared";
import { useEffect, useState } from "react";
import type { Proposal } from "../shared/bridge.js";
import type { Draft, Entry, FileEntry, Hypothesis, PaperNote, ProjectSummary } from "./api.js";
import type { DrawerItem } from "./chat.js";
import { gateState } from "./claims.js";
import { ago } from "./jobs.js";
import { ProjectList } from "./views.js";

export interface Outline {
  problem: string;
  claims: Entry[];
  hypotheses: Hypothesis[];
  tree: string;
}

/** The first paragraph of logic/problem.md that is not a heading or a comment. */
export function problemText(md: string): string {
  const para = md
    .split(/\n\s*\n/)
    .map((p) => p.replace(/<!--[\s\S]*?-->/g, "").trim())
    .find((p) => p && !p.startsWith("#"));
  return para ?? "";
}

export function Sidebar(props: {
  projects: ProjectSummary[];
  project: string | undefined;
  onProject: (name: string) => void;
  outline: Outline | undefined;
  files: FileEntry[];
  onOpen: (item: DrawerItem) => void;
}) {
  const [showFiles, setShowFiles] = useState(false);
  const o = props.outline;
  return (
    <aside className="sidebar">
      <section>
        <p className="label">Projects</p>
        <ProjectList projects={props.projects} selected={props.project} onSelect={props.onProject} />
      </section>
      {o && (
        <>
          <section className="outline">
            <p className="label">Problem</p>
            <p>{o.problem || <span className="muted">No problem statement yet (logic/problem.md).</span>}</p>
          </section>
          <section className="outline">
            <p className="label">Claims</p>
            {o.claims.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <ul>
                {o.claims.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="outline-item" onClick={() => props.onOpen({ kind: "claim", id: c.id })}>
                      <span className="id">{c.id}</span>
                      <span>
                        {c.title} <span className="tag">{c.fields.Status ?? "?"}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="outline">
            <p className="label">Hypotheses</p>
            {o.hypotheses.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <ul>
                {o.hypotheses.map((h) => (
                  <li key={h.id}>
                    <span className="outline-item static">
                      <span className="id">{h.id}</span>
                      <span>
                        {h.title} <span className="tag">{h.status}</span>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <p className="label">Exploration tree</p>
            <pre className="tree">{o.tree || "(empty)"}</pre>
          </section>
        </>
      )}
      <section>
        <button type="button" className="label-button" aria-expanded={showFiles} onClick={() => setShowFiles(!showFiles)}>
          Files {props.files.length ? `(${props.files.length})` : ""} {showFiles ? "▾" : "▸"}
        </button>
        {showFiles && (
          <div className="files">
            {props.files
              .filter((f) => !f.path.endsWith(".gitkeep"))
              .map((f) => (
                <button key={f.path} type="button" className="file" onClick={() => props.onOpen({ kind: "file", path: f.path })}>
                  {f.path}
                </button>
              ))}
          </div>
        )}
      </section>
    </aside>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const TABLE = /\.(csv|tsv)$/i;

/** Figures and tables the project holds: what experiments produced and analysis made of them. */
export function ResultsView(props: { files: FileEntry[]; thumbs: Record<string, string>; onOpen: (item: DrawerItem) => void; onWantThumb: (path: string) => void }) {
  const results = props.files.filter((f) => /^(evidence\/(figures|tables)|analysis)\//.test(f.path));
  const figures = results.filter((f) => IMAGE.test(f.path));
  const tables = results.filter((f) => TABLE.test(f.path));
  const missing = figures.slice(0, 24).filter((f) => !props.thumbs[f.path]).map((f) => f.path).join("\n");
  const want = props.onWantThumb;
  useEffect(() => {
    for (const p of missing.split("\n").filter(Boolean)) want(p);
  }, [missing, want]);
  return (
    <div className="stack wide">
      <p className="section-title">Figures {figures.length ? `· ${figures.length}` : ""}</p>
      {figures.length === 0 ? (
        <p className="muted">No figures yet. Analysis workers save them under evidence/figures/ or analysis/.</p>
      ) : (
        <div className="figures">
          {figures.map((f) => (
            <button key={f.path} type="button" className="figure" onClick={() => props.onOpen({ kind: "file", path: f.path })}>
              {props.thumbs[f.path] ? <img src={props.thumbs[f.path]} alt={f.path} /> : <span className="muted">loading…</span>}
              <span className="meta">{f.path}</span>
            </button>
          ))}
        </div>
      )}
      <p className="section-title">Tables {tables.length ? `· ${tables.length}` : ""}</p>
      {tables.length === 0 ? (
        <p className="muted">No tables yet. Parsers write them under evidence/tables/ (re evidence parse).</p>
      ) : (
        <ul className="plain">
          {tables.map((f) => (
            <li key={f.path}>
              <button type="button" className="path-button" onClick={() => props.onOpen({ kind: "file", path: f.path })}>
                {f.path}
              </button>{" "}
              <span className="meta">{f.bytes.toLocaleString()} bytes</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LiteratureView(props: { notes: PaperNote[]; references: number; onOpen: (item: DrawerItem) => void }) {
  return (
    <div className="stack">
      <p className="section-title">
        Paper notes, most relevant first · {props.notes.length} notes · {props.references} references in lit/refs.bib
      </p>
      {props.notes.length === 0 ? (
        <p className="muted">No paper notes yet. Ask in the chat for related work; a literature worker writes them, and you accept them with re literature accept.</p>
      ) : (
        <div>
          {props.notes.map((n) => (
            <button key={n.key} type="button" className="litrow" onClick={() => props.onOpen({ kind: "file", path: n.path })}>
              <span className="rel">{n.relevance ?? "–"}</span>
              <span>
                {n.title ?? n.paper} <span className="key">{n.key}</span>
              </span>
              <span className="tag">{n.year ?? ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Everything waiting for the user's decision, wherever it came from. */
export function ApprovalsView(props: {
  jobs: JobRecord[];
  drafts: Draft[];
  proposals: Proposal[];
  onOpen: (item: DrawerItem) => void;
  onRecord: (pid: string) => void;
  onDismiss: (pid: string) => void;
  onAnswer: (text: string) => void;
}) {
  const jobs = props.jobs.filter((j) => j.state === "pending_approval");
  const drafts = props.drafts.filter((d) => !d.approved);
  const decisions = props.proposals.filter((p) => p.kind === "decision" && p.state === "proposed");
  const questions = props.proposals.filter((p) => p.state === "needs_input");
  const total = jobs.length + drafts.length + decisions.length + questions.length;
  return (
    <div className="stack">
      <p className="section-title">Needs you · {total}</p>
      {total === 0 && <p className="muted">Nothing waits for you.</p>}
      {jobs.map((j) => (
        <div key={j.id} className="card needs">
          <div className="card-head">
            <span className="kind">Job</span>
            <span className="card-title">
              {j.id} · {j.experiment} → {j.target}
            </span>
            <span className="state wait">waiting · {ago(j.created)}</span>
          </div>
          <p>{j.manifest.description ?? "(no description)"}</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => props.onOpen({ kind: "job", id: j.id })}>
              Review and decide
            </button>
          </div>
        </div>
      ))}
      {drafts.map((d) => (
        <div key={d.ref} className="card needs">
          <div className="card-head">
            <span className="kind">Claim draft</span>
            <span className="card-title">{d.title}</span>
            <span className="state wait">{gateState(d).label}</span>
          </div>
          <p className="meta">{d.ref}</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => props.onOpen({ kind: "draft", ref: d.ref })}>
              Take it through the gate
            </button>
          </div>
        </div>
      ))}
      {decisions.map((p) => (
        <div key={p.id} className="card needs">
          <div className="card-head">
            <span className="kind">Decision · {p.id}</span>
            <span className="card-title">{p.title}</span>
            <span className="state wait">proposed</span>
          </div>
          {p.rationale && <p>{p.rationale}</p>}
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => props.onRecord(p.id)}>
              Record in ledger
            </button>
            <button type="button" className="btn" onClick={() => props.onDismiss(p.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {questions.map((p) => (
        <div key={p.id} className="card needs">
          <div className="card-head">
            <span className="kind">Questions · {p.id}</span>
            <span className="card-title">{p.title}</span>
          </div>
          <ul className="questions">
            {p.outcome?.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => props.onAnswer(`About ${p.id}'s questions: `)}>
              Answer in the chat
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
