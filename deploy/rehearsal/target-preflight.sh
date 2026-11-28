#!/usr/bin/env bash
# Read-only look at a restore target before anything is written to it:
# whether containers can reach it, TLS, the extensions and privileges
# restore-supabase.sh needs, rows a "new" project already has, and the Auth
# and Storage settings no backup carries. Prints no secret. Exit 1 if
# restore-supabase.sh would refuse the target or could not work on it.
#
#   TARGET_DB_URL=... TARGET_API_URL=https://<ref>.supabase.co \
#   TARGET_ANON_KEY=... TARGET_SERVICE_ROLE_KEY=... \
#   [TARGET_CA_CERT=supabase-ca.crt] [TARGET_REQUIRE_TLS=1] bash deploy/rehearsal/target-preflight.sh
#
# Every query runs in a READ ONLY transaction, so it cannot write even by mistake.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/pg-credentials.sh
. "$here/../pg-credentials.sh"
readonly PG_IMAGE=postgres:17-alpine
blocked=0
say() { echo "preflight: $*"; }
# Keys go over HTTPS only (curl verifies the certificate by default), except
# to an API on this machine.
proto='=https'
case "${TARGET_API_URL:-}" in http://127.0.0.1:*|http://localhost:*) proto='=http,https' ;; esac
# keyed_get <key> <url>: the key goes to curl on stdin, not on its command line.
keyed_get() { printf 'header = "apikey: %s"\nheader = "authorization: Bearer %s"\n' "$1" "$1" | curl -s --proto "$proto" --max-time 10 -K - "$2"; }
block() { blocked=1; echo "preflight: BLOCKED: $*"; }

