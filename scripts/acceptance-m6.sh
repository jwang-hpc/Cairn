#!/bin/sh
# M6 acceptance: a claim with a wrong number is flagged by code alone; a correct one passes with a coverage report.
# Uses the m5-demo project from the M5 acceptance (its real workstation results). Run in your own terminal.
#   sh scripts/acceptance-m6.sh          # part 1: code only (no model, no container)
#   sh scripts/acceptance-m6.sh --full   # + part 2: parsers in the agent image, an analysis agent drafts a claim,
#                                        #   rigor review by the reviewer model, your approval into logic/claims.md
set -eu
cd "$(dirname "$0")/.."
unset CAIRN_PROJECT
re() { node packages/engine/dist/bin.js "$@"; }
FULL="${1:-}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cairn-m6.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

re project use m5-demo > /dev/null || { echo "FAIL: no m5-demo project; run sh scripts/acceptance-m5.sh first" >&2; exit 1; }
PROJ="$(re project | sed 's|^[^/]*||')"
JOB="$(ls "$PROJ/evidence/raw/EXP-001" | head -n 1)"
[ -n "$JOB" ] || { echo "FAIL: no EXP-001 evidence in m5-demo" >&2; exit 1; }
CSV="evidence/raw/EXP-001/$JOB/results.csv"
L2="$(sed -n 2p "$PROJ/$CSV" | tr -d '\r')"; L4="$(sed -n 4p "$PROJ/$CSV" | tr -d '\r')"   # the job wrote CRLF lines
N2="$(echo "$L2" | cut -d, -f2)"; N4="$(echo "$L4" | cut -d, -f2)"

echo "== part 1: the support check, code only (job $JOB)"
cat > "$TMP/correct.md" <<EOF
## C??: Pure-Python sieve time grows about linearly with N
- **Statement**: In pure Python, sieve-based prime counting time grows roughly in proportion to N over this range.
- **Conditions**: N from 100000 to 400000, one core on the workstation.
- **Sources**:
  - 100000 ← ${CSV}:2 «${L2}» [input]
  - 400000 ← ${CSV}:4 «${L4}» [input]
  - ${N2} ← ${CSV}:2 «${L2}» [result]
  - ${N4} ← ${CSV}:4 «${L4}» [result]
- **Status**: supported
- **Provenance**: ai-suggested
- **Falsification**: Time rising faster than linearly in N on repeated runs.
- **Proof**: Job \`$JOB\` on the workstation: $N2 primes below 100000; $N4 below 400000.
- **Dependencies**: []
- **Tags**: python, sieve
EOF
WRONG=$((N2 + 1))
sed "s/: $N2 primes below/: $WRONG primes below/" "$TMP/correct.md" > "$TMP/wrong.md"

echo "--- correct claim"
re claim check "$TMP/correct.md" || { echo "FAIL: the correct claim did not pass" >&2; exit 1; }
echo "--- the same claim with one wrong number in Proof ($WRONG instead of $N2)"
if re claim check "$TMP/wrong.md" > "$TMP/wrong.out"; then cat "$TMP/wrong.out"; echo "FAIL: the wrong number was not flagged" >&2; exit 1; fi
awk '/^errors:/{p=1} /^(warnings|checked):/{p=0} p' "$TMP/wrong.out"
grep -q "Proof: $WRONG is not backed by a checked source" "$TMP/wrong.out" || { echo "FAIL: unexpected report" >&2; exit 1; }
echo "part 1: OK (flagged by code alone; no model was called)"

[ "$FULL" = "--full" ] || { echo "M6 acceptance (part 1): OK — add --full for the whole gate with agents"; exit 0; }

echo "== part 2a: parsers (agent image) → evidence/tables/"
re evidence parse EXP-001

echo "== part 2b: an analysis agent drafts a claim (real model, sandbox)"
cat > "$TMP/task.md" <<'EOF'
Experiment EXP-001 timed pure-Python prime counting. Its evidence is under evidence/raw/EXP-001/ (results.csv) and the
parser tables under evidence/tables/EXP-001/ (results.summary.csv, results.ratios.csv).

Read /skills/local/claim-drafting/SKILL.md and follow it exactly. Then write ONE claim draft to
staging/claims/sieve-scaling.md about how the run time grows with N over the measured range. Cite every number from a
file line quoted verbatim; take any ratio from the parser tables, never compute one yourself. Keep the claim as narrow
as the evidence (one run, three sizes, one machine). Then write /outbox/report.json with status "done" and finish.
EOF
re run --role analysis --task "$TMP/task.md" | tee "$TMP/run.out" || true
REF="$(sed -n 's/^claim  *\([^ ]*\) .*/\1/p' "$TMP/run.out" | head -n 1)"
[ -n "$REF" ] || { echo "FAIL: the agent wrote no draft under staging/claims/" >&2; exit 1; }

echo "== part 2c: support check of the agent's draft ($REF)"
re claim check "$REF" || { echo "the agent's draft failed the code check (shown above): the gate stopped it, as designed" >&2; exit 1; }
echo "== part 2d: rigor review (reviewer model)"
re claim review "$REF"
printf '\nApprove this claim into logic/claims.md? [y/N] '
read -r ANSWER || ANSWER=""
case "$ANSWER" in y|Y|yes) ;; *) echo "not approved; nothing written to logic/claims.md"; exit 0 ;; esac
re claim approve "$REF" --note "M6 acceptance"
re claim list
re ledger check
echo "M6 acceptance: OK"
