import { randomUUID } from "node:crypto";
import { AnalysisJobKind, AnalysisJobStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { utcToday } from "../../lib/dates";
import { detectAmountOutlierForExpense } from "./amountOutlier.service";
import { detectBehavioralNoveltyForExpense } from "./behavioralNovelty.service";
import { refreshOwnedCategoryStatistics } from "./categoryStatistics.service";
import { meetsNotificationSeverity, RUNTIME_DETECTION_CONFIG } from "./config";
import { refreshIsolationForestFindings } from "./isolationForest.service";
import { detectNearDuplicateForExpense } from "./nearDuplicate.service";
import { refreshRecurringPatterns } from "./recurring.service";
import { refreshTrendFindings } from "./trend.service";
import { detectVelocityForExpense } from "./velocity.service";
import { NOTIFICATION_TYPES } from "../notification.service";
import type { AnalysisMutationGuard } from "./mutationGuard";

const LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;
const MAX_ATTEMPTS = 5;

/**
 * Thrown when a newer worker already owns this job, so nothing further may be
 * written for it. Same rule and same name shape as the receipt worker's
 * `ReceiptLeaseLostError`.
 */
export class AnalysisLeaseLostError extends Error {}

/**
 * `claimJob` reclaims a PROCESSING job whose heartbeat is older than the
 * lease, and nothing refreshed that heartbeat once processing began. A
 * PROFILE_REFRESH rebuilds category statistics, recurring patterns and trends
 * for a whole profile, so passing five minutes is ordinary rather than a dead
 * worker: the reclaim landed a second worker on the same CategoryStatistics
 * rows, and whichever wrote last won.
 */
async function heartbeatJob(job: ClaimedJob): Promise<void> {
  const updated = await prisma.analysisJob.updateMany({
    where: {
      id: job.id,
      status: AnalysisJobStatus.PROCESSING,
      workerId: job.workerId,
      attemptCount: job.attemptCount,
    },
    data: { heartbeatAt: new Date() },
  });
  if (updated.count !== 1) throw new AnalysisLeaseLostError(`Analysis job ${job.id} lease was reclaimed`);
}

/** Every terminal write re-checks the lease, so a superseded worker records nothing. */
function leaseGuard(job: ClaimedJob) {
  return { id: job.id, status: AnalysisJobStatus.PROCESSING, workerId: job.workerId, attemptCount: job.attemptCount };
}

function leaseMutationGuard(job: ClaimedJob): AnalysisMutationGuard {
  return (mutation) => prisma.$transaction(async (db) => {
    const claimed = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT "AnalysisJob_ID" AS id
      FROM "AnalysisJob"
      WHERE "AnalysisJob_ID" = ${job.id}
        AND "AnalysisJob_Status" = 'PROCESSING'
        AND "AnalysisJob_WorkerID" = ${job.workerId}
        AND "AnalysisJob_AttemptCount" = ${job.attemptCount}
      FOR UPDATE
    `);
    if (claimed.length !== 1) {
      throw new AnalysisLeaseLostError(`Analysis job ${job.id} lease was reclaimed`);
    }
    return mutation(db);
  }, { maxWait: HEARTBEAT_MS, timeout: LEASE_MS });
}

// Severity gate moved to ./config so the recurring watchdog, which emits from
// the PROFILE_REFRESH path, applies the identical rule. Behaviour unchanged.

export async function enqueueExpenseAnalysis(
  businessProfileId: number,
  expenseRecordId: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.analysisJob.upsert({
    where: { idempotencyKey: `transaction:${expenseRecordId}` },
    create: { businessProfileId, expenseRecordId, idempotencyKey: `transaction:${expenseRecordId}`, kind: AnalysisJobKind.TRANSACTION },
    update: {
      status: AnalysisJobStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      workerId: null,
      heartbeatAt: null,
      processingStartedAt: null,
    },
  });
}

export async function enqueueExpenseAnalyses(businessProfileId: number, expenseRecordIds: number[]) {
  if (expenseRecordIds.length === 0) return;
  await prisma.analysisJob.createMany({
    data: expenseRecordIds.map((id) => ({ businessProfileId, expenseRecordId: id, idempotencyKey: `transaction:${id}`, kind: AnalysisJobKind.TRANSACTION })),
    skipDuplicates: true,
  });
}

/**
 * One coalesced PROFILE_REFRESH for a single profile, keyed by UTC day.
 *
 * Exists for bulk writes — a committed CSV import changes category statistics,
 * recurring patterns and trends all at once, and waiting for the hourly
 * scheduler would leave Insights describing the pre-import books for up to an
 * hour. The daily idempotency key means ten imports in one day still cost one
 * refresh; the upsert's update arm re-arms a job that already ran today, the
 * same way enqueueExpenseAnalysis re-arms a completed transaction job.
 */
export async function enqueueProfileRefresh(businessProfileId: number, today = utcToday()) {
  const date = today.toISOString().slice(0, 10);
  return prisma.analysisJob.upsert({
    where: { idempotencyKey: `profile:${businessProfileId}:${date}` },
    create: { businessProfileId, idempotencyKey: `profile:${businessProfileId}:${date}`, kind: AnalysisJobKind.PROFILE_REFRESH },
    update: {
      status: AnalysisJobStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      workerId: null,
      heartbeatAt: null,
      processingStartedAt: null,
    },
  });
}

export async function enqueueDailyProfileAnalyses(today = utcToday()) {
  const profiles = await prisma.businessProfile.findMany({ where: { archivedAt: null }, select: { id: true } });
  const date = today.toISOString().slice(0, 10);
  await prisma.analysisJob.createMany({
    data: profiles.map((profile) => ({ businessProfileId: profile.id, idempotencyKey: `profile:${profile.id}:${date}`, kind: AnalysisJobKind.PROFILE_REFRESH })),
    skipDuplicates: true,
  });
  // Reconcile the narrow failure window between a committed expense and its
  // job insert. This is bounded per scheduler pass and repeats hourly, so a
  // prolonged outage drains safely without one unbounded query.
  const missing = await prisma.expenseRecord.findMany({
    where: { analysisJobs: { none: {} } },
    select: { id: true, businessProfileId: true },
    orderBy: { id: "asc" },
    take: 5_000,
  });
  await prisma.analysisJob.createMany({
    data: missing.map((record) => ({
      businessProfileId: record.businessProfileId,
      expenseRecordId: record.id,
      idempotencyKey: `transaction:${record.id}`,
      kind: AnalysisJobKind.TRANSACTION,
    })),
    skipDuplicates: true,
  });
  return profiles.length;
}

type ClaimedJob = { id: number; businessProfileId: number; expenseRecordId: number | null; kind: AnalysisJobKind; attemptCount: number; workerId: string };

async function claimJob(): Promise<ClaimedJob | null> {
  const stale = new Date(Date.now() - LEASE_MS);
  // Rearming resets attempts, so each claim needs a token an older attempt cannot regain.
  const workerId = `analysis-${process.pid}-${randomUUID()}`;
  const rows = await prisma.$queryRaw<ClaimedJob[]>(Prisma.sql`
    UPDATE "AnalysisJob" SET
      "AnalysisJob_Status" = 'PROCESSING',
      "AnalysisJob_AttemptCount" = "AnalysisJob_AttemptCount" + 1,
      "AnalysisJob_ProcessingStartedAt" = NOW(),
      "AnalysisJob_HeartbeatAt" = NOW(),
      "AnalysisJob_WorkerID" = ${workerId},
      "AnalysisJob_UpdatedAt" = NOW()
    WHERE "AnalysisJob_ID" = (
      SELECT "AnalysisJob_ID" FROM "AnalysisJob"
      WHERE ("AnalysisJob_Status" = 'PENDING' AND "AnalysisJob_NextAttemptAt" <= NOW())
         OR ("AnalysisJob_Status" = 'PROCESSING' AND "AnalysisJob_HeartbeatAt" < ${stale})
      ORDER BY "AnalysisJob_NextAttemptAt", "AnalysisJob_ID"
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING "AnalysisJob_ID" AS id, "BusinessProfile_ID" AS "businessProfileId",
      "ExpenseRecord_ID" AS "expenseRecordId", "AnalysisJob_Kind" AS kind,
      "AnalysisJob_AttemptCount" AS "attemptCount"
  `);
  return rows[0] ? { ...rows[0], workerId } : null;
}

async function processJob(job: ClaimedJob, mutate: AnalysisMutationGuard) {
  if (job.kind === AnalysisJobKind.TRANSACTION && job.expenseRecordId) {
    const findings = await Promise.all([
      detectAmountOutlierForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG, mutate),
      detectNearDuplicateForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG, mutate),
      detectVelocityForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG, mutate),
      detectBehavioralNoveltyForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG, mutate),
    ]);
    const owner = await prisma.businessProfile.findUnique({ where: { id: job.businessProfileId }, select: { userId: true } });
    const notifiable = findings
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .filter((finding) => meetsNotificationSeverity(finding.severity, RUNTIME_DETECTION_CONFIG));
    if (owner && notifiable.length > 0) {
      await mutate(async (db) => {
        for (const finding of notifiable) {
          const message = `${finding.title}: review this transaction in Expense Insights`.slice(0, 255);
          const exists = await db.notification.findFirst({
            where: { businessProfileId: job.businessProfileId, expenseRecordId: job.expenseRecordId, type: NOTIFICATION_TYPES.ANOMALY_FINDING, message },
            select: { id: true },
          });
          if (!exists) {
            await db.notification.create({
              data: { userId: owner.userId, businessProfileId: job.businessProfileId, expenseRecordId: job.expenseRecordId, type: NOTIFICATION_TYPES.ANOMALY_FINDING, message },
            });
          }
        }
      });
    }
    return;
  }
  const profile = await prisma.businessProfile.findUnique({ where: { id: job.businessProfileId }, select: { userId: true } });
  if (!profile) return;
  const today = utcToday();
  await refreshOwnedCategoryStatistics(profile.userId, job.businessProfileId, today, RUNTIME_DETECTION_CONFIG, mutate);
  await refreshRecurringPatterns(profile.userId, job.businessProfileId, RUNTIME_DETECTION_CONFIG, today, mutate);
  await refreshTrendFindings(profile.userId, job.businessProfileId, today, RUNTIME_DETECTION_CONFIG, mutate);
  // Shadow-only ML pass, last: it reads the same bounded history the refreshers
  // just summarised, writes only SHADOW findings, and fails open — a dead
  // sidecar must not fail the job the deterministic refreshers completed.
  try {
    await refreshIsolationForestFindings(profile.userId, job.businessProfileId, RUNTIME_DETECTION_CONFIG, mutate);
  } catch (error) {
    if (error instanceof AnalysisLeaseLostError) throw error;
    logger.warn({ err: error, businessProfileId: job.businessProfileId }, "isolation forest shadow pass failed");
  }
}

export async function runAnalysisWorkerOnce() {
  const job = await claimJob();
  if (!job) return false;
  const heartbeatTimer = setInterval(() => {
    void heartbeatJob(job).catch((error) => {
      if (error instanceof AnalysisLeaseLostError) return;
      logger.error({ err: error, analysisJobId: job.id }, "analysis job heartbeat failed");
    });
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
  try {
    await processJob(job, leaseMutationGuard(job));
    const completed = await prisma.analysisJob.updateMany({
      where: leaseGuard(job),
      data: { status: AnalysisJobStatus.COMPLETE, heartbeatAt: new Date(), workerId: null, lastError: null },
    });
    if (completed.count !== 1) {
      logger.warn({ analysisJobId: job.id }, "analysis job lease was reclaimed before completion; result discarded");
    }
  } catch (error) {
    if (error instanceof AnalysisLeaseLostError) {
      logger.warn({ analysisJobId: job.id }, "analysis job lease was reclaimed; stale writes were stopped");
    } else {
      const failed = job.attemptCount >= MAX_ATTEMPTS;
      const delayMinutes = Math.min(2 ** job.attemptCount, 60);
      // Guarded for the same reason the completion is: rescheduling a job the
      // reclaiming worker is already running would undo its claim.
      const recorded = await prisma.analysisJob.updateMany({
        where: leaseGuard(job),
        data: { status: failed ? AnalysisJobStatus.FAILED : AnalysisJobStatus.PENDING, nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000), workerId: null, lastError: String(error).slice(0, 1000) },
      });
      if (recorded.count !== 1) {
        logger.warn({ analysisJobId: job.id }, "analysis job lease was reclaimed before its failure could be recorded");
      }
      logger.error({ err: error, analysisJobId: job.id }, "analysis job failed");
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
  return true;
}
