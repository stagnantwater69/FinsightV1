#!/bin/sh
set -eu

# Re-entrant child for the slow-shutdown drill below, standing in for a worker
# finishing an in-flight job after SIGTERM: it takes a second to stop, then
# exits with a status no wrapper would produce by accident. Same shape as
# verify-api-entrypoint-signal.sh, which already drills the API side.
if [ "${1:-}" = "--child" ]; then
  child_marker_dir=$2

  graceful_stop() {
    : > "$child_marker_dir/shutdown-started"
    sleep 1
    : > "$child_marker_dir/shutdown-complete"
    exit 23
  }

  trap graceful_stop TERM
  : > "$child_marker_dir/ready"
  while :; do sleep 1; done
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
backend_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
drill_root=$(mktemp -d /tmp/finsight-worker-readiness.XXXXXX)
entrypoint_pid=""

cleanup() {
  if [ -n "$entrypoint_pid" ] && kill -0 "$entrypoint_pid" 2>/dev/null; then
    kill -TERM "$entrypoint_pid" 2>/dev/null || true
    wait "$entrypoint_pid" 2>/dev/null || true
  fi
  chmod -R u+w -- "$drill_root" 2>/dev/null || true
  rm -rf -- "$drill_root"
}
trap cleanup EXIT INT TERM HUP

lang_dir="$drill_root/tessdata"
health_parent="$drill_root/finsight"
health_dir="$health_parent/worker-health"
unsafe_dir="$drill_root/private-app"
mkdir -m 700 -- "$lang_dir" "$health_parent" "$unsafe_dir"
printf '%s\n' keep > "$unsafe_dir/worker.pid"
printf '%s\n' keep > "$unsafe_dir/heartbeat"
chmod 600 -- "$unsafe_dir/worker.pid" "$unsafe_dir/heartbeat"

if TESSERACT_LANG=eng \
  TESSERACT_LANG_PATH="$lang_dir" \
  RECEIPT_WORKER_HEALTH_DIR="$unsafe_dir" \
    "$script_dir/worker-entrypoint.sh" node -e 'process.exit(0)' >/dev/null 2>&1; then
  exit 1
fi
[ "$(sed -n '1p' "$unsafe_dir/worker.pid")" = keep ]
[ "$(sed -n '1p' "$unsafe_dir/heartbeat")" = keep ]

cp -- "$backend_dir/eng.traineddata" "$lang_dir/eng.traineddata"
printf '%s  %s\n' \
  '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747' \
  'eng.traineddata' > "$lang_dir/SHA256SUMS"
chmod 444 -- "$lang_dir/eng.traineddata" "$lang_dir/SHA256SUMS"
chmod 555 -- "$lang_dir"

TESSERACT_LANG=eng \
TESSERACT_LANG_PATH="$lang_dir" \
RECEIPT_WORKER_HEALTH_DIR="$health_dir" \
  "$script_dir/worker-entrypoint.sh" node -e \
    'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)' &
entrypoint_pid=$!

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  attempt=$((attempt + 1))
  if TESSERACT_LANG=eng \
    TESSERACT_LANG_PATH="$lang_dir" \
    RECEIPT_WORKER_HEALTH_DIR="$health_dir" \
      "$script_dir/worker-readiness.sh" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || exit 1

kill -TERM "$entrypoint_pid"
wait "$entrypoint_pid" 2>/dev/null || true
entrypoint_pid=""

if TESSERACT_LANG=eng \
  TESSERACT_LANG_PATH="$lang_dir" \
  RECEIPT_WORKER_HEALTH_DIR="$health_dir" \
    "$script_dir/worker-readiness.sh" >/dev/null 2>&1; then
  exit 1
fi

# Slow-shutdown drill. The stub above exits the instant it sees TERM, which
# looks the same whether the entrypoint waited for it or abandoned it. A child
# that takes a second to finish separates the two, and abandoning it is what
# leaves production to SIGKILL a half-written job when the kill timer expires.
marker_dir="$drill_root/markers"
mkdir -m 700 -- "$marker_dir"

TESSERACT_LANG=eng \
TESSERACT_LANG_PATH="$lang_dir" \
RECEIPT_WORKER_HEALTH_DIR="$health_dir" \
  "$script_dir/worker-entrypoint.sh" "$0" --child "$marker_dir" \
  > "$drill_root/slow-shutdown-output" 2>&1 &
entrypoint_pid=$!

attempt=0
while [ ! -f "$marker_dir/ready" ] && [ "$attempt" -lt 50 ]; do
  kill -0 "$entrypoint_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -f "$marker_dir/ready" ] || exit 1

kill -TERM "$entrypoint_pid"

# The signal has to reach the child at all.
attempt=0
while [ ! -f "$marker_dir/shutdown-started" ] && [ "$attempt" -lt 50 ]; do
  kill -0 "$entrypoint_pid" 2>/dev/null || exit 1
  attempt=$((attempt + 1))
  sleep 0.1
done
[ -f "$marker_dir/shutdown-started" ] || exit 1

# ...and the entrypoint has to still be alive while the child drains, rather
# than having exited on the signal and orphaned it.
kill -0 "$entrypoint_pid" 2>/dev/null || exit 1

set +e
wait "$entrypoint_pid"
entrypoint_status=$?
set -e
entrypoint_pid=""

[ "$entrypoint_status" -eq 23 ] || exit 1
[ -f "$marker_dir/shutdown-complete" ] || exit 1

printf '%s\n' \
  'receipt_worker_readiness_drill status=ok running_probe_passed=1 stopped_probe_failed=1 unsafe_root_rejected=1 slow_child_shutdown_waited=1 child_exit_propagated=1'
