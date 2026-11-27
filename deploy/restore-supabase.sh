#!/usr/bin/env bash
# Restores a backup-db.sh dump into a NEW, EMPTY Supabase project.
#
#   RESTORE_DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres' \
#   RESTORE_CA_CERT=supabase-ca.crt BACKUP_AGE_IDENTITY=~/drill-key.txt \
#     bash deploy/restore-supabase.sh finsight-<stamp>.dump.age
#
# RESTORE_CA_CERT (the project's CA, Database settings > SSL) is required for a
# *.supabase.co/.com target: every connection then verifies the server
# certificate and host name before sending the password.
#
# A plain pg_restore cannot do this: Supabase's auth schema belongs to
# supabase_auth_admin, so recreating it fails, and in a one-shot run some auth
# tables came back empty with no error naming them. Instead, one transaction
# loads the auth rows into the tables the project's own Auth already created
# (parents before children), sets the auth sequences, then restores public
# whole. Any error, or an interruption, rolls all of it back: the project is
# left as it was, and the same command can simply be run again.
#
# After the commit it checks every table's row count and every sequence
# against the dump, and that the API roles hold no privilege in public.
#
# Refuses a target whose public schema has any table or whose auth tables (the
# ones the dump fills) have any row: that is never a new project. Storage objects and bucket settings
# are a separate step (docs/deployment-runbook.md §6.2).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/pg-credentials.sh
. "$here/pg-credentials.sh"
readonly PG_IMAGE=postgres:17-alpine
# Every container this run starts carries it, so cleanup removes those and no other.
readonly LABEL="finsight-restore-supabase=$$"
committed=no finished=no reported=no client=""

fail() { reported=yes; echo "restore-supabase: $*" >&2; exit 1; }
broken() { fail "$*. The restore was committed but does not match the backup: keep this project out of service and restore into a new one"; }

dump=${1:-}
[ -n "$dump" ] && [ -f "$dump" ] || fail "no dump found at ${1:-<none given>}"
[ -n "${RESTORE_DATABASE_URL:-}" ] || fail "set RESTORE_DATABASE_URL to the new project's direct connection string"
pg_split_url "$RESTORE_DATABASE_URL" || fail "RESTORE_DATABASE_URL is not usable (above)"
# A hosted target is verified before the password goes to it: libpq's
# verify-full checks the certificate and the host name.
PG_TLS=()
if [ -n "${RESTORE_CA_CERT:-}" ]; then
  pg_verify_tls "$RESTORE_CA_CERT" || fail "RESTORE_CA_CERT cannot verify the target (above); nothing was sent to it"
elif [ "${RESTORE_ALLOW_UNVERIFIED:-}" != 1 ]; then
  # Without a CA only a target on this machine: every host in the URL and in
  # any host=/hostaddr= parameter must be loopback (anything else, however it
  # is spelled, could be a hosted project). RESTORE_ALLOW_UNVERIFIED=1 is for
  # throwaway local containers reached by IP (the CI checks).
  rest=${PG_URL#*://}; hosts=${rest%%[/?]*}; hosts=${hosts##*@}
  if [[ $rest == *\?* ]]; then
    IFS='&' read -ra params <<< "${rest#*\?}"
    for p in "${params[@]}"; do case "${p,,}" in host=*|hostaddr=*) hosts="$hosts,${p#*=}" ;; esac; done
  fi
  IFS=',' read -ra hosts <<< "$hosts"
  for h in "${hosts[@]}"; do
    h=${h,,}
    case "$h" in \[*\]*) h=${h%%]*}; h=${h#[} ;; *) h=${h%%:*} ;; esac
    h=${h%.}
    [[ $h =~ ^127(\.[0-9]{1,3}){3}$ ]] && continue
    case "$h" in
      ''|localhost|::1|host.docker.internal) ;;
      *) fail "set RESTORE_CA_CERT to the project's CA certificate (Database settings, SSL): a restore to $h verifies the server before the password goes to it; nothing was sent to it" ;;
    esac
  done
fi

