import { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "./logger";
import { recordDbOperation } from "../lib/requestTiming";

/** A single query slower than this is logged; most are a pooler round-trip (tens of ms). */
const SLOW_QUERY_MS = 300;

/*
 * Pool size per process. The API and both workers share one `.env`, and so one
 * DATABASE_URL, but they need very different pools: the API serves many short
 * concurrent requests, a worker runs a few long jobs. Left unset, Prisma sizes
 * every pool from the CPU count (2 × cores + 1), which on a small host starves
 * the API — a request that cannot get a connection waits up to `pool_timeout`
 * (10s) before failing, which is what a 10–15 second page load looks like.
 *
 * docker-compose.yml sets DATABASE_POOL_SIZE per service. A `connection_limit`
 * already present in the URL always wins, so an operator can still pin it there.
 */
export function withPoolSize(databaseUrl: string | undefined, poolSize: string | undefined): string | undefined {
  if (!databaseUrl) return databaseUrl;
  const size = Number(poolSize);
  if (!Number.isInteger(size) || size < 1) return databaseUrl;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  if (url.searchParams.has("connection_limit")) return databaseUrl;
  url.searchParams.set("connection_limit", String(size));
  return url.toString();
}

/*
 * How long a pooled connection may wait for the database's reply before Prisma
 * drops it. Left unset, Prisma waits forever. The Supabase pooler can stop
 * answering a session without closing its socket (TCP stays up, the query is
 * acknowledged, no reply ever comes). Each such query then holds its pool slot
 * for good; once every slot is held, every request waits out `pool_timeout`
 * and fails with P2024 ("database connection is unavailable") until the
 * process restarts. With a timeout the stuck connection errors, is discarded,
 * and the pool reconnects on its own.
 *
 * 30s is well above any single statement this app runs (the longest
 * transaction, CSV import, is 60s in total but made of short statements).
 * DATABASE_SOCKET_TIMEOUT_SECONDS overrides it; a `socket_timeout` already in
 * the URL always wins.
 */
const DEFAULT_SOCKET_TIMEOUT_SECONDS = 30;

export function withSocketTimeout(databaseUrl: string | undefined, seconds: string | undefined): string | undefined {
  return withSecondsParam(databaseUrl, "socket_timeout", seconds, DEFAULT_SOCKET_TIMEOUT_SECONDS);
}

/*
 * How long an idle pooled connection may sit before Prisma closes it instead
 * of reusing it. Prisma's own default is 300s, but an idle TCP session to the
 * Supabase pooler can be dropped sooner — by Supavisor or by NAT on the way —
 * without the socket being told. The next request to borrow that connection
 * (typically the first login after the app sat unused) then fails with P1017
 * and the owner sees "database connection is unavailable". Recycling idle
 * connections after 60s means a quiet pool reconnects instead of reusing a
 * dead socket. DATABASE_IDLE_CONNECTION_LIFETIME_SECONDS overrides it; a
 * `max_idle_connection_lifetime` already in the URL always wins.
 */
const DEFAULT_IDLE_CONNECTION_LIFETIME_SECONDS = 60;

export function withIdleConnectionLifetime(databaseUrl: string | undefined, seconds: string | undefined): string | undefined {
  return withSecondsParam(databaseUrl, "max_idle_connection_lifetime", seconds, DEFAULT_IDLE_CONNECTION_LIFETIME_SECONDS);
}

function withSecondsParam(
  databaseUrl: string | undefined,
  param: string,
  seconds: string | undefined,
  fallback: number,
): string | undefined {
  if (!databaseUrl) return databaseUrl;
  const configured = seconds === undefined || seconds === "" ? fallback : Number(seconds);
  if (!Number.isInteger(configured) || configured < 1) return databaseUrl;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  if (url.searchParams.has(param)) return databaseUrl;
  url.searchParams.set(param, String(configured));
  return url.toString();
}

/*
 * WHICH CONNECTION FAILURES ARE RETRIED, AND WHY ONLY THESE.
 *
 * P2024 (no free pool slot within pool_timeout), P1001 (server not
 * reachable) and an engine that could not connect at all fail before the
 * statement is sent, so running it again
 * cannot apply a write twice. P1017 (connection closed), P1008 and P1002
 * (timed out) can strike after the database has executed the statement, so
 * they are retried only for reads.
 *
 * Nothing inside a transaction is retried. A statement re-run on its own
 * would execute outside the transaction it belonged to, and a transaction
 * whose connection died cannot be continued anyway — the whole transaction
 * fails and the error middleware answers 503 as before.
 */
const NEVER_SENT_CODES = new Set(["P2024", "P1001"]);
const DROPPED_CODES = new Set(["P1017", "P1008", "P1002"]);
const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
/** Delays before each retry. P2024 already waited out pool_timeout, so it gets one retry only. */
const RETRY_DELAYS_MS = [150, 600];

function connectionErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  if (err instanceof Prisma.PrismaClientInitializationError) return err.errorCode;
  return undefined;
}

