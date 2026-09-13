import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  Prisma,
  ReceiptPurgeMode,
  ReceiptPurgeReason,
  ReceiptPurgeStage,
  ReceiptPurgeStatus,
  type ReceiptPurgeJob,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { ApiError } from "../middleware/error.middleware";
import { deleteReceiptImage } from "./storage.service";
import {
  cancelReceiptCaptureBatch,
  lockReceiptCaptureBatchForMutation,
  refreshReceiptCaptureBatchStatus,
} from "./receiptCaptureBatch.service";

const PURGE_WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const PURGE_LEASE_MS = 2 * 60 * 1000;
const PURGE_RESULT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_PURGE_ATTEMPTS = 10;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

const ACTIVE_PURGE_STATUSES = [
  ReceiptPurgeStatus.PENDING,
  ReceiptPurgeStatus.PROCESSING,
  ReceiptPurgeStatus.RETRY,
] as const;

type PurgeTarget = {
  id: number;
  businessProfileId: number | null;
  captureBatchId: number | null;
  imageFile: string | null;
  confirmationStatus: string;
  processingStatus: string;
  evidenceDeletionRequestedAt: Date | null;
  evidenceDeletedAt: Date | null;
  pages: { pageNumber: number; imageFile: string; processedImageFile: string | null }[];
  purgeJobs: ReceiptPurgeJob[];
};

type ArtifactGroup = { pageNumber: number; paths: string[] };

class PurgeLeaseLostError extends Error {}

class PurgeStageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestKeyHash(userId: number, key: string): string {
  return sha256(`receipt-purge-request-v1\0${userId}\0${key}`);
}

function internalOrphanKeyHash(businessProfileId: number, receiptScanId: number): string {
  return sha256(`receipt-purge-orphan-v1\0${businessProfileId}\0${receiptScanId}`);
}

function targetReferenceHash(businessProfileId: number, receiptScanId: number, mode: ReceiptPurgeMode): string {
  return sha256(`receipt-purge-target-v1\0${businessProfileId}\0${receiptScanId}\0${mode}`);
}

function toDTO(job: ReceiptPurgeJob, validatedReceiptScanId: number | null = job.receiptScanId) {
  return {
    id: job.id,
    receiptScanId: validatedReceiptScanId,
    mode: job.mode,
    reason: job.reason,
    status: job.status,
    stage: job.stage,
    storageObjectsExpected: job.storageObjectsExpected,
    storageObjectsDeleted: job.storageObjectsDeleted,
    requestedAt: job.requestedAt,
    completedAt: job.completedAt,
    lastErrorCode: job.lastErrorCode,
  };
}

function artifactGroups(scan: Pick<PurgeTarget, "imageFile" | "pages">): ArtifactGroup[] {
  const seen = new Set<string>();
  const groups: ArtifactGroup[] = [];
  const ordered = [...scan.pages].sort((left, right) => left.pageNumber - right.pageNumber);

  if (ordered.length === 0) {
    if (scan.imageFile) groups.push({ pageNumber: 1, paths: [scan.imageFile] });
    return groups;
  }

  for (const [index, page] of ordered.entries()) {
    const candidates = [
      ...(index === 0 && scan.imageFile ? [scan.imageFile] : []),
      page.imageFile,
      ...(page.processedImageFile ? [page.processedImageFile] : []),
    ];
    const paths = candidates.filter((path) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    });
    groups.push({ pageNumber: page.pageNumber, paths });
  }
  return groups;
}

function artifactCount(scan: Pick<PurgeTarget, "imageFile" | "pages">): number {
  return artifactGroups(scan).reduce((count, group) => count + group.paths.length, 0);
}

