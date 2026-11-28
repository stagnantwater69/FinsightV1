#!/usr/bin/env bash
# Checks deploy/restore-supabase.sh against plain Postgres made to look like a
# new Supabase project where it matters: the API roles, default privileges
# that grant them everything, and an auth schema the target already has (its
# tables in an order that breaks foreign keys if loaded alphabetically).
# Synthetic data; needs Docker and age. CI runs it. The real thing (GoTrue,
# Storage, the API) is deploy/rehearsal/run-local-supabase.sh.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
readonly PG_IMAGE=postgres:17-alpine
readonly DB="finsight-verify-restore-supabase-$$"
# Needs URL encoding (@ : %), so a leak of either form is detectable; the "?"
# stays unencoded, as libpq allows, and must not end the password early.
readonly SECRET='Rs-p@ss:w0rd%x?y' SECRET_ENC='Rs-p%40ss%3Aw0rd%25x?y'
work=$(mktemp -d)
# Every target here is a throwaway container reached by its IP, without TLS.
export RESTORE_ALLOW_UNVERIFIED=1
locker=""
cleanup() {
  [ -z "$locker" ] || kill "$locker" 2>/dev/null || true
  docker rm -f -v "$DB" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
fail() { echo "verify-restore-supabase: $*" >&2; exit 1; }
psql_db() { docker exec -i "$DB" psql -X -v ON_ERROR_STOP=1 -qtA -U postgres -d "$1" "${@:2}"; }
held() { # held <db> <table> <lock mode>: wait until the locker holds it
  for _ in $(seq 1 60); do
    [ "$(psql_db "$1" -c "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = '$2' AND l.mode = '$3' AND l.granted")" = 1 ] && return 0
    sleep 0.5
  done
  fail "the test lock on $2 was never taken"
}

echo "verify-restore-supabase: splitting the password out of a URL"
split() { # split <url> <expected PG_URL> <expected PGPASSWORD>, or split <url> REFUSED
  local got
  got=$(export PGPASSWORD=inherited; . "$here/pg-credentials.sh"; pg_split_url "$1" 2>/dev/null && printf '%s|%s' "$PG_URL" "${PGPASSWORD-<unset>}") || got=REFUSED
  [ "$got" = "$2${3+|$3}" ] || fail "pg_split_url $1 gave '$got', expected '$2${3+|$3}'"
}
split "postgresql://u:$SECRET_ENC@h:5432/db?sslmode=require" 'postgresql://u@h:5432/db?sslmode=require' "$SECRET"
split 'postgresql://u:p?q@h' 'postgresql://u@h' 'p?q'
split 'postgresql://u:a%5Cn@h/db' 'postgresql://u@h/db' 'a\n'
split 'postgresql://u:@h/db' 'postgresql://u@h/db' ''
split 'postgresql://h/db' 'postgresql://h/db' '<unset>'
split 'postgresql://u:p@[::1]:5432,h2:5433/db' 'postgresql://u@[::1]:5432,h2:5433/db' 'p'
for bad in 'postgresql://u:p/q@h/db' 'postgresql://u:a%zz@h/db' 'postgresql://u:a%00b@h/db' \
           'postgresql://u@h/db?password=x' 'postgresql://u@h/db?PassWord=x' 'postgresql://u@h/db?pass%77ord=x' 'mysql://u:p@h/db'; do
  split "$bad" REFUSED
done
echo "  pass: 13 URLs"

docker run -d --name "$DB" -e POSTGRES_PASSWORD=bootstrap "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do psql_db postgres -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DB")
psql_db postgres <<SQL
ALTER ROLE postgres PASSWORD '$SECRET';
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
SQL

# What a new project has before anything is restored.
supabase_like() {
  psql_db postgres -c "CREATE DATABASE $1"
  psql_db "$1" <<'SQL'
CREATE SCHEMA extensions;
CREATE SCHEMA auth;
CREATE TABLE auth.schema_migrations (version varchar(14) PRIMARY KEY);
INSERT INTO auth.schema_migrations VALUES ('20260101000000');
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users);
CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, session_id uuid REFERENCES auth.sessions, token text);
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL
}

