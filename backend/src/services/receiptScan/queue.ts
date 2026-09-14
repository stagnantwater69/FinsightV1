import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Prisma, ReceiptPurgeMode } from "@prisma/client";
import { prisma } from "../../config/prisma";
import {
  RECEIPT_UPLOAD_ALLOWED_MIME_TYPES,
  RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES,
  RECEIPT_UPLOAD_MAX_LOGICAL_PAGES,
  RECEIPT_UPLOAD_MAX_OBJECT_BYTES,
} from "../../lib/receiptUploadContract";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { ApiError } from "../../middleware/error.middleware";
import {
  deleteReceiptImage,
  RECEIPT_URL_TTL_SECONDS,
  signedReceiptImageUrl,
  uploadReceiptImage,
} from "../storage.service";
import {
  lockReceiptCaptureBatchForMutation,
  RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS,
  lockReceiptCaptureBatchSlot,
  refreshReceiptCaptureBatchStatus,
  validateReceiptCaptureBatchSlot,
} from "../receiptCaptureBatch.service";
import { toDTO } from "./dto";
import { receiptPageEvidence, type ReceiptPageImageVariant } from "./pageEvidence";
import type { ReceiptUploadFile, ReceiptUploadSubmission } from "./types";

const receiptMimeTypes = new Set<string>(RECEIPT_UPLOAD_ALLOWED_MIME_TYPES);

function isTemporaryFile(file: ReceiptUploadFile): file is Extract<ReceiptUploadFile, { source: "temporary-file" }> {
  return file.source === "temporary-file";
}

async function byteLength(file: ReceiptUploadFile): Promise<number> {
  if (!isTemporaryFile(file)) return file.buffer.length;
  try {
    const details = await stat(file.temporaryPath);
    if (!details.isFile()) throw new Error("not a file");
    if (details.size !== file.sizeBytes) throw new Error("size changed");
    return details.size;
  } catch {
    throw new ApiError(400, "A receipt upload file is no longer available. Choose the receipt again.");
  }
}

async function updateFingerprints(hashes: readonly Hash[], file: ReceiptUploadFile): Promise<void> {
  if (!isTemporaryFile(file)) {
    for (const hash of hashes) hash.update(file.buffer);
    return;
  }
  try {
    let bytesRead = 0;
    for await (const chunk of createReadStream(file.temporaryPath)) {
      bytesRead += chunk.length;
      for (const hash of hashes) hash.update(chunk);
    }
    if (bytesRead !== file.sizeBytes) throw new Error("size changed");
  } catch {
    throw new ApiError(400, "A receipt upload file is no longer available. Choose the receipt again.");
  }
}

async function bufferForUpload(file: ReceiptUploadFile): Promise<Buffer> {
  if (!isTemporaryFile(file)) return file.buffer;
  try {
    return await readFile(file.temporaryPath);
  } catch {
    throw new ApiError(400, "A receipt upload file is no longer available. Choose the receipt again.");
  }
}

async function uploadOneReceiptFile(businessProfileId: number, file: ReceiptUploadFile): Promise<string> {
  const buffer = await bufferForUpload(file);
  if (isTemporaryFile(file) && buffer.length !== file.sizeBytes) {
    throw new ApiError(400, "A receipt upload file changed while it was being processed. Choose the receipt again.");
  }
  if (buffer.length > RECEIPT_UPLOAD_MAX_OBJECT_BYTES) {
    throw new ApiError(400, "Each receipt image must be 10 MiB or smaller.");
  }
  return uploadReceiptImage(businessProfileId, buffer, file.mimetype, file.originalname);
}

async function deleteUploadedObjects(imagePaths: string[], processedPaths: (string | null)[]): Promise<void> {
  await Promise.all(
    [...imagePaths, ...processedPaths.filter((path): path is string => Boolean(path))].map(deleteReceiptImage),
  );
}

/**
 * The review screen polls GET /:id every second or two while a scan is
 * processing; the abandoned-scan sweep only needs "the owner was here
 * recently", so a view stamps at most once per window per scan.
 */