async function lockOwnedTarget(
  tx: Prisma.TransactionClient,
  userId: number,
  receiptScanId: number,
): Promise<PurgeTarget> {
  const owned = await tx.receiptScan.findFirst({
    where: { id: receiptScanId, businessProfile: { userId } },
    select: { captureBatchId: true },
  });
  if (!owned) throw new ApiError(404, "Receipt scan not found");
  if (
    owned.captureBatchId !== null
    && !(await lockReceiptCaptureBatchForMutation(tx, owned.captureBatchId))
  ) {
    throw new ApiError(409, "This receipt batch is no longer available");
  }

  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT scan."ReceiptScan_ID" AS id
    FROM "ReceiptScan" scan
    INNER JOIN "BusinessProfile" profile
      ON profile."BusinessProfile_ID" = scan."BusinessProfile_ID"
    WHERE scan."ReceiptScan_ID" = ${receiptScanId}
      AND profile."User_ID" = ${userId}
    FOR UPDATE OF scan
  `;
  if (rows.length !== 1) throw new ApiError(404, "Receipt scan not found");

  return tx.receiptScan.findUniqueOrThrow({
    where: { id: receiptScanId },
    include: {
      pages: { orderBy: { pageNumber: "asc" } },
      purgeJobs: { orderBy: { requestedAt: "desc" } },
    },
  });
}

function assertRequestState(scan: PurgeTarget, mode: ReceiptPurgeMode): void {
  if (mode === ReceiptPurgeMode.DELETE_SCAN) {
    if (scan.confirmationStatus !== "Pending" && scan.confirmationStatus !== "Deletion Pending") {
      throw new ApiError(409, "A confirmed receipt must keep its financial audit. Delete only its stored evidence.");
    }
    return;
  }
  if (scan.confirmationStatus !== "Confirmed") {
    throw new ApiError(409, "Only a confirmed receipt can detach its stored evidence");
  }
  if (scan.evidenceDeletedAt) {
    throw new ApiError(409, "This receipt's stored evidence has already been deleted");
  }
}

function assertReplayTarget(
  job: ReceiptPurgeJob,
  receiptScanId: number,
  mode: ReceiptPurgeMode,
  reason: ReceiptPurgeReason,
): void {
  const expected = targetReferenceHash(job.businessProfileId, receiptScanId, mode);
  if (job.targetReferenceHash !== expected || job.mode !== mode || job.reason !== reason) {
    throw new ApiError(409, "This idempotency key belongs to a different receipt deletion request");
  }
}

async function existingReplay(
  userId: number,
  hash: string,
  receiptScanId: number,
  mode: ReceiptPurgeMode,
  reason: ReceiptPurgeReason,
): Promise<ReceiptPurgeJob | null> {
  const job = await prisma.receiptPurgeJob.findFirst({
    where: { requestKeyHash: hash, businessProfile: { userId } },
  });
  if (!job) return null;
  assertReplayTarget(job, receiptScanId, mode, reason);
  return job;
}

async function enqueueOwnedPurge(
  userId: number,
  receiptScanId: number,
  idempotencyKey: string,
  mode: ReceiptPurgeMode,
) {
  const hash = requestKeyHash(userId, idempotencyKey);
  const replay = await existingReplay(userId, hash, receiptScanId, mode, ReceiptPurgeReason.OWNER_REQUEST);
  if (replay) return toDTO(replay, receiptScanId);

  try {
    const job = await prisma.$transaction(async (tx) => {
      const scan = await lockOwnedTarget(tx, userId, receiptScanId);
      if (!scan.businessProfileId) throw new ApiError(404, "Receipt scan not found");
      assertRequestState(scan, mode);

      const lockedReplay = scan.purgeJobs.find((candidate) => candidate.requestKeyHash === hash);
      if (lockedReplay) {
        assertReplayTarget(lockedReplay, receiptScanId, mode, ReceiptPurgeReason.OWNER_REQUEST);
        return lockedReplay;
      }

      const active = scan.purgeJobs.find((candidate) =>
        ACTIVE_PURGE_STATUSES.includes(candidate.status as (typeof ACTIVE_PURGE_STATUSES)[number]),
      );
      if (active) {
        throw new ApiError(409, "A deletion is already scheduled for this receipt. Retry with its original idempotency key.");
      }
      if (mode === ReceiptPurgeMode.DELETE_SCAN) {
        const records = await tx.expenseRecord.count({ where: { receiptScanId } });
        if (records > 0) {
          throw new ApiError(409, "This receipt already has financial records. Delete only its stored evidence.");
        }
      }

      const now = new Date();
      const created = await tx.receiptPurgeJob.create({
        data: {
          businessProfileId: scan.businessProfileId,
          receiptScanId,
          receiptScanBusinessProfileId: scan.businessProfileId,
          requestKeyHash: hash,
          targetReferenceHash: targetReferenceHash(scan.businessProfileId, receiptScanId, mode),
          reason: ReceiptPurgeReason.OWNER_REQUEST,
          mode,
          storageObjectsExpected: artifactCount(scan),
          expiresAt: new Date(now.getTime() + PURGE_RESULT_TTL_MS),
        },
      });

      await tx.receiptScan.update({
        where: { id: receiptScanId },
        data: {
          evidenceDeletionRequestedAt: scan.evidenceDeletionRequestedAt ?? now,
          scanRevision: { increment: 1 },
          ...(mode === ReceiptPurgeMode.DELETE_SCAN
            ? {
                confirmationStatus: "Deletion Pending",
                processingStatus: "Failed",
                processingError: null,
                processingErrorCode: null,
                processingStartedAt: null,
                processingHeartbeatAt: null,
                processingWorkerId: null,
              }
            : {}),
        },
      });
      if (mode === ReceiptPurgeMode.DELETE_SCAN && scan.captureBatchId !== null) {
        await cancelReceiptCaptureBatch(tx, scan.captureBatchId);
      }
      return created;
    });
    return toDTO(job, receiptScanId);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await existingReplay(userId, hash, receiptScanId, mode, ReceiptPurgeReason.OWNER_REQUEST);
      if (winner) return toDTO(winner, receiptScanId);
      throw new ApiError(409, "A deletion is already scheduled for this receipt");
    }
    throw error;
  }
}

export function requestReceiptScanDeletion(userId: number, receiptScanId: number, idempotencyKey: string) {
  return enqueueOwnedPurge(userId, receiptScanId, idempotencyKey, ReceiptPurgeMode.DELETE_SCAN);
}

export function requestConfirmedReceiptEvidenceDeletion(
  userId: number,
  receiptScanId: number,
  idempotencyKey: string,
) {
  return enqueueOwnedPurge(userId, receiptScanId, idempotencyKey, ReceiptPurgeMode.DETACH_EVIDENCE);
}

export async function enqueueReceiptPurgeIfOrphaned(receiptScanId: number | null | undefined): Promise<void> {
  if (!receiptScanId) return;

  await prisma.$transaction(async (tx) => {
    const batchLink = await tx.receiptScan.findUnique({
      where: { id: receiptScanId },
      select: { captureBatchId: true },
    });
    if (!batchLink) return;
    if (
      batchLink.captureBatchId !== null
      && !(await lockReceiptCaptureBatchForMutation(tx, batchLink.captureBatchId))
    ) {
      return;
    }

    const locked = await tx.$queryRaw<{ id: number }[]>`
      SELECT "ReceiptScan_ID" AS id
      FROM "ReceiptScan"
      WHERE "ReceiptScan_ID" = ${receiptScanId}
      FOR UPDATE
    `;
    if (locked.length !== 1) return;

    const scan = await tx.receiptScan.findUnique({
      where: { id: receiptScanId },
      include: {
        pages: { orderBy: { pageNumber: "asc" } },
        purgeJobs: { orderBy: { requestedAt: "desc" } },
      },
    });
    if (!scan?.businessProfileId || scan.confirmationStatus !== "Confirmed") return;
    if (await tx.expenseRecord.count({ where: { receiptScanId } })) return;

    const active = scan.purgeJobs.some((job) =>
      ACTIVE_PURGE_STATUSES.includes(job.status as (typeof ACTIVE_PURGE_STATUSES)[number]),
    );
    if (active) return;

    const count = artifactCount(scan);
    if (scan.evidenceDeletedAt && count === 0) {
      if (scan.captureBatchId !== null) await cancelReceiptCaptureBatch(tx, scan.captureBatchId);
      await tx.receiptScan.delete({ where: { id: receiptScanId } });
      return;
    }

    const hash = internalOrphanKeyHash(scan.businessProfileId, receiptScanId);
    const prior = scan.purgeJobs.find((job) => job.requestKeyHash === hash);
    if (prior) return;

    const now = new Date();
    await tx.receiptPurgeJob.create({
      data: {
        businessProfileId: scan.businessProfileId,
        receiptScanId,
        receiptScanBusinessProfileId: scan.businessProfileId,
        requestKeyHash: hash,
        targetReferenceHash: targetReferenceHash(scan.businessProfileId, receiptScanId, ReceiptPurgeMode.DELETE_SCAN),
        reason: ReceiptPurgeReason.OWNER_REQUEST,
        mode: ReceiptPurgeMode.DELETE_SCAN,
        storageObjectsExpected: count,
        expiresAt: new Date(now.getTime() + PURGE_RESULT_TTL_MS),
      },
    });
    await tx.receiptScan.update({
      where: { id: receiptScanId },
      data: {
        evidenceDeletionRequestedAt: scan.evidenceDeletionRequestedAt ?? now,
        confirmationStatus: "Deletion Pending",
        processingStatus: "Failed",
        processingError: null,
        processingErrorCode: null,
        processingStartedAt: null,
        processingHeartbeatAt: null,
        processingWorkerId: null,
        scanRevision: { increment: 1 },
      },
    });
    if (scan.captureBatchId !== null) await cancelReceiptCaptureBatch(tx, scan.captureBatchId);
  });
}

type ClaimedPurge = {
  id: number;
  mode: ReceiptPurgeMode;
  stage: ReceiptPurgeStage;
  attemptCount: number;
};

async function claimPurge(): Promise<ClaimedPurge | null> {
  const staleBefore = new Date(Date.now() - PURGE_LEASE_MS);
  const rows = await prisma.$queryRaw<ClaimedPurge[]>(Prisma.sql`
    UPDATE "ReceiptPurgeJob" SET
      "ReceiptPurgeJob_Status" = 'PROCESSING',
      "ReceiptPurgeJob_AttemptCount" = "ReceiptPurgeJob_AttemptCount" + 1,
      "ReceiptPurgeJob_LeaseStartedAt" = NOW(),
      "ReceiptPurgeJob_HeartbeatAt" = NOW(),
      "ReceiptPurgeJob_WorkerID" = ${PURGE_WORKER_ID},
      "ReceiptPurgeJob_UpdatedAt" = NOW()
    WHERE "ReceiptPurgeJob_ID" = (
      SELECT "ReceiptPurgeJob_ID"
      FROM "ReceiptPurgeJob"
      WHERE "ReceiptPurgeJob_AttemptCount" < ${MAX_PURGE_ATTEMPTS}
        AND (
          ("ReceiptPurgeJob_Status" IN ('PENDING', 'RETRY') AND "ReceiptPurgeJob_NextAttemptAt" <= NOW())
          OR (
            "ReceiptPurgeJob_Status" = 'PROCESSING'
            AND "ReceiptPurgeJob_HeartbeatAt" < ${staleBefore}
          )
        )
      ORDER BY "ReceiptPurgeJob_NextAttemptAt", "ReceiptPurgeJob_ID"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING
      "ReceiptPurgeJob_ID" AS id,
      "ReceiptPurgeJob_Mode" AS mode,
      "ReceiptPurgeJob_Stage" AS stage,
      "ReceiptPurgeJob_AttemptCount" AS "attemptCount"
  `);
  return rows[0] ?? null;
}

async function heartbeatPurge(job: ClaimedPurge): Promise<void> {
  const updated = await prisma.receiptPurgeJob.updateMany({
    where: {
      id: job.id,
      status: ReceiptPurgeStatus.PROCESSING,
      workerId: PURGE_WORKER_ID,
      attemptCount: job.attemptCount,
      stage: job.stage,
    },
    data: { heartbeatAt: new Date() },
  });
  if (updated.count !== 1) throw new PurgeLeaseLostError(`Receipt purge ${job.id} lease was reclaimed`);
}

function validateStorageReferences(businessProfileId: number, groups: ArtifactGroup[]): void {
  const prefix = `${businessProfileId}/`;
  if (groups.some((group) => group.paths.some((path) => !path.startsWith(prefix)))) {
    throw new PurgeStageError("PURGE_UNSAFE_STORAGE_REFERENCE");
  }
}

async function processStorageStage(job: ClaimedPurge): Promise<void> {
  const current = await prisma.receiptPurgeJob.findUnique({
    where: { id: job.id },
    include: {
      receiptScan: {
        include: { pages: { orderBy: { pageNumber: "asc" } } },
      },
    },
  });
  if (!current?.receiptScan || current.receiptScan.businessProfileId !== current.businessProfileId) {
    throw new PurgeStageError("PURGE_TARGET_MISSING");
  }

  const groups = artifactGroups(current.receiptScan);
  validateStorageReferences(current.businessProfileId, groups);
  const expected = groups.reduce((count, group) => count + group.paths.length, 0);
  if (expected !== current.storageObjectsExpected) {
    throw new PurgeStageError("PURGE_ARTIFACT_SET_CHANGED");
  }

  const completedGroups = groups.filter((group) => group.pageNumber <= current.checkpointPageNumber);
  let deleted = completedGroups.reduce((count, group) => count + group.paths.length, 0);
  if (deleted !== current.storageObjectsDeleted) {
    throw new PurgeStageError("PURGE_CHECKPOINT_INVALID");
  }

  for (const group of groups) {
    if (group.pageNumber <= current.checkpointPageNumber) continue;
    for (const path of group.paths) {
      if (!(await deleteReceiptImage(path))) throw new PurgeStageError("PURGE_STORAGE_DELETE_FAILED");
    }
    deleted += group.paths.length;
    const updated = await prisma.receiptPurgeJob.updateMany({
      where: {
        id: job.id,
        status: ReceiptPurgeStatus.PROCESSING,
        stage: ReceiptPurgeStage.STORAGE,
        workerId: PURGE_WORKER_ID,
        attemptCount: job.attemptCount,
      },
      data: {
        checkpointPageNumber: group.pageNumber,
        storageObjectsDeleted: deleted,
        heartbeatAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new PurgeLeaseLostError(`Receipt purge ${job.id} lease was reclaimed`);
  }

  const advanced = await prisma.receiptPurgeJob.updateMany({
    where: {
      id: job.id,
      status: ReceiptPurgeStatus.PROCESSING,
      stage: ReceiptPurgeStage.STORAGE,
      workerId: PURGE_WORKER_ID,
      attemptCount: job.attemptCount,
    },
    data: {
      status: ReceiptPurgeStatus.PENDING,
      stage: ReceiptPurgeStage.DATABASE,
      storageObjectsDeleted: expected,
      workerId: null,
      leaseStartedAt: null,
      heartbeatAt: null,
      nextAttemptAt: new Date(),
      lastErrorCode: null,
    },
  });
  if (advanced.count !== 1) throw new PurgeLeaseLostError(`Receipt purge ${job.id} lease was reclaimed`);
}

async function processDatabaseStage(job: ClaimedPurge): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number }[]>`
      SELECT "ReceiptPurgeJob_ID" AS id
      FROM "ReceiptPurgeJob"
      WHERE "ReceiptPurgeJob_ID" = ${job.id}
        AND "ReceiptPurgeJob_Status" = 'PROCESSING'
        AND "ReceiptPurgeJob_Stage" = 'DATABASE'
        AND "ReceiptPurgeJob_WorkerID" = ${PURGE_WORKER_ID}
        AND "ReceiptPurgeJob_AttemptCount" = ${job.attemptCount}
      FOR UPDATE
    `;
    if (locked.length !== 1) throw new PurgeLeaseLostError(`Receipt purge ${job.id} lease was reclaimed`);

    const current = await tx.receiptPurgeJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        receiptScan: {
          select: {
            id: true,
            businessProfileId: true,
            captureBatchId: true,
            confirmationStatus: true,
            evidenceDeletionRequestedAt: true,
          },
        },
      },
    });
    if (current.storageObjectsDeleted !== current.storageObjectsExpected) {
      throw new PurgeStageError("PURGE_STORAGE_INCOMPLETE");
    }

    const completedAt = new Date();
    if (!current.receiptScan) {
      await tx.receiptPurgeJob.update({
        where: { id: job.id },
        data: {
          status: ReceiptPurgeStatus.COMPLETE,
          stage: ReceiptPurgeStage.COMPLETE,
          completedAt,
          workerId: null,
          leaseStartedAt: null,
          heartbeatAt: null,
          lastErrorCode: null,
        },
      });
      return null;
    }
    if (current.receiptScan.businessProfileId !== current.businessProfileId) {
      throw new PurgeStageError("PURGE_TARGET_SCOPE_INVALID");
    }
    if (!current.receiptScan.evidenceDeletionRequestedAt) {
      throw new PurgeStageError("PURGE_TARGET_CHANGED");
    }

    if (current.mode === ReceiptPurgeMode.DELETE_SCAN) {
      if (current.receiptScan.confirmationStatus !== "Deletion Pending") {
        throw new PurgeStageError("PURGE_TARGET_CHANGED");
      }
      if (await tx.expenseRecord.count({ where: { receiptScanId: current.receiptScan.id } })) {
        throw new PurgeStageError("PURGE_FINANCIAL_RECORDS_EXIST");
      }
      const batchId = current.receiptScan.captureBatchId;
      if (batchId !== null && !(await lockReceiptCaptureBatchForMutation(tx, batchId))) {
        throw new PurgeStageError("PURGE_BATCH_MISSING");
      }
      await tx.receiptPurgeJob.update({
        where: { id: job.id },
        data: {
          status: ReceiptPurgeStatus.COMPLETE,
          stage: ReceiptPurgeStage.COMPLETE,
          completedAt,
          workerId: null,
          leaseStartedAt: null,
          heartbeatAt: null,
          lastErrorCode: null,
        },
      });
      const removed = await tx.receiptScan.deleteMany({
        where: { id: current.receiptScan.id, businessProfileId: current.businessProfileId },
      });
      if (removed.count !== 1) throw new PurgeStageError("PURGE_TARGET_CHANGED");
      if (batchId !== null) await refreshReceiptCaptureBatchStatus(tx, batchId);
      return null;
    }

    if (current.receiptScan.confirmationStatus !== "Confirmed") {
      throw new PurgeStageError("PURGE_TARGET_CHANGED");
    }

    await tx.receiptScanPage.deleteMany({ where: { receiptScanId: current.receiptScan.id } });
    await tx.receiptScanItem.deleteMany({ where: { receiptScanId: current.receiptScan.id } });
    await tx.receiptFieldCorrection.deleteMany({ where: { receiptScanId: current.receiptScan.id } });
    await tx.receiptScan.update({
      where: { id: current.receiptScan.id },
      data: {
        imageFile: null,
        rawText: null,
        fieldEvidence: Prisma.DbNull,
        warnings: Prisma.DbNull,
        evidenceDeletedAt: completedAt,
        scanRevision: { increment: 1 },
      },
    });
    await tx.receiptPurgeJob.update({
      where: { id: job.id },
      data: {
        status: ReceiptPurgeStatus.COMPLETE,
        stage: ReceiptPurgeStage.COMPLETE,
        completedAt,
        workerId: null,
        leaseStartedAt: null,
        heartbeatAt: null,
        lastErrorCode: null,
      },
    });
    return current.receiptScan.id;
  });
}

async function recordFailure(job: ClaimedPurge, error: unknown): Promise<void> {
  if (error instanceof PurgeLeaseLostError) return;
  const code = error instanceof PurgeStageError
    ? error.code
    : job.stage === ReceiptPurgeStage.STORAGE
      ? "PURGE_STORAGE_FAILED"
      : "PURGE_DATABASE_FAILED";
  const failed = job.attemptCount >= MAX_PURGE_ATTEMPTS;
  const delay = RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, RETRY_DELAYS_MS.length - 1)]!;
  await prisma.receiptPurgeJob.updateMany({
    where: {
      id: job.id,
      status: ReceiptPurgeStatus.PROCESSING,
      workerId: PURGE_WORKER_ID,
      attemptCount: job.attemptCount,
    },
    data: {
      status: failed ? ReceiptPurgeStatus.FAILED : ReceiptPurgeStatus.RETRY,
      workerId: null,
      leaseStartedAt: null,
      heartbeatAt: null,
      nextAttemptAt: new Date(Date.now() + delay),
      lastErrorCode: code,
    },
  });
  logger.error({ receiptPurgeJobId: job.id, code, attempt: job.attemptCount }, "receipt purge stage failed");
}

async function deleteExpiredTerminalPurgeResults(now = new Date()): Promise<void> {
  await prisma.receiptPurgeJob.deleteMany({
    where: {
      expiresAt: { lte: now },
      status: { in: [ReceiptPurgeStatus.COMPLETE, ReceiptPurgeStatus.FAILED] },
    },
  });
}

export async function runReceiptPurgeWorkerOnce(): Promise<boolean> {
  await deleteExpiredTerminalPurgeResults();
  const job = await claimPurge();
  if (!job) return false;
  const heartbeatTimer = setInterval(() => {
    void heartbeatPurge(job).catch(() => undefined);
  }, Math.floor(PURGE_LEASE_MS / 3));
  heartbeatTimer.unref();

  try {
    if (job.stage === ReceiptPurgeStage.STORAGE) {
      await processStorageStage(job);
    } else if (job.stage === ReceiptPurgeStage.DATABASE) {
      const detachedScanId = await processDatabaseStage(job);
      if (detachedScanId !== null) await enqueueReceiptPurgeIfOrphaned(detachedScanId);
    } else {
      throw new PurgeStageError("PURGE_STAGE_INVALID");
    }
  } catch (error) {
    await recordFailure(job, error);
  } finally {
    clearInterval(heartbeatTimer);
  }
  return true;
}

export function countStalledReceiptPurges(): Promise<number> {
  return prisma.receiptPurgeJob.count({ where: { status: ReceiptPurgeStatus.FAILED } });
}
