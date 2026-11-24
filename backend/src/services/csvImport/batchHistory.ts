import { z } from "zod";
import { CsvImportProcessingStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../../lib/ownership";
import { dateCursorScope, datePageSize, decodeDateCursor, finishDatePage, invalidDateCursor, type DatePageInput } from "../../lib/datePagination";

export interface ImportBatchSummary {
  id: number;
  title: string;
  uploadDate: Date;
  status: string;
}

/**
 * The newest CSV imports for a business profile, capped for legacy callers.
 *
 * Feeds the Records page's "which import" filter — an owner narrowing to CSV
 * Upload needs a way to say WHICH file, not just that a record came from one.
 */
export async function listImportBatches(userId: number, businessProfileId: number): Promise<ImportBatchSummary[]> {
  return (await listImportBatchesPage(userId, businessProfileId, { pageSize: 100 })).items;
}

export async function listImportBatchesPage(
  userId: number,
  businessProfileId: number,
  input: DatePageInput & { search?: string },
) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const pageSize = datePageSize(input);
  const search = z.string().trim().max(150).parse(input.search ?? "");
  const scope = dateCursorScope(["csv-import-batches", userId, businessProfileId, search]);
  const cursor = decodeDateCursor(input.cursor, scope);
  const where = {
    businessProfileId,
    processingStatus: { notIn: [CsvImportProcessingStatus.STAGING, CsvImportProcessingStatus.STAGED] },
    ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
  };
  if (cursor && !await prisma.cSVImportBatch.findFirst({ where: { ...where, id: cursor.id }, select: { id: true } })) {
    invalidDateCursor();
  }
  const rows = await prisma.cSVImportBatch.findMany({
    where: {
      ...where,
      ...(cursor ? { OR: [{ uploadDate: { lt: cursor.at } }, { uploadDate: cursor.at, id: { lt: cursor.id } }] } : {}),
    },
    select: { id: true, title: true, uploadDate: true, status: true },
    orderBy: [{ uploadDate: "desc" }, { id: "desc" }],
    take: pageSize + 1,
  });
  return finishDatePage(rows, pageSize, scope, (row) => row.uploadDate);
}

/**
 * The machine-facing progress of one import, for the polling client behind a
 * 202. Ownership via the batch's own profile, 404 for anything that is not
 * this owner's — the same non-disclosure rule as every other lookup.
 */
export async function getImportBatchStatus(userId: number, batchId: number) {
  const batch = await prisma.cSVImportBatch.findFirst({
    where: {
      id: batchId,
      businessProfile: { userId },
      processingStatus: { notIn: [CsvImportProcessingStatus.STAGING, CsvImportProcessingStatus.STAGED] },
    },
    select: {
      id: true,
      status: true,
      processingStatus: true,
      totalRows: true,
      processedRows: true,
      importedRows: true,
      skippedRows: true,
      flaggedRows: true,
      failureStage: true,
      resultSummary: true,
    },
  });
  if (!batch) {
    throw new ApiError(404, "Import batch not found");
  }
  return {
    batchId: batch.id,
    status: batch.status,
    processingStatus: batch.processingStatus,
    totalRows: batch.totalRows ?? 0,
    processedRows: batch.processedRows,
    importedRows: batch.importedRows,
    skippedRows: batch.skippedRows,
    flaggedRows: batch.flaggedRows,
    failureStage: batch.failureStage,
    resultSummary: batch.resultSummary,
  };
}
