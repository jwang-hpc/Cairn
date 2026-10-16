#!/bin/sh
# M9 acceptance: a 20-point sweep runs on the workstation while the laptop sleeps; results are reconciled on wake.
# Run in your own terminal, on the VPN. No model is called: you write the campaign, approve it, and sleep the laptop.
#   sh scripts/ssh-master.sh open <ssh-alias>      # first: your SSH session to the workstation (the human gate)
#   sh scripts/acceptance-m9.sh [target]           # default: workstation (a machine without a scheduler)
# Uses project m9-sweep (PROJECT=<name> for another); asks before replacing an existing one.
set -eu
cd "$(dirname "$0")/.."
unset CAIRN_PROJECT
re() { node packages/engine/dist/bin.js "$@"; }
TARGET="${1:-workstation}"
PROJECT="${PROJECT:-m9-sweep}"
OUT="$(mktemp "${TMPDIR:-/tmp}/cairn-m9.XXXXXX")"
trap 'rm -f "$OUT"' EXIT
[ -t 0 ] || { echo "FAIL: run this in a terminal (it asks you to approve and to sleep the laptop)" >&2; exit 1; }

echo "== machines"
re machine list | tee "$OUT"
HOST="$(sed -n "s/^$TARGET  *ssh \([^ ]*\) .*/\1/p" "$OUT" | head -n 1)"
grep -q "^$TARGET .*session open" "$OUT" || { echo "FAIL: no open session to $TARGET (sh scripts/ssh-master.sh open ${HOST:-<alias>})" >&2; exit 1; }
if grep -q "^$TARGET .*NO SCRATCH" "$OUT"; then echo "FAIL: set machines.$TARGET.scratch in config/machines.yaml" >&2; exit 1; fi

echo "== project $PROJECT"
re project use "$PROJECT" > /dev/null 2>&1 && PROJECTS="$(dirname "$(re project | sed 's|^[^/]*||')")" || PROJECTS=""
if [ -n "$PROJECTS" ]; then
  case "$PROJECTS" in /*) ;; *) echo "bad projects dir: $PROJECTS" >&2; exit 1 ;; esac
  echo "project $PROJECT already exists: $(git -C "$PROJECTS/$PROJECT" rev-list --count HEAD) ledger commits"
  printf 'Delete it and start a clean run? [y/N] '
  read -r ANSWER || ANSWER=""
  case "$ANSWER" in y|Y|yes) rm -rf "${PROJECTS:?}/$PROJECT" ;; *) echo "kept $PROJECT; nothing done (set PROJECT=<another name> for a separate run)"; exit 0 ;; esac
fi
# No --data-class: you are asked (the sweep's numbers are synthetic, and no model sees them).
re project new "$PROJECT" --title "M9 acceptance: a 20-point sweep on $TARGET"
re project use "$PROJECT" > /dev/null
PROJ="$(re project | sed 's|^[^/]*||')"

echo "== the campaign you wrote: experiments/EXP-001 (Monte Carlo pi, 5 sample sizes x 4 seeds)"
mkdir -p "$PROJ/experiments/EXP-001"
cat > "$PROJ/experiments/EXP-001/run.sh" <<'EOF'
#!/bin/bash
# One point of the M9 acceptance sweep: estimate pi from P_samples random points with seed P_seed.
# The sleep stretches the sweep over a few minutes, so most of it runs while the laptop sleeps.
sleep 45
awk -v n="$P_samples" -v seed="$P_seed" -f pi.awk > results.csv
EOF
cat > "$PROJ/experiments/EXP-001/pi.awk" <<'EOF'
BEGIN {
  srand(seed); hit = 0
  for (i = 0; i < n; i++) { x = rand(); y = rand(); if (x * x + y * y <= 1) hit++ }
  pi = 4 * hit / n; err = pi - 3.14159265358979; if (err < 0) err = -err
  printf "samples,seed,pi,abs_error\n%d,%d,%.6f,%.6f\n", n, seed, pi, err
}
EOF
cat > "$PROJ/experiments/EXP-001/job.json" <<'EOF'
{
  "script": "run.sh",
  "description": "M9 acceptance: Monte Carlo pi over 5 sample sizes x 4 seeds (20 points)",
  "resources": { "cores": 4, "walltime": "00:30:00" },
  "outputs": ["results.csv"],
  "campaign": {
    "parameters": { "samples": [20000, 40000, 80000, 160000, 320000], "seed": [1, 2, 3, 4] },
    "point_walltime": "00:03:00",
    "parallel": 4,
    "retries": 1
  }
}
EOF

re job propose EXP-001 --target "$TARGET" | tee "$OUT"
ID="$(sed -n 's/^proposed \([0-9a-f-]*\): .*/\1/p' "$OUT")"
[ -n "$ID" ] || { echo "FAIL: the campaign was not proposed" >&2; exit 1; }
grep -q "(campaign: 20 points), pending_approval" "$OUT" || { echo "FAIL: expected a 20-point campaign waiting for approval" >&2; exit 1; }

