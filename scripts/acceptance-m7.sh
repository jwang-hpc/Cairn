#!/bin/sh
# M7 acceptance: a related-work note set for a known topic, every citation resolvable. Run in your own terminal.
#   sh scripts/acceptance-m7.sh          # part 1: the literature services (network, no model, no container)
#   sh scripts/acceptance-m7.sh --full   # + part 2: a literature agent builds the note set in project m7-lit;
#                                        #   re literature check re-verifies it; you accept it into the ledger
set -eu
cd "$(dirname "$0")/.."
unset CAIRN_PROJECT
re() { node packages/engine/dist/bin.js "$@"; }
FULL="${1:-}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cairn-m7.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "== part 1: resolve and search (Semantic Scholar, OpenAlex, arXiv, Crossref; doi.org)"
re literature contact
re literature resolve 10.1109/TBDATA.2022.3201176 > "$TMP/sz3.out" || { cat "$TMP/sz3.out"; echo "FAIL: the SZ3 DOI did not resolve" >&2; exit 1; }
cat "$TMP/sz3.out"
grep -q "^resolved: liang2023sz3$" "$TMP/sz3.out" || { echo "FAIL: unexpected citekey" >&2; exit 1; }
re literature resolve arxiv:2304.11768 | head -n 1
if re literature resolve 10.9999/cairn.made.up.2026 > "$TMP/fake.out"; then cat "$TMP/fake.out"; echo "FAIL: a made-up DOI resolved" >&2; exit 1; fi
head -n 2 "$TMP/fake.out"
re literature search error-bounded lossy compression scientific data --from 2020 --limit 5
echo "part 1: OK"

[ "$FULL" = "--full" ] || { echo "M7 acceptance (part 1): OK — add --full for the agent-built note set"; exit 0; }

echo "== part 2a: project m7-lit"
re project use m7-lit > /dev/null 2>&1 || re project new m7-lit --title "Related work: error-bounded lossy compression for HPC data" --data-class public
re project use m7-lit > /dev/null

echo "== part 2b: a literature agent builds the note set (real model, sandbox, literature tools)"
cat > "$TMP/task.md" <<'EOF2'
Build the related-work note set for this project: error-bounded lossy compression of scientific (HPC simulation)
data. Read /skills/local/literature-review/SKILL.md and follow it exactly.

Cover at least: the SZ family (including SZ3, DOI 10.1109/TBDATA.2022.3201176), ZFP, MGARD or another
multilevel/refactoring approach, and GPU compressors (e.g. cuSZ). Resolve at least 8 papers with
mcp_literature_resolve, write a paper note for each in lit/notes/<citekey>.md, and a synthesis in
lit/notes/related-work.md that cites every one of them. Then write /outbox/report.json and finish.
EOF2
re run --role literature --task "$TMP/task.md" | tee "$TMP/run.out" || true
BRANCH="$(sed -n 's/^lit .*re literature check \([^ ]*\).*$/\1/p' "$TMP/run.out" | head -n 1)"
[ -n "$BRANCH" ] || { echo "FAIL: the agent changed nothing under lit/" >&2; exit 1; }

echo "== part 2c: re literature check $BRANCH"
re literature check "$BRANCH" || { echo "the note set failed the check (shown above): it can't be accepted, as designed" >&2; exit 1; }
echo "== part 2d: the notes, most relevant first (the agent's 0-10 score)"
re literature notes "$BRANCH"
PROJ="$(re project | sed 's|^[^/]*||')"
REFS="$(git -C "$PROJ" show "$BRANCH:lit/refs.bib" | grep -c '^@')"
NOTES="$(git -C "$PROJ" ls-tree --name-only "$BRANCH" -- lit/notes/ | grep -c '\.md$' || true)"
echo "references: $REFS; note files: $NOTES"
[ "$REFS" -ge 8 ] || { echo "FAIL: fewer than 8 references" >&2; exit 1; }
for D in 10.1109/tbdata.2022.3201176; do
  git -C "$PROJ" show "$BRANCH:lit/refs.bib" | grep -qi "doi = {$D}" || echo "note: the known paper $D is missing from the set"
done

printf '\nAccept this note set into the m7-lit ledger? [y/N] '
read -r ANSWER || ANSWER=""
case "$ANSWER" in y|Y|yes) ;; *) echo "not accepted; the branch $BRANCH stays for review"; exit 0 ;; esac
re literature accept "$BRANCH"
re literature check
re ledger check
echo "M7 acceptance: OK"
