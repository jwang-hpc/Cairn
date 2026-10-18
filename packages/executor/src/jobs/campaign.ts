// Campaigns (DR-0011): the only autonomous mode. Approved once, then run by deterministic code: a generated driver
// runs the job's script once per point of the parameter grid, each in points/<NNNN>/ with its values as P_<name>
// environment variables, at most `parallel` at a time, each attempt under its own time limit, retrying failures, and
// starting no point once the campaign's budget (the job's walltime) could not cover it. No model is in the loop.
// It writes campaign.csv (one row per point) and merges each CSV output across points (campaign-<name>.csv): the
// first-pass summary. Portable to bash 3.2 (no `wait -n`); points stay in the job's process group, so cancelling
// the job stops them all.
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

/** What a campaign's fetch collects: the index, the merged CSVs, and every point's outputs. */
export function campaignOutputs(manifest: JobManifest): string[] {
  const spec = manifest.campaign;
  if (!spec) return manifest.outputs;
  const csv = manifest.outputs.filter((o) => /\.csv$/i.test(o));
  return ["campaign.csv", ...csv.map(mergedName), ...campaignPoints(spec).flatMap((p) => manifest.outputs.map((o) => `${pointDir(p.index)}/${o}`))];
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const value = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)))) : v);

/** The driver script (.cairn/campaign.sh). `files` are the experiment's files, copied into each point's directory. */
export function campaignDriver(manifest: JobManifest, files: readonly string[], budgetS: number, pointS: number): string {
  const spec = manifest.campaign!;
  const names = Object.keys(spec.parameters);
  const points = campaignPoints(spec);
  const parallel = spec.parallel ?? 1;
  const retries = spec.retries ?? 0;
  const csvOutputs = manifest.outputs.filter((o) => /\.csv$/i.test(o));
  const header = ["point", ...names].join(",");
  const parents = [...new Set(files.map((f) => f.split("/").slice(0, -1).join("/")).filter(Boolean))];
  const prefix = (p: CampaignPoint) => [String(p.index), ...names.map((n) => value(p.values[n]!))].join(",");
  return `${[
    "#!/usr/bin/env bash",
    "# Cairn campaign driver (generated when the campaign was approved; DR-0011). Deterministic: no model in the loop.",
    'cd "$(dirname "$0")/.." || exit 1',
    "START=$(date +%s)",
    `BUDGET=${Math.floor(budgetS)}`,
    `POINT_S=${Math.floor(pointS)}`,
    `PARALLEL=${parallel}`,
    `RETRIES=${retries}`,
    "mkdir -p points",
    ": > .cairn/points.jsonl",
    "",
    "kill_tree() { local c; for c in $(pgrep -P \"$1\" 2>/dev/null); do kill_tree \"$c\"; done; kill -TERM \"$1\" 2>/dev/null; }",
    "",
    "# The summary reads only regular, single-link files inside the job directory (as fetch does): a point cannot pull",
    "# an outside file into campaign.csv or a merged CSV through a link.",
    "ROOT=$(pwd -P)",
    'safe() { [ -f "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -prune -links +1)" ] || return 1; case "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/" in "$ROOT"/*) return 0 ;; esac; return 1; }',
    "result() { local l=''; safe \"$1/.result\" && l=$(head -n 1 \"$1/.result\" | grep -E '^(ok|failed|timeout|skipped),[0-9]*,[0-9]+,[0-9]+$'); echo \"${l:-not run,,0,0}\"; }",
    "",
    "setup() {",
    '  mkdir -p "$1"',
    ...parents.map((d) => `  mkdir -p "$1"/${sq(d)}`),
    ...files.map((f) => `  cp -p ${sq(f)} "$1"/${sq(f)}`),
    "}",
    "",
    "# run_point <index> <dir> NAME=VALUE...: attempts under a time limit; the result goes to <dir>/.result.",
    "run_point() {",
    "  local i=$1 d=$2 attempt=0 code=1 t0 t1 p w status",
    "  shift 2",
    '  setup "$d"',
    '  printf \'%s\\n\' "$@" > "$d/params.env"',
    '  while [ "$attempt" -le "$RETRIES" ]; do',
    "    attempt=$((attempt + 1))",
    '    rm -f "$d/.timeout"',
    "    t0=$(date +%s)",
    // Files the driver writes are removed first, never written through a link a point left there.
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
    '  printf \'{"point":%s,"status":"%s","exit":%s,"attempts":%s,"seconds":%s}\\n\' "$i" "$status" "$code" "$attempt" "$((t1 - t0))" >> .cairn/points.jsonl',
    "}",
    "",
    "# launch <index> <dir> NAME=VALUE...: wait for a free slot; start nothing the budget could not cover.",
    "launch() {",
    '  while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL" ]; do sleep 1; done',
    '  if [ $(( $(date +%s) - START + POINT_S + 30 )) -gt "$BUDGET" ]; then',
    '    mkdir -p "$2"; echo "skipped,,0,0" > "$2/.result"',
    '    printf \'{"point":%s,"status":"skipped","exit":null,"attempts":0,"seconds":0}\\n\' "$1" >> .cairn/points.jsonl',
    "    return",
    "  fi",
    '  run_point "$@" &',
    "}",
    "",
    ...points.map((p) => `launch ${p.index} ${pointDir(p.index)}${names.map((n) => ` ${sq(`P_${n}=${value(p.values[n]!)}`)}`).join("")}`),
    "wait",
    "",
    "# campaign.csv: one row per point.",
    "{",
    `  echo ${sq(`${header},status,exit,attempts,seconds`)}`,
    ...points.map((p) => `  printf '%s,%s\\n' ${sq(prefix(p))} "$(result ${pointDir(p.index)})"`),
    "} > campaign.csv",
    "",
    "# Each CSV output merged across points, with the point and its values in front.",
    ...csvOutputs.flatMap((o) => [
      `: > ${sq(mergedName(o))}`,
      "first=1",
      ...points.map(
        (p) =>
          `if safe ${sq(`${pointDir(p.index)}/${o}`)}; then if [ $first = 1 ]; then printf '%s,%s\\n' ${sq(header)} "$(head -n 1 ${sq(`${pointDir(p.index)}/${o}`)} | tr -d '\\r')" >> ${sq(mergedName(o))}; first=0; fi; tail -n +2 ${sq(`${pointDir(p.index)}/${o}`)} | tr -d '\\r' | sed ${sq(`s/^/${prefix(p)},/`)} >> ${sq(mergedName(o))}; fi`,
      ),
    ]),
    "",
    "# Exit 0 only if every point succeeded.",
    "grep -qv '\"status\":\"ok\"' .cairn/points.jsonl && exit 1",
    "exit 0",
  ].join("\n")}\n`;
}
