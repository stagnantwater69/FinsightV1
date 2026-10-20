#!/usr/bin/env bash
# Checks the production edge config without a real domain or certificate:
# the template renders, nginx accepts it, and its upload limit matches
# nginx.conf (verify-upload-envelope.sh proves that one against the app).
set -euo pipefail

readonly SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly DOMAIN=ci.finsight.test

limit() { grep -oE 'client_max_body_size [0-9]+[kmg]?;' "$1"; }
dev_limit=$(limit "$SCRIPT_DIR/nginx.conf")
prod_limit=$(limit "$SCRIPT_DIR/templates/finsight.conf.template")
if [ "$dev_limit" != "$prod_limit" ]; then
  echo "upload limit differs: nginx.conf has '$dev_limit', the production template '$prod_limit'" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/live/$DOMAIN"
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj "/CN=$DOMAIN" \
  -keyout "$scratch/live/$DOMAIN/privkey.pem" -out "$scratch/live/$DOMAIN/fullchain.pem" 2>/dev/null

# --add-host: nginx resolves the upstream's compose hostname while loading.
output=$(docker run --rm --add-host backend:127.0.0.1 \
  -e DOMAIN="$DOMAIN" -e HSTS_MAX_AGE=86400 \
  -v "$SCRIPT_DIR/templates:/etc/nginx/templates:ro" \
  -v "$scratch:/etc/letsencrypt:ro" \
  nginx:1.27-alpine nginx -t 2>&1) || { echo "$output" >&2; exit 1; }
echo "$output" | tail -n 2

# The rendered file must have no ${...} left that the entrypoint skipped.
rendered=$(docker run --rm -e DOMAIN="$DOMAIN" -e HSTS_MAX_AGE=86400 \
  -v "$SCRIPT_DIR/templates:/etc/nginx/templates:ro" \
  nginx:1.27-alpine sh -c '/docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null && cat /etc/nginx/conf.d/finsight.conf')
if echo "$rendered" | grep -q '\${'; then
  echo "unrendered placeholder in the production template:" >&2
  echo "$rendered" | grep -n '\${' >&2
  exit 1
fi
echo "production template OK ($prod_limit)"
