#!/usr/bin/env bash
# Full recovery rehearsal between two throwaway LOCAL Supabase stacks, with
# synthetic data, each signing tokens with its own key:
#
#   source: migrate, seed (GoTrue users, Storage objects, records), sign every
#           owner in through the FinSight API, back up with backup-db.sh and
#           backup-storage.sh (age-encrypted), drill the dump, destroy it.
#   target: a new stack, restore-supabase.sh, recreate buckets, restore the
#           objects, start the API on it, and run verify-app.mjs: sign-in,
#           ownership isolation, signed URLs, deny-all Data API, writes,
#           logout, and what the source's tokens can still do.
#
#   bash deploy/rehearsal/run-local-supabase.sh
#
# Needs Docker, age, Node 22 with `npm ci` and `npx prisma generate` run in
# backend/, and network access for `npx supabase@2.122.0` and its images. Uses
# ports 54730-54732 (source), 54740-54742 (target: another host, so image URLs
# must be rewritten) and 4731, and project ids finsight-rr-{src,dst}-<pid>.
# Touches nothing else: no .env file, no hosted project. Everything it starts
# is removed on exit, however it ends. RR_EVIDENCE_DIR=<dir> keeps the
# non-secret results (timings, check output). This is NOT a hosted rehearsal.
#
# RR_TARGET=hosted restores into a disposable HOSTED project instead (the
# source is still a local stack with synthetic data). It needs, in the
# environment and never on the command line:
#   RR_HOSTED_REF                   the project's 20-letter ref
#   RR_HOSTED_CONFIRM_DISPOSABLE    the same ref: the owner says it may be wiped
#   RR_HOSTED_DB_URL                exactly one of (password percent-encoded)
#     postgresql://postgres.<ref>:<pw>@aws-N-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full
#     postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres?sslmode=verify-full
#   RR_HOSTED_ANON_KEY, RR_HOSTED_SERVICE_ROLE_KEY
#   RR_HOSTED_S3_ACCESS_KEY_ID, RR_HOSTED_S3_SECRET_ACCESS_KEY, RR_HOSTED_S3_REGION
#                                   (objects go to https://<ref>.supabase.co/storage/v1/s3 only)
#   RR_HOSTED_CA_CERT               the project's CA certificate (Database settings, SSL).
#                                   Every database connection verifies the server
#                                   certificate and host name against it: libpq with
#                                   verify-full, Prisma with sslcert + sslaccept=strict.
#   [RR_HOSTED_ALLOW_WRITES]        the ref again; without it the run stops after
#                                   the read-only preflight of the target
# It refuses a ref or URL naming a project in this checkout's .env files. It
# does not delete the hosted project or its data afterwards: that is the owner's.
# RR_CHECK_ONLY=1 validates the inputs and exits before any network access or
# Docker call; deploy/rehearsal/verify-hosted-guard.sh tests the guard that way.
set -euo pipefail
# Regex ranges such as [a-z] mean ASCII only in the C locale.
export LC_ALL=C

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
readonly SUPABASE_CLI=supabase@2.122.0
readonly EXCLUDE=studio,realtime,edge-runtime,logflare,vector,imgproxy,mailpit,postgres-meta,supavisor
API_PORT=4731 DB_PORT=54732 SB_PORT=54731
readonly SRC="finsight-rr-src-$$" DST="finsight-rr-dst-$$" TARGET=${RR_TARGET:-local}
readonly PG_IMAGE=postgres:17-alpine AWS_IMAGE=amazon/aws-cli:2.17.0

log() { echo "rehearsal: $*"; }
fail() { echo "rehearsal: FAIL: $*" >&2; exit 1; }
# Native tools (docker, node, age) on Windows need C:/ paths; tar then needs
# --force-local so the colon is not read as a remote host.
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
supabase() { npx -y "$SUPABASE_CLI" "$@"; }

