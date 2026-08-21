/*
 * Background worker process — the durable DB-backed queue consumers, split out
 * of the API process so the two can scale and restart independently. The API
 * process (server.ts) never runs this loop; this process never calls
 * app.listen. Nothing about the queue logic itself changed in this split —
 * runReceiptWorkerOnce, runCsvImportWorkerOnce, etc. are untouched, and so are
 * the per-pass caps below.
 */
import { prisma } from "./config/prisma";
import { logger } from "./config/logger";
import { runReceiptWorkerOnce } from "./services/receiptScan.service";
import { runCsvImportWorkerOnce, sweepStalledCsvImports } from "./services/csvImport.service";
import { cleanUpExpiredRateLimits } from "./middleware/rateLimit.middleware";
import { enqueueDailyProfileAnalyses, runAnalysisWorkerOnce } from "./services/anomalyDetection/job.service";
import { purgeUnverifiedRegistrations, runAccountDeletionWorkerOnce } from "./services/accountDeletion.service";

logger.info({ pid: process.pid }, "FinSight worker starting");

let shuttingDown = false;
let workerBusy = false;

async function work(): Promise<void> {
  // Stop picking up new passes once shutdown has started — the in-flight
  // pass (if any) is still allowed to finish below, via workerBusy.
  if (shuttingDown || workerBusy) return;
  workerBusy = true;
  try {
    // Drain immediately available jobs but cap each pass so the event loop
    // returns regularly under a backlog.
    for (let i = 0; i < 5 && (await runReceiptWorkerOnce()); i++);
    /*
     * Two imports per pass, not five: one large import can be tens of
     * thousands of rows, and it yields between chunks rather than at the end,
     * so a low cap here is what keeps a big import from starving the receipt
     * and analysis work that share this loop.
     */
    for (let i = 0; i < 2 && (await runCsvImportWorkerOnce()); i++);
    for (let i = 0; i < 10 && (await runAnalysisWorkerOnce()); i++);
    // One stage per pass rather than draining: each stage of a deletion is
    // irreversible, and a bug that ran them back to back would get through all
    // three before the next pass could be stopped.
    for (let i = 0; i < 3 && (await runAccountDeletionWorkerOnce()); i++);
  } catch (error) {
    logger.error({ err: error }, "receipt worker pass failed");
  } finally {
    workerBusy = false;
  }
}

const workerTimer = setInterval(() => void work(), 5_000);
void work();

const rateLimitCleanupTimer = setInterval(() => {
  if (shuttingDown) return;
  void cleanUpExpiredRateLimits().catch((error) => logger.error({ err: error }, "rate-limit cleanup failed"));
}, 60 * 60_000);
void cleanUpExpiredRateLimits().catch((error) => logger.error({ err: error }, "initial rate-limit cleanup failed"));

/*
 * Imports that were claimed and then abandoned — the process died mid-chunk,
 * or a lease expired with attempts exhausted. Hourly rather than per-pass
 * because it is a scan for wreckage, not part of the normal path: the worker's
 * own lease reclaim handles the ordinary crash, and this only catches what has
 * stayed stuck long enough to be certainly dead.
 */
const csvSweepTimer = setInterval(() => {
  if (shuttingDown) return;
  void sweepStalledCsvImports()
    .then((swept) => {
      if (swept > 0) logger.warn({ swept }, "swept stalled CSV imports");
    })
    .catch((error) => logger.error({ err: error }, "CSV import sweep failed"));
}, 60 * 60_000);

const dailyAnalysisTimer = setInterval(() => {
  if (shuttingDown) return;
  void enqueueDailyProfileAnalyses().catch((error) => logger.error({ err: error }, "daily analysis enqueue failed"));
}, 60 * 60_000);
void enqueueDailyProfileAnalyses().catch((error) => logger.error({ err: error }, "initial daily analysis enqueue failed"));

/*
 * Unconfirmed registrations expire.
 *
 * Hourly is far more often than a 72-hour TTL needs, and that is the point: the
 * cost of a pass is one indexed query returning nothing, and running it often
 * means an address is released promptly after its window rather than whenever
 * the process last happened to restart.
 */
const unverifiedPurgeTimer = setInterval(() => {
  if (shuttingDown) return;
  void purgeUnverifiedRegistrations()
    .then((purged) => {
      if (purged > 0) logger.info({ purged }, "purged unverified registrations");
    })
    .catch((error) => logger.error({ err: error }, "unverified registration purge failed"));
}, 60 * 60_000);
void purgeUnverifiedRegistrations().catch((error) =>
  logger.error({ err: error }, "initial unverified registration purge failed"),
);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker graceful shutdown started");

  // Stop scheduling new work. Timers are cleared up front so no new pass can
  // be scheduled while we wait below for whatever pass is already running.
  clearInterval(workerTimer);
  clearInterval(rateLimitCleanupTimer);
  clearInterval(csvSweepTimer);
  clearInterval(dailyAnalysisTimer);
  clearInterval(unverifiedPurgeTimer);

  const forceTimer = setTimeout(() => {
    logger.fatal("worker graceful shutdown timed out; forcing exit mid-job");
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  // Let the in-flight pass finish rather than killing it mid-job — each job
  // inside a pass already checkpoints its own progress in the DB (lease +
  // attempt count), but finishing the current job cleanly is strictly better
  // than abandoning it for a lease timeout to reclaim later.
  while (workerBusy) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  clearTimeout(forceTimer);
  await prisma.$disconnect();
  logger.info("worker graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