# The source: Auth rows, a sequence well past its rows, app tables with RLS and
# no policies, a function, a trigram index, and padding so a cut lands in data.
supabase_like src
psql_db src > /dev/null <<'SQL'
CREATE EXTENSION pg_trgm SCHEMA extensions;
INSERT INTO auth.users SELECT md5(g::text)::uuid, 'owner' || g || '@example.test' FROM generate_series(1, 3) g;
INSERT INTO auth.identities SELECT md5('i' || g)::uuid, md5(g::text)::uuid FROM generate_series(1, 3) g;
INSERT INTO auth.sessions SELECT md5('s' || g)::uuid, md5(g::text)::uuid FROM generate_series(1, 3) g;
INSERT INTO auth.refresh_tokens (session_id, token) SELECT md5('s' || g)::uuid, 'rt' || g FROM generate_series(1, 3) g;
SELECT setval('auth.refresh_tokens_id_seq', 10);
CREATE TABLE "User" ("User_ID" serial PRIMARY KEY, "User_AuthID" uuid, email text);
CREATE TABLE "ExpenseRecord" (id serial PRIMARY KEY, "User_ID" int REFERENCES "User", amount numeric(12, 2));
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExpenseRecord" ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON "User" USING gin (email extensions.gin_trgm_ops);
CREATE FUNCTION finsight_total() RETURNS numeric LANGUAGE sql AS 'SELECT sum(amount) FROM "ExpenseRecord"';
INSERT INTO "User" ("User_AuthID", email) SELECT id, email FROM auth.users;
INSERT INTO "ExpenseRecord" ("User_ID", amount) SELECT 1 + g % 3, g FROM generate_series(1, 100) g;
CREATE TABLE zz_padding (v text);
INSERT INTO zz_padding SELECT md5(g::text) || md5((g * 7)::text) FROM generate_series(1, 40000) g;
SQL
dump() { docker exec "$DB" pg_dump -U postgres --format=custom --no-owner --no-privileges "$@" src; }
dump --schema=public --schema=auth > "$work/good.dump"
dump --schema=public > "$work/public-only.dump"
head -c $(( $(wc -c < "$work/good.dump") * 9 / 10 )) "$work/good.dump" > "$work/cut.dump"
head -c 4096 /dev/urandom > "$work/noise.dump"
age-keygen -o "$work/key.txt" 2>/dev/null
age-keygen -o "$work/wrong-key.txt" 2>/dev/null
age --encrypt --recipient "$(grep -o 'age1[a-z0-9]*' "$work/key.txt")" --output "$work/good.dump.age" "$work/good.dump"
head -c $(( $(wc -c < "$work/good.dump.age") * 9 / 10 )) "$work/good.dump.age" > "$work/cut.dump.age"

