# ---------------------------------------------------------------------------
# Build — compiles TypeScript and generates the Prisma client.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Prisma's query engine needs OpenSSL at both build and run time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Dependencies — production node_modules, on their own.
#
# WHY A THIRD STAGE rather than copying node_modules out of `build`. That is
# what this used to do, and it shipped the entire build toolchain — TypeScript,
# vitest, tsx, the Prisma CLI — into the deployed image. Every one of those is
# attack surface in a container that will never compile anything, and they are
# most of the image size.
#
# `prisma generate` is re-run here because the generated client lives inside
# node_modules and would otherwise be missing from this tree. It is the
# generated client the runtime needs, never the CLI.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Owned by `node`, the unprivileged user the base image already ships. Set on
# COPY rather than with a later `chown -R`, which would duplicate every file
# into a new layer.
COPY --chown=node:node package.json ./
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=deps  --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/dist ./dist

# DROPS ROOT, and this is the last instruction before the process starts so
# nothing after it can quietly need privileges again. Without it, a
# remote-code-execution bug in any dependency inherits root inside the
# container; with it, the same bug lands as a user that owns only this app.
USER node

EXPOSE 4000

# Mirrors the compose healthcheck so the image is self-describing when it is run
# without compose — `docker run` and most orchestrators read this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default is the API process. The `worker` target below is the same image with
# no HEALTHCHECK (it has no HTTP endpoint to probe) and a different CMD — the
# background queue consumers, deployed and scaled as their own service. See
# src/worker.ts.
CMD ["node", "dist/server.js"]

FROM runtime AS worker
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]
