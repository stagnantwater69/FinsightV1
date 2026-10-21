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
#
# What is in a dump: the application tables (public) and Supabase Auth's
# users (auth), so a restore keeps everyone's login. Storage objects (receipt
# images, CSVs) are NOT included; see docs/deployment-runbook.md section 6.2.
# A dump holds every owner's financial records and password hashes: keep the
# bucket private and set a lifecycle rule there to delete old copies.
set -euo pipefail

cd "$(dirname "$0")/.."
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

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
name="finsight-$(date -u +%Y%m%d-%H%M%S).dump"
file="$BACKUP_DIR/$name"
umask 077

schema_args=()
for schema in $SCHEMAS; do schema_args+=("--schema=$schema"); done

echo "backup: dumping ${SCHEMAS} to $file"
# The URL goes in through the environment, not the command line, so it never
# shows up in `ps`. --no-owner/--no-privileges: Supabase's roles do not exist
# in whatever database a restore targets.
if ! docker run --rm -e DIRECT_URL="$DIRECT_URL" "$PG_IMAGE" \
  sh -c 'pg_dump --format=custom --no-owner --no-privileges "$@" --dbname="$DIRECT_URL"' \
  pg_dump "${schema_args[@]}" > "$file.partial"; then
  rm -f "$file.partial"
  fail "pg_dump failed (above); no backup was written"
fi

# A dump that pg_restore cannot list is not a backup.
docker run --rm -i "$PG_IMAGE" pg_restore --list < "$file.partial" > /dev/null \
  || fail "the dump is unreadable; kept as $file.partial for inspection"
mv "$file.partial" "$file"
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
  docker run --rm \
    -e AWS_ACCESS_KEY_ID="$KEY_ID" -e AWS_SECRET_ACCESS_KEY="$SECRET" -e AWS_DEFAULT_REGION="$REGION" \
    -v "$BACKUP_DIR:/backups:ro" "$AWS_IMAGE" \
    s3 cp "/backups/$name" "s3://$BUCKET/finsight/$name" "${endpoint_args[@]}" --only-show-errors
else
  echo "backup: note: BACKUP_S3_BUCKET is empty, so this copy exists only on this VM"
fi

find "$BACKUP_DIR" -name 'finsight-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup: done"
