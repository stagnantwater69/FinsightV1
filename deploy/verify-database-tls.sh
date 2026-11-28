#!/usr/bin/env bash
# Checks that the backend's database clients verify the server: the API's
# Prisma client (dist/config/prisma.js, with its URL rewriting), the Prisma CLI
# (`migrate status`, as deploy.sh runs it, and the migrate service's check),
# and backup-db.sh's pg_dump. A disposable Postgres on a private Docker network
# serves, in turn, a certificate from the trusted CA, one from another CA, one
# for another host name, and no TLS at all. The clients run in the backend's
# build-stage image (Linux, OpenSSL), with the CA at /app/certs as in
# docker-compose.yml. Test certificates only; nothing leaves this machine.
#
#   docker build --target build -t <tag> backend
#   TLS_CLIENT_IMAGE=<tag> bash deploy/verify-database-tls.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
IMG=${TLS_CLIENT_IMAGE:?set TLS_CLIENT_IMAGE to an image built with: docker build --target build backend}
readonly PG_IMAGE=postgres:17-alpine HOST=db.finsight-tls.test
readonly TAG="finsight-dbtls-$$-$RANDOM"
work=$(mktemp -d)
cleanup() {
  docker rm -f -v "$TAG-db" > /dev/null 2>&1 || true
  docker network rm "$TAG" > /dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
fail() { echo "verify-database-tls: $*" >&2; exit 1; }
export MSYS_NO_PATHCONV=1
native() { if command -v cygpath > /dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
w=$(native "$work")

# Test PKI: a CA, a second CA nobody trusts, and server certificates.
ossl() { openssl "$@" 2> /dev/null; }
for ca in ca otherca; do
  ossl req -x509 -new -nodes -newkey rsa:2048 -subj "/CN=verify-database-tls $ca" -days 2 -keyout "$w/$ca.key" -out "$w/$ca.crt"
done
cert() { # name, signing CA, subjectAltName
  ossl req -new -nodes -newkey rsa:2048 -subj "/CN=$1" -keyout "$w/$1.key" -out "$w/$1.csr"
  printf 'subjectAltName=%s\n' "$3" > "$work/$1.ext"
  ossl x509 -req -in "$w/$1.csr" -CA "$w/$2.crt" -CAkey "$w/$2.key" -CAcreateserial -days 2 -extfile "$w/$1.ext" -out "$w/$1.crt"
}
cert good ca "DNS:$HOST"
cert untrusted otherca "DNS:$HOST"
cert wrongname ca "DNS:elsewhere.finsight-tls.test"
# The CA file as an operator would hold it, and bundles of it with the other
# CA in either order (as a CA rotation might tempt).
mkdir -p "$work/certs"
cp "$work/ca.crt" "$work/certs/db-ca.crt"
# Only a decoder finds this one: "db+ca.crt" read as a form-encoded name.
cp "$work/ca.crt" "$work/certs/db ca.crt"
cat "$work/ca.crt" "$work/otherca.crt" > "$work/certs/bundle-ca-first.crt"
cat "$work/otherca.crt" "$work/ca.crt" > "$work/certs/bundle-ca-last.crt"
chmod 644 "$work"/certs/*

docker network create "$TAG" > /dev/null
docker run -d --name "$TAG-db" --network "$TAG" --network-alias "$HOST" -e POSTGRES_PASSWORD=verify-pw "$PG_IMAGE" > /dev/null
for _ in $(seq 60); do docker exec "$TAG-db" pg_isready -q -U postgres 2> /dev/null && break; sleep 1; done
sleep 2
psql_db() { docker exec "$TAG-db" psql -qtAX -U postgres "$@"; }
serve() {
  if [ "$1" = off ]; then
    psql_db -c 'ALTER SYSTEM SET ssl = off' -c 'SELECT pg_reload_conf()' > /dev/null
  else
    docker exec -i "$TAG-db" sh -c 'cat > /var/lib/postgresql/server.crt' < "$work/$1.crt"
    docker exec -i "$TAG-db" sh -c 'umask 077; cat > /var/lib/postgresql/server.key' < "$work/$1.key"
    docker exec "$TAG-db" chown postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key
    psql_db -c "ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'" \
      -c "ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'" -c 'ALTER SYSTEM SET ssl = on' -c 'SELECT pg_reload_conf()' > /dev/null
  fi
  sleep 1
  [ "$(psql_db -c 'SHOW ssl')" = "$([ "$1" = off ] && echo off || echo on)" ] || fail "the server did not switch to $1"
}
connections() { psql_db -c "SELECT count(*) FROM pg_stat_activity WHERE usename = 'postgres' AND backend_type = 'client backend' AND pid <> pg_backend_pid()"; }
# Each client's outcome as a word: connected, refused (by the TLS handshake or
# the server) or blocked (by FinSight's own check, before any connection).
client() { # url, command...
  local url=$1; shift
  docker run --rm --network "$TAG" -v "$w/certs:/app/certs:ro" -e "DATABASE_URL=$url" -e "DIRECT_URL=$url" \
    -e NODE_ENV=production -e LOG_LEVEL=silent "$IMG" "$@" 2>&1 | tail -n 1
}
runtime() {
  client "$1" node -e '
    let prisma;
    try { ({ prisma } = require("/app/dist/config/prisma.js")); } catch (e) { console.log(e.message.startsWith("DATABASE_URL ") && e.message.endsWith("(database TLS).") ? "blocked" : "error"); process.exit(0); }
    prisma.$queryRawUnsafe("SELECT 1").then(() => console.log("connected"), () => console.log("refused")).finally(() => process.exit(0));'
}
migrate() { # `migrate status` exits 0 or 1 (pending migrations) once connected
  client "$1" sh -c 'out=$(npx prisma migrate status 2>&1); case $out in *"not yet been applied"*|*"up to date"*|*"No migration found"*) echo connected ;; *) echo refused ;; esac'
}
migrate_service() { # the migrate service's command, with `status` for `deploy`
  client "$1" sh -c 'node dist/config/databaseTls.js DIRECT_URL 2>&1 | grep -q "^DIRECT_URL .*(database TLS)\.$" && { echo blocked; exit 0; }; out=$(npx prisma migrate status 2>&1); case $out in *"not yet been applied"*|*"up to date"*|*"No migration found"*) echo connected ;; *) echo refused ;; esac'
}
backup() { # backup-db.sh as on the VM, its pg_dump joined to the test network
  local dir="$work/vm-$RANDOM"
  mkdir -p "$dir/deploy" "$dir/backend" "$dir/bin" "$dir/backups"
  cp "$here/backup-db.sh" "$here/pg-credentials.sh" "$dir/deploy/"
  cp -r "$work/certs" "$dir/backend/certs"
  echo "DIRECT_URL=$1" > "$dir/backend/.env"
  : > "$dir/.env"
  real=$(command -v docker)
  printf '#!/usr/bin/env bash\nif [ "$1" = run ]; then shift; exec "%s" run --network "%s" "$@"; fi\nexec "%s" "$@"\n' "$real" "$TAG" "$real" > "$dir/bin/docker"
  chmod +x "$dir/bin/docker"
  if PATH="$dir/bin:$PATH" BACKUP_DIR="$dir/backups" bash "$dir/deploy/backup-db.sh" > "$dir/out" 2>&1; then echo connected
  elif grep -q 'pg_dump failed' "$dir/out"; then echo refused
  else echo blocked; fi
}

base="postgresql://postgres:verify-pw@$HOST:5432/postgres"
strict() { printf '%s?sslmode=require&sslcert=/app/certs/%s&sslaccept=strict' "$base" "$1"; }
results="$work/results"
check() { # label, expected, actual
  printf '  %-62s %-9s %s\n' "$1" "$3" "$([ "$2" = "$3" ] && echo ok || echo "EXPECTED $2")" | tee -a "$results"
}

for state in good untrusted wrongname off; do
  serve "$state"
  echo "== server certificate: $state"
  want=refused; [ "$state" = good ] && want=connected
  check "runtime, verified URL" "$want" "$(runtime "$(strict db-ca.crt)")"
  check "runtime, verified URL + pgbouncer, pool size" "$want" "$(runtime "$(strict db-ca.crt)&pgbouncer=true&connection_limit=2")"
  check "migrate status (CLI), verified URL" "$want" "$(migrate "$(strict db-ca.crt)")"
  check "migrate service, verified URL" "$want" "$(migrate_service "$(strict db-ca.crt)")"
  check "backup-db.sh (libpq verify-full), verified URL" "$want" "$(backup "$(strict db-ca.crt)")"
  # Policy: these never reach the server, whatever it serves.
  before=$(connections)
  check "runtime, no TLS settings (repo template before)" blocked "$(runtime "$base?pgbouncer=true")"
  check "runtime, sslmode=require alone" blocked "$(runtime "$base?sslmode=require")"
  check "runtime, localhost URL with ?host= elsewhere" blocked "$(runtime "postgresql://postgres:verify-pw@localhost:5432/postgres?host=$HOST")"
  check "migrate service, no TLS settings" blocked "$(migrate_service "$base")"
  check "migrate service, CA file missing" blocked "$(migrate_service "$(strict none.crt)")"
  check "backup-db.sh, no TLS settings" blocked "$(backup "$base")"
  check "backup-db.sh, CA file missing" blocked "$(backup "$(strict none.crt)")"
  [ "$(connections)" -le "$before" ] || fail "a blocked client still connected"
done

# Bundles: Prisma trusts only the first certificate in the file (the CLI
# below, which has no check of its own, shows it), so FinSight refuses them.
serve good
echo "== CA bundles, server certificate: good"
check "migrate status (CLI), bundle with the CA first" connected "$(migrate "$(strict bundle-ca-first.crt)")"
check "migrate status (CLI), bundle with the CA second" refused "$(migrate "$(strict bundle-ca-last.crt)")"
check "runtime, bundle with the CA first" blocked "$(runtime "$(strict bundle-ca-first.crt)")"
check "migrate service, bundle with the CA first" blocked "$(migrate_service "$(strict bundle-ca-first.crt)")"

# Encoded CA paths: Prisma decodes them (the CLI, which has no check of its own,
# opens db-ca.crt for db%2Dca.crt and "db ca.crt" for db+ca.crt), while
# deploy.sh and backup-db.sh would read the raw name. All three FinSight
# clients refuse them, so every tool opens the same file.
echo "== encoded CA paths, server certificate: good"
check "migrate status (CLI), sslcert=db%2Dca.crt (decoded)" connected "$(migrate "$(strict db%2Dca.crt)")"
check "migrate status (CLI), sslcert=db+ca.crt (read as a space)" connected "$(migrate "$(strict db+ca.crt)")"
for name in db%2Dca.crt db+ca.crt; do
  check "runtime, sslcert=$name" blocked "$(runtime "$(strict "$name")")"
  check "migrate service, sslcert=$name" blocked "$(migrate_service "$(strict "$name")")"
  check "backup-db.sh, sslcert=$name" blocked "$(backup "$(strict "$name")")"
done

# A CA file only root can read: the API and workers run as `node`
# (backend/Dockerfile), and so do deploy.sh's checks before `up`.
cat > "$work/as-node.sh" <<'EOF'
cp /certs-src/db-ca.crt /tmp/root-only.crt && chmod 600 /tmp/root-only.crt
if [ "$1" = check ]; then
  runuser -u node -- node dist/config/databaseTls.js DATABASE_URL > /dev/null 2>&1 && echo passed || echo blocked
  exit 0
fi
as=""; [ "$1" = node ] && as="runuser -u node --"
$as node -e '
  let prisma;
  try { ({ prisma } = require("/app/dist/config/prisma.js")); } catch (e) { console.log(/cannot read the CA certificate/.test(e.message) ? "blocked" : "error"); process.exit(0); }
  prisma.$queryRawUnsafe("SELECT 1").then(() => console.log("connected"), () => console.log("refused")).finally(() => process.exit(0));'
EOF
root_only() { # node|root|check
  docker run --rm --network "$TAG" -v "$w/certs:/certs-src:ro" -v "$w/as-node.sh:/as-node.sh:ro"     -e "DATABASE_URL=$base?sslmode=require&sslcert=/tmp/root-only.crt&sslaccept=strict"     -e NODE_ENV=production -e LOG_LEVEL=silent "$IMG" sh /as-node.sh "$1" 2>&1 | tail -n 1
}
echo "== CA file readable by root only, server certificate: good"
check "runtime as root (what a root-only check would see)" connected "$(root_only root)"
check "runtime as node (the API and workers)" blocked "$(root_only node)"
check "deploy.sh check as node (databaseTls.js)" blocked "$(root_only check)"

# Local development: a loopback URL without TLS settings is still allowed.
echo "== local development (loopback, no TLS settings)"
check "runtime, loopback without TLS settings" connected "$(docker run --rm --network "container:$TAG-db" -e "DATABASE_URL=postgresql://postgres:verify-pw@127.0.0.1:5432/postgres" \
  -e NODE_ENV=production -e LOG_LEVEL=silent "$IMG" node -e '
    const { prisma } = require("/app/dist/config/prisma.js");
    prisma.$queryRawUnsafe("SELECT 1").then(() => console.log("connected"), () => console.log("refused")).finally(() => process.exit(0));' 2>&1 | tail -n 1)"

if grep -q EXPECTED "$results"; then fail "$(grep -c EXPECTED "$results") case(s) above did not behave as expected"; fi
echo "verify-database-tls: OK ($(wc -l < "$results") cases)"
