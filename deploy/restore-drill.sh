#!/usr/bin/env bash
# Proves a backup can be restored, without touching any real database:
# restores the dump into a throwaway Postgres container, prints row counts for
# the tables that hold owners' money and accounts, then removes the container.
#
#   bash deploy/restore-drill.sh                      # the newest local dump
#   bash deploy/restore-drill.sh path/to/file.dump
#
# Encrypted dumps (.dump.age) need the private key: point BACKUP_AGE_IDENTITY
# at the key file. Bring it to the VM only for the drill and delete it after.
#
#   BACKUP_AGE_IDENTITY=~/drill-key.txt bash deploy/restore-drill.sh
#
# Compare the counts with the live app (or the previous drill). Restoring the
# auth schema into plain Postgres reports errors for Supabase-only roles and
# extensions; the application tables are what this checks.
set -euo pipefail

readonly BACKUP_DIR="${BACKUP_DIR:-$HOME/finsight-backups}"
readonly PG_IMAGE=postgres:17-alpine
readonly CONTAINER="finsight-restore-drill-$$"

dump=${1:-}
if [ -z "$dump" ]; then
  dump=$(ls -1t "$BACKUP_DIR"/finsight-*.dump "$BACKUP_DIR"/finsight-*.dump.age 2>/dev/null | head -n1 || true)
fi
[ -n "$dump" ] && [ -f "$dump" ] || { echo "restore-drill: no dump found (looked in $BACKUP_DIR)" >&2; exit 1; }

case "$dump" in
  *.age)
    command -v age >/dev/null || { echo "restore-drill: age is not installed (sudo apt-get install age)" >&2; exit 1; }
    [ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -f "$BACKUP_AGE_IDENTITY" ] \
      || { echo "restore-drill: $dump is encrypted; set BACKUP_AGE_IDENTITY to the private key file" >&2; exit 1; }
    # Fails here, before any container starts, on a wrong key or a damaged file.
    age --decrypt --identity "$BACKUP_AGE_IDENTITY" "$dump" > /dev/null \
      || { echo "restore-drill: could not decrypt $dump with that key" >&2; exit 1; }
    ;;
esac

# Decrypted on the fly into pg_restore, so the plaintext never lands on disk.
read_dump() {
  case "$dump" in
    *.age) age --decrypt --identity "$BACKUP_AGE_IDENTITY" "$dump" ;;
    *) cat "$dump" ;;
  esac
}

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "restore-drill: restoring $dump into a throwaway database"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill "$PG_IMAGE" >/dev/null
# Not pg_isready: the image's setup server answers it before "drill" exists,
# and is then shut down. That server listens only on the socket, so a query
# over TCP means the final one is up.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d drill -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "restore-drill: the throwaway database did not start" >&2; exit 1; }

# Supabase keeps pg_trgm in its own "extensions" schema, which the dump does
# not include; without it the keyword-search indexes fail to restore. A
# restore into a new Supabase project needs pg_trgm enabled there first too.
docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d drill -q \
  -c 'CREATE SCHEMA IF NOT EXISTS extensions' -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions' >/dev/null

started=$(date +%s)
# Errors from the auth schema's Supabase-specific parts are expected; the
# counts and the structure check below are the verdict.
read_dump | docker exec -i "$CONTAINER" pg_restore --no-owner --no-privileges -U postgres -d drill \
  2> /tmp/finsight-restore-drill.log || true
echo "restore-drill: restored in $(( $(date +%s) - started ))s"

missing=0
for table in User BusinessProfile ExpenseRecord SalesReferenceRecord ExpenseCategory ReceiptScan _prisma_migrations; do
  count=$(docker exec "$CONTAINER" psql -U postgres -d drill -tA -c "SELECT count(*) FROM public.\"$table\"" 2>/dev/null || echo missing)
  printf '  %-22s %s\n' "$table" "$count"
  [ "$count" = missing ] && missing=1
done
count=$(docker exec "$CONTAINER" psql -U postgres -d drill -tA -c 'SELECT count(*) FROM auth.users' 2>/dev/null || echo missing)
printf '  %-22s %s\n' "auth.users" "$count"
[ "$count" = missing ] && missing=1
if [ "$missing" = 1 ]; then
  echo "restore-drill: some application tables did not restore; see /tmp/finsight-restore-drill.log" >&2
  exit 1
fi
# Rows can all be back while an index, trigger or constraint is not, which
# leaves a database that answers slowly or stops enforcing its rules.
if grep -qE '^Command was: (CREATE (UNIQUE )?INDEX|CREATE TRIGGER|CREATE (OR REPLACE )?FUNCTION|ALTER TABLE .* ADD CONSTRAINT)' /tmp/finsight-restore-drill.log; then
  echo "restore-drill: an index, trigger, function or constraint did not restore; see /tmp/finsight-restore-drill.log" >&2
  exit 1
fi
echo "restore-drill: OK"