export function shouldRetryQuery(
  err: unknown,
  operation: string,
  inTransaction: boolean,
  attempt: number,
): boolean {
  if (inTransaction || attempt >= RETRY_DELAYS_MS.length) return false;
  // The engine could not connect at all (often with no code), so nothing ran.
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  const code = connectionErrorCode(err);
  if (code === undefined) return false;
  if (code === "P2024" && attempt >= 1) return false;
  return NEVER_SENT_CODES.has(code) || (DROPPED_CODES.has(code) && READ_OPERATIONS.has(operation));
}

const datasourceUrl = withIdleConnectionLifetime(
  withSocketTimeout(
    withPoolSize(process.env.DATABASE_URL, process.env.DATABASE_POOL_SIZE),
    process.env.DATABASE_SOCKET_TIMEOUT_SECONDS,
  ),
  process.env.DATABASE_IDLE_CONNECTION_LIFETIME_SECONDS,
);

const baseClient = new PrismaClient({
  // Only override when the size was applied; otherwise Prisma reads the env as before.
  ...(datasourceUrl && datasourceUrl !== process.env.DATABASE_URL ? { datasourceUrl } : {}),
  log: [{ emit: "event", level: "query" }],
});

/*
 * `e.query` is the SQL text with `$1`-style placeholders; the bound values are
 * in `e.params`, which is deliberately never logged — they carry owner data.
 */
baseClient.$on("query", (e) => {
  if (e.duration < SLOW_QUERY_MS) return;
  logger.info({ event: "db.slow_query", durationMs: e.duration, query: e.query.slice(0, 500) }, "slow query");
});

/*
 * Typed as the plain client on purpose. A query-only extension adds no
 * methods, but its generated types are not assignable to
 * `Prisma.TransactionClient`, which dozens of helpers accept.
 */
export const prisma = baseClient.$extends({
  name: "connection-retry",
  query: {
    async $allOperations({ model, operation, args, query, ...rest }) {
      // Prisma's own marker for "this call belongs to a $transaction", batch or
      // interactive. Not in the public types; tests/unit/prismaRetry.test.ts
      // pins it so a Prisma upgrade that drops it fails loudly.
      const internal = (rest as { __internalParams?: { transaction?: unknown } }).__internalParams;
      const inTransaction = internal?.transaction !== undefined;
      for (let attempt = 0; ; attempt++) {
        // Per attempt: a retried query is another round trip.
        recordDbOperation();
        try {
          return await query(args);
        } catch (err) {
          if (!shouldRetryQuery(err, operation, inTransaction, attempt)) throw err;
          logger.warn(
            { event: "db.retry", code: connectionErrorCode(err), model, operation, attempt: attempt + 1 },
            "retrying query after a connection failure",
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
      }
    },
  },
}) as unknown as PrismaClient;
