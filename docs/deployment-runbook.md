# Deployment runbook

How to get FinSight running somewhere other than a laptop, and what to check
before and after. Host-agnostic on purpose: it does not pick a provider,
because that decision has not been made and the steps are the same either way.

Every command here has been run against this repo. Where something has NOT
been verified, it says so rather than implying it works.

---

## 1. What you are deploying

| Piece | What it is | How it ships |
|---|---|---|
| `backend/` | Express + Prisma API | Docker image (`backend/Dockerfile`, multi-stage, `node:24-bookworm-slim`) |
| `web/` | React + Vite SPA | Static files from `npm run build` → `web/dist/` |
| `mobile/` | React Native / Expo | APK or store build via Expo — **not covered here**, no build has been produced from this repo yet |
| Database + Storage + Auth | Supabase project | Already hosted; you provision the project, not the server |

`nginx/nginx.conf` and `docker-compose.yml` exist and put nginx in front of
the backend. Both were written for local use; the compose file is a reasonable
starting point for a single-VM deployment. It now has health-gated startup
ordering, a correct upload body-size limit, and a ready-to-enable HTTPS server
block — but TLS is not turned on (no certificate is committed, deliberately;
see the commented HTTPS block in `nginx/nginx.conf`), and there is no log
shipping.

---

## 2. Before the first deploy

- [ ] **A Supabase project that is not your development one.** Development
      data and real user data must not share a database. See §6.
- [ ] **Storage buckets exist** in that project: `receipts` (private),
      `csv-imports` (private), `avatars` (public). The app does not create
      them, and `uploadCsvFile` will fail at runtime if `csv-imports` is
      missing — `storage.service.ts` says so in a comment for exactly this
      reason.
- [ ] **Auth is configured** in Supabase (email/password provider enabled,
      redirect URLs set to wherever the web app is served from).
- [ ] **A receipt-provider posture.** Keep receipt-provider dispatch disabled
      for the local-first release. A provider credential alone is inert. Any
      later enablement needs the complete consent, data-terms, calibration,
      region, retention, budget, and kill-switch gate described below.

---

## 3. Environment variables

The backend validates these at boot (`backend/src/config/env.ts`) and refuses
to start if a required one is missing — a deliberate fail-fast, so a
misconfigured deploy dies immediately instead of erroring per-request later.

**Required — no default, boot fails without them:**

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase pooled connection string |
| `DIRECT_URL` | Direct connection, or the session-mode pooler on IPv4-only networks. **Migrations use this one**, not `DATABASE_URL` — see §5 |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-side secret.** Never ship this to a client |

**Defaulted — but you almost certainly want to set them in production:**

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Set to `production` |
| `CORS_ORIGIN` | `http://localhost:5173` | Must be the real web origin, or the browser blocks every request |
| `PORT` | `4000` | |
| `SUPABASE_STORAGE_BUCKET` | `receipts` | |
| `GOOGLE_GEMINI_API_KEY` | `""` | Credential only; it cannot enable receipt dispatch by itself |
| `OPENROUTER_API_KEY` | `""` | Fallback for the categoriser |
| `TESSERACT_LANG` | `eng` | `+`-joined language codes; every configured language must be packaged and checksummed in the worker image |
| `TESSERACT_LANG_PATH` | backend root locally; `/app/tessdata` in Docker | Optional for direct npm development; the source and compiled config both resolve the tracked backend bundle when it is unset. Docker sets its root-owned, read-only bundle explicitly. |
| `RECEIPT_UPLOAD_TEMP_ROOT` | OS temp directory plus `finsight-receipt-uploads` locally; `/run/finsight/receipt-uploads` in Docker | Must resolve to an absolute, private directory. Compose supplies a bounded tmpfs rather than a host volume. |
| `RECEIPT_UPLOAD_ORPHAN_TTL_SECONDS` | `3600` | Sweeper-only setting; values below 3600 are rejected because an upload request may run for 300 seconds. |
| `RECEIPT_WORKER_HEALTH_DIR` | `/tmp/finsight-worker-health` outside Compose; `/run/finsight/worker-health` in Compose | Private worker PID and heartbeat markers only; arbitrary or symlink-resolved paths are rejected before cleanup |
| `RECEIPT_WORKER_HEARTBEAT_MAX_AGE_SECONDS` | `45` | Worker healthcheck range is 15 through 300 seconds |
| `RECEIPT_WORKER_IDLE_POLL_MS` | `1000` | How long an idle worker sleeps between queue passes. Clamped to 250 through 60000; a bad value falls back to the default instead of blocking boot. See §4. |
| `RECEIPT_QUEUE_STALE_AFTER_SECONDS` | `300` | Operator-only warning threshold for the read-only queue readiness command |

**Optional receipt-provider gate, safe defaults shown:**

| Variable | Safe default | Rule |
|---|---|---|
| `RECEIPT_PROVIDER_DISPATCH_ENABLED` | `false` | Explicit request to allow dispatch evaluation, not enough by itself |
| `RECEIPT_PROVIDER_KILL_SWITCH` | `true` | One switch that stops every receipt-provider submission |
| `RECEIPT_PROVIDER_DATA_TERMS_APPROVED` | `false` | Must match reviewed provider data terms |
| `RECEIPT_PROVIDER` and `RECEIPT_PROVIDER_VERSION` | unset | One supported provider/version only; no paid fallback cascade |
| `RECEIPT_PROVIDER_REGION` | unset | Must match the consent record |
| `RECEIPT_PROVIDER_RETENTION_HOURS` | unset | Must be reviewed and no more than 24 hours |
| `RECEIPT_PROVIDER_ROUTING_CALIBRATED` | `false` | Must have a matching calibration version |
| `RECEIPT_PROVIDER_CALIBRATION_VERSION` | unset | Versioned evidence, not a raw confidence threshold |
| `RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT` | `0` | Unset, zero, invalid, or above 100 disables dispatch |
| `RECEIPT_PROVIDER_BUSINESS_MONTHLY_UNIT_LIMIT` | unset | Optional second cap; if set, it must be from 1 through 100 |

`VERYFI_*` values follow the same credential-only rule as the Gemini key.
Never place a provider key in a command line, readiness artifact, screenshot,
or Git file.

**Anomaly-detector feature flags — all default to `false`, leave them alone:**

These are read once at boot into `RUNTIME_DETECTION_CONFIG`
(`backend/src/services/anomalyDetection/config.ts`). They are staged off until
shadow-mode results have been reviewed; a deploy should ship them all unset.

| Variable | Default | Notes |
|---|---|---|
| `ANOMALY_NEAR_DUPLICATE_ENABLED` | `false` | Findings only |
| `ANOMALY_VELOCITY_ENABLED` | `false` | Findings only |
| `ANOMALY_TRENDS_ENABLED` | `false` | Findings only |
| `ANOMALY_BEHAVIORAL_NOVELTY_ENABLED` | `false` | Findings only |
| `ANOMALY_RECURRING_ENABLED` | `false` | **Not findings-only** — see below |
| `ANOMALY_ISOLATION_FOREST_ENABLED` | `false` | **Shadow-only findings**; requires the ML worker — see below |
| `ML_WORKER_URL` | `http://127.0.0.1:8321` | The Python scoring sidecar; only read when the flag above is on |

