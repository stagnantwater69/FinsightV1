import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  AccountDeletionStage,
  AccountStatus,
  CsvImportProcessingStatus,
  CsvSourcePurgeStatus,
  Prisma,
} from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { deleteCsvFile } from "./storage.service";

const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

class CsvSourcePurgeLeaseLostError extends Error {}

class CsvSourcePurgeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function targetHash(businessProfileId: number, sourceBatchId: number, fileReference: string): string {
  return createHash("sha256")
    .update(`csv-source-purge-v1\0${businessProfileId}\0${sourceBatchId}\0${fileReference}`)
    .digest("hex");
}

/**
 * Queues a known CSV object after the batch row that used to own it vanished.
 * This is the compensation path for an upload that completed after its staged
 * row was concurrently removed. The queue intentionally has no batch FK, so
 * it remains durable even though there is no relational owner left to retain.
 */
export async function enqueueDetachedCsvSourcePurge(
  businessProfileId: number,
  sourceBatchId: number,
  fileReference: string,
  options: { notBefore?: Date } = {},
): Promise<void> {
  if (!fileReference.startsWith(`${businessProfileId}/`)) return;
  const generation = randomUUID();
  const detachedHash = createHash("sha256")
    .update(`csv-source-purge-detached-v2\0${businessProfileId}\0${sourceBatchId}\0${fileReference}\0${generation}`)
    .digest("hex");
  await prisma.$transaction(async (tx) => {
    const owners = await tx.$queryRaw<{ id: number; status: AccountStatus }[]>(Prisma.sql`
      SELECT u."User_ID" AS id, u."User_Status" AS status
      FROM "User" u
      JOIN "BusinessProfile" p ON p."User_ID" = u."User_ID"
      WHERE p."BusinessProfile_ID" = ${businessProfileId}
      FOR UPDATE OF u
    `);
    const owner = owners[0];
    if (owner?.status === AccountStatus.DELETION_PENDING) {
      await tx.user.update({
        where: { id: owner.id },
        data: {
          deletionStage: AccountDeletionStage.REQUESTED,
          deletionAttempts: 0,
          deletionLastError: null,
          deletionNextAttemptAt: new Date(),
          deletionStorageManifestHash: null,
          deletionStorageCheckpoint: 0,
          deletionWorkerId: null,
          deletionLeaseStartedAt: null,
          deletionHeartbeatAt: null,
          deletionClaimVersion: { increment: 1 },
        },
      });
    }
    await tx.cSVSourcePurgeJob.create({
      data: {
        businessProfileId,
        sourceBatchId,
        targetHash: detachedHash,
        fileReference,
        nextAttemptAt: options.notBefore ?? new Date(),
      },
    });
  });
}

/**
 * Locks each candidate batch, verifies that no imported record still uses it,
 * then moves its object path into the durable purge queue before deleting the
 * batch. The caller must delete the records in this same transaction.
 */
