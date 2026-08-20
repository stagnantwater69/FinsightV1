import { Prisma } from "@prisma/client";
import type { SalesReferenceRecord, SalesRecordSource } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { cleanUpImportBatchIfOrphaned } from "../lib/sourceCleanup";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import { duplicateKeyOf, type BulkDbClient } from "./expenseRecord.service";

interface CreateInput {
  businessProfileId: number;
  date: string;
  description: string;
  amount: number;
  source?: SalesRecordSource;
  importBatchId?: number;
}

interface UpdateInput {
  date?: string;
  description?: string;
  amount?: number;
  reviewStatus?: "Reviewed" | "Needs Review";
  duplicateStatus?: "Not a Duplicate" | "Flagged";
}

export interface SearchFilters {
  businessProfileId: number;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  source?: SalesRecordSource;
  importBatchId?: number;
  take?: number;
  cursor?: { date: Date; id: number; mode: "same-type" | "include-date" | "exclude-date" };
}

function toDTO(record: SalesReferenceRecord) {
  return {
    id: record.id,
    type: "sales" as const,
    businessProfileId: record.businessProfileId,
    importBatchId: record.importBatchId,
    duplicateOfRecordId: record.duplicateOfRecordId,
    date: record.date,
    description: record.description,
    amount: Number(record.amount),
    source: record.source,
    reviewStatus: record.reviewStatus,
    duplicateStatus: record.duplicateStatus,
    createdAt: record.createdAt,
  };
}

