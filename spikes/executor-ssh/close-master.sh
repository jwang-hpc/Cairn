#!/bin/sh
# Close a ControlMaster opened by open-master.sh (revokes the executor's reach). Usage: sh close-master.sh <ssh-alias>
DIR="$(cd "$(dirname "$0")/../.." && pwd)/.engine/ssh"
ssh -o "ControlPath=$DIR/%C" -O exit "$1"
