#!/usr/bin/env bash
# Daily Storage backup: copy every object in the app's Supabase Storage
# buckets (receipt images, CSV sources, avatars and logos), pack them into one
# tar, and keep and upload it the same way backup-db.sh keeps the database
# dump. A database restore does not bring Storage back; this does.
# deploy.sh installs a daily cron entry for this.
#
#   bash deploy/backup-storage.sh
#
# Settings, in the .env next to docker-compose.yml:
#   STORAGE_BACKUP_S3_ENDPOINT    Supabase's S3 endpoint for the project:
#                                 https://<project-ref>.supabase.co/storage/v1/s3
#   STORAGE_BACKUP_S3_REGION      the project's region, e.g. ap-southeast-1
#   STORAGE_BACKUP_ACCESS_KEY_ID  an S3 access key from Supabase
#   STORAGE_BACKUP_SECRET_ACCESS_KEY  (Project Settings > Storage > S3 access keys)
#   STORAGE_BACKUP_BUCKETS        default "receipts csv-imports avatars"
# and, shared with backup-db.sh: BACKUP_AGE_RECIPIENT, BACKUP_S3_BUCKET,
# BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY_ID,
# BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_KEEP_DAYS.
#
# Without the STORAGE_BACKUP_* keys this does nothing and says so. The objects
# are only ever plaintext in a temporary folder that is deleted on exit; with
# BACKUP_AGE_RECIPIENT set, only the encrypted .tar.age is kept or uploaded,
# and uploading without it is refused, as for the database dump.
#
# Restore: decrypt, untar, and upload each bucket folder back with
# `aws s3 sync <folder> s3://<bucket> --endpoint-url <the same endpoint>`.
set -euo pipefail

cd "$(dirname "$0")/.."
readonly BACKUP_DIR="${BACKUP_DIR:-$HOME/finsight-backups}"
readonly AWS_IMAGE=amazon/aws-cli:2.17.0

fail() { echo "storage-backup: $*" >&2; exit 1; }

env_value() {
  local file=$1 key=$2
  [ -f "$file" ] || return 0
  { grep -E "^${key}=" "$file" || true; } | tail -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

SOURCE_ENDPOINT=$(env_value .env STORAGE_BACKUP_S3_ENDPOINT)
SOURCE_REGION=$(env_value .env STORAGE_BACKUP_S3_REGION)
SOURCE_KEY_ID=$(env_value .env STORAGE_BACKUP_ACCESS_KEY_ID)
SOURCE_SECRET=$(env_value .env STORAGE_BACKUP_SECRET_ACCESS_KEY)
BUCKETS=$(env_value .env STORAGE_BACKUP_BUCKETS); BUCKETS=${BUCKETS:-receipts csv-imports avatars}
BUCKET=$(env_value .env BACKUP_S3_BUCKET)
KEEP_DAYS=$(env_value .env BACKUP_KEEP_DAYS); KEEP_DAYS=${KEEP_DAYS:-7}
RECIPIENT=$(env_value .env BACKUP_AGE_RECIPIENT)

if [ -z "$SOURCE_ENDPOINT" ] || [ -z "$SOURCE_KEY_ID" ] || [ -z "$SOURCE_SECRET" ]; then
  echo "storage-backup: note: STORAGE_BACKUP_S3_ENDPOINT and its access keys are not set, so Storage is not backed up"
  exit 0
fi

if [ -n "$RECIPIENT" ]; then
  command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT is set but age is not installed (sudo apt-get install age)"
  case "$RECIPIENT" in age1*) ;; *) fail "BACKUP_AGE_RECIPIENT must be an age public key (age1...)" ;; esac
elif [ -n "$BUCKET" ]; then
  fail "BACKUP_S3_BUCKET is set but BACKUP_AGE_RECIPIENT is not; refusing to upload unencrypted receipt images"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
umask 077
scratch=$(mktemp -d "$BACKUP_DIR/.storage-XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
name="finsight-storage-$(date -u +%Y%m%d-%H%M%S).tar"
file="$BACKUP_DIR/$name"

# Passed by name so no key shows up in `ps` (see backup-db.sh).
export AWS_ACCESS_KEY_ID="$SOURCE_KEY_ID" AWS_SECRET_ACCESS_KEY="$SOURCE_SECRET" AWS_DEFAULT_REGION="${SOURCE_REGION:-us-east-1}"
for bucket in $BUCKETS; do
  echo "storage-backup: copying $bucket"
  mkdir -p "$scratch/$bucket"
  docker run --rm --user "$(id -u):$(id -g)" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -v "$scratch/$bucket:/out" "$AWS_IMAGE" \
    s3 sync "s3://$bucket" /out --endpoint-url "$SOURCE_ENDPOINT" --only-show-errors \
    || fail "copying bucket $bucket failed (above); no backup was written"
done
tar -cf "$file.partial" -C "$scratch" $BUCKETS
mv "$file.partial" "$file"
echo "storage-backup: $(find "$scratch" -type f | wc -l | tr -d ' ') objects"

if [ -n "$RECIPIENT" ]; then
  age --encrypt --recipient "$RECIPIENT" --output "$file.age.partial" "$file" \
    || { rm -f "$file" "$file.age.partial"; fail "encryption failed; nothing was kept"; }
  mv "$file.age.partial" "$file.age"
  rm -f "$file"
  name="$name.age"
  file="$file.age"
else
  echo "storage-backup: note: BACKUP_AGE_RECIPIENT is empty, so this copy is not encrypted"
fi
echo "storage-backup: wrote $(du -h "$file" | cut -f1)"

if [ -n "$BUCKET" ]; then
  ENDPOINT=$(env_value .env BACKUP_S3_ENDPOINT)
  REGION=$(env_value .env BACKUP_S3_REGION); REGION=${REGION:-us-east-1}
  KEY_ID=$(env_value .env BACKUP_S3_ACCESS_KEY_ID)
  SECRET=$(env_value .env BACKUP_S3_SECRET_ACCESS_KEY)
  [ -n "$KEY_ID" ] && [ -n "$SECRET" ] || fail "BACKUP_S3_BUCKET is set but its access keys are not"
  endpoint_args=()
  [ -n "$ENDPOINT" ] && endpoint_args=(--endpoint-url "$ENDPOINT")
  echo "storage-backup: copying to s3://$BUCKET/finsight/$name"
  export AWS_ACCESS_KEY_ID="$KEY_ID" AWS_SECRET_ACCESS_KEY="$SECRET" AWS_DEFAULT_REGION="$REGION"
  docker run --rm \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -v "$BACKUP_DIR:/backups:ro" "$AWS_IMAGE" \
    s3 cp "/backups/$name" "s3://$BUCKET/finsight/$name" "${endpoint_args[@]}" --only-show-errors
else
  echo "storage-backup: note: BACKUP_S3_BUCKET is empty, so this copy exists only on this VM"
fi

find "$BACKUP_DIR" -maxdepth 1 \( -name 'finsight-storage-*.tar' -o -name 'finsight-storage-*.tar.age' \) -mtime +"$KEEP_DAYS" -delete
echo "storage-backup: done"