work=$(mktemp -d)
chmod 700 "$work"
cleanup() {
  docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null 2>&1 || true
  [ -z "$client" ] || { kill "$client" 2>/dev/null; wait "$client" 2>/dev/null; } || true
  rm -rf -- "$work"
  if [ "$committed" = yes ] && [ "$finished" = no ] && [ "$reported" = no ]; then
    echo "restore-supabase: stopped after the restore committed, before it was fully checked; treat the project as unverified" >&2
  fi
}
trap cleanup EXIT
on_signal() {
  reported=yes
  if [ "$committed" = no ]; then
    # A signal in the instant between pg_restore's COMMIT and this script seeing
    # it exit lands here too; a re-run's emptiness check tells which it was.
    echo "restore-supabase: interrupted before the restore committed; the project is unchanged (if a re-run says it already has tables, the commit had landed: use a new project)" >&2
  else
    echo "restore-supabase: interrupted after the restore committed, before it was checked; treat the project as unverified" >&2
  fi
  exit 130
}
trap on_signal INT TERM HUP

# The decrypted dump is needed several times; it lives only in this folder.
case "$dump" in
  *.age)
    [ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -f "$BACKUP_AGE_IDENTITY" ] \
      || fail "$dump is encrypted; set BACKUP_AGE_IDENTITY to the private key file"
    age --decrypt --identity "$BACKUP_AGE_IDENTITY" --output "$work/dump" "$dump" \
      || fail "could not decrypt $dump: wrong key, or the file is damaged (age says which, above)" ;;
  *) cp "$dump" "$work/dump" ;;
esac

# Containers get the password only as PGPASSWORD, by name; PG_URL has none.
local_pg() { docker run --rm -i --label "$LABEL" "$PG_IMAGE" "$@"; }
sql() { MSYS_NO_PATHCONV=1 docker run --rm -i --label "$LABEL" -e PGPASSWORD "${PG_TLS[@]}" "$PG_IMAGE" psql -X -v ON_ERROR_STOP=1 -qtA -F ' ' -d "$PG_URL" "$@"; }

local_pg pg_restore --list < "$work/dump" > "$work/toc" 2> "$work/toc.err" \
  || fail "$dump is not a readable dump ($(head -n1 "$work/toc.err"))"
# backup-db.sh's BACKUP_SCHEMAS can drop either schema; both are needed here.
grep -q ' TABLE DATA auth users ' "$work/toc" || fail "$dump has no auth.users: restoring it would leave nobody able to sign in"
grep -q ' TABLE DATA public ' "$work/toc" || fail "$dump has no application tables"
other=$(awk '$4 == "TABLE" && $5 == "DATA" && $6 != "public" && $6 != "auth" {print $6}' "$work/toc" | sort -u | tr '\n' ' ')
[ -z "$other" ] || fail "$dump also holds data for schemas this does not restore: $other(back up with the default BACKUP_SCHEMAS)"
awk '$4 == "TABLE" && $5 == "DATA" && $6 == "auth" && $7 != "schema_migrations" {print $7}' "$work/toc" > "$work/auth-tables"
if grep -qvx '[a-z_][a-z0-9_]*' "$work/auth-tables"; then
  fail "$dump names an auth table this cannot handle: $(grep -vx '[a-z_][a-z0-9_]*' "$work/auth-tables" | head -n1)"
fi

