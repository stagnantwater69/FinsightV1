import { Prisma } from "@prisma/client";
import type { SalesReferenceRecord, SalesRecordSource } from "@prisma/client";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { DEFAULT_RECORD_SORT, recordCursorWhere, recordOrderBy, type RecordCursor, type RecordSort } from "../lib/recordSort";
import { lockSalesDuplicateWriteGate } from "../lib/recordLock";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import { duplicateKeyOf, type BulkDbClient, type FlaggedListOptions } from "./expenseRecord.service";
import { enqueueCsvSourcePurgesIfOrphaned } from "./csvSourcePurge.service";

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
  /** Defaults to DEFAULT_RECORD_SORT, i.e. today's [date desc, id desc]. */
  sort?: RecordSort;
  cursor?: RecordCursor;
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

async function runPostCommitNotification(
  ids: { businessProfileId: number; salesRecordId: number },
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch {
    logger.error(
      {
        ...ids,
        effect: "notification",
        failureKind: "notification-write-failed",
        code: "SALES_RECORD_SIDE_EFFECT_FAILED",
      },
      "sales record post-commit effect failed",
    );
  }
}

type DuplicateCandidate = {
  id: number;
  duplicateStatus: string;
  duplicateOfRecordId: number | null;
};

function canonicalCandidate<T extends DuplicateCandidate>(records: T[]): T | undefined {
  return records.find((record) =>
    record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null)
    ?? records.find((record) => record.duplicateStatus === "Not a Duplicate")
    ?? records.find((record) => record.duplicateOfRecordId === null)
    ?? records[0];
}

function canonicalRank(record: DuplicateCandidate): number {
  if (record.duplicateStatus === "Not a Duplicate" && record.duplicateOfRecordId === null) return 0;
  if (record.duplicateStatus === "Not a Duplicate") return 1;
  if (record.duplicateOfRecordId === null) return 2;
  return 3;
}