export async function enqueueCsvSourcePurgesIfOrphaned(
  tx: Prisma.TransactionClient,
  candidateBatchIds: ReadonlyArray<number | null | undefined>,
  options: { notBefore?: Date } = {},
): Promise<number> {
  const ids = [...new Set(candidateBatchIds.filter((id): id is number => typeof id === "number" && id > 0))]
    .sort((left, right) => left - right);
  if (ids.length === 0) return 0;

  const locked = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT "ImportBatch_ID" AS id
    FROM "CSVImportBatch"
    WHERE "ImportBatch_ID" IN (${Prisma.join(ids)})
    ORDER BY "ImportBatch_ID"
    FOR UPDATE
  `);
  const lockedIds = locked.map((row) => row.id);
  if (lockedIds.length === 0) return 0;

  const [batches, expenseGroups, salesGroups] = await Promise.all([
    tx.cSVImportBatch.findMany({
      where: { id: { in: lockedIds } },
      select: { id: true, businessProfileId: true, fileReference: true },
    }),
    tx.expenseRecord.groupBy({
      by: ["importBatchId"],
      where: { importBatchId: { in: lockedIds } },
      _count: { _all: true },
    }),
    tx.salesReferenceRecord.groupBy({
      by: ["importBatchId"],
      where: { importBatchId: { in: lockedIds } },
      _count: { _all: true },
    }),
  ]);
  const referenced = new Set<number>();
  for (const group of [...expenseGroups, ...salesGroups]) {
    if (group.importBatchId !== null && group._count._all > 0) referenced.add(group.importBatchId);
  }

  let scheduled = 0;
  for (const batch of batches.sort((left, right) => left.id - right.id)) {
    if (referenced.has(batch.id)) continue;
    if (batch.fileReference) {
      const created = await tx.cSVSourcePurgeJob.createMany({
        data: [{
          businessProfileId: batch.businessProfileId,
          sourceBatchId: batch.id,
          targetHash: targetHash(batch.businessProfileId, batch.id, batch.fileReference),
          fileReference: batch.fileReference,
          nextAttemptAt: options.notBefore ?? new Date(),
        }],
        skipDuplicates: true,
      });
      scheduled += created.count;
    }
    await tx.cSVImportBatch.delete({ where: { id: batch.id } });
  }
  return scheduled;
}

export async function enqueueCsvSourcePurgeIfOrphaned(
  importBatchId: number | null | undefined,
): Promise<number> {
  if (!importBatchId) return 0;
  return prisma.$transaction((tx) => enqueueCsvSourcePurgesIfOrphaned(tx, [importBatchId]));
}

/**
 * Moves a terminal batch's source reference into the durable purge queue while
 * retaining the batch row and its outcome for history/status views.
 */
export async function enqueueCsvSourcePurgeForTerminalBatch(
  tx: Prisma.TransactionClient,
  importBatchId: number,
  options: { notBefore?: Date } = {},
): Promise<number> {
  const batch = await tx.cSVImportBatch.findUnique({
    where: { id: importBatchId },
    select: { id: true, businessProfileId: true, fileReference: true },
  });
  if (!batch?.fileReference) return 0;
  const fileReference = batch.fileReference;
  const created = await tx.cSVSourcePurgeJob.createMany({
    data: [{
      businessProfileId: batch.businessProfileId,
      sourceBatchId: batch.id,
      targetHash: targetHash(batch.businessProfileId, batch.id, fileReference),
      fileReference,
      nextAttemptAt: options.notBefore ?? new Date(),
    }],
    skipDuplicates: true,
  });
  await tx.cSVImportBatch.updateMany({
    where: { id: batch.id, fileReference },
    data: { fileReference: null },
  });
  return created.count;
}

/** Keeps completed import history while expiring its downloadable source. */
export async function sweepRetainedCsvSources(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.CSV_SOURCE_RETENTION_DAYS * 24 * 60 * 60_000);
  const count = await prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT "ImportBatch_ID" AS id
      FROM "CSVImportBatch"
      WHERE "ImportBatch_ProcessingStatus" = ${CsvImportProcessingStatus.COMPLETE}::"CsvImportProcessingStatus"
        AND "ImportBatch_CompletedAt" <= ${cutoff}
        AND "ImportBatch_FileReference" IS NOT NULL
      ORDER BY "ImportBatch_CompletedAt", "ImportBatch_ID"
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `);
    let queued = 0;
    for (const candidate of candidates) {
      queued += await enqueueCsvSourcePurgeForTerminalBatch(tx, candidate.id);
    }
    return queued;
  });
  if (count > 0) logger.info({ count, retentionDays: env.CSV_SOURCE_RETENTION_DAYS }, "expired completed CSV sources");
  return count;
}

type ClaimedPurge = {
  id: number;
  businessProfileId: number;
  fileReference: string | null;
  attemptCount: number;
};

async function claimPurge(): Promise<ClaimedPurge | null> {
  const staleBefore = new Date(Date.now() - LEASE_MS);
  const rows = await prisma.$queryRaw<ClaimedPurge[]>(Prisma.sql`
    UPDATE "CSVSourcePurgeJob" SET
      "CSVSourcePurgeJob_Status" = 'PROCESSING',
      "CSVSourcePurgeJob_AttemptCount" = "CSVSourcePurgeJob_AttemptCount" + 1,
      "CSVSourcePurgeJob_LeaseStartedAt" = NOW(),
      "CSVSourcePurgeJob_HeartbeatAt" = NOW(),
      "CSVSourcePurgeJob_WorkerID" = ${WORKER_ID},
      "CSVSourcePurgeJob_UpdatedAt" = NOW()
    WHERE "CSVSourcePurgeJob_ID" = (
      SELECT "CSVSourcePurgeJob_ID"
      FROM "CSVSourcePurgeJob"
      WHERE "CSVSourcePurgeJob_AttemptCount" < ${MAX_ATTEMPTS}
        AND (
          (
            "CSVSourcePurgeJob_Status" IN ('PENDING', 'RETRY')
            AND "CSVSourcePurgeJob_NextAttemptAt" <= NOW()
          )
          OR (
            "CSVSourcePurgeJob_Status" = 'PROCESSING'
            AND (
              "CSVSourcePurgeJob_HeartbeatAt" IS NULL
              OR "CSVSourcePurgeJob_HeartbeatAt" < ${staleBefore}
            )
          )
        )
      ORDER BY "CSVSourcePurgeJob_NextAttemptAt", "CSVSourcePurgeJob_ID"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING
      "CSVSourcePurgeJob_ID" AS id,
      "BusinessProfile_ID" AS "businessProfileId",
      "CSVSourcePurgeJob_FileReference" AS "fileReference",
      "CSVSourcePurgeJob_AttemptCount" AS "attemptCount"
  `);
  return rows[0] ?? null;
}

async function heartbeat(job: ClaimedPurge): Promise<void> {
  const updated = await prisma.cSVSourcePurgeJob.updateMany({
    where: {
      id: job.id,
      status: CsvSourcePurgeStatus.PROCESSING,
      workerId: WORKER_ID,
      attemptCount: job.attemptCount,
    },
    data: { heartbeatAt: new Date() },
  });
  if (updated.count !== 1) throw new CsvSourcePurgeLeaseLostError(`CSV source purge ${job.id} lease was reclaimed`);
}

