// Campaigns (DR-0011): the only autonomous mode. Approved once, then run by deterministic code with no model in the
// loop. Each point of the parameter grid runs the job's script in points/<NNNN>/ with its values as P_<name>
// environment variables, each attempt under its own time limit, retrying failures.
// - Workstation: a generated driver (.cairn/campaign.sh) runs the points, at most `parallel` at a time, and starts
//   no point the campaign's budget (the job's walltime) could not finish. Portable to bash 3.2 (no `wait -n`); the
//   points stay in the job's process group, so cancelling the job stops them all.
// - Slurm: one job array, one task per point and at most `parallel` at once; each task runs .cairn/point.sh for its
//   index. The budget is a deadline (`--deadline`): Slurm starts no task that could not finish by then.
// The summary (campaign.csv, one row per point, and each CSV output merged across points) is plain sh generated
// here. The workstation driver runs it when the points are done; fetch runs it again from this host-generated text,
// never from a file in the job directory (the job could have rewritten it), so cancelled and Slurm campaigns get one.
import type { CampaignSpec, JobManifest } from "@cairn/shared";

export interface CampaignPoint {
  index: number;
  values: Record<string, number | string>;
}

export const pointDir = (i: number) => `points/${String(i).padStart(4, "0")}`;

/** Every combination of the parameters, the first parameter varying slowest. */
export function campaignPoints(spec: CampaignSpec): CampaignPoint[] {
  const names = Object.keys(spec.parameters);
  let combos: Record<string, number | string>[] = [{}];
  for (const n of names) combos = combos.flatMap((c) => spec.parameters[n]!.map((v) => ({ ...c, [n]: v })));
  return names.length === 0 ? [] : combos.map((values, index) => ({ index, values }));
}

export const pointCount = (spec: CampaignSpec) => Object.values(spec.parameters).reduce((n, vs) => n * vs.length, Object.keys(spec.parameters).length ? 1 : 0);

/** campaign-<output with / as _> for each CSV output. */
export const mergedName = (output: string) => `campaign-${output.replace(/\//g, "_")}`;

/** A Slurm array task's time limit: every attempt at its point, plus a minute to set the point up. */
export const taskWalltimeS = (pointS: number, retries: number) => (retries + 1) * pointS + 60;

/** What a campaign's fetch collects: the index, the merged CSVs, and every point's outputs. */
export function campaignOutputs(manifest: JobManifest): string[] {
  const spec = manifest.campaign;
  if (!spec) return manifest.outputs;
  const csv = manifest.outputs.filter((o) => /\.csv$/i.test(o));
  return ["campaign.csv", ...csv.map(mergedName), ...campaignPoints(spec).flatMap((p) => manifest.outputs.map((o) => `${pointDir(p.index)}/${o}`))];
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const value = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)))) : v);

/** "<index> P_a=x P_b=y" per point. Values never contain spaces or glob characters (CampaignValue). */
const launchTable = (spec: CampaignSpec) => campaignPoints(spec).map((p) => [String(p.index), ...Object.keys(spec.parameters).map((n) => `P_${n}=${value(p.values[n]!)}`)].join(" "));

/** "<index> <index>,<values>" per point: the columns campaign.csv and the merged CSVs put in front. */
const prefixTable = (spec: CampaignSpec) =>
  campaignPoints(spec).map((p) => `${p.index} ${[String(p.index), ...Object.keys(spec.parameters).map((n) => value(p.values[n]!))].join(",")}`);

/** bash: kill_tree, setup (a fresh copy of the experiment's files), run_point (attempts under a time limit). */
function pointFunctions(manifest: JobManifest, files: readonly string[], pointS: number): string[] {
  const parents = [...new Set(files.map((f) => f.split("/").slice(0, -1).join("/")).filter(Boolean))];
  return [
    `POINT_S=${Math.floor(pointS)}`,
    `RETRIES=${manifest.campaign!.retries ?? 0}`,
    "",
    "kill_tree() { local c; for c in $(pgrep -P \"$1\" 2>/dev/null); do kill_tree \"$c\"; done; kill -TERM \"$1\" 2>/dev/null; }",
    "",
    "# setup <dir>: a fresh point directory (a requeued Slurm task starts over) with a copy of the experiment's files.",
    "setup() {",
    '  rm -rf "$1"',
    '  mkdir -p "$1"',
    ...parents.map((d) => `  mkdir -p "$1"/${sq(d)}`),
    ...files.map((f) => `  cp -p ${sq(f)} "$1"/${sq(f)}`),
    "}",
    "",
    "# run_point <index> <dir> NAME=VALUE...: the result goes to <dir>/.result; returns 0 if the point succeeded.",
    "# Files the driver writes are removed first, never written through a link a point left there.",
    "run_point() {",
    "  local i=$1 d=$2 attempt=0 code=1 t0 t1 p w status",
    "  shift 2",
    '  setup "$d"',
    '  printf \'%s\\n\' "$@" > "$d/params.env"',
    '  while [ "$attempt" -le "$RETRIES" ]; do',
    "    attempt=$((attempt + 1))",
    '    rm -f "$d/.timeout"',
    "    t0=$(date +%s)",
    `    ( cd "$d" && rm -f stdout.log stderr.log && exec env CAIRN_POINT="$i" "$@" bash ./${sq(manifest.script)} > stdout.log 2> stderr.log < /dev/null ) &`,
    "    p=$!",
    '    ( sleep "$POINT_S"; touch "$d/.timeout"; kill_tree "$p" ) > /dev/null 2>&1 &',
    "    w=$!",
    '    wait "$p"; code=$?',
    '    kill_tree "$w"',
    "    t1=$(date +%s)",
    '    [ "$code" = 0 ] && break',
    "  done",
    '  if [ "$code" = 0 ]; then status=ok; elif [ -e "$d/.timeout" ]; then status=timeout; else status=failed; fi',
    '  rm -f "$d/.result"; echo "$status,$code,$attempt,$((t1 - t0))" > "$d/.result"',
    '  [ "$status" = ok ]',
    "}",
  ];
}

