// The approval card (DR-0006 step 3): everything a human needs to approve or deny a job, as text. The CLI prints it;
// the app (M8) renders the same facts.
import type { JobRecord } from "@cairn/shared";
import { hms, type JobFileContent } from "./lint.js";

const MAX_LINES = 400;
const isText = (b: Buffer) => !b.includes(0);

/**
 * Make agent- or machine-supplied text safe for a terminal: control characters (ESC, CR, backspace, ...), C1
 * codes, and bidi overrides are shown as escapes, so nothing can redraw or hide parts of the card. One line unless
 * multiline (tabs are kept).
 */
export function printable(text: string, multiline = false): string {
  const t = multiline ? text : text.replace(/\r?\n/g, " ⏎ ");
  return t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u{${c.charCodeAt(0).toString(16).padStart(4, "0")}}`);
}
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / (1 << 20)).toFixed(1)} MiB`);


export function renderCard(
  job: JobRecord,
  files: JobFileContent[],
  opts: { autoApproval?: string; approvedTwin?: string; snapshotDir?: string; scheduler?: string } = {},
): string {
  const { lint, manifest } = job;
  const a = job.author;
  /** A Slurm campaign: its array task's time limit. */
  const array = lint.campaign?.task_walltime_s;
  const lines = [
    `job ${job.id} · project ${job.project} · ${job.experiment} → ${job.target}`,
    `state:       ${job.state}${job.error ? `  (last error: ${job.error})` : ""}`,
    `author:      ${a.kind === "agent" ? `agent ${a.agent} (${a.role}; ${a.model}, ${a.effort}), run ${a.run}` : "you"}${job.branch ? `, branch ${job.branch}` : ""}`,
    ...(manifest.description ? [`what:        ${manifest.description}`] : []),
    `resources:   ${array ? "per point: " : ""}${lint.nodes} node${lint.nodes === 1 ? "" : "s"} × ${lint.cores} core${lint.cores === 1 ? "" : "s"}${lint.gpus ? `, ${lint.gpus} GPU${lint.gpus === 1 ? "" : "s"}/node` : ""}${manifest.resources.memory_gb ? `, ${manifest.resources.memory_gb} GB/node` : ""}, ${
      array ? `deadline ${manifest.resources.walltime} after submission (at most ${lint.node_hours} node-hours if every task runs to its limit)` : `walltime ${manifest.resources.walltime} (${lint.node_hours} node-hours)`
    }`,
    ...(lint.account || lint.partition ? [`scheduler:   ${[lint.account ? `account ${lint.account}` : "", lint.partition ? `partition ${lint.partition}` : ""].filter(Boolean).join(", ")}`] : []),
    `pre-flight:  ${job.preflight ? `${job.preflight.ok ? "ok" : "REFUSED"}: ${job.preflight.detail}` : opts.scheduler === "none" ? "none (no scheduler on this machine)" : "not run (no SSH session at submit time)"}`,
    ...(manifest.campaign && lint.campaign
      ? [
          `campaign:    ${lint.campaign.points} points (${Object.entries(manifest.campaign.parameters).map(([k, v]) => `${k} × ${v.length}`).join(", ")}), ${array ? "a Slurm job array: " : ""}${lint.campaign.parallel} at a time, ${lint.campaign.retries} retr${lint.campaign.retries === 1 ? "y" : "ies"} per point`,
          array
            ? `             each point ≤ ${manifest.campaign.point_walltime} (task limit ${hms(array)}); without queue waits the grid needs about ${hms(lint.campaign.estimate_s)}`
            : `             each point ≤ ${manifest.campaign.point_walltime}; budget ${manifest.resources.walltime} (the grid needs about ${hms(lint.campaign.estimate_s)})`,
          ...Object.entries(manifest.campaign.parameters).map(([k, v]) => `             ${k}: ${v.join(", ")}`),
          "             runs unattended once approved; no model in the loop (DR-0011)",
        ]
      : []),
    `outputs:     ${manifest.outputs.join(", ") || "(none declared)"}${manifest.campaign ? " (per point; plus campaign.csv and merged CSVs)" : ""}`,
    `fingerprint: ${job.fingerprint.slice(0, 16)}${opts.approvedTwin ? ` (identical to approved job ${opts.approvedTwin})` : " (new files)"}`,
    ...(opts.autoApproval ? [`auto:        ${opts.autoApproval}`] : []),
    lint.warnings.length > 0 ? `lint:        ${lint.warnings.length} warning(s) — review:` : "lint:        no warnings",
    ...lint.warnings.map((w) => `  ! ${w}`),
    "files:",
    ...job.files.map((f) => `  ${f.path}  ${fmtBytes(f.bytes)}  sha256 ${f.sha256.slice(0, 12)}`),
  ].map((l) => printable(l));
  // Every text file in full (capped), so approval never relies on a summary.
  for (const f of [...files].sort((x, y) => (x.path === manifest.script ? -1 : y.path === manifest.script ? 1 : x.path.localeCompare(y.path)))) {
    if (f.path === "job.json") continue;
    if (!isText(f.content)) {
      lines.push(`── ${f.path} (binary, ${fmtBytes(f.content.length)}) ──`);
      continue;
    }
    const body = f.content.toString("utf8").replace(/\n$/, "").split("\n");
    lines.push(`── ${f.path}${f.path === manifest.script ? " (entry point)" : ""} ──`, ...body.slice(0, MAX_LINES).map((l) => printable(l, true)));
    if (body.length > MAX_LINES) lines.push(`[${body.length - MAX_LINES} more lines${opts.snapshotDir ? `; full file in ${opts.snapshotDir}` : ""}]`);
  }
  lines.push("──");
  if (job.state === "pending_approval") lines.push(`approve: re job approve ${job.id} [--note N]     deny: re job deny ${job.id} --reason R`);
  return lines.join("\n");
}