export const RECEIPT_VIEW_ACTIVITY_THROTTLE_MS = 5 * 60_000;

/**
 * The throttle is a condition on the UPDATE, not a read-then-write, so
 * concurrent polls still cost one row write. Pending only: no other state
 * is in the sweep's scope, so its clock is not worth a write.
 */
export async function recordScanViewActivity(userId: number, scanId: number, now = new Date()): Promise<void> {
  await prisma.receiptScan.updateMany({
    where: {
      id: scanId,
      businessProfile: { userId },
      confirmationStatus: "Pending",
      lastActivityAt: { lt: new Date(now.getTime() - RECEIPT_VIEW_ACTIVITY_THROTTLE_MS) },
    },
    data: { lastActivityAt: now },
  });
}

/** An idempotent replay is the owner re-sending the same receipt: activity. */
async function recordUploadReplayActivity(scanId: number, businessProfileId: number): Promise<void> {
  await prisma.receiptScan.updateMany({
    where: { id: scanId, businessProfileId, confirmationStatus: "Pending" },
    data: { lastActivityAt: new Date() },
  });
}

export async function uploadAndScan(userId: number, input: ReceiptUploadSubmission) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);

  if ((input.receiptBatchId === undefined) !== (input.receiptOrdinal === undefined)) {
    throw new ApiError(400, "Receipt batch id and receipt position must be supplied together");
  }
  if (
    input.receiptBatchId !== undefined
    && (!Number.isInteger(input.receiptBatchId) || input.receiptBatchId <= 0)
  ) {
    throw new ApiError(400, "Invalid receipt batch id");
  }
  if (
    input.receiptOrdinal !== undefined
    && (
      !Number.isInteger(input.receiptOrdinal)
      || input.receiptOrdinal < 1
      || input.receiptOrdinal > RECEIPT_CAPTURE_BATCH_MAX_RECEIPTS
    )
  ) {
    throw new ApiError(400, "Invalid receipt position");
  }

  if (input.pages.length === 0) throw new ApiError(400, "At least one receipt photo is required");
  if (input.pages.length > RECEIPT_UPLOAD_MAX_LOGICAL_PAGES) {
    throw new ApiError(400, `A receipt can have at most ${RECEIPT_UPLOAD_MAX_LOGICAL_PAGES} pages`);
  }

  const pageSizes: { original: number; processed: number }[] = [];
  let aggregateBytes = 0;
  for (const page of input.pages) {
    const original = await byteLength(page);
    const processed = page.processed ? await byteLength(page.processed) : 0;
    for (const file of [page, page.processed].filter((item): item is ReceiptUploadFile => Boolean(item))) {
      if (!receiptMimeTypes.has(file.mimetype)) throw new ApiError(400, "Use a JPEG, PNG, or WebP receipt image.");
    }
    if (original === 0 || (page.processed && processed === 0)) {
      throw new ApiError(400, "This receipt file is empty. Choose another image.");
    }
    if (original > RECEIPT_UPLOAD_MAX_OBJECT_BYTES || processed > RECEIPT_UPLOAD_MAX_OBJECT_BYTES) {
      throw new ApiError(400, "Each receipt image must be 10 MiB or smaller.");
    }
    aggregateBytes += original + processed;
    pageSizes.push({ original, processed });
  }
  if (aggregateBytes > RECEIPT_UPLOAD_MAX_AGGREGATE_BYTES) {
    throw new ApiError(413, "Receipt upload files must total 80 MiB or less");
  }

  const uploadKey = input.idempotencyKey
    ? createHash("sha256").update(`${input.businessProfileId}:${input.idempotencyKey}`).digest("hex")
    : null;
  const fingerprint = createHash("sha256");
  // Only ordered originals enter this digest; request metadata and derived variants stay in uploadHash.
  const sourceFingerprint = createHash("sha256");
  sourceFingerprint.update("finsight-source-image-v1\0");
  sourceFingerprint.update(`${input.pages.length}\0`);
  if (input.receiptBatchId !== undefined && input.receiptOrdinal !== undefined) {
    fingerprint.update(JSON.stringify({
      receiptBatchId: input.receiptBatchId,
      receiptOrdinal: input.receiptOrdinal,
    }));
  }
  for (const [index, page] of input.pages.entries()) {
    const sizes = pageSizes[index]!;
    fingerprint.update(JSON.stringify({
      mimetype: page.mimetype,
      size: sizes.original,
      processedType: page.processed?.mimetype ?? null,
      processedSize: sizes.processed,
      metadata: page.metadata ?? null,
    }));
    sourceFingerprint.update(`${index}:${sizes.original}\0`);
    await updateFingerprints([fingerprint, sourceFingerprint], page);
    if (page.processed) await updateFingerprints([fingerprint], page.processed);
  }
  const uploadHash = fingerprint.digest("hex");
  const sourceImageHash = sourceFingerprint.digest("hex");

  if (uploadKey) {
    const existing = await prisma.receiptScan.findUnique({
      where: { uploadKey },
      include: { corrections: true, items: true, pages: true, purgeJobs: { select: { mode: true } } },
    });
    if (existing) {
      if (
        existing.businessProfileId !== input.businessProfileId
        || existing.uploadHash !== uploadHash
        || existing.captureBatchId !== (input.receiptBatchId ?? null)
        || existing.receiptOrdinal !== (input.receiptOrdinal ?? null)
      ) {
        throw new ApiError(409, "This upload key belongs to a different receipt. Start a new upload.");
      }
      if (existing.purgeJobs.some((job) => job.mode === ReceiptPurgeMode.DELETE_SCAN)) {
        throw new ApiError(409, "This receipt is scheduled for deletion. Start a new upload.");
      }
      await recordUploadReplayActivity(existing.id, input.businessProfileId);
      return toDTO(existing, existing.items, existing.pages, existing.corrections);
    }
  }

  if (input.receiptBatchId !== undefined && input.receiptOrdinal !== undefined) {
    await validateReceiptCaptureBatchSlot({
      batchId: input.receiptBatchId,
      businessProfileId: input.businessProfileId,
      receiptOrdinal: input.receiptOrdinal,
    });
  }

  const imagePaths: string[] = [];
  const processedPaths: (string | null)[] = [];
  try {
    for (const page of input.pages) {
      imagePaths.push(await uploadOneReceiptFile(input.businessProfileId, page));
      processedPaths.push(page.processed ? await uploadOneReceiptFile(input.businessProfileId, page.processed) : null);
    }
  } catch (error) {
    await deleteUploadedObjects(imagePaths, processedPaths);
    throw error;
  }

  let scan;
  try {
    scan = await prisma.$transaction(async (tx) => {
      if (input.receiptBatchId !== undefined && input.receiptOrdinal !== undefined) {
        await lockReceiptCaptureBatchSlot(tx, {
          batchId: input.receiptBatchId,
          businessProfileId: input.businessProfileId,
          receiptOrdinal: input.receiptOrdinal,
        });
      }

      const created = await tx.receiptScan.create({
        data: {
          businessProfileId: input.businessProfileId,
          captureBatchId: input.receiptBatchId,
          receiptOrdinal: input.receiptOrdinal,
          uploadKey,
          uploadHash,
          sourceImageHash,
          imageFile: imagePaths[0]!,
          confirmationStatus: "Pending",
          processingStatus: "Processing",
          pages: {
            create: imagePaths.map((imageFile, index) => ({
              pageNumber: index + 1,
              imageFile,
              processedImageFile: processedPaths[index],
              captureMetadata: input.pages[index]?.metadata as Prisma.InputJsonValue | undefined,
            })),
          },
        },
        include: { pages: true },
      });
      if (input.receiptBatchId !== undefined) {
        await refreshReceiptCaptureBatchStatus(tx, input.receiptBatchId);
      }
      return created;
    });
  } catch (error) {
    await deleteUploadedObjects(imagePaths, processedPaths);
    if (uploadKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.receiptScan.findUnique({
        where: { uploadKey },
        include: { corrections: true, items: true, pages: true, purgeJobs: { select: { mode: true } } },
      });
      if (
        winner
        && winner.businessProfileId === input.businessProfileId
        && winner.uploadHash === uploadHash
        && winner.captureBatchId === (input.receiptBatchId ?? null)
        && winner.receiptOrdinal === (input.receiptOrdinal ?? null)
      ) {
        if (winner.purgeJobs.some((job) => job.mode === ReceiptPurgeMode.DELETE_SCAN)) {
          throw new ApiError(409, "This receipt is scheduled for deletion. Start a new upload.");
        }
        await recordUploadReplayActivity(winner.id, input.businessProfileId);
        return toDTO(winner, winner.items, winner.pages, winner.corrections);
      }
      if (winner) throw new ApiError(409, "This upload key belongs to a different receipt. Start a new upload.");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "This receipt position is already filled. Use the existing receipt or start a new batch.");
    }
    throw error;
  }

  return toDTO(scan, [], scan.pages);
}

