#!/bin/sh
set -eu

fail() {
  printf '%s\n' "Tesseract readiness failed: $*" >&2
  exit 78
}

lang_path=${TESSERACT_LANG_PATH:-}
languages=${TESSERACT_LANG:-}

[ -n "$lang_path" ] || fail "TESSERACT_LANG_PATH is not set"
[ -n "$languages" ] || fail "TESSERACT_LANG is not set"
[ -d "$lang_path" ] || fail "language-data directory is missing: $lang_path"
[ -r "$lang_path/SHA256SUMS" ] || fail "checksum manifest is missing: $lang_path/SHA256SUMS"
[ ! -w "$lang_path" ] || fail "language-data directory must be read-only: $lang_path"

case "$languages" in
  +*|*+|*++*|*[!A-Za-z0-9_+]*)
    fail "TESSERACT_LANG must be one or more language codes joined by +"
    ;;
esac

(
  cd "$lang_path"
  sha256sum -c SHA256SUMS >/dev/null
) || fail "packaged language-data checksum verification failed"

for language in $(printf '%s' "$languages" | tr '+' ' '); do
  traineddata="$lang_path/$language.traineddata"
  [ -r "$traineddata" ] || fail "configured language is not packaged: $language"
  [ ! -w "$traineddata" ] || fail "language data must be read-only: $traineddata"
done

if [ "${1:-}" = "--check-only" ]; then
  [ "$#" -eq 1 ] || fail "--check-only accepts no other arguments"
  exit 0
fi

[ "$#" -gt 0 ] || fail "no worker command was supplied"
exec "$@"
