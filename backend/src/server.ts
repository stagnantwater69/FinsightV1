import type { Server } from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./config/prisma";
import { logger } from "./config/logger";
import { assertMigrationsApplied } from "./config/migrationGuard";

/*
 * API process only. The background queue consumers (receipt scans, CSV
 * imports, anomaly analysis, account deletion) and the periodic sweeps run in
 * worker.ts, a separate process — see that file for the polling loop. Keeping
 * them apart means API replicas can scale without multiplying worker
 * throughput, and an API restart/deploy no longer interrupts in-flight
 * background jobs (and vice versa).
 */

/** Undefined until the startup checks below pass and the port actually opens. */
let server: Server | undefined;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "graceful shutdown started");
  const forceTimer = setTimeout(() => {
    logger.fatal("graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceTimer.unref();
  // A signal during startup — before the migration check finished and the
  // port opened — has no server to close and no connections to drain.
  if (!server) {
    await prisma.$disconnect();
    logger.info("graceful shutdown complete");
    return process.exit(0);
  }
  server.close(async (error) => {
    await prisma.$disconnect();
    if (error) logger.error({ err: error }, "HTTP server close failed");
    logger.info("graceful shutdown complete");
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/*
 * THE PORT OPENS ONLY AFTER THE SCHEMA IS VERIFIED — see config/migrationGuard.
 *
 * A process whose build expects columns the database does not have answers
 * every request touching them with an opaque 500 while passing its health
 * check, which is how an unapplied migration reached a real phone as
 * "FinSight's server had a problem with that". Refusing to listen means the
 * load balancer never sends it traffic and the deploy fails visibly instead.
 */
void (async () => {
  await assertMigrationsApplied("api");
  if (shuttingDown) return;
  server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "FinSight backend listening");
  });
})();
