#!/usr/bin/env bash
# Build and start FinSight on the VM. Run as the `finsight` user from anywhere
# inside the repository clone:
#
#   bash deploy/deploy.sh             # pull, build, (first time: certificate), start
#   bash deploy/deploy.sh --migrate   # the same, applying pending migrations first
#   bash deploy/deploy.sh --no-pull   # deploy the checkout as it is
#
# It refuses to start with settings that are wrong for production (see
# check_env below) and with unapplied migrations unless --migrate is given.
# Take a database backup before using --migrate: Prisma has no rollback.
set -euo pipefail

cd "$(dirname "$0")/.."
readonly COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

migrate=0
pull=1
for arg in "$@"; do
  case "$arg" in
    --migrate) migrate=1 ;;
    --no-pull) pull=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

fail() { echo "deploy: $*" >&2; exit 1; }

# Reads KEY's value from an env file, without quotes. Never echoes the file.
env_value() {
  local file=$1 key=$2
  { grep -E "^${key}=" "$file" || true; } | tail -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

check_env() {
  [ -f .env ] || fail "missing .env next to docker-compose.yml (DOMAIN, LETSENCRYPT_EMAIL)"
  [ -f backend/.env ] || fail "missing backend/.env (copy backend/.env.example and fill in production values)"
  [ -f web/.env.production ] || fail "missing web/.env.production (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE_URL=/api/v1)"

  DOMAIN=$(env_value .env DOMAIN)
  LETSENCRYPT_EMAIL=$(env_value .env LETSENCRYPT_EMAIL)
  [ -n "$DOMAIN" ] || fail "DOMAIN is empty in .env"
  [ -n "$LETSENCRYPT_EMAIL" ] || fail "LETSENCRYPT_EMAIL is empty in .env"

  local b=backend/.env
  [ "$(env_value $b NODE_ENV)" = production ] || fail "backend/.env: NODE_ENV must be production"
  [ "$(env_value $b TRUST_PROXY_HOPS)" = 1 ] || fail "backend/.env: TRUST_PROXY_HOPS must be 1 (one nginx in front)"
  env_value $b CORS_ORIGIN | tr ',' '\n' | grep -qx "https://$DOMAIN" \
    || fail "backend/.env: CORS_ORIGIN must include https://$DOMAIN"
  [ "$(env_value $b WEB_APP_URL)" = "https://$DOMAIN" ] || fail "backend/.env: WEB_APP_URL must be https://$DOMAIN"
  local key
  for key in DATABASE_URL DIRECT_URL SUPABASE_URL; do
    if env_value $b $key | grep -qE 'localhost|127\.0\.0\.1'; then
      fail "backend/.env: $key points at this machine"
    fi
  done
  # Supabase's direct host (db.<ref>.supabase.co) answers on IPv6 only, which
  # Docker containers do not have by default. The session pooler is IPv4.
  for key in DATABASE_URL DIRECT_URL; do
    if env_value $b $key | grep -qE '@db\.[^/]*\.supabase\.co'; then
      fail "backend/.env: $key uses Supabase's IPv6-only direct host; use the session pooler URL (Dashboard > Connect)"
    fi
  done
  if [ -z "$(env_value $b HEALTH_DETAIL_TOKEN)" ]; then
    echo "deploy: note: HEALTH_DETAIL_TOKEN is empty, so /health/ready returns no queue counts"
  fi
  if [ -z "$(env_value $b SENTRY_DSN)" ]; then
    echo "deploy: note: SENTRY_DSN is empty, so crashes are only in the container logs"
  fi
  if [ -z "$(env_value .env BACKUP_S3_BUCKET)" ]; then
    echo "deploy: note: BACKUP_S3_BUCKET is empty, so database backups stay on this VM only"
  elif [ -z "$(env_value .env BACKUP_AGE_RECIPIENT)" ]; then
    fail ".env: BACKUP_S3_BUCKET is set without BACKUP_AGE_RECIPIENT, so every nightly backup would refuse to upload (see deploy/backup-db.sh)"
  fi
  if [ -n "$(env_value .env BACKUP_AGE_RECIPIENT)" ] && ! command -v age >/dev/null; then
    fail "BACKUP_AGE_RECIPIENT is set but age is not installed: sudo apt-get install age"
  fi
  if [ "$(env_value $b RECEIPT_PROVIDER_DISPATCH_ENABLED)" = true ] && [ "${ALLOW_RECEIPT_PROVIDER:-}" != 1 ]; then
    fail "backend/.env: RECEIPT_PROVIDER_DISPATCH_ENABLED=true sends receipts to an outside provider. Launch is local-first; set it to false, or rerun with ALLOW_RECEIPT_PROVIDER=1 once its consent and data-terms gate is approved"
  fi

  [ "$(env_value web/.env.production VITE_API_BASE_URL)" = /api/v1 ] \
    || fail "web/.env.production: VITE_API_BASE_URL must be /api/v1 (same origin as the app)"
}

has_certificate() {
  "${COMPOSE[@]}" run --rm --entrypoint sh certbot \
    -c "test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem" >/dev/null 2>&1
}

issue_certificate() {
  echo "deploy: requesting a certificate for $DOMAIN"
  # Standalone mode listens on port 80 itself, so nginx must not be running.
  # This happens once; renewals go through nginx (deploy/renew-certs.sh).
  "${COMPOSE[@]}" stop nginx >/dev/null 2>&1 || true
  "${COMPOSE[@]}" run --rm -p 80:80 certbot certonly --standalone \
    -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email --non-interactive
}

# Adds a crontab line once, keyed by the script it runs.
install_cron() {
  local schedule=$1 script=$2 log=$3 what=$4 line
  line="$schedule cd $(pwd) && bash $script >> \$HOME/$log 2>&1"
  if ! crontab -l 2>/dev/null | grep -qF "$script"; then
    { crontab -l 2>/dev/null || true; echo "$line"; } | crontab -
    echo "deploy: installed $what (crontab -l to see it)"
  fi
}

check_env

if [ "$pull" = 1 ]; then
  git pull --ff-only
fi

echo "deploy: building images"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" --profile tools build migrate

echo "deploy: checking migrations"
if ! "${COMPOSE[@]}" run --rm migrate npx prisma migrate status; then
  if [ "$migrate" = 1 ]; then
    "${COMPOSE[@]}" run --rm migrate
  else
    fail "the database has unapplied migrations (above). Back it up, then rerun with --migrate"
  fi
fi

has_certificate || issue_certificate
install_cron "17 3 * * *" deploy/renew-certs.sh finsight-renew.log "a daily certificate renewal check"
install_cron "30 2 * * *" deploy/backup-db.sh finsight-backup.log "a daily database backup"

echo "deploy: starting services"
"${COMPOSE[@]}" up -d --remove-orphans

echo "deploy: waiting for https://$DOMAIN/api/v1/health/live"
for _ in $(seq 1 40); do
  if curl -fsS --max-time 5 "https://$DOMAIN/api/v1/health/live" >/dev/null 2>&1; then
    echo "deploy: up at https://$DOMAIN"
    "${COMPOSE[@]}" ps
    exit 0
  fi
  sleep 3
done
"${COMPOSE[@]}" ps
fail "https://$DOMAIN/api/v1/health/live did not answer within two minutes; check: docker compose logs --tail=100"