[ -n "${TARGET_DB_URL:-}" ] || { echo "preflight: set TARGET_DB_URL" >&2; exit 2; }
pg_split_url "$TARGET_DB_URL" || exit 2
host=${PG_URL#*@}; host=${host%%[:/?]*}

# Docker's default network has no IPv6, and Supabase's direct host may have no IPv4.
say "DNS $host: $(node -e 'require("dns").lookup(process.argv[1], { all: true }, (e, a) => console.log(e ? "lookup failed (" + e.code + ")" : a.map((x) => "IPv" + x.family).sort().filter((v, i, s) => s.indexOf(v) === i).join(" ")))' "$host")"

# With a CA, every connection verifies the server certificate and host name
# (verify-full), so the password goes to no unverified server. TLS required
# and no CA: stop before connecting at all.
PG_TLS=()
if [ -n "${TARGET_CA_CERT:-}" ]; then
  pg_verify_tls "$TARGET_CA_CERT" 2> /dev/null || { block "cannot verify the server: $(pg_verify_tls "$TARGET_CA_CERT" 2>&1)"; exit 1; }
elif [ "${TARGET_REQUIRE_TLS:-0}" = 1 ]; then
  block "a verified TLS connection is required: set TARGET_CA_CERT to the project's CA certificate (nothing was sent to the target)"; exit 1
fi
sql() { MSYS_NO_PATHCONV=1 docker run --rm -i -e PGPASSWORD "${PG_TLS[@]}" "$PG_IMAGE" psql -X -v ON_ERROR_STOP=1 -qtA -d "$PG_URL" "$@"; }
err=$(mktemp); trap 'rm -f "$err"' EXIT

# \conninfo reports this client's own connection, i.e. the hop to a pooler;
# pg_stat_ssl below sees only the server's side of its session.
if ! conninfo=$(sql -c '\conninfo' 2> "$err"); then
  block "a container cannot connect: $(grep -m1 -v '^$' "$err")"; exit 1
fi
say "a container connects (default Docker network)"
if tls=$(grep -o 'SSL connection ([^,]*' <<< "$conninfo"); then say "tls from this client: on ${tls#*: }"
else say "tls from this client: off"; fi
if [ -n "${TARGET_CA_CERT:-}" ]; then
  say "TLS server certificate and host name verified against $(basename "$TARGET_CA_CERT") (verify-full, every connection)"
else
  say "TLS server certificate not verified (no TARGET_CA_CERT given)"
fi

report=$(sql 2> "$err" <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT 'server ' || current_setting('server_version') || ', user ' || current_user
       || ', superuser ' || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
SELECT 'server session tls ' || COALESCE((SELECT CASE WHEN ssl THEN 'on ' || version || ' ' || cipher ELSE 'off' END
                             FROM pg_stat_ssl WHERE pid = pg_backend_pid()), 'unknown');
SELECT 'schema extensions ' || CASE WHEN to_regnamespace('extensions') IS NULL THEN 'MISSING' ELSE 'present' END;
SELECT 'extension pg_trgm ' || COALESCE(
  (SELECT 'installed in ' || n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'),
  CASE WHEN EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN 'available' ELSE 'MISSING' END);
SELECT 'auth migration ' || COALESCE((SELECT max(version) FROM auth.schema_migrations), 'none');
SELECT 'auth table ' || c.relname
       || ' rows ' || CASE WHEN has_table_privilege(c.oid, 'SELECT')
            THEN (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM auth.%I', c.relname), false, true, '')))[1]::text
            ELSE 'unreadable' END
       || ' insert ' || has_table_privilege(c.oid, 'INSERT') || ' delete ' || has_table_privilege(c.oid, 'DELETE')
  FROM pg_class c WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind IN ('r', 'p') ORDER BY c.relname;
SELECT 'auth sequence ' || c.relname || ' setval ' || has_sequence_privilege(c.oid, 'UPDATE')
  FROM pg_class c WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind = 'S' ORDER BY c.relname;
SELECT 'auth trigger ' || t.tgrelid::regclass || ' ' || t.tgname
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.relnamespace = 'auth'::regnamespace ORDER BY 1;
SELECT 'public tables ' || count(*) FROM pg_tables WHERE schemaname = 'public';
SELECT 'public create ' || has_schema_privilege('public', 'CREATE');
SELECT CASE WHEN to_regclass('storage.buckets') IS NULL THEN 'storage absent'
            ELSE 'storage buckets ' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM storage.buckets', false, true, '')))[1]::text
              || ' objects ' || (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM storage.objects', false, true, '')))[1]::text END;
COMMIT;
SQL
) || { block "the inspection queries failed: $(grep -m1 -v '^$' "$err")"; exit 1; }
while IFS= read -r line; do say "$line"; done <<< "$report"

[ -n "$tls" ] || { [ "${TARGET_REQUIRE_TLS:-0}" = 1 ] && block "the connection is not encrypted"; true; }
grep -q '^schema extensions present' <<< "$report" || block "no extensions schema (pg_trgm goes there)"
grep -q '^extension pg_trgm MISSING' <<< "$report" && block "pg_trgm is not available"
while read -r _ _ table _ rows _ ins _ del; do
  [ "$table" = schema_migrations ] && continue
  [ "$rows" = 0 ] || block "auth.$table has $rows rows: restore-supabase.sh refuses a project with any (do not delete them to get past it)"
  [ "$ins" = true ] || block "this role cannot insert into auth.$table"
  [ "$del" = true ] || say "note: this role cannot delete from auth.$table (the session revoke needs it on sessions and refresh_tokens)"
done < <(grep '^auth table ' <<< "$report")
while read -r _ _ seq _ ok; do
  [ "$ok" = true ] || block "this role cannot set auth sequence $seq"
done < <(grep '^auth sequence ' <<< "$report")
grep -q '^auth trigger ' <<< "$report" && say "note: triggers on auth tables fire during the restore (listed above)"
grep -q '^public tables 0$' <<< "$report" || block "public already has tables"
grep -q '^public create true$' <<< "$report" || block "this role cannot create in public"

# Settings that live outside Postgres, as far as public endpoints show them.
if [ -n "${TARGET_API_URL:-}" ]; then
  say "signing keys (JWKS): $(curl -s --proto "$proto" --max-time 10 "$TARGET_API_URL/auth/v1/.well-known/jwks.json" \
    | node -e 'let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => { try { const k = JSON.parse(s).keys ?? []; console.log(k.length ? k.map((x) => `${x.alg ?? x.kty} ${x.kid}`).join(", ") : "none published (shared-secret HS256 only)"); } catch { console.log("unreadable"); } })')"
  [ -z "${TARGET_ANON_KEY:-}" ] || say "auth settings: $(keyed_get "$TARGET_ANON_KEY" "$TARGET_API_URL/auth/v1/settings" \
    | node -e 'let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => { try { const j = JSON.parse(s); const on = Object.entries(j.external ?? {}).filter(([, v]) => v).map(([k]) => k); console.log(`providers ${on.join(" ") || "none"}; disable_signup ${j.disable_signup}; mailer_autoconfirm ${j.mailer_autoconfirm}; phone_autoconfirm ${j.phone_autoconfirm}; saml ${j.saml_enabled}`); } catch { console.log("unreadable"); } })')"
  [ -z "${TARGET_SERVICE_ROLE_KEY:-}" ] || say "buckets: $(keyed_get "$TARGET_SERVICE_ROLE_KEY" "$TARGET_API_URL/storage/v1/bucket" \
    | node -e 'let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => { try { const b = JSON.parse(s); console.log(b.length ? b.map((x) => `${x.id} public=${x.public} limit=${x.file_size_limit} types=${(x.allowed_mime_types ?? []).join("|") || "any"}`).join("; ") : "none"); } catch { console.log("unreadable"); } })')"
fi

[ "$blocked" = 0 ] && say "OK: restore-supabase.sh can run on this target" || say "not ready (BLOCKED lines above)"
exit "$blocked"
