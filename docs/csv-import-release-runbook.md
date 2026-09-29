# CSV import release and monitoring

This runbook covers the staged web import flow: one private CSV upload, column
mapping and preview from durable parsed rows, confirmation, background import,
and eventual source cleanup. The general deployment and backup procedure is in
[the deployment runbook](deployment-runbook.md).

Successful imports retain their records and batch history. The private source
CSV is retained for 90 days by default, then the maintenance worker enqueues
its deletion through the durable source-purge queue. Set
`CSV_SOURCE_RETENTION_DAYS` from 30 through 365 for a different approved
retention period; deploy the same value to every maintenance worker. A source
purge failure appears in the readiness metrics below.

## Staging preflight

1. Record the candidate commit, backend image tag, web build, staging API URL,
   and Supabase project reference in the release record. Confirm the API,
   `DATABASE_URL`, `DIRECT_URL`, and Storage credentials all belong to that
   staging project. Do not infer the target from a developer `.env` file.
2. Check the staging database backup and restore procedure in the deployment
   runbook before applying migrations. Run `npx prisma migrate status` from
   `backend/` with both staging database URLs injected by the secret manager.
   Inspect the pending migration list, including the CSV staging and source
   purge migrations. Apply them through the repository's guarded
   `npm run migrate:deploy-hosted` command, using its exact project-reference
   confirmation, then rerun `migrate status`. Do not run `migrate dev`,
   `db reset`, or a seed against staging.
3. Run `npm run storage:buckets:verify` from `backend/` with staging secrets
   injected. The private `csv-imports` bucket must exist, have the 5 MiB file
   cap and `text/csv` MIME contract, and have no direct client policy. The
   verifier is read-only and prints aggregate settings only.
4. Run the full repository CI gates on the exact commit. The backend gate
   applies all migrations to a fresh database, checks schema drift, and runs
   tests. Web gates include typecheck, lint, build, bundle budget, unit tests,
   and Chromium flows. The container gate boots the backend against a migrated
   database. Run the CSV benchmark against staging with synthetic files before
   admitting real owner data; record p50/p95 upload, preview, confirm, and
   queue wait separately.

The repository does not contain a staging Supabase link or a deploy target.
Supply the staging project reference, secret-manager environment, API URL, and
deployment image target through the chosen hosting system. This document does
not turn a local `.env` into staging authority.

## Protected CSV readiness check

The backend's `/api/v1/health/ready` response includes queue detail only when
the production request supplies the configured `x-health-token`. Schedule the
read-only command below from the monitoring environment with a staging or
production HTTPS URL and matching token. `http://localhost` is accepted for
local drills. The command never loads `backend/.env` and emits only counts,
ages, fixed alert codes, and status. It exits nonzero when data is missing or
an alert threshold is exceeded.

```bash
cd backend
CSV_READINESS_URL="https://<api-host>/api/v1/health/ready" \
  npm run ops:csv-import:readiness
```

Inject `HEALTH_DETAIL_TOKEN` via the scheduler's secret store. Do not put its
value on the command line, in a URL, or in an alert message. Poll once per
minute, retain the redacted JSON result, and route nonzero exits to the
release owner. Monitor the public health endpoint separately; a missing
detail token is an alerting fault even when public readiness is green.

| Signal | Initial threshold | Action |
|---|---:|---|
| `CSV_QUEUE_WAIT` | Oldest `PENDING` import over 10 minutes | Check the `csv` worker lane and pending count. A large active import does not contribute to this wait. |
| `CSV_PROCESSING_AGE` | Oldest `PROCESSING` import over 30 minutes | Check worker heartbeat, attempt count, and recent errors. Compare with the 30,000-row benchmark before tuning. |
| `CSV_PURGE_AGE` | Oldest queued source purge over 10 minutes | Check the `maintenance` worker lane and Storage availability. |
| `CSV_PURGE_FAILED` | Any terminal source purge failure | Investigate promptly; the private source object may still exist. |
| `CSV_STAGE_AGE` | Oldest upload stage over 25 hours | The stage lifetime is 24 hours. Check expiry sweep and source purge progress. |

