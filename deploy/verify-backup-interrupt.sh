#!/usr/bin/env bash
# Checks that a backup stopped part-way leaves no readable copy behind, and
# that a finished one keeps only the encrypted file. Fake docker and age stand
# in for the real ones, so no database, bucket or key is involved. CI runs it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/repo/deploy" "$work/repo/backend" "$work/bin"
cp "$here/backup-db.sh" "$here/backup-storage.sh" "$here/pg-credentials.sh" "$work/repo/deploy/"
# A password that needs URL encoding, so a leak of either form is detectable.
readonly SECRET='Bk-p@ss:w0rd%x' SECRET_ENC='Bk-p%40ss%3Aw0rd%25x'
echo "DIRECT_URL=postgresql://verify:$SECRET_ENC@127.0.0.1:1/none?sslmode=require" > "$work/repo/backend/.env"
# The cases below up to the TLS ones use a database URL with no CA certificate.
export BACKUP_ALLOW_UNVERIFIED=1
cat > "$work/repo/.env" <<'EOF'
BACKUP_AGE_RECIPIENT=age1verifyonly
STORAGE_BACKUP_S3_ENDPOINT=http://127.0.0.1:1
STORAGE_BACKUP_ACCESS_KEY_ID=verify
STORAGE_BACKUP_SECRET_ACCESS_KEY=verify
STORAGE_BACKUP_BUCKETS=receipts
EOF

# FAKE_SLOW names the step that stalls long enough to be interrupted.
cat > "$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" pg_dump "*)
    # What `ps` would show, and the password docker would hand the container.
    [ -z "${ARGV_LOG:-}" ] || { printf '%s\n' "$*" >> "$ARGV_LOG"; printf '%s' "${PGPASSWORD:-}" > "$ARGV_LOG.env"; }
    printf 'PGDMP plaintext'; [ "${FAKE_SLOW:-}" != dump ] || sleep 2 ;;
  *"pg_restore --list"*) cat > /dev/null ;;
  *" s3 sync "*)
    while [ $# -gt 0 ]; do [ "$1" = -v ] && out=${2%:/out}; shift; done
    printf 'plaintext receipt' > "$out/receipt.jpg"; [ "${FAKE_SLOW:-}" != sync ] || sleep 2 ;;
esac
EOF
cat > "$work/bin/age" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case $1 in --output) out=$2; shift 2 ;; --encrypt) shift ;; --recipient) shift 2 ;; *) in=$1; shift ;; esac; done
[ "${FAKE_SLOW:-}" != age ] || sleep 2
cp "$in" "$out"
EOF
chmod +x "$work/bin/docker" "$work/bin/age"

fail() { echo "verify-backup-interrupt: $*" >&2; exit 1; }

# interrupt <script> <slow step> <file pattern that shows the step started>
interrupt() {
  local dir="$work/backups-$2-$1"
  mkdir -p "$dir"
  PATH="$work/bin:$PATH" BACKUP_DIR="$dir" FAKE_SLOW=$2 bash "$work/repo/deploy/$1" > "$dir.log" 2>&1 &
  local pid=$! _
  for _ in $(seq 1 100); do compgen -G "$dir/$3" > /dev/null && break; sleep 0.05; done
  compgen -G "$dir/$3" > /dev/null || { cat "$dir.log" >&2; fail "$1 never reached $2"; }
  kill -TERM "$pid"
  wait "$pid" && fail "$1 finished despite being stopped during $2" || true
  local left
  left=$(find "$dir" -mindepth 1 | sed "s#^$dir/##")
  [ -z "$left" ] || fail "$1 stopped during $2 left: $left"
}

interrupt backup-db.sh dump 'finsight-*.dump.partial'
interrupt backup-db.sh age 'finsight-*.dump'
interrupt backup-storage.sh sync '.storage-*/receipts/receipt.jpg'
interrupt backup-storage.sh age 'finsight-storage-*.tar'

# What a SIGKILLed run leaves is swept by the next run once 12 hours old; a
# fresh one (perhaps a run still going) and finished backups are left alone.
for script in backup-db.sh backup-storage.sh; do
  dir="$work/backups-sweep-$script"
  mkdir -p "$dir/.storage-old/receipts" "$dir/.storage-new"
  touch "$dir/finsight-old.dump.partial" "$dir/finsight-new.dump.age.partial" "$dir/finsight-kept.dump.age" "$dir/finsight-storage-kept.tar.age"
  touch -d '2 days ago' "$dir/finsight-old.dump.partial" "$dir/.storage-old" "$dir/finsight-kept.dump.age" "$dir/finsight-storage-kept.tar.age"
  PATH="$work/bin:$PATH" BACKUP_DIR="$dir" bash "$work/repo/deploy/$script" > /dev/null
  left=$(find "$dir" -maxdepth 1 -mindepth 1 \( -name '*old*' -o -name '*new*' -o -name '*kept*' \) | sed "s#^$dir/##" | sort | tr '\n' ' ')
  [ "$left" = ".storage-new finsight-kept.dump.age finsight-new.dump.age.partial finsight-storage-kept.tar.age " ] || fail "$script sweep left: $left"
done

done_dir="$work/backups-complete"
mkdir -p "$done_dir"
PATH="$work/bin:$PATH" BACKUP_DIR="$done_dir" ARGV_LOG="$work/argv.log" bash "$work/repo/deploy/backup-db.sh" > "$work/db.out" 2>&1
PATH="$work/bin:$PATH" BACKUP_DIR="$done_dir" bash "$work/repo/deploy/backup-storage.sh" > /dev/null
kept=$(find "$done_dir" -mindepth 1 | sed "s#^$done_dir/##" | sed -E 's/[0-9]{8}-[0-9]{6}/T/' | sort | tr '\n' ' ')
[ "$kept" = "finsight-T.dump.age finsight-storage-T.tar.age " ] || fail "a finished run kept: $kept"

