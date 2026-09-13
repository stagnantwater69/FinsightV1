#!/bin/sh
set -eu

if [ "${1:-}" = "--child" ]; then
  marker_dir=$2

  graceful_stop() {
    : > "$marker_dir/shutdown-started"
    sleep 1
    : > "$marker_dir/shutdown-complete"
    exit 23
  }

  trap graceful_stop TERM
  : > "$marker_dir/ready"
  while :; do sleep 1; done
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
drill_parent=$(mktemp -d /tmp/finsight-api-signal.XXXXXX)
upload_root="$drill_parent/finsight/receipt-uploads"
marker_dir="$drill_parent/markers"
entry_pid=""

cleanup() {
  if [ -n "$entry_pid" ]; then
    kill -KILL "$entry_pid" 2>/dev/null || true
    wait "$entry_pid" 2>/dev/null || true
  fi
  chmod -R u+w -- "$drill_parent" 2>/dev/null || true
  rm -rf -- "$drill_parent"
}
trap cleanup EXIT INT TERM HUP

mkdir -m 700 -- "$drill_parent/finsight" "$upload_root" "$marker_dir"
RECEIPT_UPLOAD_TEMP_ROOT="$upload_root" \
  "$script_dir/api-entrypoint.sh" "$0" --child "$marker_dir" \
  > "$drill_parent/entrypoint-output" 2>&1 &
entry_pid=$!

attempt=0
while [ ! -f "$marker_dir/ready" ] && [ "$attempt" -lt 50 ]; do
  kill -0 "$entry_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -f "$marker_dir/ready" ]

kill -TERM "$entry_pid"
attempt=0
while [ ! -f "$marker_dir/shutdown-started" ] && [ "$attempt" -lt 50 ]; do
  kill -0 "$entry_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -f "$marker_dir/shutdown-started" ]
kill -0 "$entry_pid" 2>/dev/null

set +e
wait "$entry_pid"
entry_status=$?
set -e
entry_pid=""

[ "$entry_status" -eq 23 ]
[ -f "$marker_dir/shutdown-complete" ]
printf '%s\n' 'receipt_api_signal_drill status=ok child_shutdown_waited=1 child_exit_propagated=1'
