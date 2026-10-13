# Load tests

Four files that stand up a sealed copy of the API and drive it with realistic
sessions. Nothing here touches the hosted Supabase project, the shared test
database, or a paid provider — and it must stay that way.

| File | What it is |
|---|---|
| `session.js` | The k6 scenario: one owner's working session |
| `seed.mjs` | Synthetic owners, profiles, categories, records |
| `supabase-stub.mjs` | Local stand-in for Supabase Auth |
| `run-stage.sh` | Runs one stage and samples what k6 cannot see |
| `seed-csv.mjs` | Creates synthetic CSV benchmark owners and profiles |
| `benchmark-csv.mjs` | Exercises staged CSV upload, review, confirm, and worker completion over HTTP |

`k6` is not vendored — it is a 60 MB static binary. Install it, or point `K6`
at one: <https://github.com/grafana/k6/releases>.

## Why the stub exists

`auth.middleware.ts` calls `supabaseAdmin.auth.getUser(token)` on every
authenticated request. Pointing `SUPABASE_URL` at the stub keeps a load run off
the hosted project entirely, and `STUB_LATENCY_MS` lets you model the real
round trip — which is the single biggest lever on measured latency. Run every
stage twice, at `0` and at something like `50`; the second resembles production.

The stub implements `GET /auth/v1/user`. Storage and admin calls return 501 by
default. With `STUB_CSV_STORAGE=true`, it also emulates upload, download, and
delete for the private `csv-imports` bucket in memory; other Storage paths
still return 501. Tokens are seeded UUIDs of the form
`00000000-0000-4000-8000-<12 digits>`; they are not credentials and are valid
only against the stub.

## Running it

```bash
# 1. A throwaway database. NEVER finsight-test-db (55432) or
#    finsight-phase2-db-audit (55433) — see the finsight-verify skill.
docker run -d --name finsight-loadtest-db --cpus=2 --memory=2g \
  -e POSTGRES_PASSWORD=testpass -e POSTGRES_USER=testuser \
  -e POSTGRES_DB=finsight_test -p 55440:5432 postgres:16-alpine

export DATABASE_URL='postgresql://testuser:testpass@localhost:55440/finsight_test'
export DIRECT_URL="$DATABASE_URL"

# 2. Schema, then synthetic data. One profile is deliberately fat (50k rows)
#    so large-history behaviour is measured rather than assumed.
npx prisma migrate deploy
SEED_USERS=60 SEED_RECORDS=400 SEED_FAT_RECORDS=50000 node tests/load/seed.mjs

# 3. Auth stub.
STUB_LATENCY_MS=0 node tests/load/supabase-stub.mjs &

# 4. The API, bound to the throwaway, providers off. Inline vars win over
#    backend/.env, which is never edited, moved or copied.
SUPABASE_URL=http://127.0.0.1:54321 PORT=4100 \
RECEIPT_PROVIDER_DISPATCH_ENABLED=false RECEIPT_PROVIDER_KILL_SWITCH=true \
node dist/server.js &

# 5. Stages: name, target VUs, ramp, hold.
tests/load/run-stage.sh s10  10  20s 60s
tests/load/run-stage.sh s500 500 45s 90s
```

Tear down the container and both processes afterwards.

## Knobs

`BASE_URL`, `USER_COUNT`, `WRITE_PCT`, `THINK_MIN`, `THINK_MAX`, `STAGES` on
the scenario; `SEED_USERS`, `SEED_RECORDS`, `SEED_FAT_RECORDS` on the seeder;
`STUB_PORT`, `STUB_LATENCY_MS` on the stub; `K6`, `LOAD_DB_CONTAINER` on the
runner. `USER_COUNT=1` puts every VU on the fat profile.

The thresholds in `session.js` are machine-enforced. k6 exits non-zero when a
run breaches them: p95 under 2 s for bootstrap, dashboard, records, and writes;
p95 under 5 s for insights; errors under 1%. The dashboard budget covers the
whole summary-plus-flagged-count flow, not one request in isolation.

Deletion sampling is opt-in so the reference session shape stays unchanged.
Set `DELETE_PCT` to delete that percentage of expenses created by the run. When
enabled, `flow_delete` must stay below `DELETE_P95_MS` (2,000 ms by default),
and `DELETE_MIN_SAMPLES` (5 by default) prevents a one-request run from passing.
For example:

```bash
WRITE_PCT=100 DELETE_PCT=100 DELETE_MIN_SAMPLES=5 \
  THINK_MIN=0.1 THINK_MAX=0.2 tests/load/run-stage.sh delete-check 10 5s 20s
```

The delete flow only targets records that the same load-test session created.

## Reference numbers

Measured 18 September 2026 at `18d7a3b`, on one laptop with the API, database
and load generator sharing cores, auth stub at 0 ms. They are a baseline to
compare against, not a capacity statement — and 750 is concurrent sessions of
this shape, not users.

| VUs | req/s | p95 all | p95 dashboard | errors | DB CPU (of 200%) |
|---:|---:|---:|---:|---:|---:|
| 10 | 2.6 | 44 ms | 54 ms | 0% | 11% |
| 100 | 25.3 | 35 ms | 42 ms | 0% | 63% |
| 500 | 122.9 | 65 ms | 85 ms | 0% | 139% |
| 750 | 162.7 | 1.11 s | 1.77 s | 0.004% | 204% |
| 1000 | 165.8 | 3.75 s | 6.61 s | 0.03% | 221% |

Throughput plateaus at ~166 req/s: past 750 the database is saturated and more
load buys latency, not work. With the stub at 50 ms, p95 at 100 VUs goes 35 ms
→ 86 ms — that is the per-request auth round trip, not the app.

## What this does not cover

Receipt scanning, CSV import, file upload and the job queue are not exercised by
the k6 session scenario: provider dispatch is off, storage is stubbed, and the
worker is not running. The separate CSV benchmark below exercises those CSV
paths.
Scan throughput in particular is bounded by `OCR_POOL_SIZE = 2` per worker
process, which is a different scaling question from anything measured here.

A write stage does not yet assert row counts before and after, so "no duplicate
writes" is untested.

## CSV import benchmark

Run this against a fresh, isolated database. It sends synthetic files through
the real HTTP routes and CSV worker. The Auth/Storage stub holds CSV objects in
memory when `STUB_CSV_STORAGE=true`; it does not model hosted Storage latency or
throughput. Other Storage routes still return 501. Do not use this result as a
hosted capacity figure.

The runner tests five shapes: 50 rows, a file close to the 5 MiB upload limit,
200 columns, 100 rows with one invalid amount, and the 30,000-row limit. Each
run uploads once, reviews the staged data, confirms it, and polls until the
batch completes. It checks imported row counts. The report includes elapsed
HTTP timings and the API's `Server-Timing` phases. The local gate requires at
least five samples for every measured stage, review, confirm, and terminal
phase. A phase with fewer samples is reported as `insufficient_samples`, makes
the gate fail, and is never presented as a performance pass.

From `backend/`:

```bash
docker run -d --name finsight-csv-bench-db --cpus=2 --memory=2g \
  -e POSTGRES_PASSWORD=testpass -e POSTGRES_USER=testuser \
  -e POSTGRES_DB=finsight_test -p 55441:5432 postgres:16-alpine

export DATABASE_URL='postgresql://testuser:testpass@127.0.0.1:55441/finsight_test'
export DIRECT_URL="$DATABASE_URL"
export SUPABASE_URL='http://127.0.0.1:54321'
export SUPABASE_ANON_KEY='local-only'
export SUPABASE_SERVICE_ROLE_KEY='local-only'
export NODE_ENV=development
export WORKER_LANES=csv
export RECEIPT_WORKER_IDLE_POLL_MS=250

npx prisma migrate deploy
csv_bench_contexts="$(mktemp)"
BENCH_USER_COUNT=5 node tests/load/seed-csv.mjs > "$csv_bench_contexts"
npm run build
STUB_CSV_STORAGE=true node tests/load/supabase-stub.mjs &
PORT=4100 node dist/server.js &
node dist/worker.js &
BENCH_CONTEXTS_FILE="$csv_bench_contexts" BENCH_ITERATIONS=5 \
  BENCH_OUTPUT="$(mktemp)" node tests/load/benchmark-csv.mjs
```

