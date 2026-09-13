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

ENV NODE_ENV=production \
    TESSERACT_LANG=eng \
    TESSERACT_LANG_PATH=/app/tessdata

# Keep traineddata inside the image and outside the process-writable tree. The
# checksum is a build gate, not metadata: changing the bytes without updating
# the reviewed pin fails the production build. The OCR service reads only the
# explicit TESSERACT_LANG_PATH with runtime caching and downloads disabled.
RUN install -d -o root -g root -m 0555 /app/tessdata
COPY eng.traineddata /app/tessdata/eng.traineddata
COPY docker/tesseract-entrypoint.sh /usr/local/bin/finsight-tesseract-preflight
COPY docker/receipt-upload-orphan-sweep.sh /usr/local/bin/finsight-receipt-upload-sweeper
COPY docker/api-entrypoint.sh /usr/local/bin/finsight-api-entrypoint
COPY docker/worker-entrypoint.sh /usr/local/bin/finsight-worker-entrypoint
COPY docker/worker-readiness.sh /usr/local/bin/finsight-worker-readiness
RUN printf '%s  %s\n' \
      '5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747' \
      'eng.traineddata' > /app/tessdata/SHA256SUMS \
    && (cd /app/tessdata && sha256sum -c SHA256SUMS) \
    && chmod 0444 /app/tessdata/eng.traineddata /app/tessdata/SHA256SUMS \
    && chmod 0555 /app/tessdata \
      /usr/local/bin/finsight-tesseract-preflight \
      /usr/local/bin/finsight-receipt-upload-sweeper \
      /usr/local/bin/finsight-api-entrypoint \
      /usr/local/bin/finsight-worker-entrypoint \
      /usr/local/bin/finsight-worker-readiness

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

# The API and worker targets share this filesystem. The worker replaces this
# HTTP healthcheck with its own process, heartbeat, and language-data probe.
ENTRYPOINT ["/usr/local/bin/finsight-api-entrypoint"]
CMD ["node", "dist/server.js"]

FROM runtime AS worker
ENTRYPOINT ["/usr/local/bin/finsight-worker-entrypoint"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/finsight-worker-readiness"]
CMD ["node", "dist/worker.js"]

# Docker resolves an untargeted build to the LAST stage in the file, and
# `worker` has to come after `runtime` because it derives from it. This final
# stage exists so a plain `docker build ./backend` (no --target) is the API
# again rather than a worker that never listens — that was QA finding
# OPS-DEPLOY-01. Compose and CI still name their targets explicitly.
FROM runtime AS api
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
