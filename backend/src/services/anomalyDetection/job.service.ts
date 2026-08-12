import { randomUUID } from "node:crypto";
import { AnalysisJobKind, AnalysisJobStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { utcToday } from "../../lib/dates";
import { detectAmountOutlierForExpense } from "./amountOutlier.service";
import { detectBehavioralNoveltyForExpense } from "./behavioralNovelty.service";
import { refreshOwnedCategoryStatistics } from "./categoryStatistics.service";
import { RUNTIME_DETECTION_CONFIG } from "./config";
import { detectNearDuplicateForExpense } from "./nearDuplicate.service";
import { refreshRecurringPatterns } from "./recurring.service";
import { refreshTrendFindings } from "./trend.service";
import { detectVelocityForExpense } from "./velocity.service";
import { NOTIFICATION_TYPES } from "../notification.service";

const WORKER_ID = `analysis-${process.pid}-${randomUUID().slice(0, 8)}`;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
function meetsNotificationSeverity(severity: keyof typeof SEVERITY_RANK): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[RUNTIME_DETECTION_CONFIG.notificationMinimumSeverity];
}

export async function enqueueExpenseAnalysis(businessProfileId: number, expenseRecordId: number) {
  return prisma.analysisJob.upsert({
    where: { idempotencyKey: `transaction:${expenseRecordId}` },
    create: { businessProfileId, expenseRecordId, idempotencyKey: `transaction:${expenseRecordId}`, kind: AnalysisJobKind.TRANSACTION },
    update: { status: AnalysisJobStatus.PENDING, attemptCount: 0, nextAttemptAt: new Date(), lastError: null },
  });
}

export async function enqueueExpenseAnalyses(businessProfileId: number, expenseRecordIds: number[]) {
  if (expenseRecordIds.length === 0) return;
  await prisma.analysisJob.createMany({
    data: expenseRecordIds.map((id) => ({ businessProfileId, expenseRecordId: id, idempotencyKey: `transaction:${id}`, kind: AnalysisJobKind.TRANSACTION })),
    skipDuplicates: true,
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

type ClaimedJob = { id: number; businessProfileId: number; expenseRecordId: number | null; kind: AnalysisJobKind; attemptCount: number };

async function claimJob(): Promise<ClaimedJob | null> {
  const stale = new Date(Date.now() - LEASE_MS);
  const rows = await prisma.$queryRaw<ClaimedJob[]>(Prisma.sql`
    UPDATE "AnalysisJob" SET
      "AnalysisJob_Status" = 'PROCESSING',
      "AnalysisJob_AttemptCount" = "AnalysisJob_AttemptCount" + 1,
      "AnalysisJob_ProcessingStartedAt" = NOW(),
      "AnalysisJob_HeartbeatAt" = NOW(),
      "AnalysisJob_WorkerID" = ${WORKER_ID},
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
  return rows[0] ?? null;
}

async function processJob(job: ClaimedJob) {
  if (job.kind === AnalysisJobKind.TRANSACTION && job.expenseRecordId) {
    const findings = await Promise.all([
      detectAmountOutlierForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG),
      detectNearDuplicateForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG),
      detectVelocityForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG),
      detectBehavioralNoveltyForExpense(job.expenseRecordId, RUNTIME_DETECTION_CONFIG),
    ]);
    const owner = await prisma.businessProfile.findUnique({ where: { id: job.businessProfileId }, select: { userId: true } });
    for (const finding of findings.filter((value): value is NonNullable<typeof value> => value !== null)) {
      if (!owner || !meetsNotificationSeverity(finding.severity)) continue;
      const message = `${finding.title}: review this transaction in Expense Insights`.slice(0, 255);
      const exists = await prisma.notification.findFirst({
        where: { businessProfileId: job.businessProfileId, expenseRecordId: job.expenseRecordId, type: NOTIFICATION_TYPES.ANOMALY_FINDING, message },
        select: { id: true },
      });
      if (!exists) {
        await prisma.notification.create({
          data: { userId: owner.userId, businessProfileId: job.businessProfileId, expenseRecordId: job.expenseRecordId, type: NOTIFICATION_TYPES.ANOMALY_FINDING, message },
        });
      }
    }
    return;
  }
  const profile = await prisma.businessProfile.findUnique({ where: { id: job.businessProfileId }, select: { userId: true } });
  if (!profile) return;
  await refreshOwnedCategoryStatistics(profile.userId, job.businessProfileId);
  await refreshRecurringPatterns(profile.userId, job.businessProfileId);
  await refreshTrendFindings(profile.userId, job.businessProfileId, utcToday(), RUNTIME_DETECTION_CONFIG);
}

export async function runAnalysisWorkerOnce() {
  const job = await claimJob();
  if (!job) return false;
  try {
    await processJob(job);
    await prisma.analysisJob.update({ where: { id: job.id }, data: { status: AnalysisJobStatus.COMPLETE, heartbeatAt: new Date(), workerId: null, lastError: null } });
  } catch (error) {
    const failed = job.attemptCount >= MAX_ATTEMPTS;
    const delayMinutes = Math.min(2 ** job.attemptCount, 60);
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: { status: failed ? AnalysisJobStatus.FAILED : AnalysisJobStatus.PENDING, nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000), workerId: null, lastError: String(error).slice(0, 1000) },
    });
    logger.error({ err: error, analysisJobId: job.id }, "analysis job failed");
  }
  return true;
}
