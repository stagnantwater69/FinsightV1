#!/usr/bin/env bash
# Checks that every client the hosted rehearsal points at a database verifies
# the server certificate and host name, on the real code paths:
#   target-preflight.sh and restore-supabase.sh (libpq in a container, via
#   pg_verify_tls), and the API's own Prisma client (backend/src/config/prisma.ts,
#   which re-encodes its URL) and a plain PrismaClient as verify-app.mjs uses,
#   both with the URL pg_prisma_tls_url builds.
# Against one throwaway Postgres serving, in turn, a certificate from the
# trusted test CA, one from an untrusted CA, and a trusted one for another
# host name. Only the first may connect. Also: no CA where one is required
# stops before any connection attempt (the server's log must show none).
# Synthetic, local; needs Docker, openssl and Node 22 with backend/ installed.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# RR_TLS_DEPLOY_DIR=<dir> tests another copy of deploy/ (its scripts and helpers).
deploy=${RR_TLS_DEPLOY_DIR:-$repo/deploy}
# shellcheck source=deploy/pg-credentials.sh
. "$deploy/pg-credentials.sh"
readonly PG_IMAGE=postgres:17-alpine DB="finsight-verify-tls-$$"
readonly SECRET='Tls-p@ss:w0rd' SECRET_ENC='Tls-p%40ss%3Aw0rd'
work=$(mktemp -d)
cleanup() { docker rm -f -v "$DB" > /dev/null 2>&1 || true; rm -rf -- "$work"; }
trap cleanup EXIT
fail() { echo "verify-target-tls: FAIL: $*" >&2; exit 1; }
w=$work; if command -v cygpath > /dev/null; then w=$(cygpath -m "$work"); fi
ossl() { MSYS_NO_PATHCONV=1 openssl "$@" 2> /dev/null; }