`ANOMALY_RECURRING_ENABLED` turns on recurring-expense schedule watching: the
detector tracks expected payment dates for recurring expenses and raises
HIGH-severity findings when a scheduled payment has not been recorded. Because
those findings are HIGH, they clear `notificationMinimumSeverity` and **owner
notifications start being sent** — messages of the form "X is due 2026-04-01 and
has not been recorded yet" will begin landing in users' notification feeds the
first time the job runs after enable. That makes this flag a user-visible
behaviour change, unlike the four findings-only detectors above, and it is not
silently reversible: notifications already delivered stay delivered.

Do not enable it as part of a routine deploy. There is an open P1 defect (a
multi-cycle catch-up deadlock producing false "missing payment" alarms) still
being fixed, so enabling it today would notify users about payments they did
make. Flipping it on is a separate, explicit decision that needs a review of
shadow-mode output after that fix lands — it is not covered by this runbook.

**The ML worker (Isolation Forest, shadow mode)**

`ANOMALY_ISOLATION_FOREST_ENABLED` runs the Isolation Forest detector in
SHADOW mode: findings are persisted with status `SHADOW`, which the findings
API, summaries, notifications, and Ask FinSight context all exclude — nothing
becomes owner-visible. It exists to accumulate evaluation data (see the
`shadow` block of `GET /insights/findings/metrics`).

It requires the Python sidecar from `ml/` (setup and pins: `ml/README.md`):

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
ml/.venv/bin/python ml/worker/server.py --port 8321
```

- **Health:** `curl -s localhost:8321/health` → `{"status":"ok", ...versions}`.
- **Resources:** single-threaded scoring, bounded requests (1 MB / 5,000 rows);
  a 512 MB memory cap and one CPU are comfortable. Bind to localhost or a
  private network only.
- **Failure behaviour:** the backend fails OPEN. If the worker is down or slow
  (5s timeout, circuit breaker), analysis jobs complete on the deterministic
  detectors and a `ml worker call failed` warning is logged. The worker being
  down never blocks record creation, imports, or analysis.
- **Rollback:** unset the flag and restart the backend. The worker can then be
  stopped; existing SHADOW findings remain as inert evaluation data. No model
  artifacts exist anywhere (fit-per-request by design), so there is nothing
  else to clean up.
- **Promotion out of shadow mode** is a separate release decision gated on the
  criteria in `docs/ANOMALY-DETECTION-AND-LARGE-CSV-ANALYSIS-STRATEGY.md` §6.3,
  measured on real shadow data via `ml/experiment/` — not covered by this
  runbook.

The web build needs `VITE_API_BASE_URL` and the Supabase URL/anon key at
**build time**, not run time — Vite inlines them. Rebuild to change them.

**How to supply them:** there is no secrets manager wired up and no
`.env.production` convention in this repo. Use your host's environment/secrets
mechanism. Do not add a production `.env` to the repo — `.gitignore` covers
`.env`, and that is the only thing currently preventing an accidental commit.

---

## 4. Building and running

### Backend

```bash
docker build --target api    -t finsight-backend:$(git rev-parse --short HEAD) ./backend
docker build --target worker -t finsight-worker:$(git rev-parse --short HEAD)  ./backend
docker run -d --name finsight-backend -p 127.0.0.1:4000:4000 \
  --env-file /path/to/prod.env \
  -e RECEIPT_UPLOAD_TEMP_ROOT=/run/finsight/receipt-uploads \
  --tmpfs /run/finsight/receipt-uploads:rw,noexec,nosuid,nodev,size=201326592,mode=0700,uid=1000,gid=1000 \
  finsight-backend:$(git rev-parse --short HEAD)