# The database password is on no command line (docker's own, or pg_dump's in
# the container: both show in `ps`) and in no output; docker gets it by name.
if grep -qF -e "$SECRET" -e "$SECRET_ENC" "$work/argv.log" "$work/db.out"; then fail "the database password is on a command line or in the output"; fi
grep -q -- '-e PGPASSWORD ' "$work/argv.log" || fail "pg_dump's container is not given PGPASSWORD"
grep -qF -- '--dbname=postgresql://verify@127.0.0.1:1/none?sslmode=require' "$work/argv.log" \
  || { cat "$work/argv.log" >&2; fail "pg_dump did not get the URL minus its password"; }
[ "$(cat "$work/argv.log.env")" = "$SECRET" ] || fail "PGPASSWORD is not the decoded password"

# Without a recipient the plaintext is the only copy and must survive.
sed -i '/^BACKUP_AGE_RECIPIENT=/d' "$work/repo/.env"
plain_dir="$work/backups-unencrypted"
mkdir -p "$plain_dir"
PATH="$work/bin:$PATH" BACKUP_DIR="$plain_dir" bash "$work/repo/deploy/backup-db.sh" > /dev/null
PATH="$work/bin:$PATH" BACKUP_DIR="$plain_dir" bash "$work/repo/deploy/backup-storage.sh" > /dev/null
kept=$(find "$plain_dir" -mindepth 1 | sed "s#^$plain_dir/##" | sed -E 's/[0-9]{8}-[0-9]{6}/T/' | sort | tr '\n' ' ')
[ "$kept" = "finsight-T.dump finsight-storage-T.tar " ] || fail "an unencrypted run kept: $kept"

# TLS: a DIRECT_URL with Prisma's settings reaches libpq without its query (libpq
# rejects sslaccept and reads sslcert as a client certificate), verifying the
# chain and host name against the same CA file, mounted from backend/certs.
unset BACKUP_ALLOW_UNVERIFIED
tls_dir="$work/backups-tls"
mkdir -p "$tls_dir" "$work/repo/backend/certs"
cp "$here/../backend/tests/fixtures/database-tls/test-ca.crt" "$work/repo/backend/certs/db-ca.crt"
echo "DIRECT_URL=postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require&sslcert=/app/certs/db-ca.crt&sslaccept=strict" > "$work/repo/backend/.env"
: > "$work/argv.log"
PATH="$work/bin:$PATH" BACKUP_DIR="$tls_dir" ARGV_LOG="$work/argv.log" bash "$work/repo/deploy/backup-db.sh" > "$work/tls.out" 2>&1   || { cat "$work/tls.out" >&2; fail "backup-db.sh failed with a verified DIRECT_URL"; }
grep -qE -- '-v [^ ]*/backend/certs/db-ca\.crt:/etc/finsight-ca\.crt:ro -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/etc/finsight-ca\.crt -e PGGSSENCMODE=disable ' "$work/argv.log"   || { cat "$work/argv.log" >&2; fail "pg_dump was not told to verify against backend/certs/db-ca.crt"; }
grep -qE -- '--dbname=postgresql://verify@db\.example\.invalid:5432/postgres$' "$work/argv.log"   || { cat "$work/argv.log" >&2; fail "pg_dump got Prisma's TLS parameters"; }
# refuses <label> <DIRECT_URL> <expected message>: no pg_dump runs at all.
refuses() {
  echo "DIRECT_URL=$2" > "$work/repo/backend/.env"
  : > "$work/argv.log"
  if PATH="$work/bin:$PATH" BACKUP_DIR="$tls_dir" ARGV_LOG="$work/argv.log" bash "$work/repo/deploy/backup-db.sh" > "$work/tls.out" 2>&1; then
    fail "backup-db.sh accepted $1"
  fi
  grep -qF -- "$3" "$work/tls.out" || { cat "$work/tls.out" >&2; fail "backup-db.sh refused $1 without saying: $3"; }
  [ ! -s "$work/argv.log" ] || fail "backup-db.sh ran pg_dump for $1"
}
refuses "a URL without a CA" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require" "needs one plain sslcert=/app/certs/<file>"
refuses "a URL with no TLS settings" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres" "needs one plain sslcert=/app/certs/<file>"
refuses "a missing CA file" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require&sslcert=/app/certs/none.crt&sslaccept=strict" "no PEM CA certificate"
refuses "a CA path outside /app/certs" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require&sslcert=/app/certs/../certs/db-ca.crt&sslaccept=strict" "needs one plain sslcert=/app/certs/<file>"
# Prisma would decode these to db-ca.crt (or a space); this script must not open another file.
refuses "a percent-encoded CA name" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require&sslcert=/app/certs/db%2Dca.crt&sslaccept=strict" "needs one plain sslcert=/app/certs/<file>"
refuses "a CA name with +" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require&sslcert=/app/certs/db+ca.crt&sslaccept=strict" "needs one plain sslcert=/app/certs/<file>"
refuses "two CA files" "postgresql://verify:$SECRET_ENC@db.example.invalid:5432/postgres?sslmode=require&sslcert=/app/certs/db-ca.crt&sslcert=/app/certs/db-ca.crt&sslaccept=strict" "needs one plain sslcert=/app/certs/<file>"

echo "verify-backup-interrupt: OK"
