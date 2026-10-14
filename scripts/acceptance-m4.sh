#!/bin/sh
# M4 acceptance: an independent + critique (+ synthesis) panel over HY01 with members from two vendors,
# stored and replayable; a restricted-class project is refused by every disallowed provider.
# Needs the m3-demo project (run scripts/acceptance-m3.sh first). CALLS REAL MODELS (a few cents or
# subscription tokens). Override members with MEMBERS=... SYNTH=... Removes any previous m4-restricted project.
set -eu
cd "$(dirname "$0")/.."
re() { node packages/engine/dist/bin.js "$@"; }
MEMBERS="${MEMBERS:-claude-sonnet@medium,gpt-frontier@medium}"
SYNTH="${SYNTH:-claude-opus@medium}"
HOME_DIR="$(node -e 'import("./packages/engine/dist/paths.js").then(m=>console.log(m.resolvePaths().home))')"
OUT="$(mktemp "${TMPDIR:-/tmp}/cairn-m4.XXXXXX")"
trap 'rm -f "$OUT"' EXIT

re project use m3-demo
DEMO="$(re project | sed 's|^[^/]*||')"
PROJECTS="$(dirname "$DEMO")"

echo "== panel over HY01 ($MEMBERS; synth $SYNTH)"
re panel run --hypothesis HY01 --rounds independent,critique,synthesis --members "$MEMBERS" --synth "$SYNTH" \
  --question "Is HY01 worth an allocation cycle, and is the decisive experiment actually decisive? What would you change?" > "$OUT" || { cat "$OUT"; echo "FAIL: panel run failed" >&2; exit 1; }
cat "$OUT"
if grep -q '^  round .*\(failed\|refused\)' "$OUT"; then echo "FAIL: a member did not answer" >&2; exit 1; fi
ID="$(sed -n 's/^panel \([0-9a-f-]*\)$/\1/p' "$OUT")"
echo "== stored: $PROJECTS/m3-demo/engine/panels/$ID"
ls -R "$DEMO/engine/panels/$ID"
echo "== replay (blind header)"
re panel replay "$ID" | sed -n '1,6p'

echo "== restricted project"
case "$PROJECTS" in /*) rm -rf "$PROJECTS/m4-restricted" ;; *) echo "bad projects dir: $PROJECTS" >&2; exit 1 ;; esac
re project new m4-restricted --title "Restricted-class refusal check" --data-class restricted
re project use m4-restricted
re hypothesis add --title "Placeholder" --statement "S" --prediction "P" --falsification "F" --baseline "B" --experiment "E" --kill "K"
if re panel run --hypothesis HY01 --rounds independent --members "$MEMBERS" --question "Should this be pursued?" > "$OUT"; then
  cat "$OUT"; echo "FAIL: restricted panel was not refused" >&2; exit 1
fi
cat "$OUT"
RID="$(sed -n 's/^panel \([0-9a-f-]*\)$/\1/p' "$OUT")"
DENIED="$(grep "\"run\":\"$RID\"" "$HOME_DIR/events.jsonl" | grep -c '"decision":"denied"' || true)"
CALLS="$(grep -c "\"run\":\"$RID\"" "$HOME_DIR/usage.jsonl" || true)"
echo "== restricted panel $RID: $DENIED approval-denied events, $CALLS model calls"
[ "$DENIED" -ge 2 ] && [ "$CALLS" -eq 0 ] || { echo "FAIL: expected >=2 denials and 0 calls" >&2; exit 1; }

re project use m3-demo
echo "== ledger check"; re ledger check
echo "M4 acceptance: OK (judge with: re panel judge $ID --prefer A)"
