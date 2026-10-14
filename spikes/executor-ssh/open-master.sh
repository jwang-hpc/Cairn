#!/bin/sh
# M0 spike 4: open a user-held SSH ControlMaster (the human gate: password + Duo happen here).
# Usage: sh open-master.sh <ssh-alias> [persist, default 4h]. Run in your own terminal.
set -eu
HOST="$1"; PERSIST="${2:-4h}"
DIR="$(cd "$(dirname "$0")/../.." && pwd)/.engine/ssh"
mkdir -p "$DIR" && chmod 700 "$DIR"
# ForwardAgent/X11 off regardless of ~/.ssh/config; -f backgrounds after auth, -N runs nothing.
ssh -o ControlMaster=yes -o "ControlPath=$DIR/%C" -o "ControlPersist=$PERSIST" \
    -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -fN "$HOST"
ssh -o "ControlPath=$DIR/%C" -O check "$HOST"
