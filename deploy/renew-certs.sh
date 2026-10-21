#!/usr/bin/env bash
# Renews the Let's Encrypt certificate when it is within 30 days of expiry,
# then reloads nginx so it serves the new one. deploy.sh installs a daily cron
# entry for this; it is a no-op on the other days.
set -euo pipefail

cd "$(dirname "$0")/.."
readonly COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

"${COMPOSE[@]}" run --rm certbot renew --webroot -w /var/www/certbot --quiet
"${COMPOSE[@]}" exec -T nginx nginx -s reload
