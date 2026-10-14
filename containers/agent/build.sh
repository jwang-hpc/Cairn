#!/bin/sh
# Build and smoke-test the agent image. Run in your own terminal (needs `container system start`).
#   sh containers/agent/build.sh [tag]      default tag: cairn-agent:dev
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:-cairn-agent:dev}"
BASE="docker.io/library/python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1"   # keep in sync with Containerfile FROM
OUT="$HERE/.build"            # gitignored: help text and base-image metadata for pinning
mkdir -p "$OUT"

container build --help > "$OUT/build-help.txt" 2>&1 || true
container image pull "$BASE" > /dev/null
container image inspect "$BASE" > "$OUT/base-inspect.json" 2>&1 || true

echo "== building $TAG"
container build -t "$TAG" -f "$HERE/Containerfile" "$HERE"

echo "== smoke test"
SMOKE='
set -e
echo "uid=$(id -u) gid=$(id -g) user=$(id -un)"
python3 - <<PY
import socket, time
t = time.time()
try:
    socket.getaddrinfo("pypi.org", 443); print("dns: RESOLVED (unexpected)")
except socket.gaierror:
    print(f"dns: fails in {time.time()-t:.2f}s")
PY
echo "setuid/setgid files: $(find / -xdev -type f -perm /6000 2>/dev/null | wc -l | tr -d " ")"
if touch /usr/pwned 2>/dev/null; then echo "rootfs: WRITABLE (unexpected)"; else echo "rootfs: read-only"; fi
python3 --version
'
container run --rm --read-only --tmpfs /tmp --cap-drop ALL --user 1000:1000 --no-dns --entrypoint sh "$TAG" -c "$SMOKE" \
  | tee "$OUT/smoke.txt"
echo "== done: $TAG (details in $OUT)"
