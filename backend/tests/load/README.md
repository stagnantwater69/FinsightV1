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

`k6` is not vendored — it is a 60 MB static binary. Install it, or point `K6`
at one: <https://github.com/grafana/k6/releases>.

## Why the stub exists

`auth.middleware.ts` calls `supabaseAdmin.auth.getUser(token)` on every
authenticated request. Pointing `SUPABASE_URL` at the stub keeps a load run off
the hosted project entirely, and `STUB_LATENCY_MS` lets you model the real
round trip — which is the single biggest lever on measured latency. Run every
stage twice, at `0` and at something like `50`; the second resembles production.

The stub implements `GET /auth/v1/user` and nothing else. Storage and admin
calls return 501 on purpose: a path that silently pretends to work would make a
load test lie. Tokens are seeded uuids of the form
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

The thresholds in `session.js` are the acceptance criteria, so k6 exits
non-zero when a run breaches them: p95 under 2 s for normal requests, under 5 s
for reports, errors under 1%.

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

Receipt scanning, CSV import, file upload and the job queue are not exercised:
provider dispatch is off, storage is stubbed, and the worker is not running.
Scan throughput in particular is bounded by `OCR_POOL_SIZE = 2` per worker
process, which is a different scaling question from anything measured here.

A write stage does not yet assert row counts before and after, so "no duplicate
writes" is untested.