curl -s http://localhost:4000/api/v1/health/live    # → {"status":"ok","uptimeSeconds":...}
```

The Dockerfile has two deployable targets: `api` (HTTP server, `dist/server.js`,
with a HEALTHCHECK) and `worker` (queue consumers, `dist/worker.js`, with no
HTTP endpoint). The worker entrypoint and container healthcheck verify its
configured Tesseract files before work starts. An untargeted build resolves to
`api`, but always name the target
— a stage-order slip once made the default image the worker, which never
listens, so compose's healthcheck failed and nginx never started
(QA finding OPS-DEPLOY-01). CI now asserts each image's CMD.

Bind published ports to `127.0.0.1` even for manual/debug `docker run` —
the same reasoning that keeps `docker-compose.yml` on `expose:` rather than
`ports:` for the `backend` service applies here (see the comment on that
service): a directly reachable backend bypasses nginx entirely, including TLS
once it terminates there, and double-counts IP-keyed rate limits against
`TRUST_PROXY_HOPS`. Under `docker compose up`, the backend is not
host-published at all; only nginx's `8080:80` (and, once TLS is enabled,
`8443:443`) is reachable from outside the compose network, and nginx will not
route to the backend until its container healthcheck passes.

`/api/v1/health` (aliased as `/api/v1/health/ready`) additionally touches the
database and, in production, requires the `x-health-token` header (matching
`HEALTH_DETAIL_TOKEN`) to see queue-depth detail — use `/api/v1/health/live`
for a plain up/down check that needs no token.

**Verified**: this image builds, boots, and answers `/api/v1/health/live` —
checked against this repo. Tagging by commit rather than `latest` is what
makes a rollback a matter of running the previous tag.

### Worker idle poll interval

`RECEIPT_WORKER_IDLE_POLL_MS` (default `1000`) is how long the worker sleeps
after a pass that claimed no job. A pass that did claim one is followed
immediately, so this governs idle replicas only, and both ends of the knob cost
something:

- **At 1000**, one idle replica runs a queue pass every second, roughly 518,000
  queue queries a day across the six consumers a pass touches. That is
  unremarkable against a Postgres you own and material against a metered hosted
  one, multiplied by every replica you add.
- **Backing it off** cuts that load in proportion and adds the same amount to
  the worst-case wait before an upload is picked up. At `5000` an idle replica
  issues about a fifth the queries and a scan can sit up to five seconds before
  the worker starts it, on top of the OCR time the owner already waits through.

The value is clamped to 250 through 60000, and anything unparseable, empty,
zero or negative falls back to 1000: a mistyped poll interval is not worth
refusing to start the queue consumers over. Changing it needs a worker restart,
not a rebuild. Leave it at the default until an idle replica's query volume is
something you are actually measuring.

### Process exit codes and restart policy

Both processes distinguish an orderly stop from a crash, which a supervisor
reads as the difference between "an operator stopped this" and "restart it":

- **Exit 0** means SIGTERM or SIGINT was received and the drain finished. The
  API stops accepting connections and lets in-flight responses complete; the
  worker finishes the pass it was in the middle of, so its lease is released
  rather than left for a timeout to reclaim.
- **Exit 1** means a fault. An unhandled promise rejection or an uncaught
  exception is logged through pino at `fatal` with a `fault` field naming which
  of the two it was, then routed through that same drain before the process
  exits non-zero. Exit 1 also covers a drain that ran past its force timer (10s
  for the API, 30s for the worker), a failed HTTP server close, and the boot
  refusals: invalid environment variables and the migration guard finding the
  database behind the build.

A crash used to exit 0, which is what a supervisor sees when someone stops a
service deliberately. Under `Restart=on-failure`, or any dashboard that reads
exit status, a crash loop could present as a clean shutdown. Compose's
`restart: unless-stopped` restarts on either code, so the practical gain there
is in the logs and the exit status, not the restart itself: grep the fatal line
(`"fault":"unhandledRejection"` or `"fault":"uncaughtException"`) to tell a
crash from a deploy. Nothing ships those logs anywhere durable yet, and nothing
pages anyone on one, see §7.

### Offline Tesseract language data

Both backend image targets contain `/app/tessdata/eng.traineddata` as a
root-owned, read-only file. Its pinned SHA-256 is
`5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747`.
The image build verifies that checksum and fails on a mismatch. The worker
entrypoint verifies the complete `/app/tessdata/SHA256SUMS` manifest, then
checks that every `+`-joined code in `TESSERACT_LANG` has a readable,
non-writable file before starting the queue consumer. Add a traineddata file
and its reviewed checksum to the image in the same change that adds a language
code; setting an unbundled code makes the worker fail readiness.

CI runs `extractText()` from the production worker image with `--network none`
and a read-only root filesystem. This is the cold English OCR gate: a missing
local file would make Tesseract.js attempt its default CDN and the job would
fail because the container has no outbound interface. The OCR service passes
`TESSERACT_LANG_PATH` to `createWorker` with `gzip: false` and
`cacheMethod: "none"`, so it does not depend on its working directory or a
Tesseract.js cache lookup.

If the worker reports `Tesseract readiness failed`, keep it stopped, leave the
API and web app running for manual expense entry, and keep optional receipt
providers disabled. Restore the pinned language file or roll back to the last
passing worker image. Do not enable egress to work around a missing file.

### Receipt upload envelope and temporary storage

The receipt contract has separate application and transport limits. Treat
`MiB` here as exactly 1,048,576 bytes.

| Boundary | Limit | Enforced by |
|---|---:|---|
| One file object | 10 MiB | Multer/API |
| Logical receipt pages | 8 | API |
| Processed plus original file objects | 16 | Multer/API |
| Aggregate bytes across all file objects | 80 MiB (83,886,080 bytes) | API |
| Entire HTTP request body | 81 MiB (84,934,656 bytes) | nginx |

nginx keeps `proxy_request_buffering off` and permits only the measured
multipart overhead above the file contract. The current 16-file/eight-field
probe sends exactly 80 MiB of file data in an 84,413,748-byte request:
527,668 bytes of headers, boundaries, and bounded fields, leaving 520,908
bytes below the proxy ceiling. It also proves that an 80 MiB + 1 byte file
aggregate still reaches the instrumented upstream, where the real API is the
authority that returns 413. A body of 81 MiB + 1 byte is rejected by nginx.

Run the same live edge gate used in CI after changing nginx, curl, or any
receipt upload field:

```bash
bash nginx/verify-upload-envelope.sh
```

The command uses task-named throwaway containers and a scratch directory under
the OS temp directory. It reports byte counts only and removes its resources
on exit. Its upstream is an instrumented request-body sink; the backend's own
boundary tests remain the proof of the 80 MiB aggregate rejection.

Compose mounts `/run/finsight/receipt-uploads` only in the API container as a
192 MiB tmpfs owned by UID/GID 1000 with mode `0700` and
`noexec,nosuid,nodev`. It is neither a bind mount nor a named volume, is not
served by nginx, and is not mounted in the worker. The size admits two 80 MiB
file aggregates for the single-owner retry case plus 32 MiB of filesystem
headroom. It is deliberately bounded; do not replace it with a 160 MiB
in-memory upload path.

Each request uses a mode-`0700` directory whose basename is exactly
`finsight-receipt-` plus six alphanumeric characters. A mode-`0600` `.active`
marker is refreshed every 60 seconds while the request is alive. Request,
response, abort, error, timeout, and controller-finally paths all invoke the
same idempotent cleanup. The API entrypoint also runs an hourly backstop:

```bash
docker compose exec -T backend finsight-receipt-upload-sweeper --once
```

The sweeper accepts only an absolute, normalized, canonical root owned by its
current user at mode `0700`. The path must end in
`finsight-receipt-uploads` or `finsight/receipt-uploads`, matching the upload
middleware contract. It rejects parent symlinks before deletion and never
follows candidate or marker symlinks. It leaves directories younger than the
3,600-second TTL alone, and also preserves an old directory while its active
marker is fresh. A stale directory with a stale or missing marker is
reclaimed. Output contains counts and the oldest observed age only, never
paths, filenames, or receipt data.

Container restart unmounts and reclaims the tmpfs. Direct `npm` development
uses `<OS temp>/finsight-receipt-uploads`; it has no container entrypoint, so
run the same script hourly under the same OS account as the API. For example:

```cron
0 * * * * cd /path/to/FinsightV1 && backend/docker/receipt-upload-orphan-sweep.sh --once
```

Set `RECEIPT_UPLOAD_TEMP_ROOT` on both the API and that job if the local
default is unsuitable. Never point the job at `/tmp` itself, a shared upload
directory, a symlink, or a public web root.

Use synthetic data in a non-production deployment for these drills. The live
proxy gate and isolated orphan drill were exercised while adding this
contract. The authenticated abort and running-compose restart drills remain
release checks because this workstation pass did not have a disposable logged-
in deployment.

Abort an upload after the directory count increases, then require the count to
return to its baseline. The sparse fixture is deliberately not a valid image;
if it finishes unexpectedly, byte-signature validation rejects it.

```bash
truncate -s 10M /tmp/finsight-upload-abort.bin
docker compose exec -T backend sh -c \
  'find "$RECEIPT_UPLOAD_TEMP_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l'
curl --limit-rate 64k --fail-with-body \
  -H "Authorization: Bearer <TEST_TOKEN>" \
  -F "businessProfileId=<TEST_PROFILE_ID>" \
  -F "files=@/tmp/finsight-upload-abort.bin;type=image/jpeg;filename=drill.jpg" \
  http://127.0.0.1:8080/api/v1/records/receipts
# Press Ctrl-C after the count increases, then run the count command again.
rm /tmp/finsight-upload-abort.bin
```

Test restart reclamation only after active uploads have drained:

```bash
docker compose exec -T backend sh -c \
  'mkdir -m 700 "$RECEIPT_UPLOAD_TEMP_ROOT/finsight-receipt-DRILL1"'
docker compose restart backend
docker compose exec -T backend sh -c \
  'test ! -e "$RECEIPT_UPLOAD_TEMP_ROOT/finsight-receipt-DRILL1"'
```

Test the active-marker rule outside the running service:

```bash
drill_parent=$(mktemp -d /tmp/finsight-upload-sweep.XXXXXX)
mkdir -m 700 "$drill_parent/finsight"
drill_root="$drill_parent/finsight/receipt-uploads"
mkdir -m 700 "$drill_root"
mkdir -m 700 "$drill_root/finsight-receipt-ACT123" \
  "$drill_root/finsight-receipt-OLD123"
printf '%s\n' active > "$drill_root/finsight-receipt-ACT123/.active"
printf '%s\n' active > "$drill_root/finsight-receipt-OLD123/.active"
chmod 600 "$drill_root"/finsight-receipt-*/.active
DRILL_ROOT="$drill_root" node <<'NODE'
const fs = require("node:fs");
const root = process.env.DRILL_ROOT;
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
fs.utimesSync(`${root}/finsight-receipt-ACT123`, old, old);
fs.utimesSync(`${root}/finsight-receipt-OLD123`, old, old);
fs.utimesSync(`${root}/finsight-receipt-OLD123/.active`, old, old);
NODE
RECEIPT_UPLOAD_TEMP_ROOT="$drill_root" \
  backend/docker/receipt-upload-orphan-sweep.sh --once
