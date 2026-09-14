import { Prisma, ReceiptPurgeMode, type ReceiptCaptureBatchStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";

export const RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS = 8;
export const RECEIPT_CAPTURE_BATCH_MIN_RECEIPTS = 2;

function validateBatchSlot(
  batch: { status: ReceiptCaptureBatchStatus; expectedReceiptCount: number },
  receiptOrdinal: number,
): void {
  if (batch.status === "COMPLETE") throw new ApiError(409, "This receipt batch is already complete");
  if (batch.status === "CANCELLED") throw new ApiError(409, "This receipt batch was cancelled. Start a new batch.");
  if (receiptOrdinal > batch.expectedReceiptCount) {
    throw new ApiError(400, "Receipt position is outside this batch");
  }
}

const batchScans = {
  where: { purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } } },
  orderBy: { receiptOrdinal: "asc" as const },
  select: {
    id: true,
    receiptOrdinal: true,
    processingStatus: true,
    processingError: true,
    processingErrorCode: true,
    confirmationStatus: true,
    extractedDate: true,
    extractedVendor: true,
    extractedAmount: true,
  },
};

type BatchWithScans = Prisma.ReceiptCaptureBatchGetPayload<{
  include: { receiptScans: typeof batchScans };
}>;

function statusFor(batch: BatchWithScans): ReceiptCaptureBatchStatus {
  if (batch.status === "CANCELLED") return "CANCELLED";
  const scans = batch.receiptScans;
  if (scans.length < batch.expectedReceiptCount) return "COLLECTING";
  if (scans.some((scan) => scan.processingStatus === "Processing")) return "PROCESSING";
  if (scans.every((scan) => scan.confirmationStatus === "Confirmed")) return "COMPLETE";

  const failed = scans.filter((scan) => scan.processingStatus === "Failed").length;
  if (failed === scans.length) return "FAILED";
  if (failed > 0) return "PARTIAL_FAILURE";
  return "READY_FOR_REVIEW";
}

function toDTO(batch: BatchWithScans) {
  return {
    id: batch.id,
    businessProfileId: batch.businessProfileId,
    expectedReceiptCount: batch.expectedReceiptCount,
    status: batch.status,
    uploadedReceiptCount: batch.receiptScans.length,
    createdAt: batch.createdAt,
    finishedAt: batch.finishedAt,
    receipts: batch.receiptScans.map((scan) => ({
      receiptOrdinal: scan.receiptOrdinal!,
      id: scan.id,
      processingStatus: scan.processingStatus,
      confirmationStatus: scan.confirmationStatus,
      processingError: scan.processingError,
      processingErrorCode: scan.processingErrorCode,
      extractedDate: scan.extractedDate,
      extractedVendor: scan.extractedVendor,
      extractedAmount: scan.extractedAmount === null ? null : Number(scan.extractedAmount),
      allowedActions: {
        retryProcessing: scan.processingStatus === "Failed" && scan.confirmationStatus === "Pending",
        reviewResult: scan.processingStatus === "Complete" && scan.confirmationStatus === "Pending",
      },
    })),
  };
}

async function loadBatch(db: Prisma.TransactionClient, batchId: number): Promise<BatchWithScans | null> {
  return db.receiptCaptureBatch.findUnique({
    where: { id: batchId },
    include: { receiptScans: batchScans },
  });
}

export async function refreshReceiptCaptureBatchStatus(
  db: Prisma.TransactionClient,
  batchId: number,
): Promise<BatchWithScans | null> {
  if (!(await lockReceiptCaptureBatchForMutation(db, batchId))) return null;

  const batch = await loadBatch(db, batchId);
  if (!batch) return null;
  const status = statusFor(batch);
  const terminal = status === "COMPLETE" || status === "CANCELLED";
  const finishedAt = terminal ? (batch.finishedAt ?? new Date()) : null;
  if (batch.status === status && batch.finishedAt?.getTime() === finishedAt?.getTime()) return batch;

  const updated = await db.receiptCaptureBatch.update({
    where: { id: batch.id },
    data: { status, finishedAt },
  });
  return { ...batch, ...updated };
}

