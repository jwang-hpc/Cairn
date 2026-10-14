// Research-session state for the chat (DR-0014), free of React: what live events change, how a transcript becomes a
// thread, the "welcome back" recap, and what counts as needing the user.
import type { JobRecord } from "@cairn/shared";
import type { Proposal, SessionEvent } from "../shared/bridge.js";
import type { Draft, SessionView, TranscriptEntry } from "./api.js";

/** The answer being written right now (before the turn's transcript is saved). */
export interface LiveTurn {
  message: string;
  text: string;
  tools: { name: string; detail: string }[];
  startedAt: number;
}

export interface ChatState {
  view?: SessionView | undefined;
  live?: LiveTurn | undefined;
  /** Messages typed while the orchestrator was answering; sent in order afterwards. */
  queued: string[];
  /** Recent worker steps by proposal id (live, from events; the full log comes from the run's steps). */
  steps: Record<string, { at: string; step: string }[]>;
}

export const emptyChat = (): ChatState => ({ queued: [], steps: {} });

export function upsertProposal(list: readonly Proposal[], p: Proposal): Proposal[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return [...list, p];
  const out = [...list];
  out[i] = p;
  return out;
}

/** Apply one pushed event for the open session; events for other sessions leave the state alone. */
export function applyEvent(s: ChatState, e: SessionEvent): ChatState {
  if (!s.view || e.session !== s.view.session.id || e.project !== s.view.session.project) return s;
  switch (e.type) {
    case "turn_delta":
      return s.live ? { ...s, live: { ...s.live, text: s.live.text + e.text } } : s;
    case "turn_tool":
      return s.live ? { ...s, live: { ...s.live, tools: [...s.live.tools, { name: e.name, detail: e.detail }] } } : s;
    case "proposal":
      return { ...s, view: { ...s.view, proposals: upsertProposal(s.view.proposals, e.proposal) } };
    case "worker_step":
      return { ...s, steps: { ...s.steps, [e.proposal]: [...(s.steps[e.proposal] ?? []), { at: e.at, step: e.step }].slice(-50) } };
    case "turn_end":
      return s;
  }
}

export type ThreadItem =
  | { kind: "user"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string; ms: number; usd?: number; error?: string; tools: { name: string; text: string; isError: boolean }[] }
  | { kind: "card"; id: string }
  | { kind: "system"; text: string; at: string };

/** The transcript as the chat shows it: tool use folded into the answer that followed it; each proposal once, where it first appeared. */
export function thread(entries: readonly TranscriptEntry[]): ThreadItem[] {
  const out: ThreadItem[] = [];
  const seen = new Set<string>();
  let tools: { name: string; text: string; isError: boolean }[] = [];
  for (const e of entries) {
    if (e.kind === "user") out.push({ kind: "user", text: e.text, at: e.at });
    else if (e.kind === "tool") tools.push({ name: e.name, text: e.text, isError: e.isError });
    else if (e.kind === "assistant") {
      out.push({ kind: "assistant", text: e.text, at: e.at, ms: e.ms, ...(e.usd !== undefined ? { usd: e.usd } : {}), ...(e.error ? { error: e.error } : {}), tools });
      tools = [];
    } else if (e.kind === "proposal") {
      if (!seen.has(e.proposal.id)) {
        seen.add(e.proposal.id);
        out.push({ kind: "card", id: e.proposal.id });
      }
    } else out.push({ kind: "system", text: e.text, at: e.at });
  }
  return out;
}

/** What the orchestrator's reading looked like, in a few words ("read 3 files · searched 1"). */
export function toolSummary(tools: readonly { name: string }[]): string {
  const count = (n: string) => tools.filter((t) => t.name === n).length;
  const parts = [
    count("read_file") ? `read ${count("read_file")} file${count("read_file") > 1 ? "s" : ""}` : "",
    count("search") ? `searched ${count("search")}` : "",
    count("list_files") ? `listed ${count("list_files")}` : "",
    count("project_overview") ? "checked the overview" : "",
    count("propose_task") + count("propose_decision") ? `proposed ${count("propose_task") + count("propose_decision")}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || `${tools.length} steps`;
}

export interface Recap {
  done: string[];
  next: string[];
}

/** "Welcome back": built from the session's cards and what waits in the project, without a model call. */
export function recap(view: SessionView | undefined, jobs: readonly JobRecord[], drafts: readonly Draft[]): Recap {
  const ps = view?.proposals ?? [];
  const done = [
    ...ps.filter((p) => p.state === "done").map((p) => `${p.id} done: ${p.title}`),
    ...ps.filter((p) => p.state === "recorded").map((p) => `${p.id} recorded as ${p.recorded}: ${p.title}`),
    ...ps.filter((p) => p.state === "failed" || p.state === "stopped").map((p) => `${p.id} ${p.state}: ${p.title}`),
  ];
  const waitingJobs = jobs.filter((j) => j.state === "pending_approval").length;
  const waitingDrafts = drafts.filter((d) => !d.approved).length;
  const next = [
    ...ps.filter((p) => p.state === "needs_input").map((p) => `${p.id} has questions for you`),
    ...(waitingJobs ? [`${waitingJobs} job${waitingJobs > 1 ? "s" : ""} waiting for your approval`] : []),
    ...(waitingDrafts ? [`${waitingDrafts} claim draft${waitingDrafts > 1 ? "s" : ""} waiting for the gate`] : []),
    ...ps.filter((p) => p.state === "proposed").map((p) => `${p.id} is proposed, not launched: ${p.title}`),
    ...ps.filter((p) => p.state === "running" || p.state === "queued").map((p) => `${p.id} is ${p.state}`),
  ];
  return { done: done.slice(-4), next: next.slice(0, 5) };
}

/** What waits for the user's decision: jobs to approve, drafts for the gate, decisions to record, workers' questions. */
export function needsYou(view: SessionView | undefined, jobs: readonly JobRecord[], drafts: readonly Draft[]): number {
  const ps = view?.proposals ?? [];
  return (
    jobs.filter((j) => j.state === "pending_approval").length +
    drafts.filter((d) => !d.approved).length +
    ps.filter((p) => (p.kind === "decision" && p.state === "proposed") || p.state === "needs_input").length
  );
}

/** "2m 14s" since an ISO time. */
export function elapsed(since: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
