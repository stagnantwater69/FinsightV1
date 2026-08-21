import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./config/prisma";
import { logger } from "./config/logger";

/*
 * API process only. The background queue consumers (receipt scans, CSV
 * imports, anomaly analysis, account deletion) and the periodic sweeps run in
 * worker.ts, a separate process — see that file for the polling loop. Keeping
 * them apart means API replicas can scale without multiplying worker
 * throughput, and an API restart/deploy no longer interrupts in-flight
 * background jobs (and vice versa).
 */
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "FinSight backend listening");
});

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
  server.close(async (error) => {
    await prisma.$disconnect();
    if (error) logger.error({ err: error }, "HTTP server close failed");
    logger.info("graceful shutdown complete");
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
