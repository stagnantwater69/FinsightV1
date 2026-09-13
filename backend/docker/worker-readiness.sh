#!/bin/sh
set -u

emit_failure() {
  printf '%s\n' "receipt_worker_readiness status=failed process=unavailable language=unknown heartbeat_age_seconds=0 code=$1" >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
preflight=/usr/local/bin/finsight-tesseract-preflight
if [ ! -x "$preflight" ] && [ -x "$script_dir/tesseract-entrypoint.sh" ]; then
  preflight="$script_dir/tesseract-entrypoint.sh"
fi
[ -x "$preflight" ] || emit_failure TESSERACT_PREFLIGHT_MISSING

health_dir=${RECEIPT_WORKER_HEALTH_DIR:-/tmp/finsight-worker-health}
max_age=${RECEIPT_WORKER_HEARTBEAT_MAX_AGE_SECONDS:-45}
case "$health_dir" in
  /*) ;;
  *) emit_failure HEALTH_DIRECTORY_INVALID ;;
esac
case "$health_dir" in
  /|*/../*|*/..|*/./*|*//*|*/.|*/|*[!A-Za-z0-9_./-]*) emit_failure HEALTH_DIRECTORY_INVALID ;;
esac
case "$health_dir" in
  /tmp/finsight-worker-health|/tmp/*/finsight/worker-health|/run/finsight/worker-health) ;;
  *) emit_failure HEALTH_DIRECTORY_INVALID ;;
esac
case "$max_age" in
  ''|*[!0-9]*) emit_failure HEARTBEAT_MAX_AGE_INVALID ;;
esac
if [ "$max_age" -lt 15 ] || [ "$max_age" -gt 300 ]; then
  emit_failure HEARTBEAT_MAX_AGE_INVALID
fi

if [ -L "$health_dir" ] || [ ! -d "$health_dir" ]; then
  emit_failure HEALTH_DIRECTORY_INVALID
fi
resolved_health_dir=$(readlink -f -- "$health_dir" 2>/dev/null || printf invalid)
if [ "$resolved_health_dir" != "$health_dir" ]; then
  emit_failure HEALTH_DIRECTORY_UNSAFE
fi
current_uid=$(id -u)
health_uid=$(stat -c %u -- "$health_dir" 2>/dev/null || printf invalid)
health_mode=$(stat -c %a -- "$health_dir" 2>/dev/null || printf invalid)
if [ "$health_uid" != "$current_uid" ] || [ "$health_mode" != 700 ]; then
  emit_failure HEALTH_DIRECTORY_UNSAFE
fi

pid_file="$health_dir/worker.pid"
heartbeat_file="$health_dir/heartbeat"
for marker in "$pid_file" "$heartbeat_file"; do
  if [ -L "$marker" ] || [ ! -f "$marker" ]; then
    emit_failure HEALTH_MARKER_INVALID
  fi
  marker_uid=$(stat -c %u -- "$marker" 2>/dev/null || printf invalid)
  marker_mode=$(stat -c %a -- "$marker" 2>/dev/null || printf invalid)
  if [ "$marker_uid" != "$current_uid" ] || [ "$marker_mode" != 600 ]; then
    emit_failure HEALTH_MARKER_UNSAFE
  fi
done

worker_pid=$(sed -n '1p' "$pid_file" 2>/dev/null || printf invalid)
case "$worker_pid" in
  ''|*[!0-9]*) emit_failure WORKER_PID_INVALID ;;
esac
if [ "$worker_pid" -le 1 ] || ! kill -0 "$worker_pid" 2>/dev/null; then
  emit_failure WORKER_PROCESS_UNAVAILABLE
fi

heartbeat_mtime=$(stat -c %Y -- "$heartbeat_file" 2>/dev/null || printf invalid)
case "$heartbeat_mtime" in
  ''|*[!0-9]*) emit_failure HEARTBEAT_INVALID ;;
esac
now=$(date +%s)
heartbeat_age=$((now - heartbeat_mtime))
if [ "$heartbeat_age" -lt 0 ]; then heartbeat_age=0; fi
if [ "$heartbeat_age" -gt "$max_age" ]; then
  emit_failure HEARTBEAT_STALE
fi

if ! "$preflight" --check-only; then
  emit_failure LANGUAGE_DATA_UNAVAILABLE
fi

printf '%s\n' \
  "receipt_worker_readiness status=ok process=ok language=ok heartbeat_age_seconds=$heartbeat_age code=NONE"
