/*
 * Durable DB-backed queue consumers, kept outside the API process. Each
 * configured lane polls independently so long OCR or CSV work cannot delay an
 * unrelated queue in the same process.
 */
import { env } from "./config/env";
import { prisma } from "./config/prisma";
import { logger } from "./config/logger";
import { assertMigrationsApplied } from "./config/migrationGuard";
import { hasWorkerLane, type WorkerLane } from "./config/workerLanes";
import { runReceiptWorkerOnce } from "./services/receiptScan/worker";
import { shutdownOcr, warmOcrPool } from "./services/ocr.service";
import { workerHeartbeatPath, writeWorkerHeartbeat } from "./lib/workerHeartbeat";
import { registerProcessFaultHandlers } from "./lib/processFaults";
import { createWorkerLaneScheduler, type WorkerLaneScheduler } from "./lib/workerLaneScheduler";
import {
  runCsvImportWorkerOnce,
  sweepExpiredCsvStages,
  sweepStalledCsvImports,
} from "./services/csvImport.service";
import { cleanUpExpiredRateLimits } from "./middleware/rateLimit.middleware";
import { enqueueDailyProfileAnalyses, runAnalysisWorkerOnce } from "./services/anomalyDetection/job.service";
import { purgeUnverifiedRegistrations, runAccountDeletionWorkerOnce } from "./services/accountDeletion.service";
import {
  redriveStrandedReceiptPurges,
  runReceiptPurgeWorkerOnce,
  sweepAbandonedReceiptScans,
} from "./services/receiptPurge.service";
import { reconcileStaleReceiptProviderDispatches } from "./services/receiptProviderDispatch.service";
import { runCsvSourcePurgeWorkerOnce, sweepRetainedCsvSources } from "./services/csvSourcePurge.service";

const SELECTED_LANES = env.WORKER_LANES;

logger.info({ pid: process.pid, lanes: SELECTED_LANES }, "FinSight worker starting");

let shuttingDown = false;
/**
 * 0 for a signal, 1 once a process-level fault has been seen. Both paths drain
 * in-flight lane passes, but a supervisor must be able to tell them apart.
 */
let exitCode = 0;

// A lane that claimed work runs again immediately. Only idle lanes sleep.
const IDLE_POLL_MS = env.RECEIPT_WORKER_IDLE_POLL_MS;

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

async function runReceiptLane(): Promise<boolean> {
  let claimedAny = false;
  try {
    const reconciled = await reconcileStaleReceiptProviderDispatches();
    if (reconciled.cancelled > 0 || reconciled.ambiguous > 0) {
      logger.warn(reconciled, "reconciled stale receipt provider dispatches");
    }
  } catch (error) {
    logger.error({ err: error }, "receipt provider dispatch reconciliation failed");
  }

  // A cap returns control regularly even while receipt work is backlogged.
  for (let i = 0; i < 5 && (await runReceiptWorkerOnce()); i++) claimedAny = true;
  return claimedAny;
}

async function runCsvLane(): Promise<boolean> {
  let claimedAny = false;
  // Imports yield within chunks, and the cap also lets this lane observe shutdown.
  for (let i = 0; i < 2 && (await runCsvImportWorkerOnce()); i++) claimedAny = true;
  return claimedAny;
}

async function runAnalysisLane(): Promise<boolean> {
  let claimedAny = false;
  for (let i = 0; i < 10 && (await runAnalysisWorkerOnce()); i++) claimedAny = true;
  return claimedAny;
}

async function runMaintenanceJob(name: string, job: () => Promise<boolean>): Promise<boolean> {
  try {
    return await job();
  } catch (error) {
    logger.error({ err: error, job: name }, "maintenance job failed");
    return false;
  }
}

async function runMaintenanceLane(): Promise<boolean> {
  let claimedAny = false;

  // One claim per subqueue keeps all three moving under a sustained backlog.
  if (await runMaintenanceJob("receipt-purge", runReceiptPurgeWorkerOnce)) claimedAny = true;
  if (await runMaintenanceJob("csv-source-purge", runCsvSourcePurgeWorkerOnce)) claimedAny = true;
  // Account deletion advances one irreversible stage per pass.
  if (await runMaintenanceJob("account-deletion", runAccountDeletionWorkerOnce)) claimedAny = true;

  return claimedAny;
}

const laneWork: Record<WorkerLane, () => Promise<boolean>> = {
  receipt: runReceiptLane,
  csv: runCsvLane,
  analysis: runAnalysisLane,
  maintenance: runMaintenanceLane,
};

async function runLane(lane: WorkerLane): Promise<boolean> {
  if (shuttingDown) return false;
  return laneWork[lane]();
}

let laneScheduler: WorkerLaneScheduler<WorkerLane> | undefined;
let livenessTimer: NodeJS.Timeout | undefined;
let rateLimitCleanupTimer: NodeJS.Timeout | undefined;
let csvSweepTimer: NodeJS.Timeout | undefined;
let csvStageSweepTimer: NodeJS.Timeout | undefined;
let dailyAnalysisTimer: NodeJS.Timeout | undefined;
let unverifiedPurgeTimer: NodeJS.Timeout | undefined;
let abandonedScanSweepTimer: NodeJS.Timeout | undefined;
let csvRetentionSweepTimer: NodeJS.Timeout | undefined;