export async function lockReceiptCaptureBatchForMutation(
  db: Prisma.TransactionClient,
  batchId: number,
): Promise<boolean> {
  const locked = await db.$queryRaw<{ id: number }[]>`
    SELECT "ReceiptCaptureBatch_ID" AS id
    FROM "ReceiptCaptureBatch"
    WHERE "ReceiptCaptureBatch_ID" = ${batchId}
    FOR UPDATE
  `;
  return locked.length === 1;
}

export async function cancelReceiptCaptureBatch(
  db: Prisma.TransactionClient,
  batchId: number,
): Promise<boolean> {
  if (!(await lockReceiptCaptureBatchForMutation(db, batchId))) return false;
  await db.receiptCaptureBatch.update({
    where: { id: batchId },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  return true;
}

export async function createReceiptCaptureBatch(
  userId: number,
  input: { businessProfileId: number; clientBatchKey: string; expectedReceiptCount: number },
) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);

  const existing = await prisma.receiptCaptureBatch.findUnique({
    where: {
      businessProfileId_clientBatchKey: {
        businessProfileId: input.businessProfileId,
        clientBatchKey: input.clientBatchKey,
      },
    },
    include: { receiptScans: batchScans },
  });
  if (existing) {
    if (existing.expectedReceiptCount !== input.expectedReceiptCount) {
      throw new ApiError(409, "This batch key belongs to a different receipt selection. Start a new batch.");
    }
    return { batch: toDTO(existing), replayed: true };
  }

  try {
    const created = await prisma.receiptCaptureBatch.create({
      data: input,
      include: { receiptScans: batchScans },
    });
    return { batch: toDTO(created), replayed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.receiptCaptureBatch.findUnique({
        where: {
          businessProfileId_clientBatchKey: {
            businessProfileId: input.businessProfileId,
            clientBatchKey: input.clientBatchKey,
          },
        },
        include: { receiptScans: batchScans },
      });
      if (winner && winner.expectedReceiptCount === input.expectedReceiptCount) {
        return { batch: toDTO(winner), replayed: true };
      }
      throw new ApiError(409, "This batch key belongs to a different receipt selection. Start a new batch.");
    }
    throw error;
  }
}

export async function getReceiptCaptureBatch(userId: number, batchId: number) {
  const batch = await prisma.$transaction(async (tx) => {
    const owned = await tx.receiptCaptureBatch.findFirst({
      where: { id: batchId, businessProfile: { userId } },
      select: { id: true },
    });
    if (!owned) throw new ApiError(404, "Receipt batch not found");

    return refreshReceiptCaptureBatchStatus(tx, batchId);
  });
  if (!batch) throw new ApiError(404, "Receipt batch not found");
  return toDTO(batch);
}

/** Cheap preflight before private objects are uploaded; the transaction below remains authoritative. */
export async function validateReceiptCaptureBatchSlot(input: {
  batchId: number;
  businessProfileId: number;
  receiptOrdinal: number;
}): Promise<void> {
  const batch = await prisma.receiptCaptureBatch.findFirst({
    where: { id: input.batchId, businessProfileId: input.businessProfileId },
    select: { status: true, expectedReceiptCount: true },
  });
  if (!batch) throw new ApiError(404, "Receipt batch not found");
  validateBatchSlot(batch, input.receiptOrdinal);

  const occupied = await prisma.receiptScan.findFirst({
    where: { captureBatchId: input.batchId, receiptOrdinal: input.receiptOrdinal },
    select: { id: true },
  });
  if (occupied) {
    throw new ApiError(409, "This receipt position is already filled. Use the existing receipt or start a new batch.");
  }
}

export async function lockReceiptCaptureBatchSlot(
  tx: Prisma.TransactionClient,
  input: { batchId: number; businessProfileId: number; receiptOrdinal: number },
) {
  const locked = await tx.$queryRaw<{ id: number }[]>`
    SELECT "ReceiptCaptureBatch_ID" AS id
    FROM "ReceiptCaptureBatch"
    WHERE "ReceiptCaptureBatch_ID" = ${input.batchId}
      AND "BusinessProfile_ID" = ${input.businessProfileId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new ApiError(404, "Receipt batch not found");

  const batch = await tx.receiptCaptureBatch.findUniqueOrThrow({ where: { id: input.batchId } });
  validateBatchSlot(batch, input.receiptOrdinal);
  return batch;
}