echo "== approval card for $ID"
re job show "$ID"
printf '\nApprove campaign %s? It then runs unattended. [y/N] ' "$ID"
read -r ANSWER || ANSWER=""
case "$ANSWER" in y|Y|yes) ;; *) re job deny "$ID" --reason "declined during M9 acceptance"; echo "denied; acceptance not completed" >&2; exit 1 ;; esac
re job approve "$ID" --note "M9 acceptance"
re job status "$ID"

cat <<EOF

== now sleep the laptop
The campaign takes about 5 minutes (20 points, 4 at a time, about 50 s each).
Close the lid (or Apple menu > Sleep) for at least 5 minutes, then wake the laptop and press Enter here.
EOF
printf 'Press Enter to start; sleep the laptop now ... '
read -r _ || true
SLEPT="$(date +%s)"
printf 'Back? Press Enter ... '
read -r _ || true
WOKE="$(date +%s)"
echo "away for $((WOKE - SLEPT)) s"
SINCE="$(date -r "$SLEPT" '+%Y-%m-%d %H:%M:%S')"
LAST_SLEEP="$(pmset -g log 2>/dev/null | awk -v since="$SINCE" '($1 " " $2) >= since && /Entering Sleep/' | tail -n 1)"
if [ -n "$LAST_SLEEP" ]; then echo "macOS slept: $LAST_SLEEP"; else echo "note: pmset shows no sleep since $SINCE (the run still counts, but the laptop did not sleep)"; fi

echo "== re job reconcile (on wake)"
while :; do
  CODE=0; re job reconcile --project "$PROJECT" > "$OUT" || CODE=$?
  cat "$OUT"
  grep -q "^fetched  $ID " "$OUT" && break
  if [ "$CODE" = 3 ]; then
    echo "The SSH session did not survive the sleep. In another terminal: sh scripts/ssh-master.sh open $HOST"
    printf 'Press Enter when it is open ... '
    read -r _ || true
  elif grep -q "^checked  $ID  \(completed\|failed\|cancelled\|lost\)" "$OUT" || ! grep -q "^checked  $ID " "$OUT"; then
    echo "FAIL: the campaign ended without its results being fetched" >&2; re job status "$ID"; exit 1
  else
    echo "(still running; checking again in 15 s)"; sleep 15
  fi
done

DIR="$PROJ/evidence/raw/EXP-001/$ID"
echo "--- $DIR/campaign.csv"
cat "$DIR/campaign.csv"
echo "--- $DIR/campaign-results.csv"
cat "$DIR/campaign-results.csv"
OK="$(tail -n +2 "$DIR/campaign.csv" | awk -F, '$4 == "ok"' | wc -l | tr -d ' ')"
ROWS="$(tail -n +2 "$DIR/campaign-results.csv" | wc -l | tr -d ' ')"
echo "points ok: $OK of 20; merged result rows: $ROWS"
[ "$OK" = 20 ] && [ "$ROWS" = 20 ] || { echo "FAIL: expected 20 ok points and 20 merged rows" >&2; exit 1; }
re ledger check
git -C "$PROJ" --no-pager log --format='%h %s  [%(trailers:key=Cairn-Provenance,valueonly,separator=)]' -3
echo "M9 acceptance: OK"
