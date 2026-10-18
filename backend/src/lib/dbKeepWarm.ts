/*
 * Keeps the API's pooled database connections from going idle.
 *
 * Measured from a laptop to the hosted database: a query on a warm connection
 * takes about 70 ms, but after a pause of a minute or more the next one took
 * about 600 ms, and a dashboard's parallel batch pays that on every connection
 * it borrows. Something on the path (the pooler, or a NAT) drops idle sessions
 * well before config/prisma's own 60 s idle limit: touching each connection
 * every 45 s did not help, every 15 s did (75-80 ms after a 70 s pause, against
 * about 600 ms without). A connection that is used is never idle long enough to
 * be dropped, so this also never hands out a dead socket.
 *
 * Failures are ignored: the next real query reconnects (and retries) as before.
 */

export interface KeepWarmClient {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

export interface KeepWarmOptions {
  /** Connections to touch each round; 0 turns keep-warm off. */
  connections: number;
  intervalMs: number;
}

const MAX_CONNECTIONS = 10;
const INTERVAL_MS = 15_000;
const FALLBACK_CONNECTIONS = 5;

/**
 * Every connection the API's pool may hold, so a parallel batch finds them all
 * warm. DATABASE_KEEP_WARM_CONNECTIONS overrides it; 0 turns keep-warm off.
 */
export function keepWarmOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): KeepWarmOptions {
  const override = env.DATABASE_KEEP_WARM_CONNECTIONS;
  const poolSize = Number(env.DATABASE_POOL_SIZE);
  const requested = override !== undefined && override !== ""
    ? Number(override)
    : Number.isInteger(poolSize) && poolSize > 0 ? poolSize : FALLBACK_CONNECTIONS;
  const connections = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_CONNECTIONS) : 0;
  return { connections, intervalMs: INTERVAL_MS };
}

/** Starts the timer and returns a function that stops it. */
export function startDbKeepWarm(client: KeepWarmClient, options: KeepWarmOptions = keepWarmOptionsFromEnv()): () => void {
  if (options.connections < 1) return () => {};
  const touch = () => {
    // In parallel, so each call borrows its own pooled connection.
    for (let i = 0; i < options.connections; i++) void client.$queryRaw`SELECT 1`.catch(() => undefined);
  };
  const timer = setInterval(touch, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