The thresholds are operational starting points, not measured service-level
objectives. The command accepts `CSV_QUEUE_WAIT_ALERT_SECONDS`,
`CSV_PROCESSING_AGE_ALERT_SECONDS`, `CSV_PURGE_AGE_ALERT_SECONDS`, and
`CSV_STAGE_AGE_ALERT_SECONDS` as integer overrides from 60 through 172,800.
Change them only after reviewing staging measurements. Queue ages and stage
ages are aggregate metrics; they contain no owner identifiers or filenames.
The source-purge age includes pending, retrying, and processing jobs, so check
worker state before interpreting it as time waiting to start.

Count structured log events with `operationalEvent=csv.request.rejected`,
grouped by the `code` field in a short time window. `CSV_STAGE_BUSY` means the
per-process CSV work gate is saturated; inspect API replica count and upload/preview
latency. `CSV_STAGE_OUTSTANDING_LIMIT`, `CSV_STAGE_STORAGE_LIMIT`, and
`CSV_STAGE_HOURLY_LIMIT` are owner admission caps; a single occurrence can be
normal, but a sustained increase across distinct requests deserves review.
Use response codes and request IDs for triage, not CSV contents or object
paths. Set a warning for five such responses in five minutes during rollout,
then tune it from observed traffic. The app currently writes JSON logs to
container stdout; a hosted log drain and an alert destination must be
configured before this becomes an automated alert. Do not mark monitoring
complete merely because the query or command exists.

## Controlled rollout

1. Deploy the additive database migrations first. Keep the existing API and
   web build running while `migrate status` and bucket verification pass.
2. Deploy the backend API and `csv,analysis,maintenance` jobs worker from the
   same candidate commit. Check `/health/live`, `/health/ready`, the protected
   CSV readiness command, and worker readiness. The API still accepts the
   prior CSV request path, so this can precede the web deployment.
3. Deploy the web build to staging. Import synthetic small, near-5 MiB, wide,
   malformed, and 30,000-row files. Check column mapping, skipped rows,
   duplicate confirmation, one-upload behavior, result counts, and removal of
   an abandoned stage. Run the Storage reconciliation audit after cleanup.
   From `backend/`, run
   `npm run ops:csv-storage:reconcile -- --profile-id <synthetic-profile-id>`.
   Reconciliation is audit-only by default. Add `--delete` after the profile
   argument only after reviewing eligible orphan counts; that mode queues aged
   objects for the durable purge worker rather than deleting them in the audit
   request.
4. Release to the chosen initial production audience or deployment slice only
   after staging p95 timings, error counts, and cleanup metrics are reviewed.
   Keep the previous API, worker, and web artifacts available by commit tag.
   Expand the slice only while queue wait, processing age, purge age, 429
   responses, and API readiness stay within the agreed thresholds. Record the
   size and duration of each slice in the release record; the repository does
   not choose a traffic router or user-cohort system.

Rollback starts with the web artifact if the regression is limited to its
import flow. If backend processing is faulty, stop new CSV confirmations at
the edge or restore the previous backend and jobs-worker image together after
checking schema compatibility. Let already accepted jobs finish or resume on
the compatible worker; do not delete their batch rows or private source
objects to force a rollback. Keep the additive migrations in place unless a
tested database restore is required. Recheck readiness, staged upload counts,
source purges, and one synthetic import after restoring the previous build.
The general database restore procedure is in the deployment runbook.

## Release record

Record the exact commit and image tags, staging project reference, migration
status before and after, backup identifier, bucket verification result,
benchmark p95 values, synthetic import result, readiness output, log-alert
delivery test, reconciliation result, rollout slices, and rollback result.
Exclude tokens, connection strings, CSV row data, object paths, and owner IDs.
