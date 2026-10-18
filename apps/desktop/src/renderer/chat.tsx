// The research-session chat (DR-0014): the user talks with the orchestrator; proposals and workers appear as cards.
// Presentational: data and callbacks come from App.
import { useState } from "react";
import type { Proposal } from "../shared/bridge.js";
import type { SessionMeta } from "./api.js";
import { type ChatState, elapsed, type Recap, thread, toolSummary } from "./session.js";

/** Something the preview drawer can open. */
export type DrawerItem =
  | { kind: "file"; path: string }
  | { kind: "job"; id: string }
  | { kind: "draft"; ref: string }
  | { kind: "claim"; id: string }
  | { kind: "log"; proposal: string; run: string; title: string };

const usd = (n: number | undefined) => (n === undefined ? "" : n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);
const ROLE: Record<string, string> = { literature: "Literature", coder: "Coder", analysis: "Analysis", writer: "Writer" };

export function SessionBar(props: { sessions: SessionMeta[]; current: string | undefined; onSelect: (id: string) => void; onNew: () => void; busy: boolean }) {
  return (
    <div className="session-bar">
      <label className="session-pick">
        <span className="label">Chat</span>
        <select value={props.current ?? ""} onChange={(e) => props.onSelect(e.target.value)} disabled={props.busy || props.sessions.length === 0} id="session-select">
          {props.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} · {s.turns} turn{s.turns === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn" onClick={props.onNew} disabled={props.busy}>
        New chat
      </button>
    </div>
  );
}

export function RecapCard(props: { recap: Recap }) {
  if (props.recap.done.length === 0 && props.recap.next.length === 0) return null;
  return (
    <div className="recap">
      {props.recap.done.length > 0 && (
        <>
          <b>Done</b>
          <span>{props.recap.done.join(" · ")}</span>
        </>
      )}
      {props.recap.next.length > 0 && (
        <>
          <b>Next</b>
          <span>{props.recap.next.join(" · ")}</span>
        </>
      )}
    </div>
  );
}

function Tools(props: { tools: { name: string; text?: string; detail?: string; isError?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  if (props.tools.length === 0) return null;
  return (
    <div className="tools">
      <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        {toolSummary(props.tools)}
      </button>
      {open && (
        <div className="toolrows">
          {props.tools.map((t, i) => (
            <span key={i} className={t.isError ? "err" : ""}>
              {t.name} {t.detail ?? (t.text ? `· ${t.text.split("\n")[0]!.slice(0, 120)}` : "")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<Proposal["state"], string> = {
  proposed: "proposed",
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  needs_input: "has questions",
  stopped: "stopped",
  dismissed: "dismissed",
  recorded: "recorded",
};

export function ProposalCard(props: {
  proposal: Proposal;
  steps: { at: string; step: string }[];
  busy: boolean;
  onAction: (action: "launch" | "dismiss" | "stop") => void;
  onOpen: (item: DrawerItem) => void;
  onAnswer: (text: string) => void;
}) {
  const p = props.proposal;
  const [showTask, setShowTask] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const o = p.outcome;
  const last = props.steps.at(-1)?.step;
  const kind = p.kind === "task" ? `${ROLE[p.role ?? ""] ?? p.role} · ${p.id}` : `Decision · ${p.id}`;
  const needs = (p.kind === "decision" && p.state === "proposed") || p.state === "needs_input";
  const stateClass = p.state === "running" || p.state === "queued" ? "run" : p.state === "done" || p.state === "recorded" ? "done" : p.state === "failed" ? "bad" : needs ? "wait" : "prop";
  return (
    <div className={`card${needs ? " needs" : ""}${p.state === "dismissed" ? " dim" : ""}`}>
      <div className="card-head">
        <span className="kind">{kind}</span>
        <span className="card-title">{p.title}</span>
        <span className={`state ${stateClass}`}>
          {STATE_LABEL[p.state]}
          {p.state === "running" ? ` · ${elapsed(p.updated)}` : ""}
          {o?.usd ? ` · ${usd(o.usd)}` : ""}
        </span>
      </div>
      {p.kind === "decision" && p.rationale && <p>{p.rationale}</p>}
      {p.kind === "task" && p.state === "proposed" && (
        <>
          {showTask ? <pre className="task">{p.task}</pre> : null}
          <button type="button" className="btn link" onClick={() => setShowTask(!showTask)}>
            {showTask ? "Hide the task" : "Show the task"}
          </button>
        </>
      )}
      {p.state === "queued" && <p className="meta">Waiting for a free worker slot (three run at once).</p>}
      {p.state === "running" && (
        <div className="step-now">
          <span className="pulse" aria-hidden="true" />
          {last ?? "starting the sandbox…"}
        </div>
      )}
      {o && (
        <div className="outcome">
          {o.summary && <p>{o.summary.split("\n")[0]}</p>}
          {o.error && <p className="error">{o.error}</p>}
          {o.questions.length > 0 && (
            <ul className="questions">
              {o.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          )}
          <div className="links">
            {o.jobs.map((j) => (
              <button key={j} type="button" className="btn link" onClick={() => props.onOpen({ kind: "job", id: j.split(" ")[0]! })}>
                Job {j}
              </button>
            ))}
            {o.drafts.map((d) => (
              <button key={d} type="button" className="btn link" onClick={() => props.onOpen({ kind: "draft", ref: d })}>
                Claim draft {d.split(":")[1]}
              </button>
            ))}
            {o.literature && o.branch && <span className="meta">Literature on {o.branch}: re literature check {o.branch}</span>}
            {o.files.length > 0 && <span className="meta">{o.files.length} file{o.files.length > 1 ? "s" : ""} changed{o.branch ? ` on ${o.branch}` : ""}</span>}
          </div>
        </div>
      )}
      {p.state === "recorded" && <p className="meta">Recorded as {p.recorded} in engine/decisions.md (user-revised).</p>}
      <div className="actions">
        {p.state === "proposed" && p.kind === "task" && (
          <button type="button" className="btn primary" disabled={props.busy} onClick={() => props.onAction("launch")}>
            Launch
          </button>
        )}
        {p.state === "proposed" && p.kind === "decision" && (
          <button type="button" className="btn primary" disabled={props.busy} onClick={() => props.onAction("launch")}>
            Record in ledger
          </button>
        )}
        {p.state === "proposed" && (
          <button type="button" className="btn" disabled={props.busy} onClick={() => props.onAction("dismiss")}>
            Dismiss
          </button>
        )}
        {p.state === "needs_input" && (
          <button type="button" className="btn primary" onClick={() => props.onAnswer(`About ${p.id}'s questions: `)}>
            Answer
          </button>
        )}
        {p.run && props.steps.length > 0 && (
          <button type="button" className="btn link" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}>
            {showSteps ? "Hide steps" : `Show ${props.steps.length} step${props.steps.length > 1 ? "s" : ""}`}
          </button>
        )}
        {p.run && (
          <button type="button" className="btn link" onClick={() => props.onOpen({ kind: "log", proposal: p.id, run: p.run!, title: p.title })}>
            Open log
          </button>
        )}
        {(p.state === "running" || p.state === "queued") && (
          <button type="button" className="btn danger" disabled={props.busy} onClick={() => props.onAction("stop")}>
            Stop
          </button>
        )}
      </div>
      {showSteps && (
        <ol className="steps">
          {props.steps.map((s, i) => (
            <li key={i}>{s.step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Thread(props: {
  chat: ChatState;
  busyCards: boolean;
  onAction: (pid: string, action: "launch" | "dismiss" | "stop") => void;
  onOpen: (item: DrawerItem) => void;
  onAnswer: (text: string) => void;
}) {
  const view = props.chat.view;
  if (!view) return <p className="muted">Loading the chat…</p>;
  const items = thread(view.transcript);
  const live = props.chat.live;
  const byId = new Map(view.proposals.map((p) => [p.id, p]));
  // Cards proposed in the turn being answered are not in the transcript yet.
  const liveCards = live ? view.proposals.filter((p) => !items.some((i) => i.kind === "card" && i.id === p.id)) : [];
  const card = (p: Proposal | undefined) =>
    p && <ProposalCard key={p.id} proposal={p} steps={props.chat.steps[p.id] ?? []} busy={props.busyCards} onAction={(a) => props.onAction(p.id, a)} onOpen={props.onOpen} onAnswer={props.onAnswer} />;
  return (
    <div className="thread">
      {items.length === 0 && !live && (
        <p className="muted hello">
          Ask about the project, or say what you want to find out. The orchestrator reads the project and proposes work; nothing runs until you launch it.
        </p>
      )}
      {items.map((it, i) => {
        if (it.kind === "user")
          return (
            <div key={i} className="msg user">
              <div className="text">{it.text}</div>
            </div>
          );
        if (it.kind === "assistant")
          return (
            <div key={i} className="msg bot">
              <span className="who">Orchestrator</span>
              <Tools tools={it.tools} />
              <div className="text">{it.text || (it.error ? "" : "(no answer)")}</div>
              {it.error && <p className="error">{it.error}</p>}
              <span className="footer">
                {(it.ms / 1000).toFixed(1)} s{it.usd !== undefined ? ` · ${usd(it.usd)}` : ""}
              </span>
            </div>
          );
        if (it.kind === "card") return card(byId.get(it.id));
        return (
          <div key={i} className="system">
            {it.text}
          </div>
        );
      })}
      {live && (
        <>
          <div className="msg user">
            <div className="text">{live.message}</div>
          </div>
          <div className="msg bot">
            <span className="who">Orchestrator</span>
            <Tools tools={live.tools} />
            <div className="text">{live.text || <span className="muted">reading the project…</span>}</div>
          </div>
          {liveCards.map((p) => card(p))}
        </>
      )}
    </div>
  );
}

export function Composer(props: {
  draft: string;
  onDraft: (t: string) => void;
  onSend: () => void;
  answering: boolean;
  queued: string[];
  running: { id: string; title: string; step: string; since: string }[];
  queuedWorkers: number;
}) {
  return (
    <div className="composer">
      {(props.running.length > 0 || props.queuedWorkers > 0) && (
        <div className="activity" aria-label="Running workers">
          {props.running.map((w) => (
            <span key={w.id}>
              <span className="pulse" aria-hidden="true" />
              <b>{w.id}</b> {w.step} · {elapsed(w.since)}
            </span>
          ))}
          <span>
            {props.running.length} of 3 worker slots in use{props.queuedWorkers ? ` · ${props.queuedWorkers} queued` : ""}
          </span>
        </div>
      )}
      {props.queued.length > 0 && <div className="queued">Will send after the current answer: {props.queued.map((q) => `“${q.slice(0, 60)}”`).join(", ")}</div>}
      <div className="input">
        <textarea
          id="message"
          aria-label="Message"
          rows={2}
          value={props.draft}
          placeholder="Ask about the project, or say what to do next."
          onChange={(e) => props.onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              props.onSend();
            }
          }}
        />
        <button type="button" className="btn primary" onClick={props.onSend} disabled={props.draft.trim() === ""}>
          {props.answering ? "Queue" : "Send"}
        </button>
      </div>
      <span className="hint">Enter sends, Shift+Enter adds a line. You can keep writing while the orchestrator answers. Nothing runs until you launch it.</span>
    </div>
  );
}