function assertSafeReference(job: ClaimedPurge): string {
  const reference = job.fileReference;
  if (!reference || !reference.startsWith(`${job.businessProfileId}/`)) {
    throw new CsvSourcePurgeError("CSV_PURGE_UNSAFE_STORAGE_REFERENCE");
  }
  return reference;
}

async function processPurge(job: ClaimedPurge): Promise<void> {
  const reference = assertSafeReference(job);
  const activeOwner = await prisma.cSVImportBatch.count({ where: { fileReference: reference } });
  if (activeOwner > 0) throw new CsvSourcePurgeError("CSV_PURGE_ACTIVE_REFERENCE");
  if (!(await deleteCsvFile(reference))) {
    throw new CsvSourcePurgeError("CSV_PURGE_STORAGE_DELETE_FAILED");
  }

  // fileReference is the one-object checkpoint: it remains present through
  // every failure and is cleared only after Storage confirms deletion.
  const completed = await prisma.cSVSourcePurgeJob.updateMany({
    where: {
      id: job.id,
      status: CsvSourcePurgeStatus.PROCESSING,
      workerId: WORKER_ID,
      attemptCount: job.attemptCount,
    },
    data: {
      status: CsvSourcePurgeStatus.COMPLETE,
      fileReference: null,
      completedAt: new Date(),
      workerId: null,
      leaseStartedAt: null,
      heartbeatAt: null,
      lastErrorCode: null,
    },
  });
  if (completed.count !== 1) {
    throw new CsvSourcePurgeLeaseLostError(`CSV source purge ${job.id} lease was reclaimed`);
  }
}

async function recordFailure(job: ClaimedPurge, error: unknown): Promise<void> {
  if (error instanceof CsvSourcePurgeLeaseLostError) return;
  const code = error instanceof CsvSourcePurgeError
    ? error.code
    : "CSV_PURGE_STORAGE_FAILED";
  const failed = job.attemptCount >= MAX_ATTEMPTS;
  const activeReference = code === "CSV_PURGE_ACTIVE_REFERENCE";
  const delay = RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, RETRY_DELAYS_MS.length - 1)]!;
  await prisma.cSVSourcePurgeJob.updateMany({
    where: {
      id: job.id,
      status: CsvSourcePurgeStatus.PROCESSING,
      workerId: WORKER_ID,
      attemptCount: job.attemptCount,
    },
    data: {
      status: failed || activeReference ? CsvSourcePurgeStatus.FAILED : CsvSourcePurgeStatus.RETRY,
      nextAttemptAt: new Date(Date.now() + delay),
      workerId: null,
      leaseStartedAt: null,
      heartbeatAt: null,
      lastErrorCode: code,
    },
  });
  logger.error({ csvSourcePurgeJobId: job.id, code, attempt: job.attemptCount }, "CSV source purge failed");
}

function exhaustedWhere(now: Date): Prisma.CSVSourcePurgeJobWhereInput {
  const staleBefore = new Date(now.getTime() - LEASE_MS);
  return {
    attemptCount: { gte: MAX_ATTEMPTS },
    OR: [
      { status: { in: [CsvSourcePurgeStatus.PENDING, CsvSourcePurgeStatus.RETRY] } },
      {
        status: CsvSourcePurgeStatus.PROCESSING,
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      },
    ],
  };
}

async function terminalizeExhausted(now = new Date()): Promise<number> {
  const result = await prisma.cSVSourcePurgeJob.updateMany({
    where: exhaustedWhere(now),
    data: {
      status: CsvSourcePurgeStatus.FAILED,
      workerId: null,
      leaseStartedAt: null,
      heartbeatAt: null,
      lastErrorCode: "CSV_PURGE_ATTEMPTS_EXHAUSTED",
    },
  });
  if (result.count > 0) {
    logger.error({ count: result.count }, "terminalized CSV source purges at the attempt limit");
  }
  return result.count;
}

export async function runCsvSourcePurgeWorkerOnce(): Promise<boolean> {
  const terminalized = await terminalizeExhausted();
  const job = await claimPurge();
  if (!job) return terminalized > 0;

  const heartbeatTimer = setInterval(() => {
    void heartbeat(job).catch(() => undefined);
  }, Math.floor(LEASE_MS / 3));
  heartbeatTimer.unref();
  try {
    await processPurge(job);
  } catch (error) {
    await recordFailure(job, error);
  } finally {
    clearInterval(heartbeatTimer);
  }
  return true;
}

export async function countFailedCsvSourcePurges(): Promise<number> {
  const [failed, exhausted] = await Promise.all([
    prisma.cSVSourcePurgeJob.count({ where: { status: CsvSourcePurgeStatus.FAILED } }),
    prisma.cSVSourcePurgeJob.count({ where: exhaustedWhere(new Date()) }),
  ]);
  return failed + exhausted;
}
