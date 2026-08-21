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
- [ ] **A decision about `GOOGLE_GEMINI_API_KEY`.** Without it the vision
      rescue and the AI features degrade quietly rather than erroring — which
      is the intended design, but means an unset key looks like "the AI is
      just not very good" rather than "the AI is not configured."

---

## 3. Environment variables

The backend validates these at boot (`backend/src/config/env.ts`) and refuses
to start if a required one is missing — a deliberate fail-fast, so a
misconfigured deploy dies immediately instead of erroring per-request later.

**Required — no default, boot fails without them:**

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase pooled connection string |
| `DIRECT_URL` | Direct (non-pooled) connection. **Migrations use this one**, not `DATABASE_URL` — see §5 |
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
| `GOOGLE_GEMINI_API_KEY` | `""` | Empty disables the vision rescue silently |
| `OPENROUTER_API_KEY` | `""` | Fallback for the categoriser |
| `TESSERACT_LANG` | `eng` | |

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
docker build -t finsight-backend:$(git rev-parse --short HEAD) ./backend
docker run -d --name finsight-backend -p 127.0.0.1:4000:4000 --env-file /path/to/prod.env \
  finsight-backend:$(git rev-parse --short HEAD)
curl -s http://localhost:4000/api/v1/health/live    # → {"status":"ok","uptimeSeconds":...}
```

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

### Web

```bash
cd web && npm ci && npm run build      # → web/dist/
```

Serve `web/dist` as static files. It is a single-page app, so **the server
must fall back to `index.html` for unknown paths** — without that, refreshing
on `/records` returns a 404 instead of the app.

---

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
- **Single instance only.** The rate limiter is in-memory and per-process
  (`rateLimit.middleware.ts` documents this itself). Behind two instances the
  effective limit doubles. Scaling horizontally means moving it to Redis or
  the database first.
- **Background scan work does not survive a restart.** Receipt reads run
  in-process (see schema header note 15); deploying mid-read strands those
  scans on `processingStatus = "Processing"`. The clients time out politely
  and offer a rescan, but those rows stay stuck. **Prefer deploying when
  nobody is mid-scan**, and know this is the cost of not having a job queue.
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
- [ ] Scan one receipt — this exercises Storage, OCR, and (if configured) the
      vision model, which is the most infrastructure any single action touches
- [ ] Import a small CSV
- [ ] Confirm `CORS_ORIGIN` is right by using the web app from its real URL,
      not from localhost
- [ ] Delete the throwaway account's data (**manual** — see `SECURITY.md`;
      there is no in-app hard delete yet)

---

## 9. Rolling back

1. Run the previous image tag (this is why §4 tags by commit).
2. **Check whether the bad deploy included a migration.** If it did, the old
   image may not tolerate the new schema. The migrations here are additive, so
   an older backend generally runs against a newer schema — but that is a
   property of the migrations so far, not a guarantee. Check the migration
   before assuming it.
3. If data is wrong rather than the code, restore from backup — and note that
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