# Any row in an auth table the dump fills would be loaded alongside the
# backup's (a test user made and deleted in the dashboard still leaves audit rows).
occupied=$(sql -c "SELECT c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM auth.%I', c.relname), false, true, '')))[1]::text
                     FROM pg_class c WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind IN ('r', 'p')
                      AND c.relname = ANY (string_to_array('$(paste -sd, "$work/auth-tables")', ','))
                   UNION ALL SELECT 'public-tables', count(*)::text FROM pg_tables WHERE schemaname = 'public'" \
  | awk '$2 != 0 {print $1}' | tr '\n' ' ')
[ -z "$occupied" ] || fail "the target already has tables in public or rows in auth (${occupied% }); this only restores into a new, empty project"

# Restoring auth data into an OLDER Auth could meet columns it does not have.
# A newer one is normal; signing in afterwards checks it (runbook §6.1 Step 6).
# Reading every row up front also catches a dump damaged or cut short inside
# its data before anything is written.
local_pg pg_restore --data-only -f - < "$work/dump" > "$work/data.sql" 2> "$work/data.err" \
  || fail "$dump is damaged: $(grep -m1 'error' "$work/data.err" || head -n1 "$work/data.err"); the project was not touched"
dump_auth=$(awk '/^COPY auth\.schema_migrations /{on=1; next} on && /^\\\.$/{exit} on' "$work/data.sql" | sort | tail -n1)
target_auth=$(sql -c 'SELECT max(version) FROM auth.schema_migrations')
[ -z "$dump_auth" ] || [ "$target_auth" \> "$dump_auth" ] || [ "$target_auth" = "$dump_auth" ] \
  || fail "the target's Auth (migration $target_auth) is older than the backup's ($dump_auth); upgrade the project first"

# The restore list: auth rows parents first (the order comes from the target's
# own foreign keys), auth sequences, then all of public but the schema itself,
# which a Supabase project already has.
{
  sql -c "SELECT p.relname, c.relname FROM pg_constraint k
            JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
           WHERE k.contype = 'f' AND c.relnamespace = 'auth'::regnamespace
             AND p.relnamespace = 'auth'::regnamespace AND c.oid <> p.oid"
  awk '{print $1, $1}' "$work/auth-tables"
} | tsort > "$work/auth-order" || fail "could not order the auth tables for loading (a foreign-key cycle?)"
{
  while read -r table; do
    grep -qx "$table" "$work/auth-tables" || continue
    awk -v t="$table" '$4 == "TABLE" && $5 == "DATA" && $6 == "auth" && $7 == t' "$work/toc"
  done < "$work/auth-order"
  awk '$4 == "SEQUENCE" && $5 == "SET" && $6 == "auth"' "$work/toc"
  local_pg pg_restore --list --schema=public < "$work/dump" \
    | grep -vE '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA - public|COMMENT - SCHEMA public) '
} > "$work/list"
[ "$(grep -c ' TABLE DATA auth ' "$work/list")" = "$(wc -l < "$work/auth-tables" | tr -d ' ')" ] \
  || fail "could not order the auth tables for loading (a table in the backup the target's Auth lacks?)"

started=$(date +%s)
sql -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions'
# A new project grants anon, authenticated and service_role everything on what
# postgres creates, and --no-privileges dropped the migrations' REVOKEs. Taking
# the defaults back first means the restored objects never get those grants.
# Mirrors migrations 20260806153854, 20260913075700 and 20261022105708.
sql -c 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role' \
    -c 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role' \
    -c 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role' \
    -c 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC'

# One transaction. pg_restore cannot follow a reordered list from a pipe, so
# the list and dump go into the container as a tar on stdin (no mount, no long
# argv) and leave with it. The container exists before anything runs in it, so
# a signal at any point finds it for the cleanup's `docker rm -f`, which drops
# the connection and so rolls the transaction back. Waited for in the
# background so a signal is handled at once.
cid=$(MSYS_NO_PATHCONV=1 docker create -i --rm --label "$LABEL" -e PGPASSWORD "${PG_TLS[@]}" "$PG_IMAGE" sh -c '
  tar -xf - -C /tmp &&
  exec pg_restore --single-transaction --exit-on-error --no-owner --no-privileges \
    -L /tmp/list --dbname="$1" /tmp/dump' sh "$PG_URL")
tar -cf - -C "$work" list dump | docker start -ai "$cid" 2> "$work/restore.log" &
client=$!
status=0
wait "$client" || status=$?
client=""
if [ "$status" != 0 ]; then
  # Error lines only: DETAIL/CONTEXT can quote row values (emails, hashes).
  grep '^pg_restore: error:' "$work/restore.log" >&2 || true
  fail "the restore failed (status $status) and was rolled back; the project is unchanged"
fi
committed=yes
echo "restore-supabase: restore committed in $(( $(date +%s) - started ))s; checking it"

# Belt and braces for the defaults above, then prove it.
sql -c 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role' \
    -c 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role' \
    -c 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role'
open_grants=$(sql -c "
  WITH api AS (SELECT 0::oid AS oid UNION ALL SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')),
  grants AS (
    SELECT (aclexplode(COALESCE(relacl, acldefault((CASE relkind WHEN 'S' THEN 's' ELSE 'r' END)::\"char\", relowner)))).grantee
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    UNION ALL
    SELECT (aclexplode(COALESCE(proacl, acldefault('f', proowner)))).grantee FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    UNION ALL
    SELECT (aclexplode(defaclacl)).grantee FROM pg_default_acl
     WHERE defaclrole = 'postgres'::regrole AND defaclnamespace = 'public'::regnamespace)
  SELECT count(*) FROM grants WHERE grantee IN (SELECT oid FROM api)")
[ "$open_grants" = 0 ] || broken "anon, authenticated, service_role or PUBLIC still hold $open_grants privileges in public"
[ "$(sql -c "SELECT count(*) FROM pg_default_acl d WHERE defaclrole = 'postgres'::regrole AND defaclnamespace = 0
              AND defaclobjtype = 'f' AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)")" = 1 ] \
  || broken "functions postgres creates would still be executable by PUBLIC"

# Rows per table in the dump (COPY text format escapes newlines) and in the target.
awk '!on && /^COPY /{name=$2; gsub(/"/, "", name); n=0; on=1; next}
     on && /^\\\.$/ {if (name != "auth.schema_migrations") print name, n; on=0; next}
     on {n++}' "$work/data.sql" | sort > "$work/rows.dump"
sql -c "SELECT n.nspname || '.' || c.relname,
               (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p')" | sort > "$work/rows.target"
mismatch=$(awk 'NR == FNR {t[$1] = $2; next} t[$1] != $2 {print $1 " has " (($1 in t) ? t[$1] : "no table") ", the backup has " $2}' \
  "$work/rows.target" "$work/rows.dump")
[ -z "$mismatch" ] || broken "rows differ: $mismatch"

# Sequences: a missed one makes the next insert collide with a restored row
# (for auth.refresh_tokens, every sign-in fails: "Database error granting user").
sed -En "s/^SELECT pg_catalog\.setval\('(.*)', (-?[0-9]+), (true|false)\);$/\1 \2 \3/p" "$work/data.sql" \
  | awk '{gsub(/"/, "", $1); print $1, ($3 == "true" ? $2 : "null")}' | sort > "$work/seq.dump"
sql -c "SELECT schemaname || '.' || sequencename, COALESCE(last_value::text, 'null')
          FROM pg_sequences WHERE schemaname IN ('public', 'auth')" | sort > "$work/seq.target"
mismatch=$(awk 'NR == FNR {t[$1] = $2; next} t[$1] != $2 {print $1 " is at " (($1 in t) ? t[$1] : "nothing") ", the backup has " $2}' \
  "$work/seq.target" "$work/seq.dump")
[ -z "$mismatch" ] || broken "sequences differ: $mismatch"

# Neither check may pass by having nothing to compare.
expected=$(awk '$4 == "TABLE" && $5 == "DATA" && ($6 == "public" || ($6 == "auth" && $7 != "schema_migrations"))' "$work/toc" | wc -l)
[ "$(wc -l < "$work/rows.dump")" -eq "$expected" ] \
  || broken "only $(wc -l < "$work/rows.dump" | tr -d ' ') of $expected tables could be read back from the dump to check"
expected=$(awk '$4 == "SEQUENCE" && $5 == "SET" && ($6 == "public" || $6 == "auth")' "$work/toc" | wc -l)
[ "$(wc -l < "$work/seq.dump")" -eq "$expected" ] \
  || broken "only $(wc -l < "$work/seq.dump" | tr -d ' ') of $expected sequences could be read back from the dump to check"
finished=yes

echo "restore-supabase: $(wc -l < "$work/rows.dump" | tr -d ' ') tables ($(awk '{s += $2} END {print s}' "$work/rows.dump") rows) and $(wc -l < "$work/seq.dump" | tr -d ' ') sequences match the backup; API roles hold no privileges in public"
printf '  %-22s %s\n' auth.users "$(awk '$1 == "auth.users" {print $2}' "$work/rows.dump")"
echo "restore-supabase: OK. Next: Storage (§6.2), then start the API on this project and sign in (§6.1 Step 6)"
