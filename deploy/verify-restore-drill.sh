#!/usr/bin/env bash
# Checks that deploy/restore-drill.sh passes an intact dump and fails one that
# was cut short. A dump cut inside its table data used to restore every table
# (some of them empty) and print "restore-drill: OK". Needs Docker. CI runs it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
readonly PG_IMAGE=postgres:17-alpine
readonly SOURCE="finsight-verify-restore-drill-$$"
work=$(mktemp -d)
cleanup() { docker rm -f -v "$SOURCE" >/dev/null 2>&1 || true; rm -rf -- "$work"; }
trap cleanup EXIT

docker run -d --name "$SOURCE" -e POSTGRES_PASSWORD=verify "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$SOURCE" psql -h 127.0.0.1 -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done

# The tables the drill counts, then one large table that pg_dump writes last,
# so cutting the dump at 90% lands in table data rather than in its header.
docker exec -i "$SOURCE" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -q <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.users (id int);
INSERT INTO auth.users VALUES (1);
CREATE TABLE "User" (id int);
CREATE TABLE "BusinessProfile" (id int);
CREATE TABLE "ExpenseRecord" (id int);
CREATE TABLE "SalesReferenceRecord" (id int);
CREATE TABLE "ExpenseCategory" (id int);
CREATE TABLE "ReceiptScan" (id int);
CREATE TABLE "_prisma_migrations" (id int);
INSERT INTO "User" VALUES (1);
INSERT INTO "ExpenseRecord" SELECT g FROM generate_series(1, 100) g;
CREATE TABLE zz_padding (v text);
INSERT INTO zz_padding SELECT md5(g::text) || md5((g * 7)::text) FROM generate_series(1, 40000) g;
SQL
docker exec "$SOURCE" pg_dump -U postgres --format=custom --no-owner --no-privileges \
  --schema=public --schema=auth postgres > "$work/good.dump"
size=$(wc -c < "$work/good.dump")
head -c $((size * 9 / 10)) "$work/good.dump" > "$work/cut.dump"

fail() { echo "verify-restore-drill: $*" >&2; exit 1; }

docker volume ls -q | sort > "$work/volumes.before"
BACKUP_DIR="$work" bash "$here/restore-drill.sh" "$work/good.dump" > "$work/good.out" 2>&1 \
  || { cat "$work/good.out" >&2; fail "an intact dump did not pass"; }
# The restored database must not outlive the drill in a Docker volume.
leaked=$(docker volume ls -q | sort | comm -13 "$work/volumes.before" -)
[ -z "$leaked" ] || fail "the drill left a volume behind: $leaked"

if BACKUP_DIR="$work" bash "$here/restore-drill.sh" "$work/cut.dump" > "$work/cut.out" 2>&1; then
  cat "$work/cut.out" >&2
  fail "a dump cut short passed"
fi
grep -q 'could not read from input file' "$work/cut.out" \
  || { cat "$work/cut.out" >&2; fail "a dump cut short failed without naming the read error"; }

if BACKUP_DIR="$work" bash "$here/restore-drill.sh" "$work/absent.dump" > "$work/absent.out" 2>&1; then
  fail "a missing dump passed"
fi
grep -q "no dump found at $work/absent.dump" "$work/absent.out" \
  || { cat "$work/absent.out" >&2; fail "a missing dump was not named"; }

echo "verify-restore-drill: OK"