Stop the three processes and remove only `finsight-csv-bench-db` when done.
The context file contains local stub tokens, not hosted credentials. The
benchmark prints no token and writes no CSV fixtures. It exits nonzero if a
request fails, a row count differs, a batch fails or times out, a performance
budget is breached, or any budget has too few samples. Keep the JSON report out
of git.

Local reference run on 29 September 2026: five samples per shape, one laptop,
Postgres capped at 2 CPUs and 2 GiB, Auth and in-memory CSV Storage stub at
0 ms added latency. The benchmark ran the shapes in the order shown, so these
figures also include warming and the records imported by earlier shapes.

| Shape | Size | Rows | p95 stage | p95 review | p95 confirm | p95 terminal |
|---|---:|---:|---:|---:|---:|---:|
| Small | 2,173 B | 50 | 45 ms | 18 ms | 42 ms | 43 ms |
| Near 5 MiB | 5,177,864 B | 1,274 | 465 ms | 113 ms | 329 ms | 329 ms |
| Wide | 260,583 B | 100, 200 columns | 79 ms | 39 ms | 64 ms | 64 ms |
| Invalid amount | 4,329 B | 100, one skipped | 22 ms | 22 ms | 55 ms | 55 ms |
| Row limit | 1,368,923 B | 30,000 | 221 ms | 436 ms | 140 ms | 10,208 ms |

Only the 30,000-row shape entered the queue. Its p95 time after the confirm
response, including pickup, processing, and status polling, was 10,068 ms.
All 25 batches completed with the expected imported and skipped counts.

The default local regression budgets use three times each reference p95, with a
100 ms floor for short phases so normal laptop timer and scheduling noise does
not make the gate brittle. They are regression tripwires for the isolated setup
above, not production capacity figures or service-level objectives.

| Shape | Stage budget | Review budget | Confirm budget | Terminal budget |
|---|---:|---:|---:|---:|
| Small | 135 ms | 100 ms | 126 ms | 129 ms |
| Near 5 MiB | 1,395 ms | 339 ms | 987 ms | 987 ms |
| Wide | 237 ms | 117 ms | 192 ms | 192 ms |
| Invalid amount | 100 ms | 100 ms | 165 ms | 165 ms |
| Row limit | 663 ms | 1,308 ms | 420 ms | 30,624 ms |

`BENCH_MIN_SAMPLES` changes the required sample count, with five as the minimum
because the runner does not calculate p95 below five samples. Use exactly one
of `BENCH_BUDGETS_FILE` or `BENCH_BUDGETS_JSON` to override selected budgets.
Any omitted phase keeps its default. Unknown scenario or phase names fail fast
so a misspelled override cannot silently disable a gate.

```json
{
  "minimumSamples": 7,
  "scenarios": {
    "near-5mb": { "stageMs": 1000 },
    "30k-rows": { "terminalMs": 25000 }
  }
}
```

`queueAndWorkMs` remains diagnostic. Only asynchronous batches produce that
sample, while `terminalMs` covers every shape and is therefore the enforced
end-to-end completion budget.

On local targets, the runner also starts one 30,000-row import and waits until
the worker has committed at least one chunk while more rows remain. It then
deletes a manual expense from the same business profile while the import
continues. The gate checks that the import finishes with all rows, the deleted
record returns 404, the delete stays within the existing 2,000 ms normal-request
budget, and total import time stays within the 30,000-row terminal budget.
`BENCH_MIXED_DELETE_BUDGET_MS` can override the delete budget;
`BENCH_MIXED_DELETE_TIMEOUT_MS` sets its hard timeout and must be at least as
large as the budget. The mixed gate is skipped for remote targets.

Set `BENCH_MIXED_ONLY=true` to run just this local contention gate. This mode is
useful for a focused rerun and is rejected for remote targets. It still needs a
fresh seeded context file but only uses its first profile.

To test staging, point `BENCH_BASE_URL` to the staging API, provide a contexts
file with staging test account tokens and profile IDs, and set
`BENCH_ALLOW_REMOTE=true`. Use an isolated staging business because confirms
write records. The script never targets a remote host without that flag. Supply
staging-specific budgets rather than treating the local defaults as an SLA.
