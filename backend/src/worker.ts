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
import { assertMigrationsApplied } from "./config/migrationGuard";
import { runReceiptWorkerOnce } from "./services/receiptScan/worker";
import { shutdownOcr } from "./services/ocr.service";
import { workerHeartbeatPath, writeWorkerHeartbeat } from "./lib/workerHeartbeat";
import { runCsvImportWorkerOnce, sweepStalledCsvImports } from "./services/csvImport.service";
import { cleanUpExpiredRateLimits } from "./middleware/rateLimit.middleware";
import { enqueueDailyProfileAnalyses, runAnalysisWorkerOnce } from "./services/anomalyDetection/job.service";
import { purgeUnverifiedRegistrations, runAccountDeletionWorkerOnce } from "./services/accountDeletion.service";
import {
  redriveStrandedReceiptPurges,
  runReceiptPurgeWorkerOnce,
  sweepAbandonedReceiptScans,
} from "./services/receiptPurge.service";
import { reconcileStaleReceiptProviderDispatches } from "./services/receiptProviderDispatch.service";

logger.info({ pid: process.pid }, "FinSight worker starting");

let shuttingDown = false;
let workerBusy = false;

// An upload waits up to one idle interval to be claimed; a pass that claimed
// anything is followed at once by another so a backlog drains without sleeping.
const IDLE_POLL_MS = 1_000;

// Comfortably inside the probe's 45s staleness ceiling, so a single missed
// write is not a restart. See lib/workerHeartbeat for what it does and does
// not attest to.
const HEARTBEAT_INTERVAL_MS = 10_000;
const heartbeatFile = workerHeartbeatPath();
let heartbeatWritable = true;

async function beatLiveness(): Promise<void> {
  const written = await writeWorkerHeartbeat(heartbeatFile);
  // Logged on the edge only: outside a container this fails on every tick and
  // is unremarkable, but a container that stops being able to write it is
  // about to be restarted and the reason should be in the log.
  if (!written && heartbeatWritable) logger.warn({ file: heartbeatFile }, "worker liveness heartbeat is not writable");
  heartbeatWritable = written;
}

/** One pass over every queue. Resolves true when at least one job was claimed. */
async function work(): Promise<boolean> {
  // Stop picking up new passes once shutdown has started — the in-flight
  // pass (if any) is still allowed to finish below, via workerBusy.
  if (shuttingDown || workerBusy) return false;
  workerBusy = true;
  let claimedAny = false;
  try {
    try {
      const reconciled = await reconcileStaleReceiptProviderDispatches();
      if (reconciled.cancelled > 0 || reconciled.ambiguous > 0) {
        logger.warn(reconciled, "reconciled stale receipt provider dispatches");
      }
    } catch (error) {
      logger.error({ err: error }, "receipt provider dispatch reconciliation failed");
    }
    // Drain immediately available jobs but cap each pass so the event loop
    // returns regularly under a backlog.
    for (let i = 0; i < 5 && (await runReceiptWorkerOnce()); i++) claimedAny = true;
    await runReceiptPurgeWorkerOnce();
    /*
     * Two imports per pass, not five: one large import can be tens of
     * thousands of rows, and it yields between chunks rather than at the end,
     * so a low cap here is what keeps a big import from starving the receipt
     * and analysis work that share this loop.
     */
    for (let i = 0; i < 2 && (await runCsvImportWorkerOnce()); i++) claimedAny = true;
    for (let i = 0; i < 10 && (await runAnalysisWorkerOnce()); i++) claimedAny = true;
    // One stage per pass rather than draining: each stage of a deletion is
    // irreversible, and a bug that ran them back to back would get through all
    // three before the next pass could be stopped.
    for (let i = 0; i < 3 && (await runAccountDeletionWorkerOnce()); i++) claimedAny = true;
  } catch (error) {
    logger.error({ err: error }, "receipt worker pass failed");
  } finally {
    workerBusy = false;
  }
  return claimedAny;
}

/** Runs a pass, then books the next one: immediately after a claim, else after the idle interval. */
async function runPass(): Promise<void> {
  const claimed = await work();
  if (shuttingDown) return;
  workerTimer = setTimeout(() => void runPass(), claimed ? 0 : IDLE_POLL_MS);
}

/*
 * Cleared by shutdown(). Assigned in start(), which does not run until the
 * database has been confirmed to be at the schema this build expects —
 * `undefined` here is the state where a signal arrived during that check,
 * and clearInterval/clearTimeout ignore it. workerTimer is a one-shot timer
 * re-armed by runPass after each pass, not an interval.
 */
