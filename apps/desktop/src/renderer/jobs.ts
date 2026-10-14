// Job inbox logic, free of React: which jobs wait for the user, and what can be done with each one. The actions mirror
// `re job ...` (DR-0006): approve launches; deny needs a reason that goes back to the agent.
import type { JobRecord } from "@cairn/shared";

export type JobAction = "approve" | "deny" | "submit" | "refresh" | "cancel" | "fetch";

export interface JobGroups {
  /** pending_approval: the user's decision is needed. */
  waiting: JobRecord[];
  /** approved, submitted, running, lost: on its way or needing a look. */
  active: JobRecord[];
  /** completed, failed, cancelled, denied. */
  done: JobRecord[];
}

const newestFirst = (a: JobRecord, b: JobRecord) => b.created.localeCompare(a.created);

export function groupJobs(jobs: readonly JobRecord[]): JobGroups {
  const g: JobGroups = { waiting: [], active: [], done: [] };
  for (const j of jobs) {
    if (j.state === "pending_approval") g.waiting.push(j);
    else if (["approved", "submitted", "running", "lost"].includes(j.state)) g.active.push(j);
    else g.done.push(j);
  }
  g.waiting.sort(newestFirst);
  g.active.sort(newestFirst);
  g.done.sort(newestFirst);
  return g;
}

export function actionsFor(j: JobRecord): JobAction[] {
  switch (j.state) {
    case "pending_approval":
      return ["approve", "deny"];
    case "approved":
      // Approved but not started (e.g. no open SSH session): start it once the session is up, or withdraw it.
      return j.error ? ["submit", "cancel"] : ["refresh"];
    case "submitted":
    case "running":
      return ["refresh", "cancel"];
    case "lost":
      return ["refresh"];
    case "completed":
    case "failed":
    case "cancelled":
      return j.remote && !j.results ? ["fetch", "refresh"] : [];
    default:
      return [];
  }
}

export const ACTION_LABEL: Record<JobAction, string> = {
  approve: "Approve and launch",
  deny: "Deny",
  submit: "Start",
  refresh: "Refresh status",
  cancel: "Cancel",
  fetch: "Fetch results",
};

/** "3 min ago", "2 h ago", or the date. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return iso.slice(0, 10);
}
