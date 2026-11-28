#!/usr/bin/env bash
# Daily database backup: dump, check it is readable, keep it on this VM for
# BACKUP_KEEP_DAYS, and copy it to S3-compatible storage (Backblaze B2,
# DigitalOcean Spaces, Cloudflare R2, AWS S3) when that is configured.
# deploy.sh installs a daily cron entry for this.
#
#   bash deploy/backup-db.sh
#
# Settings, in the .env next to docker-compose.yml:
#   BACKUP_S3_BUCKET              bucket name; empty keeps backups on this VM only
#   BACKUP_S3_ENDPOINT            e.g. https://s3.us-west-004.backblazeb2.com (empty for AWS)
#   BACKUP_S3_REGION              defaults to us-east-1 (R2 uses "auto")
#   BACKUP_S3_ACCESS_KEY_ID       a key that can only write to that bucket
#   BACKUP_S3_SECRET_ACCESS_KEY
#   BACKUP_KEEP_DAYS              local copies to keep, default 7
#   BACKUP_SCHEMAS                default "public auth"
#   BACKUP_AGE_RECIPIENT          an age public key (age1...); each dump is
#                                 encrypted to it before it is kept or copied
#
# Encryption: with BACKUP_AGE_RECIPIENT set, only the encrypted .dump.age is
# kept or uploaded, and the plaintext is deleted. The private key belongs off
# this VM (a password manager), so neither a leaked bucket key nor a stolen VM
# disk can read old backups. Create the pair anywhere with `age-keygen`.
# Uploading without it is refused: the bucket would then be the only thing
# between the internet and every owner's records.
#
# What is in a dump: the application tables (public) and Supabase Auth's
# users (auth), so a restore keeps everyone's login. Storage objects (receipt
# images, CSVs) are NOT included; see docs/deployment-runbook.md section 6.2.
# A dump holds every owner's financial records and password hashes: keep the
# bucket private and set a lifecycle rule there to delete old copies.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=deploy/pg-credentials.sh
. deploy/pg-credentials.sh
readonly BACKUP_DIR="${BACKUP_DIR:-$HOME/finsight-backups}"
# pg_dump must be at least the server's major version; 17 also reads older ones.
readonly PG_IMAGE=postgres:17-alpine
readonly AWS_IMAGE=amazon/aws-cli:2.17.0

fail() { echo "backup: $*" >&2; exit 1; }

env_value() {
  local file=$1 key=$2
  [ -f "$file" ] || return 0
  { grep -E "^${key}=" "$file" || true; } | tail -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

[ -f backend/.env ] || fail "missing backend/.env"
DIRECT_URL=$(env_value backend/.env DIRECT_URL)
[ -n "$DIRECT_URL" ] || fail "DIRECT_URL is empty in backend/.env"

BUCKET=$(env_value .env BACKUP_S3_BUCKET)
KEEP_DAYS=$(env_value .env BACKUP_KEEP_DAYS); KEEP_DAYS=${KEEP_DAYS:-7}
SCHEMAS=$(env_value .env BACKUP_SCHEMAS); SCHEMAS=${SCHEMAS:-public auth}
RECIPIENT=$(env_value .env BACKUP_AGE_RECIPIENT)

if [ -n "$RECIPIENT" ]; then
  command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT is set but age is not installed (sudo apt-get install age)"
  case "$RECIPIENT" in age1*) ;; *) fail "BACKUP_AGE_RECIPIENT must be an age public key (age1...)" ;; esac
elif [ -n "$BUCKET" ]; then
  fail "BACKUP_S3_BUCKET is set but BACKUP_AGE_RECIPIENT is not; refusing to upload an unencrypted dump. Run age-keygen on your own machine, keep the private key off this VM, and set BACKUP_AGE_RECIPIENT to the public key"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
name="finsight-$(date -u +%Y%m%d-%H%M%S).dump"
file="$BACKUP_DIR/$name"
umask 077
# A run killed outright (SIGKILL, power loss) never reaches the trap below.
# 12 hours old: gone by the next daily run, and far longer than any run takes.
find "$BACKUP_DIR" -maxdepth 1 \( -name 'finsight-*.partial' -o -name '.storage-*' \) -mmin +720 -exec rm -rf -- {} +

# A run stopped part-way (a reboot, a kill) must not leave a readable dump
# behind: no later run deletes a .partial, and the encryption exists so this
# disk never keeps one. $file is renamed to the .age below, hence the copy.
readonly plain="$file"
on_signal() {
  rm -f -- "$plain.partial" "$plain.age.partial"
  [ -z "$RECIPIENT" ] || rm -f -- "$plain"
  echo "backup: interrupted; the unfinished dump was deleted" >&2
  exit 1
}
trap on_signal INT TERM HUP

