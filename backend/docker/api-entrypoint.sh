#!/bin/sh
set -u

if [ "$#" -eq 0 ]; then
  printf '%s\n' "FinSight API entrypoint requires a command" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sweeper=/usr/local/bin/finsight-receipt-upload-sweeper
if [ ! -x "$sweeper" ] && [ -x "$script_dir/receipt-upload-orphan-sweep.sh" ]; then
  sweeper="$script_dir/receipt-upload-orphan-sweep.sh"
fi
if [ ! -x "$sweeper" ]; then
  printf '%s\n' "Receipt upload sweeper is unavailable" >&2
  exit 70
fi
if ! "$sweeper" --once; then
  printf '%s\n' "Receipt upload sweeper preflight failed" >&2
  exit 78
fi

"$sweeper" --loop &
sweeper_pid=$!
app_pid=""
received_signal=""

forward_signal() {
  received_signal=$1
  if [ -n "$app_pid" ]; then
    kill -TERM "$app_pid" 2>/dev/null || true
  fi
  kill -TERM "$sweeper_pid" 2>/dev/null || true
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP

"$@" &
app_pid=$!
wait "$app_pid"
status=$?
if [ -n "$received_signal" ] && kill -0 "$app_pid" 2>/dev/null; then
  wait "$app_pid"
  status=$?
fi

kill -TERM "$sweeper_pid" 2>/dev/null || true
wait "$sweeper_pid" 2>/dev/null || true
exit "$status"
