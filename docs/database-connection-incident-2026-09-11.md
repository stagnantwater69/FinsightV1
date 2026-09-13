# Database connection incident — 11 September 2026

**Status: local development database connectivity restored.** A fresh Prisma
query through the saved development launcher succeeded in about two seconds,
and the restarted API returned three successive successful readiness checks
through the web proxy. A synthetic nonexistent-account login reached the
expected HTTP 401 credential response instead of a database failure. An actual
user login has not been verified in this report.

The original connection path stalls during PostgreSQL SSL negotiation. The
available evidence does not establish whether the network or provider caused
it. Persisted `.env` files and the upstream database project are unchanged.

## Observed evidence

| Check | Result |
| --- | --- |
| Local web server on port 5173 | HTTP 200 |
| API `/api/v1/health/live` | HTTP 200; Node process running |
| API `/api/v1/health/ready` before recovery | HTTP 503; database unavailable to the API |
| Fresh Prisma client, transaction pooler on port 6543 | Connection timed out after the default 5 seconds |
| Fresh Prisma client, session pooler on port 5432 | Connection timed out after the default 5 seconds |
| Increased connection timeout to 30 seconds | Did not restore the connection |
| Hosted project status and management SQL | `ACTIVE_HEALTHY`; SQL queries succeeded; 23 of 60 database connections in use at observation time |
| TCP to the pooler | Connection established and request bytes acknowledged, but expected PostgreSQL replies did not arrive during the normal handshake |
| Additional protocol diagnostics | SSL acceptance (`S`) and a SASL authentication challenge became visible when a malformed continuation forced the connection to close; normal connections still failed |
| Same-project direct endpoint | IPv6 unavailable from this workstation |
| Alternate-network comparison | Not established: the default route remained unchanged |
| TLS negotiation with ClientHello sent before the delayed acknowledgement | TLS and encrypted PostgreSQL startup completed on an open connection |
| Saved development launcher, fresh Prisma `SELECT 1` | Succeeded in about 2 seconds; diagnostic exit code 0 |
| Concurrent query load | 24 real `SELECT 1` queries succeeded through one fresh Prisma client, in three waves of eight concurrent queries |
| Restarted API `/api/v1/health/ready` through the port-5173 web proxy | Three successive HTTP 200 responses, `"status":"ready"`, `"database":"ok"` |
| Login endpoint through the same web proxy | Synthetic nonexistent account received the expected HTTP 401 invalid-credentials response; no real-user login claimed |

The management SQL path working does not verify the application's Prisma
connection. TCP acknowledgements establish transport reachability, not a
successful PostgreSQL handshake. The delayed protocol responses are evidence
of a connection-path problem, but do not identify which component held them.
The failed direct probes did not establish an alternate-network connection.
The subsequent relay successfully used the same upstream database and
credentials; no project switch was involved.

## Recovery that persists across development restarts

`npm run dev`, `npm run worker:dev` and `npm run db:check` now use
`scripts/dev-database.ts`. In development, compatible shared Supabase pooler
connections go through an automatically started loopback-only relay. It
allows the TLS ClientHello to proceed before the delayed SSL acknowledgement,
then forwards TLS records unchanged. The relay does not terminate TLS or
decrypt database traffic; TLS remains mandatory and the existing certificate
acceptance policy is preserved.

Only the child process receives the derived loopback `DATABASE_URL`.
Persisted `DATABASE_URL`, `DIRECT_URL` and credentials are untouched, and the
relay closes with the child. Strict/custom TLS configurations and other
database hosts keep their original direct route. Production startup and test
connections also keep their existing behavior. The original commands remain
available as `dev:direct`, `worker:dev:direct` and `db:check:direct`.

## Next investigation

1. Compare the standard SSL/PostgreSQL handshake and
   `npm run db:check:direct --prefix backend` from a genuinely different
   network or an existing authorized host. Verify the route actually changed
   before interpreting the result.
2. Inspect the workstation's route, VPN/proxy/firewall behavior and network
   equipment for delayed or buffered PostgreSQL traffic. Compare packet
   timestamps with the independent-host result where available.
3. If the same failure occurs independently, provide the provider with the
   incident time, affected pooler host/ports and sanitized handshake evidence
   through the existing support channel. Request investigation of the shared
   pooler and its network path. Sending a support message is a separate action.
4. Keep requiring the actual API's readiness endpoint to return HTTP 200 with
   `"database":"ok"` after restarts, then verify login. A successful management
   query, web page or liveness check alone is insufficient.

Do not disable the durable rate limiter, weaken RLS, reset passwords or change
database projects to work around this failure. Increasing timeouts alone did
not address the observed outage.

## Prevention and validation completed

- Added `npm run db:check --prefix backend`, a read-only `SELECT 1` through
  the runtime Prisma client. It reports sanitized connection details and
  status, exits nonzero on failure and has a 45-second overall deadline.
- Added regression coverage for diagnostic validation, credential redaction,
  database error handling and relay transport behavior: **86 targeted tests
  passed across seven files**. The backend build, strict script TypeScript
  check and focused lint check also passed.
- Verified the saved development launcher against the hosted database and
  observed the running API return successful database readiness. A local
  test-database check also passed through the unchanged direct route.
- Updated the [deployment runbook](deployment-runbook.md#if-login-reports-that-the-database-cannot-be-reached)
  and onboarding guidance to require database
  readiness, distinguish it from process liveness, and check the actual
  runtime/network environment before declaring recovery.

The local workaround restores connectivity for the observed handshake stall
and is included in future normal development starts. The original direct
connection path remains unfixed; its underlying network/provider cause is
uncertain, and external outages remain possible.
