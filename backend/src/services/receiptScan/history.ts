import { Prisma, ReceiptPurgeMode } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { ApiError } from "../../middleware/error.middleware";

export const RECEIPT_HISTORY_STATUSES = [
  "active",
  "processing",
  "ready",
  "failed",
  "confirmed",
  "all",
] as const;

export type ReceiptHistoryStatus = (typeof RECEIPT_HISTORY_STATUSES)[number];

interface ReceiptHistoryCursor {
  v: 1;
  createdAt: Date;
  id: number;
}

function decodeCursor(encoded: string): ReceiptHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.createdAt !== "string" || !Number.isInteger(parsed.id) || Number(parsed.id) <= 0) {
      throw new Error("shape");
    }
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
      throw new Error("date");
    }
    return { v: 1, createdAt, id: Number(parsed.id) };
  } catch {
    throw new ApiError(400, "Invalid receipt history cursor");
  }
}

function encodeCursor(row: { createdAt: Date; id: number }): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}

function statusWhere(status: ReceiptHistoryStatus): Prisma.ReceiptScanWhereInput {
  if (status === "active") return { confirmationStatus: "Pending" };
  if (status === "processing") return { confirmationStatus: "Pending", processingStatus: "Processing" };
  if (status === "ready") return { confirmationStatus: "Pending", processingStatus: "Complete" };
  if (status === "failed") return { confirmationStatus: "Pending", processingStatus: "Failed" };
  if (status === "confirmed") return { confirmationStatus: "Confirmed" };
  return {};
}

export async function listReceiptScans(
  userId: number,
  input: {
    businessProfileId: number;
    status: ReceiptHistoryStatus;
    cursor?: string;
    take: number;
  },
) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await prisma.receiptScan.findMany({
    where: {
      businessProfileId: input.businessProfileId,
      purgeJobs: { none: { mode: ReceiptPurgeMode.DELETE_SCAN } },
      AND: [
        statusWhere(input.status),
        ...(cursor
          ? [{
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }]
          : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.take + 1,
    select: {
      id: true,
      businessProfileId: true,
      captureBatchId: true,
      receiptOrdinal: true,
      scanRevision: true,
      processingStatus: true,
      confirmationStatus: true,
      processingError: true,
      processingErrorCode: true,
      extractedDate: true,
      extractedVendor: true,
      extractedDescription: true,
      extractedAmount: true,
      createdAt: true,
      evidenceDeletionRequestedAt: true,
      evidenceDeletedAt: true,
      _count: { select: { pages: true } },
    },
  });

  const hasMore = rows.length > input.take;
  const visible = hasMore ? rows.slice(0, input.take) : rows;
  return {
    items: visible.map((scan) => ({
      id: scan.id,
      businessProfileId: scan.businessProfileId,
      receiptBatchId: scan.captureBatchId,
      receiptOrdinal: scan.receiptOrdinal,
      scanRevision: scan.scanRevision,
      processingStatus: scan.processingStatus,
      confirmationStatus: scan.confirmationStatus,
      processingError: scan.processingError,
      processingErrorCode: scan.processingErrorCode,
      extractedDate: scan.extractedDate,
      extractedVendor: scan.extractedVendor,
      extractedDescription: scan.extractedDescription,
      extractedAmount: scan.extractedAmount === null ? null : Number(scan.extractedAmount),
      createdAt: scan.createdAt,
      evidenceDeletionRequestedAt: scan.evidenceDeletionRequestedAt,
      evidenceDeletedAt: scan.evidenceDeletedAt,
      pageCount: scan._count.pages,
      allowedActions: {
        retryProcessing: scan.processingStatus === "Failed" && scan.confirmationStatus === "Pending",
        reviewResult: scan.processingStatus === "Complete" && scan.confirmationStatus === "Pending",
      },
    })),
    nextCursor: hasMore ? encodeCursor(visible.at(-1)!) : null,
  };
}