# Every docker command line the script runs goes through this log.
real_docker=$(command -v docker)
mkdir "$work/bin"
# With $work/delay present it also stalls the command that starts the load,
# to hold open the window between starting it and it running.
cat > "$work/bin/docker" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$work/argv.log"
if [ -e "$work/delay" ]; then case "\$*" in *single-transaction*) touch "$work/delaying"; sleep 4 ;; esac; fi
exec "$real_docker" "\$@"
SHIM
chmod +x "$work/bin/docker"
restore() { # restore <target db> <dump> [identity]
  PATH="$work/bin:$PATH" RESTORE_DATABASE_URL="postgresql://postgres:$SECRET_ENC@$ip:5432/$1" \
    BACKUP_AGE_IDENTITY="${3:-$work/key.txt}" bash "$here/restore-supabase.sh" "$2"
}
untouched() { # the target holds nothing the script could have written
  [ "$(psql_db "$1" -c "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') + (SELECT count(*) FROM auth.users) + (SELECT count(*) FROM auth.sessions)")" = 0 ]
}
refused() { # refused <name> <target> <dump> <expected message> [identity]
  if restore "$2" "$3" "${5:-}" > "$work/$1.out" 2>&1; then cat "$work/$1.out" >&2; fail "$1: the restore succeeded"; fi
  grep -q "restore-supabase: OK" "$work/$1.out" && fail "$1: printed OK and failed"
  grep -q "$4" "$work/$1.out" || { cat "$work/$1.out" >&2; fail "$1: no message naming the cause ($4)"; }
  echo "  pass: $1"
}

echo "verify-restore-supabase: success path"
supabase_like t_ok
restore t_ok "$work/good.dump.age" > "$work/ok.out" 2>&1 || { cat "$work/ok.out" >&2; fail "an intact dump did not restore"; }
grep -q 'restore-supabase: OK' "$work/ok.out" || fail "no OK from a good restore"
# 3 public and 4 auth tables, 3 sequences: checks that compared nothing would say 0.
grep -q '7 tables (40115 rows) and 3 sequences match' "$work/ok.out" \
  || { cat "$work/ok.out" >&2; fail "the restore's own check did not cover every table and sequence"; }
[ "$(psql_db t_ok -c 'SELECT count(*) FROM auth.refresh_tokens')" = 3 ] || fail "auth rows missing"
[ "$(psql_db t_ok -c 'SELECT last_value FROM auth.refresh_tokens_id_seq')" = 10 ] || fail "auth sequence not restored"
[ "$(psql_db t_ok -c 'SELECT count(*) FROM "ExpenseRecord"')" = 100 ] || fail "app rows missing"
[ "$(psql_db t_ok -c "SELECT count(*) FROM pg_class WHERE relname IN ('User', 'ExpenseRecord') AND relrowsecurity")" = 2 ] \
  || fail "RLS not enabled on the restored tables"
for probe in 'SELECT count(*) FROM "User"' 'SELECT finsight_total()' 'SELECT nextval($$"User_User_ID_seq"$$)'; do
  for role in anon authenticated service_role; do
    if psql_db t_ok -c "SET ROLE $role" -c "$probe" > /dev/null 2> "$work/probe.err"; then fail "$role can run: $probe"; fi
    grep -q 'permission denied' "$work/probe.err" || { cat "$work/probe.err" >&2; fail "$role: $probe failed for another reason"; }
  done
done
# A table the next migration creates must not be open to the API either.
psql_db t_ok -c 'CREATE TABLE zz_after_restore (i int)'
if psql_db t_ok -c 'SET ROLE anon' -c 'SELECT * FROM zz_after_restore' > /dev/null 2>&1; then
  fail "a table created after the restore is readable by anon (default privileges)"
fi
psql_db t_ok -c 'DROP TABLE zz_after_restore'
echo "  pass: rows, sequences, RLS, and no API-role access, including to new tables"

echo "verify-restore-supabase: refusals (each target must be left as it was)"
refused rerun t_ok "$work/good.dump.age" 'already has tables'
supabase_like t_users; psql_db t_users -c "INSERT INTO auth.users VALUES (gen_random_uuid(), 'live@example.test')"
refused auth-users t_users "$work/good.dump.age" 'already has tables'
supabase_like t_empty
refused no-auth-data t_empty "$work/public-only.dump" 'no auth.users'
refused noise t_empty "$work/noise.dump" 'not a readable dump'
refused cut-plain t_empty "$work/cut.dump" 'is damaged'
refused cut-age t_empty "$work/cut.dump.age" 'could not decrypt'
refused wrong-key t_empty "$work/good.dump.age" 'could not decrypt' "$work/wrong-key.txt"
refused missing t_empty "$work/absent.dump" 'no dump found'
untouched t_empty || fail "a refused restore changed the target"
# An error late in the load (after the auth rows) must roll everything back.
supabase_like t_conflict
psql_db t_conflict -c 'CREATE FUNCTION public.finsight_total() RETURNS numeric LANGUAGE sql AS $$SELECT 0$$'
refused late-error t_conflict "$work/good.dump.age" 'rolled back'
untouched t_conflict || fail "a restore that failed part-way left rows or tables in the target"
# No user left, but another auth table the dump fills still has a row.
supabase_like t_leftover; psql_db t_leftover -c "INSERT INTO auth.refresh_tokens (token) VALUES ('stale')"
refused auth-leftovers t_leftover "$work/good.dump.age" 'rows in auth (refresh_tokens)'
[ "$(psql_db t_leftover -c "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public') || ' ' || (SELECT count(*) FROM auth.refresh_tokens)")" = '0 1' ] \
  || fail "a refused restore changed a target with leftover auth rows"

echo "verify-restore-supabase: rehearsal/target-preflight.sh (read-only)"
preflight() { # preflight <db> [user]: exit status of the preflight as that user
  TARGET_DB_URL="postgresql://${2:-postgres}:$SECRET_ENC@$ip:5432/$1" PATH="$work/bin:$PATH" \
    bash "$here/rehearsal/target-preflight.sh" > "$work/preflight-$1-${2:-postgres}.out" 2>&1
}
preflight t_empty || { cat "$work/preflight-t_empty-postgres.out" >&2; fail "the preflight blocked an empty target"; }
for case in 't_users auth.users' 't_leftover auth.refresh_tokens'; do
  set -- $case
  if preflight "$1"; then fail "the preflight passed $1, which restore-supabase.sh refuses"; fi
  grep -q "BLOCKED: $2 has 1 rows" "$work/preflight-$1-postgres.out" || { cat "$work/preflight-$1-postgres.out" >&2; fail "the preflight did not name $2"; }
done
# A role that can read Auth but not write it, as a hosted project might give.
psql_db t_empty -c "CREATE ROLE reader LOGIN PASSWORD '$SECRET'" -c 'GRANT USAGE ON SCHEMA auth, extensions TO reader' \
  -c 'GRANT SELECT ON ALL TABLES IN SCHEMA auth TO reader' -c 'GRANT CREATE ON SCHEMA public TO reader' > /dev/null
if preflight t_empty reader; then fail "the preflight passed a role that cannot write auth tables"; fi
grep -q 'BLOCKED: this role cannot insert into auth.users' "$work/preflight-t_empty-reader.out" \
  || { cat "$work/preflight-t_empty-reader.out" >&2; fail "the preflight did not name the missing auth privilege"; }
psql_db t_empty -c 'DROP OWNED BY reader' -c 'DROP ROLE reader' > /dev/null
untouched t_empty || fail "the preflight changed the target"
# Hosted mode requires verified TLS; with no CA it must stop before connecting
# (rehearsal/verify-target-tls.sh covers the certificates themselves).
if TARGET_REQUIRE_TLS=1 preflight t_empty; then fail "the preflight ran with TLS required and no CA"; fi
grep -q 'BLOCKED: a verified TLS connection is required' "$work/preflight-t_empty-postgres.out" && ! grep -q 'a container connects' "$work/preflight-t_empty-postgres.out" \
  || { cat "$work/preflight-t_empty-postgres.out" >&2; fail "the preflight did not stop before connecting without a CA"; }
echo "  pass: empty target OK; users, leftover auth rows, a read-only role and TLS without a CA blocked; nothing written"

echo "verify-restore-supabase: rewrite-public-image-urls.sql"
psql_db postgres -c 'CREATE DATABASE t_rewrite' > /dev/null
psql_db t_rewrite > /dev/null <<'SQL'
CREATE TABLE "User" ("User_ID" int PRIMARY KEY, "User_AvatarURL" text);
CREATE TABLE "BusinessProfile" ("BusinessProfile_ID" int PRIMARY KEY, "BusinessProfile_LogoURL" text);
INSERT INTO "User" VALUES
  (1, 'http://127.0.0.1:5473/storage/v1/object/public/avatars/users/1.a%20b'),
  (2, 'http://127.0.0.1:54731/storage/v1/object/public/avatars/users/2.b'),
  (3, 'https://cdn.example/storage/v1/object/public/avatars/users/3.c'),
  (4, 'http://127.0.0.1:5473/storage/v1/object/public/receipts/4.d'),
  (5, NULL);
INSERT INTO "BusinessProfile" VALUES (1, 'http://127.0.0.1:5473/storage/v1/object/public/avatars/businesses/1.e'), (2, NULL);
SQL
rewrite() { psql_db t_rewrite -v old_origin="$1" -v new_origin="$2" < "$here/rewrite-public-image-urls.sql"; }
urls() { psql_db t_rewrite -c 'SELECT string_agg(coalesce(u, $$NULL$$), $$ $$ ORDER BY k) FROM (SELECT "User_ID" k, "User_AvatarURL" u FROM "User" UNION ALL SELECT 100 + "BusinessProfile_ID", "BusinessProfile_LogoURL" FROM "BusinessProfile") x'; }
before=$(urls)
if rewrite http://127.0.0.1:5473 https://new.example/ > "$work/rewrite-slash.out" 2>&1; then fail "the rewrite accepted an origin ending in /"; fi
[ "$(urls)" = "$before" ] || fail "a refused rewrite changed URLs"
want='https://new.example/storage/v1/object/public/avatars/users/1.a%20b http://127.0.0.1:54731/storage/v1/object/public/avatars/users/2.b https://cdn.example/storage/v1/object/public/avatars/users/3.c http://127.0.0.1:5473/storage/v1/object/public/receipts/4.d NULL https://new.example/storage/v1/object/public/avatars/businesses/1.e NULL'
for run in first second; do
  [ "$(rewrite http://127.0.0.1:5473 https://new.example)" = 'image URLs not on the new host: 3' ] || fail "the $run rewrite miscounted URLs left elsewhere"
  [ "$(urls)" = "$want" ] || fail "the $run rewrite changed the wrong URLs: $(urls)"
done
echo "  pass: only avatars on the old origin move (path kept, :54731 and other hosts untouched); repeatable; trailing / refused"

echo "verify-restore-supabase: a commit that does not match the backup"
# The target's own trigger drops a row the dump holds; only the check after the commit can see it.
supabase_like t_drop
psql_db t_drop -c "CREATE FUNCTION auth.drop_one() RETURNS trigger LANGUAGE plpgsql AS \$\$BEGIN IF NEW.id = md5('i1')::uuid THEN RETURN NULL; END IF; RETURN NEW; END\$\$" \
  -c 'CREATE TRIGGER drop_one BEFORE INSERT ON auth.identities FOR EACH ROW EXECUTE FUNCTION auth.drop_one()'
refused rows-differ t_drop "$work/good.dump.age" 'rows differ: auth.identities has 2, the backup has 3'
grep -q 'keep this project out of service' "$work/rows-differ.out" || fail "a mismatch did not say to keep the project out of service"

echo "verify-restore-supabase: interrupted restore"
supabase_like t_int
# Hold back writes to auth.users (reads still pass), so the restore stops in
# its transaction, then stop the script there.
docker exec "$DB" psql -U postgres -d t_int -c "BEGIN; LOCK auth.users IN EXCLUSIVE MODE; SELECT pg_sleep(300)" > /dev/null 2>&1 &
locker=$!
held t_int users ExclusiveLock
# exec, so $! is the script's own bash and the signal reaches it.
(export PATH="$work/bin:$PATH" RESTORE_DATABASE_URL="postgresql://postgres:$SECRET_ENC@$ip:5432/t_int" BACKUP_AGE_IDENTITY="$work/key.txt"
 exec bash "$here/restore-supabase.sh" "$work/good.dump.age") > "$work/int.out" 2>&1 &
rpid=$!
blocked=no
for _ in $(seq 1 240); do
  [ "$(psql_db t_int -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 't_int' AND wait_event_type = 'Lock'")" -ge 1 ] && { blocked=yes; break; }
  sleep 0.5
done
[ "$blocked" = yes ] || { cat "$work/int.out" >&2; fail "the restore never reached its load"; }
# What `docker top` shows of the restore's own processes must hold no password.
restore_containers() { docker ps -aq --filter label=finsight-restore-supabase; }
for c in $(restore_containers); do docker top "$c" >> "$work/top.log" 2>&1 || true; done
kill -TERM "$rpid"
status=0; wait "$rpid" || status=$?
[ "$status" != 0 ] || fail "an interrupted restore exited 0"
grep -q 'restore-supabase: OK' "$work/int.out" && fail "an interrupted restore printed OK"
# The runbook's recovery table goes by this line.
grep -q 'interrupted before the restore committed; the project is unchanged' "$work/int.out" \
  || { cat "$work/int.out" >&2; fail "an interrupted restore did not say what state it left the project in"; }
for _ in $(seq 1 30); do [ -z "$(restore_containers)" ] && break; sleep 0.5; done
left=$(restore_containers)
[ -z "$left" ] || { cat "$work/int.out" >&2; fail "an interrupted restore left containers: $left"; }
psql_db postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 't_int' AND query LIKE '%pg_sleep%'" > /dev/null
wait "$locker" 2>/dev/null || true; locker=""
sleep 2
untouched t_int || fail "an interrupted restore left rows or tables in the target"
echo "  pass: exit $status, no OK, no container left, target unchanged"
restore t_int "$work/good.dump.age" > "$work/int-retry.out" 2>&1 \
  || { cat "$work/int-retry.out" >&2; fail "the same target could not be restored after the interruption"; }
echo "  pass: the same target restores cleanly afterwards"
# A signal while the load is being started, before its container runs, must
# not leave it to start and commit after the script has said "unchanged".
supabase_like t_race
touch "$work/delay"
(export PATH="$work/bin:$PATH" RESTORE_DATABASE_URL="postgresql://postgres:$SECRET_ENC@$ip:5432/t_race" BACKUP_AGE_IDENTITY="$work/key.txt"
 exec bash "$here/restore-supabase.sh" "$work/good.dump.age") > "$work/race.out" 2>&1 &
rpid=$!
for _ in $(seq 1 240); do [ -e "$work/delaying" ] && break; sleep 0.25; done
[ -e "$work/delaying" ] || { cat "$work/race.out" >&2; fail "the restore never started its load"; }
kill -TERM "$rpid"
status=0; wait "$rpid" || status=$?
rm -f "$work/delay"
[ "$status" != 0 ] || fail "a restore interrupted while starting its load exited 0"
grep -q 'interrupted before the restore committed' "$work/race.out" || { cat "$work/race.out" >&2; fail "no interrupt message"; }
# Long enough for a load left running to commit (it takes a few seconds).
for _ in $(seq 1 20); do
  untouched t_race || { cat "$work/race.out" >&2; fail "the load ran on and committed after the script said the project was unchanged"; }
  sleep 1
done
[ -z "$(restore_containers)" ] || fail "a restore interrupted while starting its load left a container"
echo "  pass: interrupted while starting the load: nothing ran on, nothing left"

echo "verify-restore-supabase: backup-db.sh against the same database"
# The real script in a throwaway checkout layout, held on a lock so its
# pg_dump process can be inspected while it runs.
mkdir -p "$work/repo/deploy" "$work/repo/backend" "$work/backups"
cp "$here/backup-db.sh" "$here/pg-credentials.sh" "$work/repo/deploy/"
echo "DIRECT_URL=postgresql://postgres:$SECRET_ENC@$ip:5432/src" > "$work/repo/backend/.env"
: > "$work/repo/.env"
docker exec "$DB" psql -U postgres -d src -c "BEGIN; LOCK zz_padding IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(300)" > /dev/null 2>&1 &
locker=$!
held src zz_padding AccessExclusiveLock
(export PATH="$work/bin:$PATH" BACKUP_DIR="$work/backups" BACKUP_ALLOW_UNVERIFIED=1; exec bash "$work/repo/deploy/backup-db.sh") > "$work/backup.out" 2>&1 &
bpid=$!
for _ in $(seq 1 240); do
  [ "$(psql_db src -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'src' AND wait_event_type = 'Lock' AND application_name = 'pg_dump'")" -ge 1 ] && break
  sleep 0.5
done
for c in $(docker ps -q --filter "ancestor=$PG_IMAGE"); do
  [ "$c" = "$(docker inspect -f '{{.Id}}' "$DB" | cut -c1-12)" ] && continue
  docker top "$c" >> "$work/top.log" 2>&1 || true
done
psql_db postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'src' AND query LIKE '%pg_sleep%'" > /dev/null
wait "$locker" 2>/dev/null || true; locker=""
wait "$bpid" || { cat "$work/backup.out" >&2; fail "backup-db.sh failed against a URL with an encoded password"; }
grep -q 'pg_dump' "$work/top.log" || fail "docker top saw no pg_dump process, so the argv check proved nothing"
echo "  pass: backup-db.sh dumped through PGPASSWORD"

echo "verify-restore-supabase: credentials"
for f in "$work"/argv.log "$work"/top.log "$work"/*.out; do
  if grep -qF -e "$SECRET" -e "$SECRET_ENC" "$f"; then fail "the password appears in $(basename "$f")"; fi
done
grep -q 'pg_restore' "$work/top.log" || fail "docker top saw no restore process, so the argv check proved nothing"
echo "  pass: no password in docker command lines, container processes or output"

echo "verify-restore-supabase: OK"
