#!/bin/sh
# M0 spike 3: capture Apple container CLI help + current network/system state for offline reading.
# Run in your own terminal (the Claude Code sandbox can't reach container-apiserver).
cd "$(dirname "$0")" && mkdir -p help
for c in "run" "create" "exec" "start" "stop" "delete" "inspect" "logs" \
         "network" "network create" "network list" "network inspect" "network delete" \
         "image pull" "image list" "system" "system property" "system property list" "system dns"; do
  f="help/$(echo "$c" | tr ' ' '-').txt"
  container $c --help > "$f" 2>&1 || true
done
container network list > help/state-network-list.txt 2>&1 || true
container system property list > help/state-system-properties.txt 2>&1 || true
container network inspect default > help/state-network-default.json 2>&1 || true
echo "wrote $(ls help | wc -l | tr -d ' ') files to $(pwd)/help"