RECEIPT_UPLOAD_TEMP_ROOT="$drill_root" \
  backend/docker/receipt-upload-orphan-sweep.sh --once
rm -r -- "$drill_parent"
```

The first pass must report `active=1 removed=1 errors=0`; the second must
report `removed=0`. The preserved `ACT123` directory has an old directory
timestamp and a fresh marker. The reclaimed `OLD123` directory has both an old
directory timestamp and an old marker.

If a request fails with `ENOSPC`, stop retries first, keep manual expense entry
available, record only the response/request correlation ID, and check
`docker compose exec -T backend df -h /run/finsight/receipt-uploads`. Let
active requests finish or abort them deliberately, run the one-shot sweep,
and confirm the directory count returns to baseline. If no upload is active,
restarting the API safely reclaims the tmpfs. Repeated exhaustion means the
actual concurrency/retry policy must be corrected and the 192 MiB capacity
reviewed; do not move the files to a public or unbounded host path, loosen
permissions, expose filenames in logs, or raise Node's memory allowance to
160 MiB.

### Phase 1 receipt readiness and drills

Receipt readiness is a set of independent signals. Do not collapse them into a
single green process check.

| Signal | Command | Passing state |
|---|---|---|
| API process | `curl --max-time 5 --fail-with-body http://127.0.0.1:8080/api/v1/health/live` | HTTP 200 and `status: ok` |
| Database from the API | `curl --max-time 45 --fail-with-body http://127.0.0.1:8080/api/v1/health/ready` | HTTP 200 and `database: ok` |
| Worker process and language bundle | `docker compose exec -T worker finsight-worker-readiness` | `status=ok process=ok language=ok` |
| Migrations and queue freshness | from `backend/`, `npm run ops:receipt-queue:readiness` | `status: ok`, `databaseTransaction: read-only`, `migrations: ok`, `workerQueue` not `stale`, and `providerDispatchReview: ok` |
| Private Storage contract | from `backend/`, `npm run storage:buckets:verify` | `status: ok` and `bucketMismatchCount: 0` |
| Optional provider | from `backend/`, `npm run ops:receipt-provider:status` | `disabled` for local-only mode, or `operational` after every optional gate is approved |

Inject the target deployment environment through its secret manager before
running the three backend operator commands. The queue and Storage commands do
not load `backend/.env` to fill missing credentials. A developer file must not
silently turn a target readiness check into a check of another environment.

The API liveness endpoint does not prove database access. The worker container
healthcheck proves that its child process is alive, its heartbeat is fresh, and
every configured Tesseract language file is readable, read-only, and matches
the packaged checksum. It does not prove that work is draining. The queue
readiness command fills that gap with read-only counts from the same database
route as the application. Run it from the worker's network context when the
host cannot reach `DATABASE_URL`.

The queue command reports an otherwise eligible receipt as stale after 300
seconds by default. Set `RECEIPT_QUEUE_STALE_AFTER_SECONDS` from 60 through
3,600 only when a measured local OCR service-time envelope justifies it. It
also reports failed scans, purge work, exhausted or unsafe provider budgets,
stale reservations, stale submitted calls, and ambiguous submissions. A
`SUBMITTED` dispatch older than the fixed 600-second reconciliation threshold
needs review because the process may have stopped after sending the request but
before recording its outcome. `submittedProviderDispatchCount` remains the
total number of dispatch rows that reached submission. The command never
prints a profile ID, scan ID, dispatch ID, object path, receipt text, or money
value.

Optional-provider state is not part of local OCR readiness. `disabled` is a
passing and preferred Phase 1 state. `blocked` means someone requested dispatch
but the complete configuration is not valid; local OCR and owner editing stay
available, while provider calls remain off.

#### Provider-disable drill

Run this first during an incident and before any secret rotation:

1. Set `RECEIPT_PROVIDER_DISPATCH_ENABLED=false`,
   `RECEIPT_PROVIDER_KILL_SWITCH=true`, and
   `RECEIPT_PROVIDER_MONTHLY_UNIT_LIMIT=0` in the deployment secret store.
2. Restart both API and worker so the consent endpoint and worker use the same
   configuration.
3. Run `npm run ops:receipt-provider:status -- --require-disabled` from
   `backend/`. Credentials may remain present; the result must still be
   `disabled` with `providerNetworkCalls: 0`.
4. Record `providerDispatchCount` and `submittedProviderDispatchCount` from
   `receipt-queue-readiness.ts`, process one synthetic receipt through local
   OCR, then confirm both provider counts are unchanged and the local draft is
   still editable.

The CI gate `npm run ops:receipt-provider:smoke` covers safe defaults, credentials
alone, zero and over-100 resource caps, a zero business cap, a complete bounded
configuration, and the kill switch without making a network call.

The CI gate `npm run ops:receipt-queue:smoke` also proves that one stale
`SUBMITTED` count changes readiness to `attention`. Its output contains only
scenario status and counts.

#### Budget-exhaustion drill

Do not consume paid pages to prove exhaustion. The required automated backend
gate uses a mock adapter and a disposable database to race reservations at the configured
limit; its required result is one bounded set of accepted reservations, quota
refusals for the rest, and zero calls beyond the reserved units. The
configuration smoke separately proves that zero, unset, invalid, and values
above the Phase 1 cap of 100 cannot become operational.

In a deployed environment, `exhaustedProviderBudgetCount` is an expected
fail-closed state, not a reason to raise the limit. Keep the limit unchanged,
leave local OCR running, and wait for the next approved cycle. Any
`unsafeProviderBudgetCount` above zero fails release readiness. A stale
reservation, stale submitted call, or ambiguous submission also fails
optional-provider readiness. Keep the kill switch active and reconcile the
provider outcome and billing manually before a new dispatch is allowed. Do not
retry a stale `SUBMITTED` call or release its reserved units until that review
establishes the provider outcome.

#### Orphan-cleanup drill

Run the isolated, synthetic test used by CI:

```bash
bash backend/docker/verify-receipt-upload-orphan-sweep.sh
```

It creates one active directory, one stale directory, and one symlink-shaped
invalid candidate under a task-named OS temporary directory. It also presents
an arbitrary private root, a nonnormalized root, and a path reached through a
parent symlink. A pass preserves the active directory, removes the stale
directory, rejects all unsafe roots without deleting their sentinel files,
refuses the candidate symlink, and prints counts only. The live one-shot
command remains:

```bash
docker compose exec -T backend finsight-receipt-upload-sweeper --once
```

Investigate `errors` or `invalid` above zero. Do not log directory contents or
change the root to a public or unbounded path.

#### API graceful-stop drill

Run the isolated signal test used by CI:

```bash
bash backend/docker/verify-api-entrypoint-signal.sh
```

The fixture sends `TERM` while a synthetic child takes one second to stop. A
pass proves the entrypoint stays alive until that child finishes, propagates
the child's exit status, and then stops the cleanup loop. This is local wrapper
evidence only. The authenticated upload-abort and deployed restart drills in
the temporary-upload section remain release checks.

#### Worker graceful-stop and readiness drill

Run the isolated worker test used by CI:

```bash
bash backend/docker/verify-receipt-worker-readiness.sh
```

