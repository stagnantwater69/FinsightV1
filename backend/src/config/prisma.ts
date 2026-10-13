import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

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

const datasourceUrl = withPoolSize(process.env.DATABASE_URL, process.env.DATABASE_POOL_SIZE);

export const prisma = new PrismaClient({
  // Only override when the size was applied; otherwise Prisma reads the env as before.
  ...(datasourceUrl && datasourceUrl !== process.env.DATABASE_URL ? { datasourceUrl } : {}),
  log: [{ emit: "event", level: "query" }],
});

/*
 * `e.query` is the SQL text with `$1`-style placeholders; the bound values are
 * in `e.params`, which is deliberately never logged — they carry owner data.
 */
prisma.$on("query", (e) => {
  if (e.duration < SLOW_QUERY_MS) return;
  logger.info({ event: "db.slow_query", durationMs: e.duration, query: e.query.slice(0, 500) }, "slow query");
});
