#!/bin/sh
# Open, check, or close your SSH session to a machine (DR-0006). The executor reaches machines only through this
# ControlMaster, mux-only: opening it is the human gate (key, or password + Duo), and closing it revokes the
# executor's reach. Run in your own terminal.
#   sh scripts/ssh-master.sh open  <ssh-alias> [persist, default 4h]
#   sh scripts/ssh-master.sh check <ssh-alias>
#   sh scripts/ssh-master.sh close <ssh-alias>
set -eu
ACTION="${1:-}"; HOST="${2:-}"; PERSIST="${3:-4h}"
case "$ACTION" in open|check|close) ;; *) echo "usage: sh scripts/ssh-master.sh open|check|close <ssh-alias> [persist]" >&2; exit 2 ;; esac
[ -n "$HOST" ] || { echo "missing <ssh-alias> (the host: field in config/machines.yaml)" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${CAIRN_HOME:-$REPO/.engine}/ssh"   # must match the executor: <engine home>/ssh
mkdir -p "$DIR" && chmod 700 "$DIR"
CTL="ControlPath=$DIR/%C"
case "$ACTION" in
  open)
    if ssh -o "$CTL" -O check "$HOST" 2>/dev/null; then echo "already open: $HOST"; exit 0; fi
    # Agent and X11 forwarding off regardless of ~/.ssh/config; -f backgrounds after authentication, -N runs nothing.
    ssh -o ControlMaster=yes -o "$CTL" -o "ControlPersist=$PERSIST" \
        -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -fN "$HOST"
    ssh -o "$CTL" -O check "$HOST"
    ;;
  check) ssh -o "$CTL" -O check "$HOST" ;;
  close) ssh -o "$CTL" -O exit "$HOST" ;;
esac