It runs the worker entrypoint against a synthetic child in a task-named OS
temporary directory. A pass proves four things: the readiness probe succeeds
while the worker runs, it fails once the worker stops, an arbitrary private
health directory is rejected without its marker files being deleted, and the
entrypoint stays alive until a child that takes one second to stop has
finished, then exits with that child's status.

The last of those is what stands between a graceful stop and the orchestrator
SIGKILLing a half-written job at the end of `stop_grace_period` (35s for the
worker service in `docker-compose.yml`). This is local wrapper evidence only;
the queue-recovery drill below remains the release check.

#### Queue-recovery drill

Use a synthetic receipt and a disposable deployment with the provider kill
switch active. Capture only the readiness counts.

1. Confirm `workerQueue` is `idle`, then stop the worker and enqueue one scan.
2. Confirm the API remains live and manual record entry works. Queue readiness
   should show a claimable count while the worker is stopped.
3. Start the worker and require the claimable count to return to zero.
4. To exercise stale-lease recovery, start another synthetic scan, wait until
   `activeReceiptLeaseCount` increases, force-stop only the disposable worker,
   wait for the two-minute receipt lease to expire, and start the worker again.
5. Require the queue to drain or the scan to reach its bounded terminal failure
   after the configured three attempts. It must not remain claimable beyond the
   readiness threshold.

A normal deploy uses graceful stop and allows the current pass up to 30 seconds
to finish. The force-stop step is only for the disposable recovery drill. Never
run it while a real owner's receipt is being processed.

#### Secret-rotation drill

1. Activate the provider kill switch, restart API and worker, and complete the
   provider-disable drill.
2. Create the replacement secret in the provider or Supabase console. Put it in
   the deployment secret store without printing it or saving it in shell
   history.
3. Restart the affected processes. Keep receipt-provider dispatch disabled and
   run API, database, Storage, worker, language, and queue readiness separately.
4. Revoke the old secret only after the replacement passes those checks.
5. Re-enabling an optional receipt provider is a separate owner-approved change
   that repeats terms, consent, calibration, and budget checks. Rotation alone
   is never authorization to turn it on.

If the Supabase server key changes, restart both API and worker and rerun the
private-bucket verifier. Public web/mobile anon-key rotation is a separate
client rebuild and release.

#### Safe rollback drill

Start by activating the provider kill switch. Roll back API and worker images
independently to known commit tags, keep the additive Phase 1 migration in
place, and do not loosen private bucket restrictions or add client Storage
policies. If the worker rollback fails its language or process probe, stop the
worker and keep the API available for manual records. If the API rollback
cannot use the current additive schema, restore the pre-migration backup using
the already-rehearsed §6 procedure; never improvise a migration-down command.

The release drill must record image tags, start/end times, readiness states,
and before/after counts only. Do not put receipt text, filenames, object paths,
profile IDs, scan IDs, credentials, or financial values in the artifact.

#### Supabase Pro cost-control checklist (manual, not executed here)

This checklist applies only after the owner confirms a real-data Pro target.
It is not required for a synthetic-only school-project target that remains on
the eligible Free plan.

- [ ] Record the target organization and project in private release evidence.
- [ ] Confirm the organization Spend Cap is on in the current billing UI.
- [ ] Inventory every usage category and add-on the current UI marks as
      excluded from Spend Cap. Do not assume a historical list is current.
- [ ] Confirm the selected compute class is the plan-included class. Any larger
      class needs separate written owner approval.
- [ ] Review the upcoming invoice and list each nonzero add-on or excluded item
      by billing label and status, without copying financial records.
- [ ] Confirm no paid add-on is enabled without explicit owner approval.
- [ ] Record the owner's approval, date, and evidence location outside Git.

Do not mark this checklist complete from code review, local tests, or a
dashboard from another organization. A real-owner release remains blocked
until an authorized operator verifies the target organization.

### If login reports that the database cannot be reached

Check the process and its database connection separately:

```bash
curl --max-time 5 --fail-with-body http://localhost:4000/api/v1/health/live
curl --max-time 45 --fail-with-body http://localhost:4000/api/v1/health/ready
npm run db:check --prefix backend
npm run db:check:direct --prefix backend
```

`db:check` runs only `SELECT 1` using the API's runtime Prisma configuration.
It exits with code 0 on success and 1 on failure, with a 45-second overall
deadline. Its JSON output includes the host, port, connection mode, elapsed
time and a Prisma error code when available; it excludes the connection URL,
username, password, database name and raw error message. Run it from the same
host/network and environment as the API. A check on a laptop cannot prove
that a deployed container can connect. The development command requires the
backend's npm dependencies; it is not shipped inside the runtime-only image.
In development, `db:check` follows the same connection launcher as `npm run
dev`; `db:check:direct` tests the original configured route without the local
relay described below. Compare both when investigating a network problem.

- **Liveness succeeds, readiness fails:** the Node process is running, but
  cannot complete its database-backed readiness checks. A green liveness
  probe or Supabase project status does not verify this connection.
- **`db:check` also fails:** check the configured connection against the
  project's current Supabase **Connect** dialog, the hosting network's DNS,
  TCP/TLS reachability and any database network restrictions. Copy the host,
  port and username together; do not guess a pooler hostname from its region.
- **`db:check` succeeds, readiness fails:** inspect the API's request-correlated
  logs, loaded environment, running build and migration status. The command
  starts a fresh Prisma client, so it does not validate an old process's pool
  or prove the application schema is current.

After changing environment settings, restart the API and worker through the
existing process supervisor, then require readiness to return HTTP 200 and
`"database":"ok"` before retrying login. `tsx watch` watches source files;
an edited `.env` is not proof that a running process loaded the new settings.
Do not change projects, reset account passwords, disable the durable rate
limiter or loosen RLS to work around a database connection failure.

Keep container restart checks on `/health/live`. Monitor `/health/ready`
separately for service availability: a database outage should raise a
readiness failure without creating a restart storm. Compose's
`depends_on: service_healthy` only gates initial startup; it does not remove
an already-running backend from nginx when a later check fails. External
monitoring and alert delivery still require the hosting setup described in §7.

