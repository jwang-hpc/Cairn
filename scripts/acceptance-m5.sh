#!/bin/sh
# M5 acceptance: a coder agent authors a job; you approve it from the CLI; it runs on the workstation; its results
# land in evidence/raw/. Run in your own terminal, on the VPN, with the agent image built and `container` running.
#   sh scripts/ssh-master.sh open workstation      # first: your SSH session (the human gate)
#   sh scripts/acceptance-m5.sh [target]           # default: workstation; also e.g. uncc-hpc (Slurm)
# CALLS A REAL MODEL (one coder run) and RUNS A SMALL JOB on the target. Uses project m5-demo (workstation) or
# m5-<target>, removing any previous one.
set -eu
cd "$(dirname "$0")/.."
unset CAIRN_PROJECT   # it would override `re project use` below
re() { node packages/engine/dist/bin.js "$@"; }
TARGET="${1:-workstation}"
PROJECT="m5-demo"; [ "$TARGET" = workstation ] || PROJECT="m5-$TARGET"
OUT="$(mktemp "${TMPDIR:-/tmp}/cairn-m5.XXXXXX")"
TASK="$(mktemp "${TMPDIR:-/tmp}/cairn-m5-task.XXXXXX")"
trap 'rm -f "$OUT" "$TASK"' EXIT

echo "== machines"
re machine list | tee "$OUT"
grep -q "^$TARGET .*session open" "$OUT" || { echo "FAIL: no open session to $TARGET (sh scripts/ssh-master.sh open <alias>)" >&2; exit 1; }
if grep -q "^$TARGET .*NO SCRATCH" "$OUT"; then echo "FAIL: set machines.$TARGET.scratch in config/machines.yaml" >&2; exit 1; fi

echo "== project $PROJECT"
re project use "$PROJECT" > /dev/null 2>&1 && PROJECTS="$(dirname "$(re project | sed 's|^[^/]*||')")" || PROJECTS=""
if [ -n "$PROJECTS" ]; then case "$PROJECTS" in /*) rm -rf "${PROJECTS:?}/$PROJECT" ;; *) echo "bad projects dir: $PROJECTS" >&2; exit 1 ;; esac; fi
re project new "$PROJECT" --title "M5 acceptance: agent-authored job on $TARGET" --data-class unpublished
re project use "$PROJECT"

cat > "$TASK" <<EOF
Create experiment EXP-001 that measures how long pure-Python prime counting takes on the $TARGET machine.

1. experiments/EXP-001/bench.py: for N in 100000, 200000, 400000, count the primes below N with a simple sieve and
   time it with time.perf_counter(). Write results.csv with the header n,primes,seconds and one row per N.
   Use only the Python standard library.
2. experiments/EXP-001/run.sh: runs \`python3 bench.py\`.
3. experiments/EXP-001/job.json as described by the mcp_jobs_submit tool: 1 node, 1 core, walltime 00:05:00,
   outputs ["results.csv"], and a one-line description.
You may test bench.py in your sandbox first (python3 is available), but leave the full N values in the file.
Then call mcp_jobs_submit with experiment EXP-001 and target $TARGET. Do not wait for approval: put the job id in
/outbox/report.json (status "done") and finish.
EOF

echo "== coder agent (real model, sandbox)"
re run --role coder --task "$TASK" | tee "$OUT" || true
ID="$(sed -n 's/^job  *\([0-9a-f-]*\) [a-z_]* .*/\1/p' "$OUT" | head -n 1)"
FIRST="$(sed -n 's/^job  *[0-9a-f-]* \([a-z_]*\) .*/\1/p' "$OUT" | head -n 1)"
[ -n "$ID" ] || { echo "FAIL: the agent did not submit a job (see the run output above)" >&2; exit 1; }

echo "== approval card for $ID"
re job show "$ID"
if [ "$FIRST" = pending_approval ]; then
  printf '\nApprove job %s? [y/N] ' "$ID"
  read -r ANSWER
  case "$ANSWER" in y|Y|yes) ;; *) re job deny "$ID" --reason "declined during M5 acceptance"; echo "denied; acceptance not completed" >&2; exit 1 ;; esac
  re job approve "$ID" --note "M5 acceptance"
else
  echo "note: job is $FIRST (auto-approved as an identical rerun of a job you approved earlier)"
fi

echo "== waiting for the job (up to 30 minutes; a Slurm job may queue first)"
i=0
while :; do
  re job status "$ID" > "$OUT"
  STATE="$(sed -n '1s/^[^ ]*  \([a-z_]*\).*/\1/p' "$OUT")"
  case "$STATE" in completed|failed|cancelled|lost) break ;; esac
  i=$((i + 1)); [ "$i" -lt 360 ] || { echo "FAIL: still $STATE after 30 minutes (re job status $ID to keep following)" >&2; exit 1; }
  sleep 5
done
cat "$OUT"
[ "$STATE" = completed ] || { echo "FAIL: job ended $STATE" >&2; exit 1; }

echo "== fetch results"
re job fetch "$ID"
DIR="$(re project | sed 's|^[^/]*||')/evidence/raw/EXP-001/$ID"
echo "--- $DIR/results.csv"
cat "$DIR/results.csv"
echo "== ledger check"
re ledger check
git -C "$(re project | sed 's|^[^/]*||')" --no-pager log --format='%h %s  [%(trailers:key=Cairn-Provenance,valueonly,separator=)]' -6
echo "M5 acceptance: OK"