function startCsvSchedules(): void {
  /*
   * Imports that were claimed and then abandoned — the process died mid-chunk,
   * or a lease expired with attempts exhausted. Hourly rather than per-pass
   * because it is a scan for wreckage, not part of the normal path: the worker's
   * own lease reclaim handles the ordinary crash, and this only catches what has
   * stayed stuck long enough to be certainly dead.
   */
  let stalledSweepRunning = false;
  let stageSweepRunning = false;
  const sweepStalled = async (): Promise<void> => {
    if (shuttingDown || stalledSweepRunning) return;
    stalledSweepRunning = true;
    try {
      await sweepStalledCsvImports();
    } catch (error) {
      logger.error(
        { failureKind: error instanceof Error ? error.name : "unknown" },
        "CSV import sweep failed",
      );
    } finally {
      stalledSweepRunning = false;
    }
  };
  const sweepStages = async (): Promise<void> => {
    if (shuttingDown || stageSweepRunning) return;
    stageSweepRunning = true;
    try {
      await sweepExpiredCsvStages();
    } catch (error) {
      logger.error(
        { failureKind: error instanceof Error ? error.name : "unknown" },
        "CSV stage sweep failed",
      );
    } finally {
      stageSweepRunning = false;
    }
  };
  csvSweepTimer = setInterval(() => {
    void sweepStalled();
  }, 60 * 60_000);
  csvStageSweepTimer = setInterval(() => {
    void sweepStages();
  }, 60_000);
  void sweepStalled();
  void sweepStages();
}

function startAnalysisSchedules(): void {
  dailyAnalysisTimer = setInterval(() => {
    if (shuttingDown) return;
    void enqueueDailyProfileAnalyses().catch((error) => logger.error({ err: error }, "daily analysis enqueue failed"));
  }, 60 * 60_000);
  void enqueueDailyProfileAnalyses().catch((error) => logger.error({ err: error }, "initial daily analysis enqueue failed"));
}

/** Recurring cleanup has one owner even when queue lanes run in parallel. */
function startMaintenanceSchedules(): void {
  csvRetentionSweepTimer = setInterval(() => {
    if (shuttingDown) return;
    void sweepRetainedCsvSources()
      .catch((error) => logger.error({ err: error }, "completed CSV source retention sweep failed"));
  }, 60 * 60_000);
  rateLimitCleanupTimer = setInterval(() => {
    if (shuttingDown) return;
    void cleanUpExpiredRateLimits().catch((error) => logger.error({ err: error }, "rate-limit cleanup failed"));
  }, 60 * 60_000);
  void cleanUpExpiredRateLimits().catch((error) => logger.error({ err: error }, "initial rate-limit cleanup failed"));

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
   * return nothing, and the sweep only enqueues; the maintenance lane does the
   * deleting. The log carries counts only.
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

/** Starts only after the migration guard and receipt-only OCR warmup finish. */
function start(): void {
  void beatLiveness();
  livenessTimer = setInterval(() => void beatLiveness(), HEARTBEAT_INTERVAL_MS);

  laneScheduler = createWorkerLaneScheduler({
    lanes: SELECTED_LANES,
    idlePollMs: IDLE_POLL_MS,
    runLane,
    onError: (lane, error) => logger.error({ err: error, lane }, "worker lane pass failed"),
  });
  laneScheduler.start();

  if (hasWorkerLane(SELECTED_LANES, "csv")) startCsvSchedules();
  if (hasWorkerLane(SELECTED_LANES, "analysis")) startAnalysisSchedules();
  if (hasWorkerLane(SELECTED_LANES, "maintenance")) startMaintenanceSchedules();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker graceful shutdown started");

  // Stop scheduling new work before waiting for every active lane to drain.
  laneScheduler?.stop();
  // Stops here rather than in the tail below: once shutdown has begun this
  // worker should stop asserting it is live, so a probe sees the truth even
  // if the drain runs long.
  clearInterval(livenessTimer);
  clearInterval(rateLimitCleanupTimer);
  clearInterval(csvSweepTimer);
  clearInterval(csvStageSweepTimer);
  clearInterval(dailyAnalysisTimer);
  clearInterval(unverifiedPurgeTimer);
  clearInterval(abandonedScanSweepTimer);
  clearInterval(csvRetentionSweepTimer);

  const forceTimer = setTimeout(() => {
    logger.fatal("worker graceful shutdown timed out; forcing exit mid-job");
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  // Each queue checkpoints progress in the DB, but a clean lane drain avoids
  // waiting for a lease timeout to reclaim an interrupted job.
  while (laneScheduler?.isBusy()) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // The force timer stays armed across both awaits below. A warm tesseract
  // thread that refuses to terminate, or a pooler that will not answer
  // $disconnect, would otherwise hang here unbounded past the container's
  // stop grace period and be SIGKILLed mid-disconnect.
  if (hasWorkerLane(SELECTED_LANES, "receipt")) {
    await shutdownOcr().catch((error) => logger.error({ err: error }, "OCR shutdown failed"));
  }
  await prisma.$disconnect();
  clearTimeout(forceTimer);
  logger.info("worker graceful shutdown complete");
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A rejection or throw that escaped a pass's own try/catch — a timer callback,
// an event handler, a promise nobody awaited. Drained through the same path as
// SIGTERM so the in-flight job finishes and tesseract's threads are shut down,
// rather than dying mid-job for a lease timeout to reclaim minutes later.
registerProcessFaultHandlers({
  process,
  logger,
  onFatal: (kind) => {
    exitCode = 1;
    void shutdown(kind);
  },
});

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
  if (hasWorkerLane(SELECTED_LANES, "receipt")) {
    try {
      const workers = await warmOcrPool();
      logger.info({ workers }, "OCR worker pool warmed");
    } catch (error) {
      logger.warn({ err: error }, "OCR worker pool warmup failed");
    }
  }
  if (shuttingDown) return;
  start();
})();