Connection modes and network requirements are documented in
[Supabase's connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

### Local development connection recovery

Normal development commands include the connection workaround verified during
the [11 September incident](database-connection-incident-2026-09-11.md):

```bash
npm run dev --prefix backend
npm run worker:dev --prefix backend
npm run db:check --prefix backend
```

For compatible shared Supabase pooler URLs in `NODE_ENV=development`, the
launcher opens a loopback-only TCP relay and gives its child process a derived
connection URL. The relay releases a stalled PostgreSQL SSL negotiation so
the TLS handshake can proceed. Database traffic remains encrypted end to end;
the relay does not decrypt credentials or queries, replay operations, or
change the existing certificate acceptance policy. It requires TLS and closes
when the launched process exits.

This is automatic on each normal development start. No `.env` edit or separate
relay process is needed. The upstream remains the same configured project;
`DIRECT_URL` and the persisted `DATABASE_URL` are unchanged. Local databases,
test/production environments, and strict or custom certificate settings use
their original route. Production `start`, `worker` and Docker commands retain
their existing connection behavior.

Use `dev:direct`, `worker:dev:direct` and `db:check:direct` to bypass the relay
when checking whether the underlying path has recovered. The workaround
restores development connectivity for the observed handshake stall; it cannot
guarantee availability during a provider or network outage.

### Web

```bash
cd web && npm ci && npm run build      # → web/dist/
```

Serve `web/dist` as static files. It is a single-page app, so **the server
must fall back to `index.html` for unknown paths** — without that, refreshing
on `/records` returns a 404 instead of the app.

---

### 4.4 Android receipt-scanner development build

**As of 31 August 2026, ML Kit Document Scanner is Android's only
receipt-camera capture path — see `docs/receipt-camera.md` §0.** There is no
custom FinSight camera to fall back to any more; the scanner contains native
ML Kit/Nitro modules and cannot run in Expo Go. From `mobile/`, install the
lockfile exactly and enable the Android feature flag:

```bash
npm ci
EXPO_PUBLIC_RECEIPT_SCANNER_ENABLED=true npx expo prebuild --platform android
```

Then either run a local development build with a configured JDK/Android SDK and
connected device:

```bash
EXPO_PUBLIC_RECEIPT_SCANNER_ENABLED=true npm run android
```

`npm run android` builds/installs the native development client and discovers
the project-local JDK/Android SDK when they are not exported in the shell.
`npm run android:expo-go` remains available for general app testing and for
the gallery-import receipt workflow, but it must not — and, gated by
`ANDROID_RECEIPT_SCANNER_ENABLED`, does not — expose the ML Kit receipt
scanner, because Expo Go does not contain the scanner's Nitro native module.
Opening the receipt-scan action inside Expo Go shows a plain "A native
FinSight build is required" message instead.

or use the project's eventual EAS development/release profile. The generated
native project must autolink both `expo-document-scanner` and
`react-native-nitro-modules`. Setting the flag to `false`, or running in an
unsupported runtime, does **not** restore a camera — Android's receipt-scan
action shows the same "native build is required" message and gallery import
remains the only capture route. Never place server secrets in `EXPO_PUBLIC_*`
variables because they are embedded in the APK.

This repository has validated isolated Android prebuild/autolinking, but has
not produced or signed a release APK. Device verification must record Google
Play Services availability, permissions, first launch/offline behavior,
cancellation, multi-page capture, memory, upload retry and confirmation.

## 5. Database migrations

**`prisma migrate deploy` uses `DIRECT_URL`, not `DATABASE_URL`.** This is the
single easiest thing to get wrong here, and it fails in the worst way:
overriding only `DATABASE_URL` leaves the command pointed at whatever
`DIRECT_URL` holds, which — if that is still your development project — means
migrating the wrong database. Override **both**, always:

```bash
cd backend
DATABASE_URL="$PROD_DB_URL" DIRECT_URL="$PROD_DIRECT_URL" npx prisma migrate deploy
```

Then confirm it did what you expected:

```bash
DATABASE_URL="$PROD_DB_URL" DIRECT_URL="$PROD_DIRECT_URL" npx prisma migrate status
```

Notes:

- **Migrations run separately from the container start**, deliberately — an
  image that migrates on boot will race itself the moment there is more than
  one instance.
- `migrate deploy` only applies pending migrations and never resets. Do not
  use `migrate dev` against a real database; it can drop and recreate.
- **There is no automated rollback.** Prisma has no `migrate down`. The
  migrations in this repo are additive (new tables and defaulted columns), so
  the practical undo is a restore from backup — which is the reason §6 exists.
- Take a backup *before* migrating, not after.
- **On any database with real owners, `20260914104600_receipt_scan_last_activity_grace`
  must be applied in the same `migrate deploy` as
  `20260914010610_receipt_scan_last_activity`, or at least before the first
  hourly abandoned-scan sweep runs after it.** `20260914010610` backfills
  `ReceiptScan.lastActivityAt` from the timestamps the database already had,
  and none of them recorded owner *views*. A pending scan the owner merely
  opened last week therefore looks inactive since its last edit or OCR pass,
  and the sweep would queue it for purge on its first run. The grace
  migration floors `lastActivityAt` for unconfirmed scans at its own ledger
  `started_at` minus six days, so every owner gets at least a day to resume
  before anything is deleted; re-running it computes the same floor and
  changes no rows. Because the chain is ordered, one `migrate deploy` that
  has both pending applies them back to back, leaving a window of seconds;
  the real exposure is a deploy that stops after `20260914010610` while a
  worker is running.
  The development project was migrated without the grace floor on
  14 September 2026 (owner decision, synthetic data); see
  `docs/phase-2/PR-2-REVIEW-2026-09-14.md`, open item 1.

---

## 6. Backups and recovery

### 6.0 What backup mechanism actually exists today

There is **no backup tooling in this repository** — no `supabase/` CLI
project, no scheduled `pg_dump`, no storage-export script. Checked directly:
no `supabase.toml`, no cron/GitHub Actions backup job, nothing under
`backend/` that writes a dump anywhere. That means today's *only* backup is
whatever your Supabase project's plan tier does automatically:

- **Free/low tiers**: backups are minimal or absent, and retention is short.
- **Paid tiers**: daily backups and, on higher tiers, point-in-time recovery
  (PITR), with retention length set by the plan.

**Which tier the production project will be on, and therefore what RPO it
actually has, is not decided yet** — see §10. Until it is, treat the RPO as
"unknown, possibly zero" and do not rely on Supabase's automatic backups alone
for anything you are not prepared to lose.

Because that automatic mechanism is opaque, plan-dependent, and outside this
repo's control, this runbook adds one thing that is *not* plan-dependent: a
manual **logical backup** (`pg_dump`) that any engineer with the production
`DIRECT_URL` can run, verify, and restore, independent of which Supabase tier
is active. Use it as a supplement to (not a replacement for) whatever Supabase
provides — it is a safety net you control, cheap to test, and exactly what
this section rehearses.

### 6.1 Restore rehearsal — Postgres

**Never run any step below against `finsight_test` (the throwaway DB used by
`npm run test:db:up`) or against a real production/staging database.** This
drill uses its own disposable container so nothing in `backend/tests/setup`
can collide with it and nothing here can touch real data.

**Step 1 — Take a logical backup of the source database.**

Point this at whichever database you're rehearsing against. For the actual
rehearsal, a good source is either a real (non-production, ideally staging)
Supabase project's `DIRECT_URL`, or — for a fully offline dry run of the
*mechanics* — the local dev database. Never point `SOURCE_DIRECT_URL` at
production for a casual test; treat a real production dump like the
credential it effectively is.

If a local `postgresql-client` matching Postgres 16 is installed:

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$SOURCE_DIRECT_URL" \
  --file="finsight-backup-$(date +%Y%m%d-%H%M).dump"
```

**Verified working without any local Postgres client install** (this is the
recommended default — it needs only Docker, which every engineer on this repo
already has for `test:db:up`): run `pg_dump` inside a throwaway
`postgres:16-alpine` container — the exact image the rest of this repo already
uses for Postgres — via `docker exec`, then copy the file out:

```bash
docker run -d --rm --name finsight-dump-tool postgres:16-alpine sleep infinity
docker exec finsight-dump-tool pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$SOURCE_DIRECT_URL" --file=/tmp/backup.dump
docker cp finsight-dump-tool:/tmp/backup.dump "finsight-backup-$(date +%Y%m%d-%H%M).dump"
docker rm -f finsight-dump-tool
```

Both were exercised end to end while writing this section (seed rows →
`pg_dump` → `pg_restore` into a fresh container → row count and `md5` checksum
match) — see the checksum command in Step 5.

`--no-owner --no-privileges` matters either way: Supabase's connection roles
differ from whatever local role restores the dump, and including
ownership/grants makes `pg_restore` fail on roles that don't exist in the
target.

**Step 2 — Stand up a disposable restore target.** This mirrors
`backend/package.json`'s `test:db:up`/`test:db:down` pattern exactly, but with
a different container name and port so it can never be confused with (or
collide with) the real test database:

```bash
docker run -d --name finsight-restore-drill \
  -e POSTGRES_USER=drilluser -e POSTGRES_PASSWORD=drillpass \
  -e POSTGRES_DB=finsight_restore_drill \
  -p 55433:5432 \
  postgres:16-alpine

# Wait for it to accept connections
until docker exec finsight-restore-drill pg_isready -U drilluser; do sleep 1; done
```

**Step 3 — Restore into it.**

```bash
DRILL_URL="postgresql://drilluser:drillpass@localhost:55433/finsight_restore_drill"
DUMP_FILE="finsight-backup-YYYYMMDD-HHMM.dump"   # the exact filename from Step 1

# With a local postgresql-client:
pg_restore --no-owner --no-privileges --dbname="$DRILL_URL" "$DUMP_FILE"

# Without one (docker-exec, same pattern as Step 1):
docker cp "$DUMP_FILE" finsight-restore-drill:/tmp/backup.dump
docker exec finsight-restore-drill pg_restore --no-owner --no-privileges \
  -U drilluser -d finsight_restore_drill /tmp/backup.dump
```

**Step 4 — Confirm the schema Prisma expects is actually present.** A restore
that succeeds at the `pg_restore` level but is missing a migration (e.g. the
backup predates a schema change) is a silent data-loss trap, not a working
restore:

```bash
cd backend
DATABASE_URL="$DRILL_URL" DIRECT_URL="$DRILL_URL" npx prisma migrate status
```

This should report the database is up to date with the migrations in
`backend/prisma/migrations`. If it reports missing migrations, apply them
(`DATABASE_URL="$DRILL_URL" DIRECT_URL="$DRILL_URL" npx prisma migrate deploy`)
and note that the backup was taken from a database on an older schema version
— that gap is itself useful information about how stale backups can get
relative to deploys.

**Step 5 — Verify the data, not just the schema.** Compare row counts (and,
ideally, a content checksum) between source and restored target for at least
the tables that hold financial data:

```bash
# With a local psql, query $SOURCE_DIRECT_URL and $DRILL_URL directly.
# Without one, query through the containers instead — this is what was
# actually run to verify this procedure:
for T in "User" "BusinessProfile" "ExpenseRecord" "ExpenseCategory" "SalesReferenceRecord" "ReceiptScan"; do
  echo "== $T =="
  docker exec finsight-restore-drill psql -U drilluser -d finsight_restore_drill \
    -c "SELECT count(*) FROM \"$T\";"
  # Order-independent content checksum, cheap to eyeball for a mismatch against
  # the same query run on the source:
  docker exec finsight-restore-drill psql -U drilluser -d finsight_restore_drill \
    -c "SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM \"$T\";"
done
```

**Step 6 — Smoke test against the restored database**, not just raw SQL. Point
a local backend instance at it and exercise one real read path end to end
(this is the step that actually proves "the app works against this restore",
not just "the tables are there"):

```bash
cd backend
DATABASE_URL="$DRILL_URL" DIRECT_URL="$DRILL_URL" \
  SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  npm run dev
# In another terminal:
curl -s http://localhost:4000/api/v1/health/ready   # → {"status":"ready","database":"ok",...}
```

(Supabase Auth/Storage keys still point at wherever Auth/Storage actually
live — restoring the Postgres database does not restore Supabase-managed Auth
users or Storage objects; those are separate systems, see §6.2.)

**Step 7 — Record the results and tear down.**

- [ ] Write down wall-clock time from "decided to restore" to "Step 6 passed"
      — that number, not a guess, is your actual RTO for this procedure.
- [ ] Note the dump file size and how long Steps 1 and 3 took, since those
      scale with data volume and this rehearsal is done on whatever data
      volume exists today, not at eventual production scale.
- [ ] `docker rm -f finsight-restore-drill` and delete the local dump file
      once satisfied — it contains real data if the source was non-synthetic,
      so it should not be left lying around on a laptop.

### 6.2 Restore rehearsal — Supabase Storage

Storage is a **separate system from Postgres** and a Postgres restore does
**not** bring back Storage objects. Three buckets exist, per
`backend/src/services/storage.service.ts` and `backend/.env.example`:

| Bucket | Contents | Visibility |
|---|---|---|
| `receipts` (`SUPABASE_STORAGE_BUCKET`, default `receipts`) | Scanned receipt photographs | Private (signed URLs) |
| `csv-imports` | Uploaded source CSV files | Private (signed URLs) |
| `avatars` | User profile pictures | Public |

#### Private bucket contract and hosted evidence

The private buckets must match the backend upload contract exactly:

| Bucket | Public | Per-object limit | Allowed stored MIME types |
|---|---:|---:|---|
| `receipts` | no | 10,485,760 bytes | `image/jpeg`, `image/png`, `image/webp` |
| `csv-imports` | no | 5,242,880 bytes | `text/csv` |

The CSV endpoint accepts a small compatibility set at ingress, but the backend
stores every accepted CSV as `text/csv`. Do not add a client policy for either
bucket. `avatars` is outside these commands and remains unchanged.

Run operator commands from `backend/` with `SUPABASE_URL`,
`SUPABASE_STORAGE_BUCKET=receipts`, and either `SUPABASE_SECRET_KEY`
(preferred) or the legacy `SUPABASE_SERVICE_ROLE_KEY` injected by the
operator's secret manager. Do not put a key in a command argument or evidence
file. Verification also requires `DIRECT_URL`; the script refuses a database
target that does not match the canonical Supabase project URL. Neither command
loads `.env` to satisfy missing operator credentials.

First capture the read-only state:

```bash
npm run storage:buckets:verify
```

The verifier uses `getBucket` plus a read-only PostgreSQL catalog transaction.
It emits bucket settings and aggregate counts only, never object paths. A
passing result has `bucketMismatchCount: 0`, two RLS-enabled Storage tables,
zero elevated/owner client roles, and zero policies applicable to `anon` or
`authenticated`. `effectiveClientDmlGrantCount` can be nonzero because
Supabase grants table operations before RLS; RLS with no applicable policy is
the intended denial. `forceRlsTableCount` can be zero because the client roles
neither own nor bypass the Supabase-managed tables.

Configuration is a separate, deliberate mutation:

```bash
npm run storage:buckets:configure -- --apply
npm run storage:buckets:verify
```

The configure command calls only `getBucket` and `updateBucket`. It never
creates a bucket and refuses any receipt bucket name other than `receipts`. It
preflights both buckets before the first update, verifies the returned settings
afterward, and is safe to rerun when the contract already matches.

If either command fails, keep the candidate release and its receipt/CSV upload
routes out of service, keep receipt-provider dispatch disabled, and do not add
direct-client Storage policies. A later API failure can leave one preflighted
bucket updated and the other unchanged; rerun the idempotent configure command,
then require the read-only verifier to exit zero. Do not loosen a private bucket
as rollback. If a bucket is absent, stop and provision it as a separate reviewed
operator action; this tool never creates one.

For hosted evidence, enable shell `pipefail` and capture the verifier's JSON
after configuration. The output contains settings and counts but no key or
object name:

```bash
set -o pipefail
npm run storage:buckets:verify 2>&1 | tee storage-bucket-verification.json
```

There is no scripted backup for these either — same finding as §6.0. Rehearse
an export/restore using the Supabase JS admin client (the same
`SUPABASE_SERVICE_ROLE_KEY` the backend already uses), against a **second,
throwaway Supabase project** — never restore Storage objects into the real
project as a test, since `upload` calls in `storage.service.ts` use
content-addressed/owner-scoped paths and a bad test restore could collide with
real paths.

```js
// scratchpad script — export every object in a bucket to local disk.
// Node/CommonJS, matching how the rest of this repo runs (see backend/package.json) —
// not Bun or Deno.
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function exportBucket(bucket, outDir) {
  const { data: entries, error } = await supabase.storage.from(bucket).list("", { limit: 1000 });
  if (error) throw error;
  for (const entry of entries) {
    const { data, error: dlErr } = await supabase.storage.from(bucket).download(entry.name);
    if (dlErr) throw dlErr;
    const destPath = path.join(outDir, entry.name);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, Buffer.from(await data.arrayBuffer()));
  }
}
```

(This lists only the top level — `receipts` and `csv-imports` are organised
under a `<businessProfileId>/` or similar owner-scoped prefix per
`storage.service.ts`, so a real export needs to recurse into each prefix
returned by `list()`. Treat the snippet above as the shape of the procedure,
not a finished script — write and test the recursive version against the
throwaway project before trusting it.)

Restore rehearsal:

1. Create (or reuse) a throwaway Supabase project with the same three buckets
   and the same public/private settings as production.
2. Re-upload the exported files with `supabase.storage.from(bucket).upload(path, data, { contentType })`,
   preserving the original path — `storage.service.ts`'s `deleteAvatar` and the
   private-bucket signed-URL helpers all depend on the path shape matching
   what a real upload would have produced.
3. **Verification**: for the `receipts`/`csv-imports` buckets, generate a
   signed URL for a handful of restored objects
   (`supabase.storage.from(bucket).createSignedUrl(path, 60)`) and confirm the
   URL actually serves the file back. For `avatars`, hit the public URL
   directly. A restore that "succeeds" at `upload()` but produces an object
   nothing can retrieve is not a working restore.
4. Compare object counts per prefix between source and restored bucket.

### 6.3 Cadence and ownership

- [ ] **Assign an owner** for this rehearsal — someone specific, not "the
      team." This runbook cannot name one.
- **Recommended cadence**: once before any real (non-test) owner data enters
  the system, then quarterly, and again after any schema migration that
  changes a table this rehearsal checksums (§6.1 Step 5) or any change to
  which Storage buckets exist.
- Every rehearsal should update the RTO number in §6.1 Step 7 — a stale "it
  took 20 minutes last time" from before the data volume grew is a false
  sense of security.
- [ ] Decide who is allowed to run `migrate deploy` or a restore against
      production. Not decided here — an operational-access decision, not a
      technical one.

---

## 7. What you will not have on day one

Named plainly, so nobody assumes otherwise:

- **No error tracking.** No Sentry or equivalent. Structured logs (see below)
  go to the container's stdout and nowhere else — nobody is paged, and a
  crash loop is invisible until someone looks.
- **No centralized log retention.** `pino`/`pino-http` give structured,
  request-id-correlated JSON logs, which is a real improvement over
  `console.*` — but they still only go to the container's own stdout. Nothing
  ships them anywhere durable, aggregatable, or alertable, and container
  stdout is typically lost the moment the container is recreated. Choosing
  where logs live (a hosting platform's built-in log drain, a self-run
  collector, a SaaS log service) is a hosting/vendor decision — see §10.
- **No automated scaling policy.** Rate limits and receipt leases are durable,
  but compose still defines one API and one worker. Capacity thresholds and
  replica counts remain an operator decision.
- **Durable work still needs monitoring.** Receipt scans survive a worker
  restart and stale leases can be reclaimed, but no external monitor watches
  the queue-age signal or pages an operator. Three failed attempts produce a
  reviewable terminal failure rather than an infinite retry loop.
- **No production probes/alerting beyond the two health endpoints.**
  `/api/v1/health/live` and `/api/v1/health/ready` exist and are wired into
  the Docker healthcheck and nginx's `depends_on`, but nothing external polls
  them, pages anyone on failure, or graphs them over time. That requires
  picking a monitoring target, which is a hosting decision — see §10.

---

## 8. After deploying

- [ ] `curl https://<host>/api/v1/health` → `{"status":"ok"}`
- [ ] Register a throwaway account and create a business profile
- [ ] Record one expense by hand
- [ ] Scan one synthetic receipt. This exercises Storage and local OCR. An
      optional provider must stay off unless its separate gate is approved.
