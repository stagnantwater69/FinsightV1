#!/bin/sh
set -eu

default_root=$(node -p 'require("node:path").resolve(require("node:os").tmpdir(), "finsight-receipt-uploads")')
root=${RECEIPT_UPLOAD_TEMP_ROOT:-$default_root}
ttl_seconds=${RECEIPT_UPLOAD_ORPHAN_TTL_SECONDS:-3600}

emit_result() {
  printf '%s\n' \
    "receipt_upload_orphan_sweep status=$1 scanned=$2 fresh=$3 active=$4 removed=$5 invalid=$6 errors=$7 oldest_age_seconds=$8"
}

validate_configuration() {
  case "$root" in
    /*) ;;
    *) emit_result invalid-root 0 0 0 0 0 1 0; return 78 ;;
  esac
  case "$root" in
    /|*/../*|*/..|*/./*|*//*|*/.|*/|*[!A-Za-z0-9_./-]*)
      emit_result invalid-root 0 0 0 0 0 1 0
      return 78
      ;;
  esac
  case "$root" in
    */finsight-receipt-uploads|*/finsight/receipt-uploads) ;;
    *) emit_result invalid-root 0 0 0 0 0 1 0; return 78 ;;
  esac
  case "$ttl_seconds" in
    ''|*[!0-9]*) emit_result invalid-ttl 0 0 0 0 0 1 0; return 78 ;;
  esac
  if [ "$ttl_seconds" -lt 3600 ]; then
    emit_result invalid-ttl 0 0 0 0 0 1 0
    return 78
  fi
}

sweep_once() {
  validate_configuration || return $?

  if [ -L "$root" ]; then
    emit_result invalid-root 0 0 0 0 0 1 0
    return 78
  fi
  if [ ! -e "$root" ]; then
    emit_result root-absent 0 0 0 0 0 0 0
    return 0
  fi
  if [ ! -d "$root" ]; then
    emit_result invalid-root 0 0 0 0 0 1 0
    return 78
  fi

  resolved_root=$(readlink -f -- "$root" 2>/dev/null || printf invalid)
  if [ "$resolved_root" != "$root" ]; then
    emit_result invalid-root 0 0 0 0 0 1 0
    return 78
  fi

  current_uid=$(id -u)
  root_uid=$(stat -c %u -- "$root" 2>/dev/null || printf invalid)
  root_mode=$(stat -c %a -- "$root" 2>/dev/null || printf invalid)
  if [ "$root_uid" != "$current_uid" ] || [ "$root_mode" != 700 ]; then
    emit_result invalid-root 0 0 0 0 0 1 0
    return 78
  fi

  now=$(date +%s)
  scanned=0
  fresh=0
  active=0
  removed=0
  invalid=0
  errors=0
  oldest_age=0

  for candidate in "$root"/finsight-receipt-*; do
    if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
      continue
    fi
    scanned=$((scanned + 1))

    name=${candidate##*/}
    suffix=${name#finsight-receipt-}
    case "$name:$suffix" in
      finsight-receipt-??????:*[!A-Za-z0-9]*) invalid=$((invalid + 1)); continue ;;
      finsight-receipt-??????:*) ;;
      *) invalid=$((invalid + 1)); continue ;;
    esac
    if [ -L "$candidate" ] || [ ! -d "$candidate" ]; then
      invalid=$((invalid + 1))
      continue
    fi

    candidate_uid=$(stat -c %u -- "$candidate" 2>/dev/null || printf invalid)
    candidate_mode=$(stat -c %a -- "$candidate" 2>/dev/null || printf invalid)
    candidate_mtime=$(stat -c %Y -- "$candidate" 2>/dev/null || printf invalid)
    case "$candidate_mtime" in
      ''|*[!0-9]*) invalid=$((invalid + 1)); continue ;;
    esac
    if [ "$candidate_uid" != "$current_uid" ] || [ "$candidate_mode" != 700 ]; then
      invalid=$((invalid + 1))
      continue
    fi

    age=$((now - candidate_mtime))
    if [ "$age" -lt 0 ]; then age=0; fi
    if [ "$age" -gt "$oldest_age" ]; then oldest_age=$age; fi

    marker="$candidate/.active"
    if [ -f "$marker" ] && [ ! -L "$marker" ]; then
      marker_uid=$(stat -c %u -- "$marker" 2>/dev/null || printf invalid)
      marker_mode=$(stat -c %a -- "$marker" 2>/dev/null || printf invalid)
      marker_mtime=$(stat -c %Y -- "$marker" 2>/dev/null || printf invalid)
      case "$marker_mtime" in
        ''|*[!0-9]*) marker_mtime=0 ;;
      esac
      marker_age=$((now - marker_mtime))
      if [ "$marker_age" -lt 0 ]; then marker_age=0; fi
      if [ "$marker_uid" = "$current_uid" ] && [ "$marker_mode" = 600 ] && [ "$marker_age" -lt "$ttl_seconds" ]; then
        active=$((active + 1))
        continue
      fi
    fi

    if [ "$age" -lt "$ttl_seconds" ]; then
      fresh=$((fresh + 1))
      continue
    fi

    if [ -d "$candidate" ] && [ ! -L "$candidate" ] && rm -rf -- "$candidate" 2>/dev/null; then
      removed=$((removed + 1))
    else
      errors=$((errors + 1))
    fi
  done

  status=ok
  if [ "$errors" -gt 0 ]; then status=partial; fi
  emit_result "$status" "$scanned" "$fresh" "$active" "$removed" "$invalid" "$errors" "$oldest_age"
  [ "$errors" -eq 0 ]
}

case "${1:---once}" in
  --once)
    sweep_once
    ;;
  --loop)
    while :; do
      sleep 3600
      sweep_once || true
    done
    ;;
  *)
    emit_result invalid-command 0 0 0 0 0 1 0
    exit 64
    ;;
esac