# On Windows the backup scripts also run with MSYS_NO_PATHCONV=1: Git Bash
# would otherwise rewrite backup-storage.sh's `docker -v C:/...:/out`.
work=$(native "$(mktemp -d)")
chmod 700 "$work"
export TAR_OPTIONS=--force-local
started_stacks=()
# shellcheck source=deploy/rehearsal/api-process.sh
. "$here/api-process.sh"
cleanup() {
  api_stop
  for id in "${started_stacks[@]}"; do
    (cd "$work/$id" && supabase stop --no-backup --project-id "$id" >/dev/null 2>&1) || true
  done
  rm -rf -- "$work"
  [ -z "${lock:-}" ] || rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

timings="$work/timings.txt"
step_start=0
begin() { step_start=$(date +%s); log "$1"; step_name=$1; }
end() { printf '%-48s %4ss\n' "$step_name" "$(( $(date +%s) - step_start ))" >> "$timings"; }

# --- Preflight: refuse rather than half-run.
[ "$(node -p 'process.versions.node.split(".")[0]')" = 22 ] || fail "needs Node 22 on PATH (found $(node -v))"
# shellcheck source=deploy/pg-credentials.sh
. "$repo/deploy/pg-credentials.sh"
# The target guard comes first: nothing above or in it touches the network.
case "$TARGET" in
  local) ;;
  hosted)
    ref=${RR_HOSTED_REF:-}
    [[ $ref =~ ^[a-z]{20}$ ]] || fail "RR_HOSTED_REF must be the disposable project's 20-letter ref"
    [ "${RR_HOSTED_CONFIRM_DISPOSABLE:-}" = "$ref" ] || fail "set RR_HOSTED_CONFIRM_DISPOSABLE to the ref to confirm the owner designated $ref disposable"
    [ -z "${RR_HOSTED_ALLOW_WRITES:-}" ] || [ "$RR_HOSTED_ALLOW_WRITES" = "$ref" ] || fail "RR_HOSTED_ALLOW_WRITES is set but is not $ref"
    for f in .env backend/.env web/.env mobile/.env; do
      if [ -f "$repo/$f" ] && grep -q "$ref" "$repo/$f"; then fail "$ref appears in $f: that is a project in use, not a disposable one"; fi
    done
    # Refs of the projects this checkout uses, kept in memory and never printed.
    live_refs=$(for f in .env backend/.env web/.env mobile/.env; do
                  [ ! -f "$repo/$f" ] || grep -ohE '(//|db\.|postgres\.)[a-z]{20}' "$repo/$f" || true
                done | grep -oE '[a-z]{20}$' | sort -u || true)
    for v in RR_HOSTED_DB_URL RR_HOSTED_ANON_KEY RR_HOSTED_SERVICE_ROLE_KEY RR_HOSTED_S3_ACCESS_KEY_ID RR_HOSTED_S3_SECRET_ACCESS_KEY RR_HOSTED_S3_REGION; do
      [ -n "${!v:-}" ] || fail "set $v in the environment"
    done
    for r in $live_refs; do [[ $RR_HOSTED_DB_URL != *"$r"* ]] || fail "RR_HOSTED_DB_URL names a project from this checkout's .env files"; done
    # Parsed, not substring-matched: the ref must be the user or host, not
    # merely appear in a password, a query or a look-alike host.
    db_url=$(pg_split_url "$RR_HOSTED_DB_URL" && printf '%s' "$PG_URL") || fail "RR_HOSTED_DB_URL is malformed (above)"
    [[ $db_url =~ ^postgres(ql)?://([^@/?:]+)@([^@/?:,]+):5432/postgres\?sslmode=verify-full$ ]] \
      || fail "RR_HOSTED_DB_URL must be postgresql://<user>:<password>@<host>:5432/postgres?sslmode=verify-full, with nothing else"
    db_user=${BASH_REMATCH[2]} db_host=${BASH_REMATCH[3]}
    if ! { [ "$db_user" = "postgres.$ref" ] && [[ $db_host =~ ^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$ ]]; } \
       && ! { [ "$db_user" = postgres ] && [ "$db_host" = "db.$ref.supabase.co" ]; }; then
      fail "RR_HOSTED_DB_URL is not $ref's session pooler (user postgres.$ref at aws-N-<region>.pooler.supabase.com) or direct host (db.$ref.supabase.co)"
    fi
    # Prisma (the API) parses URLs by WHATWG rules, libpq by its own: an
    # unencoded ? # @ in the password could give them different hosts. Both
    # must read the same user, password, host and database. Values by env only.
    ( pg_split_url "$RR_HOSTED_DB_URL" > /dev/null 2>&1
      U=$RR_HOSTED_DB_URL P=${PGPASSWORD:-} H="$db_host:5432" N=$db_user node -e '
        let u; try { u = new URL(process.env.U); } catch { process.exit(1); }
        const same = u.host === process.env.H && decodeURIComponent(u.username) === process.env.N
          && decodeURIComponent(u.password) === process.env.P && u.pathname === "/postgres"
          && u.search === "?sslmode=verify-full" && u.hash === "";
        process.exit(same ? 0 : 1);' ) \
      || fail "RR_HOSTED_DB_URL reads differently to Prisma than to libpq: percent-encode any ? # @ / [ ] in the password"
    # The S3 keys write to whichever project the endpoint names.
    s3_endpoint=https://$ref.supabase.co/storage/v1/s3
    [ "${RR_HOSTED_S3_ENDPOINT:-$s3_endpoint}" = "$s3_endpoint" ] || fail "RR_HOSTED_S3_ENDPOINT must be $s3_endpoint"
    # No CA, no run: never encrypted-but-unverified. Parsed here, offline.
    [ -n "${RR_HOSTED_CA_CERT:-}" ] || fail "set RR_HOSTED_CA_CERT to the project's CA certificate: every hosted connection verifies the server"
    [ -f "$RR_HOSTED_CA_CERT" ] || fail "no CA certificate at RR_HOSTED_CA_CERT"
    CA_FILE=$(native "$RR_HOSTED_CA_CERT") node -e '
      const { X509Certificate } = require("crypto");
      const pems = require("fs").readFileSync(process.env.CA_FILE, "utf8").match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? [];
      if (!pems.length) process.exit(1);
      for (const pem of pems) { const c = new X509Certificate(pem); if (!c.ca || Date.parse(c.validTo) < Date.now()) process.exit(1); }' 2> /dev/null \
      || fail "RR_HOSTED_CA_CERT is not a PEM file of current CA certificates"
    # One copy at a path without spaces: Prisma reads it from its URL.
    cp "$RR_HOSTED_CA_CERT" "$work/target-ca.crt"
    # Keys reach node by environment, not argv. Legacy JWT keys carry their
    # project's ref and role; the newer sb_ keys say their kind in the prefix.
    for pair in RR_HOSTED_ANON_KEY:anon:sb_secret_ RR_HOSTED_SERVICE_ROLE_KEY:service_role:sb_publishable_; do
      IFS=: read -r v role wrong <<< "$pair"
      [[ ${!v} =~ ^[A-Za-z0-9._-]+$ ]] || fail "$v has characters no Supabase key has"
      [[ ${!v} != "$wrong"* ]] || fail "$v is a ${wrong%_} key, not the $role key"
      IFS='|' read -r key_ref key_role < <(K=${!v} node -e '
        const p = process.env.K.split("."); let c = {};
        try { if (p.length === 3) c = JSON.parse(Buffer.from(p[1], "base64url")); } catch {}
        console.log(`${c.ref ?? ""}|${c.role ?? ""}`);')
      [ -z "$key_ref" ] || [ "$key_ref" = "$ref" ] || fail "$v belongs to another project"
      [ -z "$key_role" ] || [ "$key_role" = "$role" ] || fail "$v is the $key_role key, not the $role key"
    done ;;
  *) fail "RR_TARGET is local or hosted" ;;
esac
if [ "${RR_CHECK_ONLY:-}" = 1 ]; then log "inputs pass the guard (RR_CHECK_ONLY=1: stopping before any network access)"; exit 0; fi
[ -d "$repo/backend/node_modules/.prisma/client" ] || fail "run npm ci and npx prisma generate in backend/ first"
for tool in docker age age-keygen curl tsort; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
# One rehearsal at a time: two would pass the port check below together.
mkdir "${TMPDIR:-/tmp}/finsight-rehearsal.lock" 2>/dev/null \
  || fail "another rehearsal holds ${TMPDIR:-/tmp}/finsight-rehearsal.lock (remove it if none is running)"
lock="${TMPDIR:-/tmp}/finsight-rehearsal.lock"
# A TCP connect, not HTTP: a Postgres already on 54732 would answer neither.
for port in $API_PORT 54730 54731 54732 54740 54741 54742; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then fail "port $port is already in use"; fi
done
# Containers started by the backup and restore scripts reach the stack here.
if docker info --format '{{.OperatingSystem}}' | grep -q 'Docker Desktop'; then dhost=host.docker.internal
else dhost=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'); fi

new_stack() { # new_stack <project id> <port base>: its own signing key and ports, load its settings
  local id=$1 dir="$work/$1"
  SB_PORT=$(( $2 + 1 )) DB_PORT=$(( $2 + 2 ))
  mkdir -p "$dir/supabase"
  sed "s/@PROJECT_ID@/$id/; s/@API_PORT@/$SB_PORT/; s/@DB_PORT@/$DB_PORT/; s/@SHADOW_PORT@/$2/" "$here/config.toml" > "$dir/supabase/config.toml"
  (cd "$work" && supabase gen signing-key --algorithm ES256 2>/dev/null) | { printf '['; cat; printf ']'; } > "$dir/supabase/signing_keys.json"
  started_stacks+=("$id")
  (cd "$dir" && supabase start -x "$EXCLUDE") > "$dir/start.log" 2>&1 || { tail -n 20 "$dir/start.log" >&2; fail "could not start $id"; }
  (cd "$dir" && supabase status -o json 2>/dev/null) | node -e '
    const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const k of ["API_URL", "DB_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "S3_PROTOCOL_ACCESS_KEY_ID", "S3_PROTOCOL_ACCESS_KEY_SECRET", "S3_PROTOCOL_REGION"])
      console.log(`${k}=${JSON.stringify(s[k] ?? "")}`);' > "$dir/stack.env"
  # shellcheck disable=SC1090,SC1091
  set -a; . "$dir/stack.env"; set +a
  [ "$DB_URL" = "postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres" ] || fail "$id is not on the expected port ($DB_URL)"
  docker run --rm "$PG_IMAGE" pg_isready -q -h "$dhost" -p "$DB_PORT" \
    || fail "containers cannot reach the stack at $dhost:$DB_PORT"
}
stop_stack() {
  (cd "$work/$1" && supabase stop --no-backup --project-id "$1" > /dev/null 2>&1) || fail "could not stop $1"
  [ -z "$(docker ps -aq --filter "name=_$1\$")" ] || fail "$1 left containers behind"
}
start_api() { # start_api <name>: the real API on the current stack, from an empty directory
  local run="$work/api-$1"
  mkdir -p "$run"
  local tsx="$repo/backend/node_modules/tsx/dist"
  # Secrets via a private file, not env's argv: on Windows `env` stays alive as
  # the API's parent, its command line readable for as long as the API runs.
  api_secret_file="$run/api.env"   # api_stop deletes it, however the run ends
  ( umask 077; printf '%s="%s"\n' DATABASE_URL "$DB_URL" DIRECT_URL "$DB_URL" SUPABASE_URL "$API_URL" \
      SUPABASE_ANON_KEY "$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY" > "$api_secret_file" )
  local loader; loader=$(node -p 'require("url").pathToFileURL(process.argv[1]).href' "$tsx/loader.mjs")
  api_start "$work/api-$1.log" "$run" env -i PATH="$PATH" SYSTEMROOT="${SYSTEMROOT:-}" TEMP="${TEMP:-/tmp}" TMP="${TMP:-/tmp}" HOME="$run" \
    NODE_ENV=development PORT=$API_PORT \
    node --env-file="$api_secret_file" --require "$tsx/preflight.cjs" --import "$loader" "$repo/backend/src/server.ts"
  for _ in $(seq 1 90); do
    api_alive || break
    curl -s --max-time 2 "http://127.0.0.1:$API_PORT/api/v1/health/ready" | grep -q '"ready"' && break
    sleep 1
  done
  rm -f "$api_secret_file"   # read at startup; the keys need not stay on disk
  api_alive && grep -q 'database migrations verified' "$work/api-$1.log" \
    || { tail -n 20 "$work/api-$1.log" >&2; fail "the API did not start on $1$(api_alive || echo ' (it exited)')"; }
}

# --- Source.
begin "source: start stack"; new_stack "$SRC" 54730; end
src_origin=$API_URL
begin "source: apply migrations"
(cd "$work" && DATABASE_URL="$DB_URL" DIRECT_URL="$DB_URL" node "$repo/backend/node_modules/prisma/build/index.js" \
  migrate deploy --schema "$repo/backend/prisma/schema.prisma") > "$work/migrate.log" 2>&1 \
  || { tail -n 20 "$work/migrate.log" >&2; fail "migrations failed"; }
end
begin "source: seed"
(cd "$work" && DATABASE_URL="$DB_URL" SUPABASE_URL="$API_URL" SERVICE_KEY="$SERVICE_ROLE_KEY" node "$here/seed.mjs" "$work/manifest.json") | tee "$work/fixture.json"
end
begin "source: sign owners in"
start_api source
(cd "$work" && API_PORT=$API_PORT node "$here/source-tokens.mjs" "$work/manifest.json" "$work/source-tokens.json")
api_stop
end

begin "source: back up (backup-db.sh, backup-storage.sh)"
mkdir -p "$work/vm/deploy" "$work/vm/backend" "$work/backups"
cp "$repo/deploy/backup-db.sh" "$repo/deploy/backup-storage.sh" "$repo/deploy/pg-credentials.sh" "$repo/deploy/restore-drill.sh" "$work/vm/deploy/"
age-keygen -o "$work/key.txt" 2>/dev/null
echo "DIRECT_URL=postgresql://postgres:postgres@$dhost:$DB_PORT/postgres" > "$work/vm/backend/.env"
cat > "$work/vm/.env" <<EOF
BACKUP_AGE_RECIPIENT=$(grep -o 'age1[a-z0-9]*' "$work/key.txt")
STORAGE_BACKUP_S3_ENDPOINT=http://$dhost:$SB_PORT/storage/v1/s3
STORAGE_BACKUP_S3_REGION=$S3_PROTOCOL_REGION
STORAGE_BACKUP_ACCESS_KEY_ID=$S3_PROTOCOL_ACCESS_KEY_ID
STORAGE_BACKUP_SECRET_ACCESS_KEY=$S3_PROTOCOL_ACCESS_KEY_SECRET
EOF
# The local source database has no TLS.
MSYS_NO_PATHCONV=1 BACKUP_ALLOW_UNVERIFIED=1 BACKUP_DIR="$work/backups" bash "$work/vm/deploy/backup-db.sh" > "$work/backup-db.log" 2>&1 || { cat "$work/backup-db.log" >&2; fail "backup-db.sh failed"; }
MSYS_NO_PATHCONV=1 BACKUP_DIR="$work/backups" bash "$work/vm/deploy/backup-storage.sh" > "$work/backup-storage.log" 2>&1 || { cat "$work/backup-storage.log" >&2; fail "backup-storage.sh failed"; }
dump=$(ls "$work"/backups/finsight-2*.dump.age); archive=$(ls "$work"/backups/finsight-storage-*.tar.age)
ls -l "$dump" "$archive" | awk '{print $5, $NF}' | sed "s#$work/##" >> "$work/fixture.json"
end
begin "source: restore-drill.sh"
BACKUP_AGE_IDENTITY="$work/key.txt" BACKUP_DIR="$work/backups" bash "$work/vm/deploy/restore-drill.sh" "$dump" > "$work/drill.log" 2>&1 \
  || { cat "$work/drill.log" >&2; fail "the drill failed"; }
end
begin "source: destroy"; stop_stack "$SRC"; end

# --- Target: a different project with a different signing key and host.
if [ "$TARGET" = local ]; then
  begin "target: start stack (new signing key, new host)"; new_stack "$DST" 54740; end
  target_url="postgresql://postgres:postgres@$dhost:$DB_PORT/postgres"   # as containers reach it
  expect_target="127.0.0.1:$DB_PORT" s3_endpoint="http://$dhost:$SB_PORT/storage/v1/s3"
else
  # libpq clients take the URL as given (verify-full) plus the CA; Prisma (the
  # API, verify-app.mjs) needs its own parameters to verify at all.
  target_url=$RR_HOSTED_DB_URL target_ca="$work/target-ca.crt" expect_target="$db_host:5432"
  API_URL="https://$ref.supabase.co" DB_URL=$(pg_prisma_tls_url "$RR_HOSTED_DB_URL" "$target_ca") || fail "no Prisma URL for the target"
  H=$expect_target U=$DB_URL node -e 'process.exit(new URL(process.env.U).host === process.env.H ? 0 : 1)' \
    || fail "the Prisma URL does not name the guarded host $expect_target"
  ANON_KEY=$RR_HOSTED_ANON_KEY SERVICE_ROLE_KEY=$RR_HOSTED_SERVICE_ROLE_KEY
  S3_PROTOCOL_ACCESS_KEY_ID=$RR_HOSTED_S3_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET=$RR_HOSTED_S3_SECRET_ACCESS_KEY
  S3_PROTOCOL_REGION=$RR_HOSTED_S3_REGION   # s3_endpoint: set by the guard
fi
# Every query of the target from here on: through a container, password by name.
target_sql() {
  ( pg_split_url "$target_url" || exit 1
    PG_TLS=(); if [ -n "${target_ca:-}" ]; then pg_verify_tls "$target_ca" || exit 1; fi
    MSYS_NO_PATHCONV=1 docker run --rm -i -e PGPASSWORD "${PG_TLS[@]}" "$PG_IMAGE" psql -X -v ON_ERROR_STOP=1 -qtA -F ' ' -d "$PG_URL" "$@" )
}

begin "target: read-only preflight"
pf=0
TARGET_DB_URL=$target_url TARGET_API_URL=$API_URL TARGET_ANON_KEY=$ANON_KEY TARGET_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  TARGET_CA_CERT=${target_ca:-} TARGET_REQUIRE_TLS=$([ "$TARGET" = hosted ] && echo 1 || echo 0) \
  bash "$here/target-preflight.sh" > "$work/preflight.txt" 2>&1 || pf=$?
cat "$work/preflight.txt"
end
if [ "$pf" != 0 ]; then
  [ -z "${RR_EVIDENCE_DIR:-}" ] || { mkdir -p "$RR_EVIDENCE_DIR"; cp "$work/preflight.txt" "$RR_EVIDENCE_DIR/"; }
  fail "the target is not ready (preflight above); nothing was written to it"
fi
if [ "$TARGET" = hosted ] && [ "${RR_HOSTED_ALLOW_WRITES:-}" != "$ref" ]; then
  [ -z "${RR_EVIDENCE_DIR:-}" ] || { mkdir -p "$RR_EVIDENCE_DIR"; cp "$work/preflight.txt" "$RR_EVIDENCE_DIR/"; }
  log "preflight only: set RR_HOSTED_ALLOW_WRITES=$ref to restore into it. Nothing was written to it."
  exit 0
fi

begin "target: restore-supabase.sh"
# The local target is a throwaway stack reached by IP; the hosted one always has its CA.
RESTORE_ALLOW_UNVERIFIED=$([ "$TARGET" = local ] && echo 1 || true) \
RESTORE_DATABASE_URL=$target_url RESTORE_CA_CERT=${target_ca:-} BACKUP_AGE_IDENTITY="$work/key.txt" \
  bash "$repo/deploy/restore-supabase.sh" "$dump" > "$work/restore.log" 2>&1 || { cat "$work/restore.log" >&2; fail "restore-supabase.sh failed"; }
end
begin "target: image URLs to the new host (deploy/rewrite-public-image-urls.sql)"
target_sql -v old_origin="$src_origin" -v new_origin="$API_URL" < "$repo/deploy/rewrite-public-image-urls.sql" | tee "$work/rewrite.txt"
grep -qx 'image URLs not on the new host: 0' "$work/rewrite.txt" || fail "image URLs still point at the old host"
end
begin "target: buckets and objects"
for b in 'receipts false 10485760 ["image/jpeg","image/png","image/webp"]' 'csv-imports false 5242880 ["text/csv"]' 'avatars true null null'; do
  set -- $b
  # The key goes to curl on stdin (-K -), not on its command line.
  printf 'header = "apikey: %s"\nheader = "authorization: Bearer %s"\n' "$SERVICE_ROLE_KEY" "$SERVICE_ROLE_KEY" \
  | curl -sf -K - -o /dev/null -X POST "$API_URL/storage/v1/bucket" -H 'content-type: application/json' -d "{\"id\":\"$1\",\"name\":\"$1\",\"public\":$2,\"file_size_limit\":$3,\"allowed_mime_types\":$4}" \
    || fail "could not create bucket $1"
done
mkdir -p "$work/storage-restore"
age --decrypt --identity "$work/key.txt" "$archive" | tar -x -C "$work/storage-restore"
for b in receipts csv-imports avatars; do
  # Keys by name only, so they are in no command line.
  AWS_ACCESS_KEY_ID=$S3_PROTOCOL_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$S3_PROTOCOL_ACCESS_KEY_SECRET AWS_DEFAULT_REGION=$S3_PROTOCOL_REGION \
  MSYS_NO_PATHCONV=1 docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -v "$work/storage-restore:/in:ro" "$AWS_IMAGE" \
    s3 sync "/in/$b" "s3://$b" --endpoint-url "$s3_endpoint" --only-show-errors || fail "sync of $b failed"
done
rm -rf -- "$work/storage-restore"
node -e 'for (const o of require(process.argv[1]).objects) console.log(o.bucket, o.key, o.size)' "$work/manifest.json" | sort > "$work/objects.want"
target_sql -c "SELECT bucket_id, name, metadata->>'size' FROM storage.objects" | sort > "$work/objects.got"
diff -q "$work/objects.want" "$work/objects.got" > /dev/null || fail "restored objects differ from the source: $(diff "$work/objects.want" "$work/objects.got" | head -n 5)"
missing=$(target_sql -c "
  WITH r AS (SELECT 'receipts' b, \"ReceiptScan_ImageFile\" k FROM \"ReceiptScan\" WHERE \"ReceiptScan_ImageFile\" IS NOT NULL
             UNION ALL SELECT 'receipts', \"ReceiptScanPage_ImageFile\" FROM \"ReceiptScanPage\"
             UNION ALL SELECT 'csv-imports', \"ImportBatch_FileReference\" FROM \"CSVImportBatch\" WHERE \"ImportBatch_FileReference\" IS NOT NULL)
  SELECT count(*) FROM r WHERE NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = r.b AND o.name = r.k)")
[ "$missing" = 0 ] || fail "$missing database references point at no restored object"
log "  $(wc -l < "$work/objects.got" | tr -d ' ') objects match the source; every database reference resolves"
end

begin "target: API checks (verify-app.mjs)"
start_api target
status=0
(cd "$work" && DATABASE_URL="$DB_URL" SUPABASE_URL="$API_URL" ANON_KEY="$ANON_KEY" API_PORT=$API_PORT RR_EXPECT_TARGET="$expect_target" \
  node "$here/verify-app.mjs" "$work/manifest.json" "$work/source-tokens.json") > "$work/verify-app.txt" 2>&1 || status=$?
api_stop
end
cat "$work/verify-app.txt"
log "timings:"; cat "$timings"
if [ -n "${RR_EVIDENCE_DIR:-}" ]; then
  mkdir -p "$RR_EVIDENCE_DIR"
  cp "$work/verify-app.txt" "$work/timings.txt" "$work/fixture.json" "$work/preflight.txt" "$work/rewrite.txt" "$RR_EVIDENCE_DIR/"
  grep -v '^  ' "$work/restore.log" > "$RR_EVIDENCE_DIR/restore.log" || true
  cp "$work/drill.log" "$RR_EVIDENCE_DIR/" 2>/dev/null || true
  log "evidence in $RR_EVIDENCE_DIR"
fi
[ "$status" = 0 ] || fail "verify-app.mjs reported failures (above)"
if [ "$TARGET" = local ]; then log "OK (local stacks and synthetic data: not evidence about a hosted project)"
else log "OK (hosted target $ref, synthetic data; the project and its data are left for the owner to delete)"; fi
