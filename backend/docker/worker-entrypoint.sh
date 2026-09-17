#!/bin/sh
set -u

fail() {
  printf '%s\n' "receipt_worker_startup status=failed code=$1" >&2
  exit 78
}

if [ "$#" -eq 0 ]; then
  fail WORKER_COMMAND_MISSING
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
preflight=/usr/local/bin/finsight-tesseract-preflight
if [ ! -x "$preflight" ] && [ -x "$script_dir/tesseract-entrypoint.sh" ]; then
  preflight="$script_dir/tesseract-entrypoint.sh"
fi
[ -x "$preflight" ] || fail TESSERACT_PREFLIGHT_MISSING

health_dir=${RECEIPT_WORKER_HEALTH_DIR:-/tmp/finsight-worker-health}
case "$health_dir" in
  /*) ;;
  *) fail HEALTH_DIRECTORY_INVALID ;;
esac
case "$health_dir" in
  /|*/../*|*/..|*/./*|*//*|*/.|*/|*[!A-Za-z0-9_./-]*) fail HEALTH_DIRECTORY_INVALID ;;
esac
case "$health_dir" in
  /tmp/finsight-worker-health|/tmp/*/finsight/worker-health|/run/finsight/worker-health) ;;
  *) fail HEALTH_DIRECTORY_INVALID ;;
esac
if [ -L "$health_dir" ] || { [ -e "$health_dir" ] && [ ! -d "$health_dir" ]; }; then
  fail HEALTH_DIRECTORY_INVALID
fi

umask 077
if [ ! -d "$health_dir" ]; then
  mkdir -m 700 -- "$health_dir" || fail HEALTH_DIRECTORY_CREATE_FAILED
fi
resolved_health_dir=$(readlink -f -- "$health_dir" 2>/dev/null || printf invalid)
if [ "$resolved_health_dir" != "$health_dir" ]; then
  fail HEALTH_DIRECTORY_UNSAFE
fi

current_uid=$(id -u)
health_uid=$(stat -c %u -- "$health_dir" 2>/dev/null || printf invalid)
health_mode=$(stat -c %a -- "$health_dir" 2>/dev/null || printf invalid)
if [ "$health_uid" != "$current_uid" ] || [ "$health_mode" != 700 ]; then
  fail HEALTH_DIRECTORY_UNSAFE
fi

pid_file="$health_dir/worker.pid"
heartbeat_file="$health_dir/heartbeat"
if [ -L "$pid_file" ] || [ -L "$heartbeat_file" ]; then
  fail HEALTH_MARKER_UNSAFE
fi
rm -f -- "$pid_file" "$heartbeat_file"

"$preflight" --check-only || fail LANGUAGE_DATA_UNAVAILABLE

"$@" &
worker_pid=$!
printf '%s\n' "$worker_pid" > "$pid_file"
: > "$heartbeat_file"
chmod 600 -- "$pid_file" "$heartbeat_file"

# A BRIDGE, not the heartbeat itself.
#
# dist/worker.js writes this file from a timer of its own (see
# src/lib/workerHeartbeat.ts), which is what makes the probe's mtime mean "the
# event loop is still turning" rather than "a pid exists" — the latter kept a
# wedged worker reporting healthy indefinitely. Until the worker's first write
# lands, keep the file fresh so a slow boot (Prisma connect, migration guard,
# against only a 5s start period) is not read as a stall, then stand down so
# the two never both claim to be the heartbeat.
heartbeat() {
  while kill -0 "$worker_pid" 2>/dev/null; do
    if [ "$(head -c 4 -- "$heartbeat_file" 2>/dev/null)" = node ]; then
      return
    fi
    touch -- "$heartbeat_file" || exit 1
    sleep 2
  done
}

heartbeat &
heartbeat_pid=$!
received_signal=""

forward_signal() {
  received_signal=$1
  kill -TERM "$worker_pid" 2>/dev/null || true
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP

wait "$worker_pid"
worker_status=$?
if [ -n "$received_signal" ] && kill -0 "$worker_pid" 2>/dev/null; then
  wait "$worker_pid"
  worker_status=$?
fi

kill -TERM "$heartbeat_pid" 2>/dev/null || true
wait "$heartbeat_pid" 2>/dev/null || true
rm -f -- "$pid_file" "$heartbeat_file"
exit "$worker_status"
