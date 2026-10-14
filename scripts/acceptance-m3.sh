#!/bin/sh
# M3 acceptance: re project new, re hypothesis add, tree renders as text, every write tagged.
# Uses the configured projects_dir (default .engine/projects). Removes any previous m3-demo project first.
set -eu
cd "$(dirname "$0")/.."
re() { node packages/engine/dist/bin.js "$@"; }
DIR="$(node -e 'import("./packages/engine/dist/paths.js").then(m=>console.log(m.resolvePaths().home))')/projects/m3-demo"
rm -rf "$DIR"
re project new m3-demo --title "Error-bounded compression for HPC checkpoints" --data-class unpublished
re hypothesis add --title "SZ3 cuts checkpoint time at scale" \
  --statement "Error-bounded lossy compression (SZ3, 1e-3 rel) reduces checkpoint write time on Lustre." \
  --prediction "At least 3x lower write time at 512 nodes." \
  --falsification "Reduction below 1.5x at 512 nodes with identical striping." \
  --baseline "Uncompressed HDF5 with default striping." \
  --experiment "Weak scaling 64-512 nodes, 5 repeats." \
  --kill "Compression overhead exceeds I/O savings at 128 nodes."
re hypothesis approve HY01 --note "worth one allocation cycle"
re trace add dead-end --title "Lossless zstd only" --hypothesis "Lossless is enough" \
  --failure "1.1x ratio on float fields" --lesson "Use error-bounded lossy compressors" --parent N01
re decision add --title "Lustre stripe count 8 for all runs" --refs "HY01"
echo "== tree"; re tree
echo "== ledger check"; re ledger check