schema_args=()
for schema in $SCHEMAS; do schema_args+=("--schema=$schema"); done

echo "backup: dumping ${SCHEMAS} to $file"
# The password reaches pg_dump only as PGPASSWORD, passed to docker by name, so
# it is in no command line: not docker's, and not pg_dump's inside the
# container (`ps` and `docker top` show both). PG_URL has no password.
# --no-owner/--no-privileges: Supabase's roles do not exist in whatever
# database a restore targets.
pg_split_url "$DIRECT_URL" || fail "DIRECT_URL in backend/.env is not usable (above)"
# DIRECT_URL carries Prisma's TLS settings (backend/.env.example, database TLS),
# which libpq rejects or reads differently (its sslcert is a client
# certificate). So the query is dropped and libpq verifies the chain and host
# name itself, against the same CA file on this side of the container mount.
# Without that file, libpq's default would accept any certificate, or none.
PG_TLS=()
if ca=$(pg_mounted_ca "$PG_URL"); then
  PG_URL=${PG_URL%%\?*}
  pg_verify_tls "$ca" || fail "DIRECT_URL's CA certificate is not usable (above)"
elif [ "${BACKUP_ALLOW_UNVERIFIED:-}" = 1 ]; then
  echo "backup: note: BACKUP_ALLOW_UNVERIFIED=1, so the database's certificate is not checked"
else
  fail "DIRECT_URL in backend/.env needs one plain sslcert=/app/certs/<file> (see backend/.env.example, database TLS); BACKUP_ALLOW_UNVERIFIED=1 skips the check for a local test database"
fi
if ! MSYS_NO_PATHCONV=1 docker run --rm -e PGPASSWORD "${PG_TLS[@]}" "$PG_IMAGE" \
  pg_dump --format=custom --no-owner --no-privileges "${schema_args[@]}" --dbname="$PG_URL" > "$file.partial"; then
  rm -f "$file.partial"
  fail "pg_dump failed (above); no backup was written"
fi

# A dump that pg_restore cannot list is not a backup.
docker run --rm -i "$PG_IMAGE" pg_restore --list < "$file.partial" > /dev/null \
  || fail "the dump is unreadable; kept as $file.partial for inspection until the next run deletes it"
mv "$file.partial" "$file"

if [ -n "$RECIPIENT" ]; then
  age --encrypt --recipient "$RECIPIENT" --output "$file.age.partial" "$file" \
    || { rm -f "$file.age.partial"; fail "encryption failed; the plaintext dump was kept at $file"; }
  mv "$file.age.partial" "$file.age"
  rm -f "$file"
  name="$name.age"
  file="$file.age"
else
  echo "backup: note: BACKUP_AGE_RECIPIENT is empty, so this dump is not encrypted"
fi
echo "backup: wrote $(du -h "$file" | cut -f1)"

if [ -n "$BUCKET" ]; then
  ENDPOINT=$(env_value .env BACKUP_S3_ENDPOINT)
  REGION=$(env_value .env BACKUP_S3_REGION); REGION=${REGION:-us-east-1}
  KEY_ID=$(env_value .env BACKUP_S3_ACCESS_KEY_ID)
  SECRET=$(env_value .env BACKUP_S3_SECRET_ACCESS_KEY)
  [ -n "$KEY_ID" ] && [ -n "$SECRET" ] || fail "BACKUP_S3_BUCKET is set but its access keys are not"
  endpoint_args=()
  [ -n "$ENDPOINT" ] && endpoint_args=(--endpoint-url "$ENDPOINT")
  echo "backup: copying to s3://$BUCKET/finsight/$name"
  # Exported and passed by name, for the same reason as DIRECT_URL above.
  export AWS_ACCESS_KEY_ID="$KEY_ID" AWS_SECRET_ACCESS_KEY="$SECRET" AWS_DEFAULT_REGION="$REGION"
  docker run --rm \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -v "$BACKUP_DIR:/backups:ro" "$AWS_IMAGE" \
    s3 cp "/backups/$name" "s3://$BUCKET/finsight/$name" "${endpoint_args[@]}" --only-show-errors
else
  echo "backup: note: BACKUP_S3_BUCKET is empty, so this copy exists only on this VM"
fi

find "$BACKUP_DIR" \( -name 'finsight-*.dump' -o -name 'finsight-*.dump.age' \) -mtime +"$KEEP_DAYS" -delete
echo "backup: done"
