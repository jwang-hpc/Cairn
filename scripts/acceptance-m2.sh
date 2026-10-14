#!/bin/sh
# M2 acceptance: an agent edits files in its worktree only. Run in your own terminal.
set -eu
CAIRN=/Users/jonwang/LocalRepo/Cairn
D=/tmp/cairn-demo
TASK=/tmp/cairn-demo-task.md

echo "== demo project at $D"
rm -rf "$D"; mkdir -p "$D/logic"
cat > "$D/logic/claims.md" <<'EOF'
# Claims
1. Lossy compressor X keeps PSNR above 60 dB on dataset A.
2. Throughput exceeds 2 GB/s on 64 cores.
3. The error bound holds for all timesteps.
EOF
printf 'demo project\n' > "$D/README.md"
git -C "$D" init -q -b main
git -C "$D" add -A
git -C "$D" -c user.name=demo -c user.email=demo@example.com commit -qm init

cat > "$TASK" <<'EOF'
Read logic/claims.md. Write analysis/summary.md containing the number of claims and a one-line
restatement of each claim. Do not change anything else. Then write your report.
EOF

echo "== re run (analysis role, Claude Haiku, low effort)"
cd "$CAIRN"
node packages/engine/dist/bin.js run --repo "$D" --role analysis --task "$TASK" --model claude-haiku --effort low || true

echo "== evidence"
echo "-- main is untouched:";        git --no-pager -C "$D" status --porcelain; git --no-pager -C "$D" log --oneline main
echo "-- agent branch:";             git --no-pager -C "$D" log --oneline --format='%h %an: %s' 'agent/*' 2>/dev/null | head -3
echo "-- files the agent changed:";  git --no-pager -C "$D" diff --name-status main...$(git -C "$D" branch --list 'agent/*' --format='%(refname:short)' | head -1)
echo "-- analysis/summary.md:";      git --no-pager -C "$D" show "$(git -C "$D" branch --list 'agent/*' --format='%(refname:short)' | head -1):analysis/summary.md" 2>/dev/null || echo "(not created)"
echo "-- leftover containers/networks:"; container list --all | grep cairn- || echo "none"; container network list | grep cairn-net || echo "none"
