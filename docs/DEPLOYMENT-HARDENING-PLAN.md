# Deployment & operations hardening plan

Status: proposed 2026-08-11, implemented the same day. Kept as the record of
what was changed and why.

This follows the auth work in [AUTH-HARDENING-PLAN.md](AUTH-HARDENING-PLAN.md).
That plan fixed the account lifecycle in the *application*; this one fixes the
things around it — the edge, the container, the logs — that either break the
product or quietly undo the application-level controls.

The ordering below is by consequence, not by effort. The first two items are the
reason it exists: as it stood, the containerised deployment could not scan a
receipt, and the rate limits it appeared to enforce could be walked around.

---

## Phase 1 — Make the containerised deployment actually work

### 1.1 nginx rejects every real receipt upload

*Problem:* `nginx/nginx.conf` sets no `client_max_body_size`, so nginx applies
its default of **1 MB**. `upload.middleware.ts` allows 10 MB per receipt image
and `receipt.routes.ts` accepts up to `MAX_PAGES` (8) of them in one request.
A single phone photo at quality 0.9 is routinely 2–5 MB.

Behind Docker, receipt scanning — the product's headline feature — fails with a
bare nginx 413 before the application sees the request. None of the app's own
limits, quality checks or worded errors ever run. It works in `npm run dev`,
which is why it has not been noticed.

- Set `client_max_body_size` at the edge to match what the app actually accepts,
  derived from `MAX_PAGES × the per-file limit` plus multipart overhead.
- Keep the app's own multer limits as the authority on the *per-file* rule, so
  the friendly per-file message is still what an owner sees.
- Add proxy timeouts sized for a multi-page upload over a slow connection.

### 1.2 The backend is reachable without going through nginx

*Problem:* `docker-compose.yml` publishes `4000:4000`, so the API answers
directly on the host as well as through nginx.

That is two problems at once. It bypasses any TLS terminated at the edge, and it
splits every IP-keyed rate limit into two bucket spaces — `TRUST_PROXY_HOPS=1`
resolves `X-Forwarded-For` on the nginx path and the raw socket address on the
direct one, so the same limiter counts the same caller under two identities.

- `expose` instead of `ports`, so the API is reachable only from inside the
  compose network.
- Keep a documented, commented-out mapping for the local-debugging case, so the
  next person changes it deliberately rather than rediscovering it.

### 1.3 TLS

*Problem:* nginx listens on port 80 only. If that is the public edge, bearer
tokens for a financial records system cross the wire in plaintext, and every
control in the auth plan is moot.

Certificates cannot be committed, so this phase provides the *path* rather than
the certificates:

- An HTTPS server block, ready to enable, with modern protocol settings.
- HSTS, and an HTTP block that redirects rather than serves.
- Both written so that the common alternative — TLS terminated by the hosting
  platform in front of this container — remains correct, with the trade-off
  stated at the point of the change rather than in a wiki.

---

## Phase 2 — Container hardening

### 2.1 The backend runs as root

`backend/Dockerfile` never drops privileges. A remote-code-execution bug in any
dependency inherits root inside the container.

- Run as the `node` user the base image already provides.
- Ensure file ownership is correct so the non-root process can read what it needs.

### 2.2 The production image ships the build toolchain

The runtime stage copies `node_modules` wholesale from the build stage, so
TypeScript, vitest, tsx and every other dev dependency are in the deployed
image. Larger attack surface, larger pulls, slower cold starts.

- Install production dependencies separately for the runtime stage.
- Keep `prisma generate` in the build stage — the generated client is needed at
  runtime, the CLI is not.

### 2.3 Nothing checks whether the container is healthy

`/api/v1/health/live` exists and is purpose-built for this, and nothing calls
it. `restart: unless-stopped` only catches a process that has exited, not one
that is wedged — which is the failure that actually happens.

- A `HEALTHCHECK` in the Dockerfile, using the liveness endpoint.
- `depends_on` conditioned on it in compose, so nginx does not start routing to
  a backend that is not answering yet.

---

## Phase 3 — Observability

### 3.1 Structured logging is bypassed in the places it matters most

The app configures pino with request-id correlation, and then roughly ten call
sites use `console.error` instead — including the global error handler, so
**every unhandled 500 loses its `x-request-id`**. That is precisely the log line
someone will be trying to correlate.

- Route every one of them through the existing logger.
- The error handler additionally logs `req.id`, so a 500 reported by a user
  ("it said try again, here is the code on screen") is findable.
- Keep the error *response* unchanged: the client is still told nothing but
  "Internal server error".

### 3.2 The readiness probe is a public operational readout

