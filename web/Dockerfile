# ---------------------------------------------------------------------------
# The public edge for a single-VM deployment (docker-compose.prod.yml): the
# built SPA served by nginx, which also proxies /api/ to the backend service.
#
# Vite reads web/.env.production at build time. It holds only values that ship
# to every browser anyway (the API path, the Supabase URL and anon key), so it
# is safe inside the build context, but it is gitignored and must be created
# on the server. The build refuses to run without it rather than produce an
# app pointed at nothing.
#
# The server config is not baked in: compose mounts nginx/templates, and the
# image's entrypoint renders ${DOMAIN} into it at start.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN test -f .env.production || { echo "web/.env.production is missing" >&2; exit 1; }
RUN npm run build

FROM nginx:1.27-alpine
# The stock server answers every unmatched host with the nginx welcome page.
RUN rm /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
