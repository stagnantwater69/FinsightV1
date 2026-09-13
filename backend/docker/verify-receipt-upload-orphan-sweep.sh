#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
drill_parent=$(mktemp -d /tmp/finsight-upload-sweep.XXXXXX)
drill_root="$drill_parent/finsight/receipt-uploads"
unsafe_root="$drill_parent/private-app-data"
real_alias_parent="$drill_parent/real-alias-parent"
alias_parent="$drill_parent/alias-parent"
alias_root="$alias_parent/finsight-receipt-uploads"

cleanup() {
  chmod -R u+w -- "$drill_parent" 2>/dev/null || true
  rm -rf -- "$drill_parent"
}
trap cleanup EXIT INT TERM HUP

mkdir -m 700 -- "$drill_parent/finsight" "$drill_root" "$unsafe_root" "$real_alias_parent"
mkdir -m 700 -- \
  "$drill_root/finsight-receipt-ACT123" \
  "$drill_root/finsight-receipt-OLD123" \
  "$drill_root/protected" \
  "$unsafe_root/finsight-receipt-OLD999" \
  "$real_alias_parent/finsight-receipt-uploads"
printf '%s\n' active > "$drill_root/finsight-receipt-ACT123/.active"
printf '%s\n' active > "$drill_root/finsight-receipt-OLD123/.active"
printf '%s\n' keep > "$drill_root/protected/evidence"
printf '%s\n' keep > "$unsafe_root/finsight-receipt-OLD999/evidence"
printf '%s\n' keep > "$real_alias_parent/finsight-receipt-uploads/evidence"
chmod 600 -- \
  "$drill_root"/finsight-receipt-*/.active \
  "$drill_root/protected/evidence" \
  "$unsafe_root/finsight-receipt-OLD999/evidence" \
  "$real_alias_parent/finsight-receipt-uploads/evidence"
ln -s -- "$drill_root/protected" "$drill_root/finsight-receipt-BAD123"
ln -s -- "$real_alias_parent" "$alias_parent"

DRILL_ROOT="$drill_root" UNSAFE_ROOT="$unsafe_root" node <<'NODE'
const fs = require("node:fs");
const root = process.env.DRILL_ROOT;
const unsafeRoot = process.env.UNSAFE_ROOT;
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
fs.utimesSync(`${root}/finsight-receipt-ACT123`, old, old);
fs.utimesSync(`${root}/finsight-receipt-OLD123`, old, old);
fs.utimesSync(`${root}/finsight-receipt-OLD123/.active`, old, old);
fs.utimesSync(`${unsafeRoot}/finsight-receipt-OLD999`, old, old);
NODE

set +e
unsafe_output=$(RECEIPT_UPLOAD_TEMP_ROOT="$unsafe_root" \
  "$script_dir/receipt-upload-orphan-sweep.sh" --once 2>&1)
unsafe_status=$?
set -e
[ "$unsafe_status" -eq 78 ]
case "$unsafe_output" in
  *"status=invalid-root"*) ;;
  *) exit 1 ;;
esac
[ -f "$unsafe_root/finsight-receipt-OLD999/evidence" ]

set +e
normalized_output=$(RECEIPT_UPLOAD_TEMP_ROOT="$drill_parent/finsight/./receipt-uploads" \
  "$script_dir/receipt-upload-orphan-sweep.sh" --once 2>&1)
normalized_status=$?
set -e
[ "$normalized_status" -eq 78 ]
case "$normalized_output" in
  *"status=invalid-root"*) ;;
  *) exit 1 ;;
esac
[ -d "$drill_root/finsight-receipt-OLD123" ]

set +e
alias_output=$(RECEIPT_UPLOAD_TEMP_ROOT="$alias_root" \
  "$script_dir/receipt-upload-orphan-sweep.sh" --once 2>&1)
alias_status=$?
set -e
[ "$alias_status" -eq 78 ]
case "$alias_output" in
  *"status=invalid-root"*) ;;
  *) exit 1 ;;
esac
[ -f "$real_alias_parent/finsight-receipt-uploads/evidence" ]

first=$(RECEIPT_UPLOAD_TEMP_ROOT="$drill_root" \
  "$script_dir/receipt-upload-orphan-sweep.sh" --once)
case "$first" in
  *"status=ok"*"scanned=3"*"active=1"*"removed=1"*"invalid=1"*"errors=0"*) ;;
  *) exit 1 ;;
esac
[ -d "$drill_root/finsight-receipt-ACT123" ]
[ ! -e "$drill_root/finsight-receipt-OLD123" ]
[ -f "$drill_root/protected/evidence" ]

second=$(RECEIPT_UPLOAD_TEMP_ROOT="$drill_root" \
  "$script_dir/receipt-upload-orphan-sweep.sh" --once)
case "$second" in
  *"status=ok"*"scanned=2"*"active=1"*"removed=0"*"invalid=1"*"errors=0"*) ;;
  *) exit 1 ;;
esac

printf '%s\n' 'receipt_upload_orphan_drill status=ok active_preserved=1 stale_removed=1 candidate_symlink_followed=0 unsafe_root_rejected=1 nonnormalized_root_rejected=1 parent_symlink_rejected=1'