let workerTimer: NodeJS.Timeout | undefined;
let livenessTimer: NodeJS.Timeout | undefined;
let rateLimitCleanupTimer: NodeJS.Timeout | undefined;
let csvSweepTimer: NodeJS.Timeout | undefined;
let dailyAnalysisTimer: NodeJS.Timeout | undefined;
let unverifiedPurgeTimer: NodeJS.Timeout | undefined;
let abandonedScanSweepTimer: NodeJS.Timeout | undefined;

/** Every recurring job the worker owns. See start()'s caller for the boot gate. */
function start(): void {
  void beatLiveness();
  livenessTimer = setInterval(() => void beatLiveness(), HEARTBEAT_INTERVAL_MS);

  void runPass();

  rateLimitCleanupTimer = setInterval(() => {
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
  csvSweepTimer = setInterval(() => {
    if (shuttingDown) return;
    void sweepStalledCsvImports()
      .then((swept) => {
        if (swept > 0) logger.warn({ swept }, "swept stalled CSV imports");
      })
      .catch((error) => logger.error({ err: error }, "CSV import sweep failed"));
  }, 60 * 60_000);

  dailyAnalysisTimer = setInterval(() => {
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
  unverifiedPurgeTimer = setInterval(() => {
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

  /*
   * Unconfirmed scans the owner walked away from expire after seven days.
   * Hourly like the registration purge: two bounded index reads that usually
   * return nothing, and the sweep only enqueues; the purge worker in work()
   * does the deleting. The log carries counts only.
   *
   * No sweep at boot on purpose. The first deploy of the activity clock
   * backfills it from timestamps that never recorded owner views, so a sweep
   * in the same second as startup would purge scans the owner opened
   * yesterday before anyone can read the counts. One interval of delay keeps
   * the first pass observable.
   */
  abandonedScanSweepTimer = setInterval(() => {
    if (shuttingDown) return;
    void sweepAbandonedReceiptScans()
      .then((swept) => {
        if (swept.enqueued > 0) logger.info(swept, "swept abandoned receipt scans");
      })
      .catch((error) => logger.error({ err: error }, "abandoned receipt scan sweep failed"));
    // Same cadence: a deletion whose job series burned out gets a fresh
    // series once its cool-down has passed. Counts only in the log.
    void redriveStrandedReceiptPurges()
      .then((redriven) => {
        if (redriven.enqueued > 0) logger.info(redriven, "re-drove stranded receipt purges");
      })
      .catch((error) => logger.error({ err: error }, "stranded receipt purge re-drive failed"));
  }, 60 * 60_000);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker graceful shutdown started");

  // Stop scheduling new work. Timers are cleared up front so no new pass can
  // be scheduled while we wait below for whatever pass is already running.
  clearTimeout(workerTimer);
  // Stops here rather than in the tail below: once shutdown has begun this
  // worker should stop asserting it is live, so a probe sees the truth even
  // if the drain runs long.
  clearInterval(livenessTimer);
  clearInterval(rateLimitCleanupTimer);
  clearInterval(csvSweepTimer);
  clearInterval(dailyAnalysisTimer);
  clearInterval(unverifiedPurgeTimer);
  clearInterval(abandonedScanSweepTimer);

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

  // The force timer stays armed across both awaits below. A warm tesseract
  // thread that refuses to terminate, or a pooler that will not answer
  // $disconnect, would otherwise hang here unbounded past the container's
  // stop grace period and be SIGKILLed mid-disconnect.
  await shutdownOcr().catch((error) => logger.error({ err: error }, "OCR shutdown failed"));
  await prisma.$disconnect();
  clearTimeout(forceTimer);
  logger.info("worker graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/*
 * NO JOB RUNS UNTIL THE SCHEMA IS VERIFIED — see config/migrationGuard.
 *
 * The worker has the same exposure as the API to a database that is behind
 * the build, and less of an audience: a receipt scan that fails here fails
 * inside a queue consumer, where the owner sees a scan that never finishes
 * rather than an error. Worse, a pass that dies on a missing column still
 * burns the job's attempt budget, so a schema problem quietly exhausts
 * retries on work that was never going to succeed until it is fixed.
 */
void (async () => {
  await assertMigrationsApplied("worker");
  if (shuttingDown) return;
  start();
})();