async function ensureValidDuplicateTarget<T extends DuplicateCandidate>(
  db: BulkDbClient,
  businessProfileId: number,
  candidate: T | undefined,
): Promise<T | undefined> {
  if (!candidate) return undefined;
  const validRoot = candidate.duplicateStatus === "Not a Duplicate" && candidate.duplicateOfRecordId === null;
  const validFollower = candidate.duplicateStatus === "Flagged" && candidate.duplicateOfRecordId !== null;
  if (validRoot || validFollower) return candidate;
  await db.salesReferenceRecord.updateMany({
    where: { id: candidate.id, businessProfileId },
    data: { duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
  });
  return { ...candidate, duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null };
}

async function findDuplicate(
  businessProfileId: number,
  date: Date,
  amount: Prisma.Decimal,
  description: string,
  excludeId?: number,
  // Same reason as the expense side's findDuplicate: a caller inside an
  // interactive transaction must pass its own client, or a row that
  // transaction has already written would be invisible here.
  db: BulkDbClient = prisma,
) {
  const matches = await db.salesReferenceRecord.findMany({
    where: {
      businessProfileId,
      date,
      amount,
      description: { equals: description, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return canonicalCandidate(matches);
}

async function normalizeDuplicateIdentity(
  db: BulkDbClient,
  businessProfileId: number,
  identity: { date: Date; amount: Prisma.Decimal; description: string },
  options: { preferredOriginalId?: number; forcedFollowerId?: number } = {},
): Promise<void> {
  const matches = await db.salesReferenceRecord.findMany({
    where: {
      businessProfileId,
      date: identity.date,
      amount: identity.amount,
      description: { equals: identity.description, mode: "insensitive" },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, duplicateStatus: true, duplicateOfRecordId: true },
  });
  const available = matches.filter((record) => record.id !== options.forcedFollowerId);
  const preserved = available.filter((record) => record.duplicateStatus === "Not a Duplicate");
  const original = available.find((record) => record.id === options.preferredOriginalId)
    ?? canonicalCandidate(preserved)
    ?? canonicalCandidate(available)
    ?? matches[0];
  if (!original) return;

  const independentIds = preserved.map((record) => record.id);
  const rootIds = [...new Set([original.id, ...independentIds])];
  await db.salesReferenceRecord.updateMany({
    where: { id: { in: rootIds }, businessProfileId },
    data: { duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
  });
  const rootIdSet = new Set(rootIds);
  const duplicateIds = matches.filter((record) => !rootIdSet.has(record.id)).map((record) => record.id);
  if (duplicateIds.length > 0) {
    await db.salesReferenceRecord.updateMany({
      where: { id: { in: duplicateIds }, businessProfileId },
      data: { duplicateStatus: "Flagged", duplicateOfRecordId: original.id },
    });
  }
}

/**
 * The typed-in single sales-reference create — the same shape, and the same
 * fix, as createExpenseRecord.
 *
 * The duplicate check and the insert happen inside one transaction, behind
 * the profile's shared sales write gate (see lib/recordLock.ts), because a
 * double-tap on Add Sales had exactly the expense side's problem: both
 * requests read "no duplicate" before either wrote, and the owner was told
 * about neither. The duplicate NOTIFICATION is sent after the commit, so a
 * notification failure can never undo a sale the owner has already been shown
 * as saved.
 */
export async function createSalesRecord(userId: number, input: CreateInput) {
  await requireOwnedBusinessProfile(userId, input.businessProfileId);

  const date = new Date(input.date);
  const amount = new Prisma.Decimal(input.amount);

  const { record, duplicate } = await prisma.$transaction(async (tx) => {
    await lockSalesDuplicateWriteGate(tx, input.businessProfileId);

    let existing = await findDuplicate(input.businessProfileId, date, amount, input.description, undefined, tx);
    existing = await ensureValidDuplicateTarget(tx, input.businessProfileId, existing);

    const created = await tx.salesReferenceRecord.create({
      data: {
        businessProfileId: input.businessProfileId,
        date,
        description: input.description,
        amount,
        source: input.source ?? "MANUAL_ENTRY",
        importBatchId: input.importBatchId,
        reviewStatus: "Reviewed",
        duplicateStatus: existing ? "Flagged" : "Not a Duplicate",
        duplicateOfRecordId: existing?.id,
      },
    });

    return { record: created, duplicate: existing };
  });

  if (duplicate) {
    await runPostCommitNotification(
      { businessProfileId: record.businessProfileId, salesRecordId: record.id },
      () => createNotification(
        userId,
        input.businessProfileId,
        NOTIFICATION_TYPES.POSSIBLE_DUPLICATE,
        `Possible duplicate: "${input.description}" (PHP ${input.amount}) on ${input.date}`,
      ),
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
): Promise<ReturnType<typeof toDTO>[]> {
  if (rows.length === 0) return [];
  if (db === prisma) {
    return prisma.$transaction((tx) =>
      bulkCreateSalesRecords(userId, businessProfileId, importBatchId, rows, tx));
  }

  await requireOwnedBusinessProfile(userId, businessProfileId, db);
  await lockSalesDuplicateWriteGate(db, businessProfileId);

  const dates = [...new Set(rows.map((r) => r.date))].map((d) => new Date(d));
  const candidates = await db.salesReferenceRecord.findMany({
    where: { businessProfileId, date: { in: dates } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      duplicateStatus: true,
      duplicateOfRecordId: true,
    },
  });

  const existingByKey = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    const key = duplicateKeyOf(c.date, c.amount, c.description);
    const current = existingByKey.get(key);
    if (!current || canonicalRank(c) < canonicalRank(current)) existingByKey.set(key, c);
  }

  const firstIndexByKey = new Map<string, number>();
  const duplicatesEarlierRow = new Map<number, number>();
  const repairedCandidateIds = new Set<number>();

  const data = rows.map((row, i) => {
    const date = new Date(row.date);
    const amount = new Prisma.Decimal(row.amount);
    const key = duplicateKeyOf(date, amount, row.description);

    const existing = existingByKey.get(key);
    if (existing) {
      const validRoot = existing.duplicateStatus === "Not a Duplicate" && existing.duplicateOfRecordId === null;
      const validFollower = existing.duplicateStatus === "Flagged" && existing.duplicateOfRecordId !== null;
      if (!validRoot && !validFollower) {
        existing.duplicateStatus = "Not a Duplicate";
        existing.duplicateOfRecordId = null;
        repairedCandidateIds.add(existing.id);
      }
    }
    const existingId = existing?.id;
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

  if (repairedCandidateIds.size > 0) {
    await db.salesReferenceRecord.updateMany({
      where: { id: { in: [...repairedCandidateIds] }, businessProfileId },
      data: { duplicateStatus: "Not a Duplicate", duplicateOfRecordId: null },
    });
  }

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
      created[rowIndex]!.duplicateOfRecordId = targetId;
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
  const result = await prisma.$transaction(async (tx) => {
    let existing = await tx.salesReferenceRecord.findFirst({
      where: { id, businessProfile: { userId } },
    });
    if (!existing) throw new ApiError(404, "Sales reference record not found");

    await lockSalesDuplicateWriteGate(tx, existing.businessProfileId);
    existing = await tx.salesReferenceRecord.findFirst({
      where: { id, businessProfile: { userId } },
    });
    if (!existing) throw new ApiError(404, "Sales reference record not found");

    const nextDate = input.date ? new Date(input.date) : existing.date;
    const nextAmount = input.amount !== undefined ? new Prisma.Decimal(input.amount) : existing.amount;
    const nextDescription = input.description ?? existing.description;
    const valueFieldsChanged = input.date !== undefined || input.amount !== undefined || input.description !== undefined;
    const previousIdentity = {
      date: existing.date,
      amount: existing.amount,
      description: existing.description,
    };
    const nextIdentity = { date: nextDate, amount: nextAmount, description: nextDescription };
    const identityChanged = duplicateKeyOf(
      previousIdentity.date,
      previousIdentity.amount,
      previousIdentity.description,
    ) !== duplicateKeyOf(nextIdentity.date, nextIdentity.amount, nextIdentity.description);
    const targetOriginal = valueFieldsChanged && identityChanged
      ? await findDuplicate(
          existing.businessProfileId,
          nextDate,
          nextAmount,
          nextDescription,
          existing.id,
          tx,
        )
      : undefined;
    const requestedDuplicate = !valueFieldsChanged && input.duplicateStatus === "Flagged"
      ? await findDuplicate(
          existing.businessProfileId,
          existing.date,
          existing.amount,
          existing.description,
          existing.id,
          tx,
        )
      : undefined;

    const updated = await tx.salesReferenceRecord.updateMany({
      where: { id, businessProfile: { userId } },
      data: {
        date: nextDate,
        description: nextDescription,
        amount: nextAmount,
        reviewStatus: input.reviewStatus ?? existing.reviewStatus,
        ...(!valueFieldsChanged
          ? {
              duplicateStatus: input.duplicateStatus === "Flagged"
                ? (requestedDuplicate ? "Flagged" : "Not a Duplicate")
                : (input.duplicateStatus ?? existing.duplicateStatus),
              duplicateOfRecordId: input.duplicateStatus === "Not a Duplicate"
                ? null
                : (input.duplicateStatus === "Flagged"
                    ? (requestedDuplicate?.id ?? null)
                    : existing.duplicateOfRecordId),
            }
          : {}),
      },
    });
    if (updated.count !== 1) throw new ApiError(404, "Sales reference record not found");

    if (valueFieldsChanged) {
      await normalizeDuplicateIdentity(tx, existing.businessProfileId, previousIdentity);
      if (identityChanged) {
        await normalizeDuplicateIdentity(tx, existing.businessProfileId, nextIdentity, {
          preferredOriginalId: targetOriginal?.id,
          forcedFollowerId: targetOriginal ? existing.id : undefined,
        });
      }
    } else if (input.duplicateStatus === "Flagged" && requestedDuplicate) {
      await normalizeDuplicateIdentity(tx, existing.businessProfileId, nextIdentity, {
        preferredOriginalId: requestedDuplicate.id,
        forcedFollowerId: existing.id,
      });
    }

    const record = await tx.salesReferenceRecord.findUniqueOrThrow({ where: { id } });
    return { existing, record, nextDate, nextAmount, nextDescription };
  });

  const { existing, record, nextDate, nextAmount, nextDescription } = result;
  if (record.duplicateStatus === "Flagged" && existing.duplicateStatus !== "Flagged") {
    await runPostCommitNotification(
      { businessProfileId: record.businessProfileId, salesRecordId: record.id },
      () => createNotification(
        userId,
        existing.businessProfileId,
        NOTIFICATION_TYPES.POSSIBLE_DUPLICATE,
        `Possible duplicate: "${nextDescription}" (PHP ${Number(nextAmount)}) on ${nextDate.toISOString().slice(0, 10)}`,
      ),
    );
  }

  return toDTO(record);
}

export async function deleteSalesRecord(userId: number, id: number) {
  await prisma.$transaction(async (tx) => {
    let existing = await tx.salesReferenceRecord.findFirst({ where: { id, businessProfile: { userId } } });
    if (!existing) throw new ApiError(404, "Sales reference record not found");

    await lockSalesDuplicateWriteGate(tx, existing.businessProfileId);
    existing = await tx.salesReferenceRecord.findFirst({ where: { id, businessProfile: { userId } } });
    if (!existing) throw new ApiError(404, "Sales reference record not found");

    const deleted = await tx.salesReferenceRecord.deleteMany({ where: { id, businessProfile: { userId } } });
    if (deleted.count !== 1) throw new ApiError(404, "Sales reference record not found");
    await normalizeDuplicateIdentity(tx, existing.businessProfileId, {
      date: existing.date,
      amount: existing.amount,
      description: existing.description,
    });
    await enqueueCsvSourcePurgesIfOrphaned(tx, [existing.importBatchId]);
  });
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

  if (action === "keep") {
    return prisma.$transaction(async (tx) => {
      await lockSalesDuplicateWriteGate(tx, businessProfileId);
      const { count } = await tx.salesReferenceRecord.updateMany({
        where: { id: { in: ids }, businessProfileId, duplicateStatus: "Flagged" },
        data: {
          duplicateStatus: "Not a Duplicate",
          duplicateOfRecordId: null,
          reviewStatus: "Reviewed",
        },
      });
      return count;
    });
  }

  const owned = await prisma.$transaction(async (tx) => {
    await lockSalesDuplicateWriteGate(tx, businessProfileId);
    const records = await tx.salesReferenceRecord.findMany({
      where: { id: { in: ids }, businessProfileId, duplicateStatus: "Flagged" },
    });
    if (records.length === 0) return records;
    const recordIds = records.map((record) => record.id);
    const affectedFollowers = await tx.salesReferenceRecord.findMany({
      where: {
        businessProfileId,
        duplicateOfRecordId: { in: recordIds },
        id: { notIn: recordIds },
      },
    });
    await tx.salesReferenceRecord.deleteMany({
      where: { id: { in: recordIds }, businessProfileId, duplicateStatus: "Flagged" },
    });
    const repairs = new Map<string, (typeof affectedFollowers)[number]>();
    for (const follower of affectedFollowers) {
      const key = duplicateKeyOf(follower.date, follower.amount, follower.description);
      if (!repairs.has(key)) repairs.set(key, follower);
    }
    for (const follower of repairs.values()) {
      await normalizeDuplicateIdentity(tx, businessProfileId, {
        date: follower.date,
        amount: follower.amount,
        description: follower.description,
      });
    }
    await enqueueCsvSourcePurgesIfOrphaned(tx, records.map((record) => record.importBatchId));
    return records;
  });
  return owned.length;
}

export async function searchSalesRecords(userId: number, filters: SearchFilters) {
  await requireOwnedBusinessProfile(userId, filters.businessProfileId);

  const sort = filters.sort ?? DEFAULT_RECORD_SORT;
  const cursorWhere = recordCursorWhere(filters.cursor, sort);

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
    orderBy: recordOrderBy(sort),
    take: filters.take,
  });

  return records.map(toDTO);
}

/** The one definition of "flagged" on this side, shared by the list and the count. */
const FLAGGED_SALES_WHERE = {
  OR: [{ reviewStatus: "Needs Review" }, { duplicateStatus: "Flagged" }],
};

/** The sales half of the bounded flagged list — see listFlaggedExpenseRecords. */
export async function listFlaggedSalesRecords(
  userId: number,
  businessProfileId: number,
  options: FlaggedListOptions = {},
) {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  // The flagged list has no sort parameter; it stays on the default order.
  const cursorWhere = recordCursorWhere(options.cursor);

  const records = await prisma.salesReferenceRecord.findMany({
    where: {
      businessProfileId,
      AND: [FLAGGED_SALES_WHERE, ...(cursorWhere ? [cursorWhere] : [])],
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: options.take,
  });
  return records.map(toDTO);
}

/** The sales half of the badge count — see countFlaggedExpenseRecords. */
export async function countFlaggedSalesRecords(userId: number, businessProfileId: number): Promise<number> {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  return prisma.salesReferenceRecord.count({
    where: { businessProfileId, ...FLAGGED_SALES_WHERE },
  });
}