/**
 * The summary, plain sh, run in the job directory: campaign.csv (one row per point) and each CSV output merged across
 * points with the point and its values in front. It reads only regular, single-link files inside the job directory
 * (as fetch does), so a point cannot pull an outside file in through a link.
 */
export function campaignSummary(manifest: JobManifest): string {
  const spec = manifest.campaign!;
  const head = ["point", ...Object.keys(spec.parameters)].join(",");
  const csvOutputs = manifest.outputs.filter((o) => /\.csv$/i.test(o));
  return `${[
    "# Campaign summary (generated by Cairn; DR-0011).",
    "ROOT=$(pwd -P)",
    'safe() { [ -f "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -prune -links +1)" ] || return 1; case "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/" in "$ROOT"/*) return 0 ;; esac; return 1; }',
    "result() { _l=''; safe \"$1/.result\" && _l=$(head -n 1 \"$1/.result\" | grep -E '^(ok|failed|timeout|skipped),[0-9]*,[0-9]+,[0-9]+$'); echo \"${_l:-not run,,0,0}\"; }",
    "points() {",
    "cat <<'CAIRN_POINTS'",
    ...prefixTable(spec),
    "CAIRN_POINTS",
    "}",
    "rm -f campaign.csv",
    "{",
    `  echo ${sq(`${head},status,exit,attempts,seconds`)}`,
    `  points | while read -r i p; do printf '%s,%s\\n' "$p" "$(result "$(printf 'points/%04d' "$i")")"; done`,
    "} > campaign.csv",
    "# merge <output> <merged file>",
    "merge() {",
    '  rm -f "$2"; : > "$2"; _first=1',
    "  points | while read -r i p; do",
    `    f="$(printf 'points/%04d' "$i")/$1"`,
    '    safe "$f" || continue',
    `    if [ "$_first" = 1 ]; then printf '%s,%s\\n' ${sq(head)} "$(head -n 1 "$f" | tr -d '\\r')" >> "$2"; _first=0; fi`,
    `    tail -n +2 "$f" | tr -d '\\r' | awk -v p="$p" '{ print p "," $0 }' >> "$2"`,
    "  done",
    "}",
    ...csvOutputs.map((o) => `merge ${sq(o)} ${sq(mergedName(o))}`),
  ].join("\n")}\n`;
}

/** The workstation driver (.cairn/campaign.sh). `files` are the experiment's files, copied into each point's directory. */
export function campaignDriver(manifest: JobManifest, files: readonly string[], budgetS: number, pointS: number): string {
  const spec = manifest.campaign!;
  return `${[
    "#!/usr/bin/env bash",
    "# Cairn campaign driver (generated when the campaign was launched; DR-0011). Deterministic: no model in the loop.",
    'cd "$(dirname "$0")/.." || exit 1',
    "START=$(date +%s)",
    `BUDGET=${Math.floor(budgetS)}`,
    `PARALLEL=${spec.parallel ?? 1}`,
    ...pointFunctions(manifest, files, pointS),
    "",
    "# launch <index> <dir> NAME=VALUE...: wait for a free slot; start nothing the budget could not cover.",
    "launch() {",
    '  while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]; do sleep 1; done',
    '  if [ $(( $(date +%s) - START + POINT_S + 30 )) -gt "$BUDGET" ]; then',
    '    mkdir -p "$2"; rm -f "$2/.result"; echo "skipped,,0,0" > "$2/.result"',
    "    return",
    "  fi",
    '  run_point "$@" &',
    "}",
    "",
    "mkdir -p points",
    "# The loop reads a here-document, so it runs in this shell: `jobs` and `wait` see every point.",
    `while read -r i a; do launch "$i" "$(printf 'points/%04d' "$i")" $a; done <<'CAIRN_LAUNCH'`,
    ...launchTable(spec),
    "CAIRN_LAUNCH",
    "wait",
    "",
    campaignSummary(manifest).trimEnd(),
    "",
    "# Exit 0 only if every point succeeded.",
    "awk -F, 'NR > 1 && $(NF - 3) != \"ok\" { bad = 1 } END { exit bad }' campaign.csv",
  ].join("\n")}\n`;
}

/** One Slurm array task (.cairn/point.sh <index>): its point, with retries, under the point's time limit. */
export function campaignTask(manifest: JobManifest, files: readonly string[], pointS: number): string {
  return `${[
    "#!/usr/bin/env bash",
    "# Cairn campaign point (generated when the campaign was launched; DR-0011): one Slurm array task runs one point.",
    'cd "$(dirname "$0")/.." || exit 1',
    ...pointFunctions(manifest, files, pointS),
    "",
    "i=$1",
    `case "$i" in ''|*[!0-9]*) echo "cairn: bad point index '$i'" >&2; exit 2 ;; esac`,
    "found=0",
    `while read -r j a; do if [ "$j" = "$i" ]; then found=1; break; fi; done <<'CAIRN_LAUNCH'`,
    ...launchTable(manifest.campaign!),
    "CAIRN_LAUNCH",
    '[ "$found" = 1 ] || { echo "cairn: no point $i" >&2; exit 2; }',
    `run_point "$i" "$(printf 'points/%04d' "$i")" $a`,
  ].join("\n")}\n`;
}