docker run -d --name "$DB" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SECRET" "$PG_IMAGE" -c log_connections=on > /dev/null
for _ in $(seq 1 60); do docker exec "$DB" pg_isready -q -U postgres 2> /dev/null && break; sleep 1; done
sleep 2
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DB")
port=$(docker port "$DB" 5432/tcp | head -n1); port=${port##*:}

for ca in ca untrusted-ca; do ossl req -x509 -new -nodes -newkey rsa:2048 -subj "/CN=FinSight $ca" -days 2 -keyout "$w/$ca.key" -out "$w/$ca.crt"; done
cert() { # cert <name> <ca> <subjectAltName>
  ossl req -new -nodes -newkey rsa:2048 -subj "/CN=$1" -keyout "$w/$1.key" -out "$w/$1.csr"
  printf 'subjectAltName=%s\n' "$3" > "$work/$1.ext"
  ossl x509 -req -in "$w/$1.csr" -CA "$w/$2.crt" -CAkey "$w/$2.key" -CAcreateserial -days 2 -extfile "$w/$1.ext" -out "$w/$1.crt"
}
# Containers reach the server at its IP; Prisma (on this host) at 127.0.0.1.
cert good ca "IP:$ip,IP:127.0.0.1"
cert untrusted untrusted-ca "IP:$ip,IP:127.0.0.1"
cert wrong-name ca "DNS:elsewhere.test"
serve() { # serve <cert name>: the server presents it from now on
  docker exec -i "$DB" sh -c 'cat > /var/lib/postgresql/server.crt' < "$work/$1.crt"
  docker exec -i "$DB" sh -c 'umask 077; cat > /var/lib/postgresql/server.key' < "$work/$1.key"
  docker exec "$DB" sh -c 'chown postgres /var/lib/postgresql/server.*'
  docker exec "$DB" psql -qtA -U postgres -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
    -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" -c 'ALTER SYSTEM SET ssl = on' -c 'SELECT pg_reload_conf()' > /dev/null
  sleep 1
}
# A dump restore-supabase.sh accepts, and a target it will refuse only after
# connecting (it has a table), so reaching that refusal proves the connection.
docker exec "$DB" psql -qtA -U postgres -c 'CREATE DATABASE src' -c 'CREATE DATABASE occupied' > /dev/null
docker exec "$DB" psql -qtA -U postgres -d src -c 'CREATE SCHEMA auth' -c 'CREATE TABLE auth.users (id int)' -c 'INSERT INTO auth.users VALUES (1)' -c 'CREATE TABLE public.app (id int)' > /dev/null
docker exec "$DB" psql -qtA -U postgres -d occupied -c 'CREATE SCHEMA auth' -c 'CREATE TABLE auth.users (id int)' -c 'CREATE TABLE t (id int)' > /dev/null
docker exec "$DB" pg_dump -U postgres --format=custom src > "$work/src.dump"

libpq_url="postgresql://postgres:$SECRET_ENC@$ip:5432"
preflight() { TARGET_DB_URL="$libpq_url/postgres" bash "$deploy/rehearsal/target-preflight.sh" > "$work/out" 2>&1; }
restore() { RESTORE_DATABASE_URL="$libpq_url/occupied" bash "$deploy/restore-supabase.sh" "$work/src.dump" > "$work/out" 2>&1; }
prisma_app() { # the API's own client: backend/src/config/prisma.ts
  local url; url=$(pg_prisma_tls_url "postgresql://postgres:$SECRET_ENC@127.0.0.1:$port/postgres" "$w/ca.crt")
  (cd "$work" && DATABASE_URL=$url NODE_ENV=test node --import "$(node -p 'require("url").pathToFileURL(process.argv[1]).href' "$repo/backend/node_modules/tsx/dist/loader.mjs")" \
    -e 'import(require("url").pathToFileURL(process.argv[1]).href).then(async (m) => { const p = m.prisma ?? m.default?.prisma; await p.$queryRawUnsafe("SELECT 1"); console.log("connected"); process.exit(0); }).catch((e) => { console.log("refused: " + String(e.message).split("\n").filter(Boolean).pop()); process.exit(1); })' \
    "$repo/backend/src/config/prisma.ts") > "$work/out" 2>&1
}
prisma_plain() { # a PrismaClient on DATABASE_URL, as verify-app.mjs makes one
  local url; url=$(pg_prisma_tls_url "postgresql://postgres:$SECRET_ENC@127.0.0.1:$port/postgres" "$w/ca.crt")
  (cd "$work" && URL=$url node -e '
    const { PrismaClient } = require(process.argv[1]);
    const p = new PrismaClient({ datasources: { db: { url: process.env.URL } } });
    p.$queryRawUnsafe("SELECT 1").then(() => { console.log("connected"); process.exit(0); }, (e) => { console.log("refused: " + String(e.message).split("\n").filter(Boolean).pop()); process.exit(1); });' \
    "$(cd "$repo/backend/node_modules/@prisma/client" && pwd -W 2> /dev/null || pwd)") > "$work/out" 2>&1
}
ok() { # ok <label> <command...>: must connect
  "${@:2}" || true
  grep -qE "$OK_PATTERN" "$work/out" || { cat "$work/out" >&2; fail "$1 did not connect with a valid certificate"; }
}
refused() { # refused <label> <pattern> <command...>: must fail, naming why
  if "${@:3}"; then cat "$work/out" >&2; fail "$1 connected to a server it must not trust"; fi
  grep -qiE "$2" "$work/out" || { cat "$work/out" >&2; fail "$1 failed, but not on the certificate"; }
}

export TARGET_CA_CERT="$w/ca.crt" RESTORE_CA_CERT="$w/ca.crt"
serve good
OK_PATTERN='verified against ca.crt'; ok preflight preflight
OK_PATTERN='already has tables'; ok restore restore
OK_PATTERN='^connected$'; ok 'Prisma (backend/src/config/prisma.ts)' prisma_app; ok 'Prisma (plain client)' prisma_plain
echo "verify-target-tls: valid certificate: preflight, restore and both Prisma clients connect"

for case in 'untrusted certificate verify failed|not trusted' 'wrong-name does not match|CN name does not match|name mismatch|IP address mismatch'; do
  name=${case%% *} why=${case#* }
  serve "$name"
  refused "preflight ($name)" "$why" preflight
  refused "restore ($name)" "$why" restore
  refused "Prisma app ($name)" "$why" prisma_app
  refused "Prisma plain ($name)" "$why" prisma_plain
  echo "verify-target-tls: $name: all four refused"
done

# Missing or overridden trust configuration: refused before any connection.
serve good
before=$(docker logs "$DB" 2>&1 | grep -c 'connection received' || true)
unset TARGET_CA_CERT RESTORE_CA_CERT
if TARGET_REQUIRE_TLS=1 preflight; then fail "the preflight ran without a CA where TLS is required"; fi
grep -q 'set TARGET_CA_CERT' "$work/out" || { cat "$work/out" >&2; fail "the preflight did not ask for a CA"; }
for url in "$libpq_url/occupied?sslmode=require" "$libpq_url/occupied?sslrootcert=system" "$libpq_url/occupied?gssencmode=require"; do
  if RESTORE_CA_CERT="$w/ca.crt" RESTORE_DATABASE_URL=$url bash "$deploy/restore-supabase.sh" "$work/src.dump" > "$work/out" 2>&1; then fail "restore accepted $url"; fi
  grep -q 'would override certificate verification' "$work/out" || { cat "$work/out" >&2; fail "restore did not refuse an overriding URL"; }
done
if RESTORE_CA_CERT="$w/absent.crt" RESTORE_DATABASE_URL="$libpq_url/occupied" bash "$deploy/restore-supabase.sh" "$work/src.dump" > "$work/out" 2>&1; then fail "restore ran with a missing CA file"; fi
grep -q 'no PEM CA certificate' "$work/out" || { cat "$work/out" >&2; fail "restore did not name the missing CA"; }
after=$(docker logs "$DB" 2>&1 | grep -c 'connection received' || true)
[ "$before" -gt 0 ] || fail "the server logged no connections, so the no-connection check proves nothing"
[ "$before" = "$after" ] || fail "a refused configuration still connected to the server ($before -> $after connections)"
# A remote target with no CA, however it is spelled: refused before Docker or the network.
unset RESTORE_ALLOW_UNVERIFIED
mkdir -p "$work/bin"; printf '#!/bin/sh\necho called >> "%s/docker-called"\nexit 97\n' "$work" > "$work/bin/docker"; chmod +x "$work/bin/docker"
for url in 'postgresql://postgres:x@db.abcdefghijabcdefghij.supabase.co:5432/postgres' \
           'postgresql://postgres:x@DB.ABCDEFGHIJABCDEFGHIJ.SUPABASE.CO:5432/postgres' \
           'postgresql://postgres:x@db.abcdefghijabcdefghij.supabase.co.:5432/postgres' \
           'postgresql://postgres:x@localhost:5432/postgres?host=db.abcdefghijabcdefghij.supabase.co' \
           'postgresql://postgres:x@/postgres?host=db.abcdefghijabcdefghij.supabase.co' \
           'postgresql://postgres:x@localhost:5432/postgres?hostaddr=203.0.113.7' \
           'postgresql://postgres:x@203.0.113.7:5432/postgres' \
           'postgresql://postgres:x@127.a.b.c:5432/postgres' \
           'postgresql://postgres:x@localhost,db.abcdefghijabcdefghij.supabase.co:5432/postgres'; do
  if PATH="$work/bin:$PATH" RESTORE_DATABASE_URL=$url bash "$deploy/restore-supabase.sh" "$work/src.dump" > "$work/out" 2>&1; then fail "restore ran against $url without a CA"; fi
  grep -q 'set RESTORE_CA_CERT' "$work/out" && [ ! -e "$work/docker-called" ] || { cat "$work/out" >&2; fail "restore did not stop before Docker for $url without a CA"; }
done
echo "verify-target-tls: no CA (TLS required or hosted URL), a missing CA file, or a URL that overrides verification: refused, no connection attempted"
echo "verify-target-tls: OK"