async function findDuplicate(businessProfileId: number, date: Date, amount: Prisma.Decimal, description: string, excludeId?: number) {
  return prisma.salesReferenceRecord.findFirst({
    where: {
      businessProfileId,
      date,
      amount,
      description: { equals: description, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function createSalesRecord(userId: number, input: CreateInput) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);

  const date = new Date(input.date);
  const amount = new Prisma.Decimal(input.amount);

  const duplicate = await findDuplicate(input.businessProfileId, date, amount, input.description);

  const record = await prisma.salesReferenceRecord.create({
    data: {
      businessProfileId: input.businessProfileId,
      date,
      description: input.description,
      amount,
      source: input.source ?? "MANUAL_ENTRY",
      importBatchId: input.importBatchId,
      reviewStatus: "Reviewed",
      duplicateStatus: duplicate ? "Flagged" : "Not a Duplicate",
      duplicateOfRecordId: duplicate?.id,
    },
  });

  if (duplicate) {
    await createNotification(
      userId,
      input.businessProfileId,
      NOTIFICATION_TYPES.POSSIBLE_DUPLICATE,
      `Possible duplicate: "${input.description}" (PHP ${input.amount}) on ${input.date}`
    );
  }

  return toDTO(record);
}

export interface BulkSalesRow {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  amount: number;
}

/**
 * The sales-record half of the CSV bulk path — see bulkCreateExpenseRecords
 * for why this exists and what it replaces. Simpler than the expense side:
 * sales references have no category to verify and no large-expense rule, so
 * duplicate detection is the only per-row decision.
 */
export async function bulkCreateSalesRecords(
  userId: number,
  businessProfileId: number,
  importBatchId: number,
  rows: BulkSalesRow[],
  db: BulkDbClient = prisma,
) {
  if (rows.length === 0) return [];

  const dates = [...new Set(rows.map((r) => r.date))].map((d) => new Date(d));
  const candidates = await db.salesReferenceRecord.findMany({
    where: { businessProfileId, date: { in: dates } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, date: true, amount: true, description: true },
  });

  const existingIdByKey = new Map<string, number>();
  for (const c of candidates) {
    const key = duplicateKeyOf(c.date, c.amount, c.description);
    if (!existingIdByKey.has(key)) existingIdByKey.set(key, c.id);
  }

  const firstIndexByKey = new Map<string, number>();
  const duplicatesEarlierRow = new Map<number, number>();

  const data = rows.map((row, i) => {
    const date = new Date(row.date);
    const amount = new Prisma.Decimal(row.amount);
    const key = duplicateKeyOf(date, amount, row.description);

    const existingId = existingIdByKey.get(key);
    const earlierIndex = firstIndexByKey.get(key);
    if (existingId === undefined && earlierIndex === undefined) {
      firstIndexByKey.set(key, i);
    } else if (existingId === undefined) {
      duplicatesEarlierRow.set(i, earlierIndex!);
    }

    return {
      businessProfileId,
      date,
      description: row.description,
      amount,
      source: "CSV_UPLOAD" as const,
      importBatchId,
      reviewStatus: "Reviewed",
      duplicateStatus: existingId !== undefined || earlierIndex !== undefined ? "Flagged" : "Not a Duplicate",
      duplicateOfRecordId: existingId,
    };
  });

  const created = await db.salesReferenceRecord.createManyAndReturn({ data });
  if (created.length !== rows.length) {
    throw new ApiError(500, "Import did not create the expected number of records");
  }

  if (duplicatesEarlierRow.size > 0) {
    // Grouped by target — one statement per distinct original rather than one
    // per duplicate row. See the same block in bulkCreateExpenseRecords for why.
    const rowsByTarget = new Map<number, number[]>();
    for (const [rowIndex, earlierIndex] of duplicatesEarlierRow) {
      const targetId = created[earlierIndex]!.id;
      const bucket = rowsByTarget.get(targetId);
      if (bucket) bucket.push(created[rowIndex]!.id);
      else rowsByTarget.set(targetId, [created[rowIndex]!.id]);
    }

    if (db === prisma) {
      await prisma.$transaction(
        [...rowsByTarget].map(([targetId, ids]) =>
          prisma.salesReferenceRecord.updateMany({
            where: { id: { in: ids } },
            data: { duplicateOfRecordId: targetId },
          }),
        ),
      );
    } else {
      // Inside the CSV chunk transaction — see the same branch in
      // bulkCreateExpenseRecords.
      for (const [targetId, ids] of rowsByTarget) {
        await db.salesReferenceRecord.updateMany({
          where: { id: { in: ids } },
          data: { duplicateOfRecordId: targetId },
        });
      }
    }
  }

  /*
   * NO PER-RECORD NOTIFICATIONS HERE — see the note in bulkCreateExpenseRecords.
   * The import's own summary notification covers the whole batch, and the
   * flagged rows are reachable through the review queue.
   */

  return created.map(toDTO);
}

export async function getSalesRecord(userId: number, id: number) {
  const record = await prisma.salesReferenceRecord.findFirst({
    where: { id, businessProfile: { userId } },
  });
  if (!record) {
    throw new ApiError(404, "Sales reference record not found");
  }
  return toDTO(record);
}

export async function updateSalesRecord(userId: number, id: number, input: UpdateInput) {
  const existing = await prisma.salesReferenceRecord.findFirst({
    where: { id, businessProfile: { userId } },
  });
  if (!existing) {
    throw new ApiError(404, "Sales reference record not found");
  }

  const nextDate = input.date ? new Date(input.date) : existing.date;
  const nextAmount = input.amount !== undefined ? new Prisma.Decimal(input.amount) : existing.amount;
  const nextDescription = input.description ?? existing.description;

  const valueFieldsChanged = input.date !== undefined || input.amount !== undefined || input.description !== undefined;
  let duplicateStatus = input.duplicateStatus ?? existing.duplicateStatus;
  let duplicateOfRecordId = existing.duplicateOfRecordId;

  if (valueFieldsChanged) {
    const duplicate = await findDuplicate(existing.businessProfileId, nextDate, nextAmount, nextDescription, existing.id);
    duplicateStatus = duplicate ? "Flagged" : "Not a Duplicate";
    duplicateOfRecordId = duplicate?.id ?? null;
  }

  const record = await prisma.salesReferenceRecord.update({
    where: { id },
    data: {
      date: nextDate,
      description: nextDescription,
      amount: nextAmount,
      reviewStatus: input.reviewStatus ?? existing.reviewStatus,
      duplicateStatus,
      duplicateOfRecordId,
    },
  });

  if (duplicateStatus === "Flagged" && existing.duplicateStatus !== "Flagged") {
    await createNotification(
      userId,
      existing.businessProfileId,
      NOTIFICATION_TYPES.POSSIBLE_DUPLICATE,
      `Possible duplicate: "${nextDescription}" (PHP ${Number(nextAmount)}) on ${nextDate.toISOString().slice(0, 10)}`
    );
  }

  return toDTO(record);
}

export async function deleteSalesRecord(userId: number, id: number) {
  const existing = await prisma.salesReferenceRecord.findFirst({ where: { id, businessProfile: { userId } } });
  if (!existing) {
    throw new ApiError(404, "Sales reference record not found");
  }
  await prisma.salesReferenceRecord.delete({ where: { id } });

  // A sales record only ever comes from a spreadsheet, never a receipt.
  await cleanUpImportBatchIfOrphaned(existing.importBatchId);
}

/**
 * The sales-record half of a bulk duplicate resolution.
 *
 * See bulkResolveExpenseDuplicates for why this exists and why discarding a
 * whole flagged group cannot delete the owner's original. Kept as a separate
 * function rather than generalised over both tables: the two models have
 * different columns and different cleanup (a sales row never came from a
 * receipt), and one function branching on which table it was handed is harder
 * to read than two that each say what they do.
 */
export async function bulkResolveSalesDuplicates(
  userId: number,
  businessProfileId: number,
  ids: number[],
  action: "keep" | "discard",
): Promise<number> {
  if (ids.length === 0) return 0;
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const owned = await prisma.salesReferenceRecord.findMany({
    where: { id: { in: ids }, businessProfileId },
    select: { id: true, importBatchId: true },
  });
  if (owned.length === 0) return 0;
  const ownedIds = owned.map((r) => r.id);

  if (action === "keep") {
    const { count } = await prisma.salesReferenceRecord.updateMany({
      where: { id: { in: ownedIds } },
      data: { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" },
    });
    return count;
  }

  await prisma.salesReferenceRecord.deleteMany({ where: { id: { in: ownedIds } } });

  const batchIds = [...new Set(owned.map((r) => r.importBatchId).filter((v): v is number => v !== null))];
  for (const batchId of batchIds) await cleanUpImportBatchIfOrphaned(batchId);

  return ownedIds.length;
}

export async function searchSalesRecords(userId: number, filters: SearchFilters) {
  await requireOwnedBusinessProfile(userId, filters.businessProfileId);

  const cursorWhere = !filters.cursor
    ? undefined
    : filters.cursor.mode === "include-date"
      ? { date: { lte: filters.cursor.date } }
      : filters.cursor.mode === "exclude-date"
        ? { date: { lt: filters.cursor.date } }
        : { OR: [{ date: { lt: filters.cursor.date } }, { date: filters.cursor.date, id: { lt: filters.cursor.id } }] };

  const records = await prisma.salesReferenceRecord.findMany({
    where: {
      businessProfileId: filters.businessProfileId,
      source: filters.source,
      importBatchId: filters.importBatchId,
      AND: [
        {
          date: {
            gte: filters.dateFrom ? new Date(filters.dateFrom) : undefined,
            lte: filters.dateTo ? new Date(filters.dateTo) : undefined,
          },
        },
        ...(cursorWhere ? [cursorWhere] : []),
      ],
      description: filters.keyword ? { contains: filters.keyword, mode: "insensitive" } : undefined,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: filters.take,
  });

  return records.map(toDTO);
}

export async function listFlaggedSalesRecords(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const records = await prisma.salesReferenceRecord.findMany({
    where: {
      businessProfileId,
      OR: [{ reviewStatus: "Needs Review" }, { duplicateStatus: "Flagged" }],
    },
    orderBy: { date: "desc" },
  });
  return records.map(toDTO);
}