`/api/v1/health/ready` returns queue depths and `stalledAccountDeletions` to
anyone. Individually minor; together it is a load and backlog readout for an
unauthenticated caller.

- Keep liveness and the plain ready/not-ready verdict public — that is what a
  load balancer needs.
- Return the counters only to a caller that proves it is ours, and only require
  that in production so local development stays convenient.

### 3.3 Reads with no ceiling

Around forty `findMany` calls have no `take`. Reviewed individually rather than
capped in bulk, because a `take` on the wrong query silently drops records from
a total — which, in a product whose entire job is arithmetic on those records,
is far worse than a slow query.

What the audit actually found:

| Category | Count | Action |
| --- | --- | --- |
| Date-scoped (dashboard, insights, trends) | 16 | **Leave.** Bounded by the period requested, and each feeds a sum. |
| Domain-bounded (categories per profile, pages per scan, profiles per owner) | ~5 | **Leave.** A ceiling here is a handful of rows by construction. |
| Already capped, missed by the first grep | 2 | None needed. |
| Offline maintainer scripts (`loadCorrections`, called only from `tests/ocr-accuracy/*`) | 1 | **Leave, deliberately.** Never on a request path, both callers already pass `since`, and a cap would skew the accuracy rate it computes. |
| **Genuinely unbounded on a request path** | **1** | **Capped.** |

The one that mattered is `listNotifications`. It grows for the life of an
account — every duplicate warning, every large-expense flag — and returned all
of it to the client in a single response. Capped newest-first at 500, which is
a *list* and not a total, so nothing can be made arithmetically wrong by it.

The honest summary is that this finding was largely a false alarm from a crude
grep, and saying so is more useful than 22 defensive `take`s that would each
need justifying later.

---

## Phase 4 — Dependencies

- **web:** `react-router` 7.18.1 is inside the range of
  [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2)
  (high). The advisory is an RSC-mode CSRF bypass and this app is a Vite SPA on
  `BrowserRouter` with no RSC, so it is **not exploitable here**. Bumped anyway,
  so a future real advisory is not lost among known noise.
- **mobile:** `js-yaml` and `nanoid` fixed cleanly with `npm audit fix` — no
  version constraints changed.

  `image-size` (high) and `uuid` (moderate) are **left, deliberately**. npm's
  "fix available" for both is `expo@53.0.27` against an installed `expo@57.0.12`
  — a four-major *downgrade*, not an upgrade. Taking it would roll the entire
  mobile toolchain back two years to resolve a denial-of-service in an ICNS
  parser and a bounds check in `uuid` v3/v5/v6, neither of which this app's code
  paths reach: FinSight decodes JPEG/PNG/WEBP only, and uses `randomUUID`.
  Re-check when Expo's own dependency tree moves forward.

  The `@expo/config-plugins` / `@expo/prebuild-config` / `expo-splash-screen`
  chain (17 of the 19 reported vulnerabilities) is **not a separate finding** —
  confirmed via `npm audit --omit=dev --json`, every one of those packages
  traces to the same two root advisories above: the moderate ones (`@expo/cli`,
  `@expo/config`, `@expo/config-plugins`, `@expo/inline-modules`,
  `@expo/local-build-cache-provider`, `@expo/prebuild-config`,
  `expo-splash-screen`, `xcode`) all resolve through `xcode` → `uuid`
  (GHSA-w5hq-g745-h8pq); the high ones (`@expo/metro`, `@expo/metro-config`,
  `metro`, `metro-config`, `metro-transform-worker`, `react-native`,
  `@react-native/community-cli-plugin`, `@react-native/virtualized-lists`,
  `expo`) resolve through `metro` → `image-size`. None of these packages are
  direct entries in `mobile/package.json` — they're transitive deps of `expo`
  and `expo-splash-screen`, pulled in for `expo prebuild`/native-project
  generation (Xcode project file editing, Metro bundling config) and CLI
  tooling. They run on the developer/CI machine during build, not on end-user
  devices, so the DoS/bounds-check advisories above don't reach shipped app
  code either way. `npm audit fix` (non-force) resolves none of it — every
  path in the tree requires `--force`, and `--force` still lands on the same
  `expo@53.0.27` downgrade. No new action beyond the existing deferral above;
  re-check together when Expo's tree moves forward.

---

## Verification

Each phase carries its own check; the whole set has to pass together:

1. Backend, web and mobile typecheck, lint and test suites.
2. Backend production build and web production build.
3. `docker compose config` parses, and the nginx configuration passes
   `nginx -t` inside the real image.
4. The upload ceiling is asserted against `MAX_PAGES` in a test, so raising the
   page limit without raising the edge limit fails CI rather than production.