- [ ] Import a small CSV
- [ ] Confirm `CORS_ORIGIN` is right by using the web app from its real URL,
      not from localhost
- [ ] Delete the throwaway account's data (**manual** — see `SECURITY.md`;
      there is no in-app hard delete yet)

---

## 9. Rolling back

1. Activate `RECEIPT_PROVIDER_KILL_SWITCH=true` and restart API and worker.
2. Run the previous API and worker image tags independently (this is why §4
   tags by commit).
3. **Check whether the bad deploy included a migration.** If it did, the old
   image may not tolerate the new schema. The migrations here are additive, so
   an older backend generally runs against a newer schema — but that is a
   property of the migrations so far, not a guarantee. Check the migration
   before assuming it.
4. Keep both private Storage buckets restricted. Never add a client policy as
   rollback.
5. If data is wrong rather than the code, restore from backup, and note that
   §6 means you should have tested that path already.

---

## 10. Decisions this runbook does not make

These block a fully production-ready deployment and are explicitly **not**
decided here — they are business/stakeholder calls, not engineering ones, and
this document deliberately stays host-agnostic (§1) rather than pick one
unilaterally:

- [ ] **Hosting topology.** Where the containers run (a VM, a PaaS, a
      container platform), and therefore how `docker-compose.yml` maps onto
      real infrastructure — it is written as a reasonable single-VM starting
      point, not a commitment to that shape.
- [ ] **TLS termination point and certificate management.** `nginx/nginx.conf`
      is ready for either shape (TLS at this container via an uncommented
      HTTPS block, or TLS terminated upstream by the hosting platform) but
      does not pick one — see the comment block above the `server { listen
      80; }` block in that file. Whichever is chosen also fixes
      `TRUST_PROXY_HOPS` (backend/.env.example) and needs a certificate
      renewal plan if terminating locally.
- [ ] **Backup retention window and RPO/RTO targets.** §6.0 lays out what
      backup coverage exists today (Supabase's plan-tier automatic backups,
      plus the manual `pg_dump` procedure this runbook adds) but does not
      choose a Supabase plan tier, a retention length, or a target RPO/RTO.
      Until those are chosen, treat current RPO as unknown.
- [ ] **Log retention and alerting destination.** §7 notes structured logs
      exist but go nowhere durable. Where they should go (a platform log
      drain, a self-hosted collector, a SaaS log/monitoring service) and who
      gets paged on a failed `/api/v1/health/ready` are not decided.
- [ ] **Android release signing and distribution.** Not covered by this
      runbook at all (§1) — no signed build has been produced from this repo,
      and the Play Console account / signing key custody is a business
      decision.