export async function retryScan(userId: number, scanId: number) {
  await prisma.$transaction(async (tx) => {
    const scan = await tx.receiptScan.findFirst({
      where: {
        id: scanId,
        businessProfile: { userId },
        purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
      },
      select: { captureBatchId: true, confirmationStatus: true, processingStatus: true },
    });
    if (!scan) throw new ApiError(404, "Receipt scan not found");
    if (scan.processingStatus !== "Failed" || scan.confirmationStatus !== "Pending") {
      throw new ApiError(409, "Only an unconfirmed failed receipt scan can be retried");
    }
    if (
      scan.captureBatchId !== null
      && !(await lockReceiptCaptureBatchForMutation(tx, scan.captureBatchId))
    ) {
      throw new ApiError(409, "This receipt batch is no longer available");
    }
    const retried = await tx.receiptScan.updateMany({
      where: {
        id: scanId,
        businessProfile: { userId },
        processingStatus: "Failed",
        confirmationStatus: "Pending",
      },
      data: {
        processingStatus: "Processing",
        processingError: null,
        processingErrorCode: null,
        processingAttemptCount: 0,
        processingStartedAt: null,
        processingWorkerId: null,
        processingHeartbeatAt: null,
        nextProcessingAttemptAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
    if (retried.count !== 1) throw new ApiError(409, "This receipt scan is already being retried");
    if (scan.captureBatchId !== null) await refreshReceiptCaptureBatchStatus(tx, scan.captureBatchId);
  });
  return getScan(userId, scanId);
}

export async function getScan(userId: number, scanId: number) {
  const scan = await prisma.receiptScan.findFirst({
    where: {
      id: scanId,
      businessProfile: { userId },
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
    },
    include: { corrections: true, items: { orderBy: { lineNumber: "asc" } }, pages: true },
  });
  if (!scan) throw new ApiError(404, "Receipt scan not found");
  await recordScanViewActivity(userId, scanId);
  return toDTO(scan, scan.items, scan.pages, scan.corrections);
}

export async function getScanPageImage(
  userId: number,
  scanId: number,
  pageNumber: number,
  variant: ReceiptPageImageVariant,
) {
  const page = await prisma.receiptScanPage.findFirst({
    where: {
      receiptScanId: scanId,
      pageNumber,
      receiptScan: {
        businessProfile: { userId },
        evidenceDeletionRequestedAt: null,
        purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
      },
    },
  });
  if (!page) throw new ApiError(404, "Receipt page not found");
  await recordScanViewActivity(userId, scanId);

  const path = variant === "source" ? page.imageFile : page.processedImageFile;
  if (!path) throw new ApiError(404, "Receipt page image not found");
  const url = await signedReceiptImageUrl(path);
  if (!url) throw new ApiError(502, "Receipt page image is temporarily unavailable");

  const evidence = receiptPageEvidence(page);
  return {
    pageNumber,
    ...(variant === "source" ? evidence.source : evidence.derived!),
    url,
    expiresInSeconds: RECEIPT_URL_TTL_SECONDS,
  };
}
