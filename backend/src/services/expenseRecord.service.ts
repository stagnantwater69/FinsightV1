import { Prisma } from "@prisma/client";
import type { ExpenseRecord, ExpenseRecordSource, ReceiptScanItem } from "@prisma/client";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { cleanUpImportBatchIfOrphaned, cleanUpReceiptScanIfOrphaned } from "../lib/sourceCleanup";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import { signedReceiptImageUrl, signedCsvFileUrl } from "./storage.service";
import { logger } from "../config/logger";
import { enqueueExpenseAnalyses, enqueueExpenseAnalysis } from "./anomalyDetection/job.service";

interface CreateInput {
  businessProfileId: number;
  categoryId: number;
  date: string;
  description: string;
  vendor?: string;
  amount: number;
  source?: ExpenseRecordSource;
  receiptScanId?: number;
  importBatchId?: number;
  /**
   * This record's share of a receipt's tax, service charge or discount —
   * part of `amount`, not on top of it. Signed. See schema header note 13.
   */
  allocatedCharges?: number;
}

interface UpdateInput {
  categoryId?: number;
  date?: string;
  description?: string;
  vendor?: string | null;
  amount?: number;
  reviewStatus?: "Reviewed" | "Needs Review";
  duplicateStatus?: "Not a Duplicate" | "Flagged";
}

export interface SearchFilters {
  businessProfileId: number;
  categoryId?: number;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  source?: ExpenseRecordSource;
  importBatchId?: number;
  take?: number;
  cursor?: { date: Date; id: number; mode: "same-type" | "include-date" | "exclude-date" };
}

function toDTO(record: ExpenseRecord) {
  return {
    id: record.id,
    type: "expense" as const,
    businessProfileId: record.businessProfileId,
    categoryId: record.categoryId,
    receiptScanId: record.receiptScanId,
    importBatchId: record.importBatchId,
    duplicateOfRecordId: record.duplicateOfRecordId,
    date: record.date,
    description: record.description,
    vendor: record.vendor,
    amount: Number(record.amount),
    allocatedCharges: record.allocatedCharges === null ? null : Number(record.allocatedCharges),
    source: record.source,
    reviewStatus: record.reviewStatus,
    duplicateStatus: record.duplicateStatus,
    largeExpenseFlag: record.largeExpenseFlag,
    createdAt: record.createdAt,
  };
}

async function queueAnalysis(businessProfileId: number, expenseRecordId: number) {
  await enqueueExpenseAnalysis(businessProfileId, expenseRecordId).catch((error) => {
    logger.error({ err: error, expenseRecordId }, "failed to enqueue expense analysis");
  });
}

async function findDuplicate(businessProfileId: number, date: Date, amount: Prisma.Decimal, description: string, excludeId?: number) {
  return prisma.expenseRecord.findFirst({
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

// ============================================================
// The two flagging rules, extracted so there is one copy of each
// ============================================================
// CSV import can't afford findDuplicate-per-row or a profile fetch per row
// (see bulkCreateExpenseRecords), so it re-implements both decisions against
// an in-memory index. These helpers exist so that "re-implements" means
// "calls the same function", not "has a second copy of the arithmetic that
// can quietly disagree with this one".

export function largeExpenseThresholdFor(profile: {
  expectedMonthlyExpenses: Prisma.Decimal | number;
  largeExpenseThresholdPercent: Prisma.Decimal | number;
}): number {
  return Number(profile.expectedMonthlyExpenses) * (Number(profile.largeExpenseThresholdPercent) / 100);
}

/**
 * The identity two records must share to count as duplicates of each other.
 *
 * Mirrors findDuplicate's WHERE clause exactly: same calendar date, same
 * amount, same description ignoring case. Anything that changes there has to
 * change here in the same commit, or a CSV import and a typed-in record will
 * disagree about what a duplicate is.
 */
export function duplicateKeyOf(date: Date, amount: Prisma.Decimal | number, description: string): string {
  return [
    date.toISOString().slice(0, 10),
    Number(amount).toFixed(2),
    description.toLowerCase(),
  ].join("|");
}

async function verifyCategoryBelongsToProfile(categoryId: number, businessProfileId: number) {
  const category = await prisma.expenseCategory.findFirst({ where: { id: categoryId, businessProfileId } });
  if (!category) {
    throw new ApiError(400, "Category does not belong to this business profile");
  }
}

export async function createExpenseRecord(userId: number, input: CreateInput) {
  const profile = await requireOwnedBusinessProfile(userId, input.businessProfileId);
  await verifyCategoryBelongsToProfile(input.categoryId, input.businessProfileId);

  const date = new Date(input.date);
  const amount = new Prisma.Decimal(input.amount);

  const duplicate = await findDuplicate(input.businessProfileId, date, amount, input.description);
  const largeExpenseFlag = input.amount >= largeExpenseThresholdFor(profile);

  const record = await prisma.expenseRecord.create({
    data: {
      businessProfileId: input.businessProfileId,
      categoryId: input.categoryId,
      date,
      description: input.description,
      vendor: input.vendor,
      amount,
      allocatedCharges:
        input.allocatedCharges === undefined ? undefined : new Prisma.Decimal(input.allocatedCharges),
      source: input.source ?? "MANUAL_ENTRY",
      receiptScanId: input.receiptScanId,
      importBatchId: input.importBatchId,
      largeExpenseFlag,
      reviewStatus: largeExpenseFlag ? "Needs Review" : "Reviewed",
      duplicateStatus: duplicate ? "Flagged" : "Not a Duplicate",
      duplicateOfRecordId: duplicate?.id,
    },
  });

  if (duplicate) {
    await createNotification(
      userId,
      input.businessProfileId,
      NOTIFICATION_TYPES.POSSIBLE_DUPLICATE,
      `Possible duplicate: "${input.description}" (PHP ${input.amount}) on ${input.date}`,
      record.id
    );
  }
  if (largeExpenseFlag) {
    await createNotification(
      userId,
      input.businessProfileId,
      NOTIFICATION_TYPES.LARGE_EXPENSE_FLAG,
      `Large expense flagged: "${input.description}" (PHP ${input.amount}) on ${input.date}`,
      record.id
    );
  }

  await queueAnalysis(record.businessProfileId, record.id);

  return toDTO(record);
}

export interface BulkExpenseRow {
  categoryId: number;
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  amount: number;
  vendor?: string;
}

/**
 * Either the shared client or a transaction handed down by the CSV import's
 * chunked path, so a whole chunk (records + duplicate links + the batch's
 * resume checkpoint) commits or rolls back as one unit — the checkpoint must
 * never claim rows that did not land, or a retry would re-insert them.
 */
export type BulkDbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Creates a whole CSV batch in a fixed number of queries instead of a
 * per-row handful.
 *
 * createExpenseRecord is right for one record and wrong for a hundred: it
 * re-fetches the business profile, re-verifies the category, and runs its own
 * findDuplicate SELECT every time it is called. Looping it over a 35-row file
 * measured at ~57 seconds against the hosted database — roughly 175 round
 * trips at ~300ms each — and it scales linearly, so a 200-row import would
 * have sat behind a spinner for five minutes and very likely tripped a
 * gateway timeout before it finished.
 *
 * This does the same work in four queries regardless of row count: one SELECT
 * for the existing records a row could possibly duplicate, one createMany,
 * one optional transaction to link within-batch duplicates, one createMany for
 * the notifications. The profile and the categories are resolved once by the
 * caller, which is also the only caller — everything here assumes the rows
 * have already been validated and their categories already belong to this
 * profile.
 *
 * A welcome side effect: the insert is now atomic. The old loop committed
 * every row before the one that threw, so a failure halfway through left a
 * half-imported batch behind and returned a 500 describing none of it.
 */
export async function bulkCreateExpenseRecords(
  userId: number,
  profile: { id: number; expectedMonthlyExpenses: Prisma.Decimal; largeExpenseThresholdPercent: Prisma.Decimal },
  importBatchId: number,
  rows: BulkExpenseRow[],
  db: BulkDbClient = prisma,
) {
  if (rows.length === 0) return [];

  const businessProfileId = profile.id;
  const threshold = largeExpenseThresholdFor(profile);

  // Only records sharing a date with some row in the file can possibly be a
  // duplicate of one, so the candidate set is bounded by the file's date range
  // rather than by the business's whole history.
  const dates = [...new Set(rows.map((r) => r.date))].map((d) => new Date(d));
  const candidates = await db.expenseRecord.findMany({
    where: { businessProfileId, date: { in: dates } },
    // findDuplicate takes the OLDEST match; id breaks createdAt ties, which a
    // previous bulk import can now produce since its rows share a timestamp.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, date: true, amount: true, description: true },
  });

  const existingIdByKey = new Map<string, number>();
  for (const c of candidates) {
    const key = duplicateKeyOf(c.date, c.amount, c.description);
    if (!existingIdByKey.has(key)) existingIdByKey.set(key, c.id);
  }

  // A row can also duplicate an earlier row of the SAME file, which the old
  // loop caught for free because each insert was visible to the next one's
  // SELECT. Here the earlier row has no id until after the createMany, so the
  // link is recorded by row index and resolved below.
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

    const largeExpenseFlag = row.amount >= threshold;
    return {
      businessProfileId,
      categoryId: row.categoryId,
      date,
      description: row.description,
      vendor: row.vendor,
      amount,
      source: "CSV_UPLOAD" as const,
      importBatchId,
      largeExpenseFlag,
      reviewStatus: largeExpenseFlag ? "Needs Review" : "Reviewed",
      duplicateStatus: existingId !== undefined || earlierIndex !== undefined ? "Flagged" : "Not a Duplicate",
      duplicateOfRecordId: existingId,
    };
  });

  // Postgres returns INSERT ... RETURNING rows in insertion order, so
  // created[i] is data[i]. The length check is cheap insurance on an
  // assumption the index-based links below depend on completely.
  const created = await db.expenseRecord.createManyAndReturn({ data });
  if (created.length !== rows.length) {
    throw new ApiError(500, "Import did not create the expected number of records");
  }

  if (duplicatesEarlierRow.size > 0) {
    /*
     * Grouped by TARGET, so this is one UPDATE per distinct original rather
     * than one per duplicate row.
     *
     * It used to be a statement each, which was fine at a 5,000-row cap and
     * became the only superlinear path in the import once that cap rose: a file
     * whose rows all repeat one another turns every row after the first into a
     * separate UPDATE in a single transaction. Measured at 30,000 such rows
     * that was 18s against a local database, versus ~5s for the same file
     * without the repetition — and it collapses to a handful of statements
     * here, because all those rows point at the same original.
     */
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
          prisma.expenseRecord.updateMany({
            where: { id: { in: ids } },
            data: { duplicateOfRecordId: targetId },
          }),
        ),
      );
    } else {
      // Already inside the caller's transaction — a nested $transaction is
      // not a thing, and the outer one is what makes these atomic anyway.
      for (const [targetId, ids] of rowsByTarget) {
        await db.expenseRecord.updateMany({
          where: { id: { in: ids } },
          data: { duplicateOfRecordId: targetId },
        });
      }
    }
  }

  /*
   * NO PER-RECORD NOTIFICATIONS. This path is only ever reached by a CSV
   * import, and confirmImport already raises ONE notification summarising the
   * whole batch — how many rows were skipped, flagged as duplicates, and
   * flagged as large.
   *
   * A notification each was tolerable at a 5,000-row cap and is actively
   * harmful above it: a measured 30,000-row import produced 33,355 of them, on
   * top of the summary, which does not inform an owner of anything — it buries
   * every other notification they have and makes the bell useless for the one
   * job it exists to do.
   *
   * Nothing becomes unreachable. Every flagged row still carries its
   * duplicateStatus and largeExpenseFlag, still gets reviewStatus "Needs
   * Review", and still appears in the review queue — which is the screen built
   * for working through exactly this, and which handles thousands of rows in a
   * way a notification list never could. The single-record paths
   * (createExpenseRecord / updateExpenseRecord) keep their notifications,
   * because there one record IS the whole event.
   */
  /*
   * Skipped when running inside a caller's transaction: the analysis jobs
   * carry a foreign key to records that are not committed yet, so writing
   * them through the shared client here would hit an FK violation every
   * time. The CSV chunk loop enqueues the same ids itself, AFTER its
   * transaction commits — and the hourly reconcile in
   * enqueueDailyProfileAnalyses backstops the narrow crash window between
   * that commit and the enqueue.
   */
  if (db === prisma) {
    await enqueueExpenseAnalyses(businessProfileId, created.map((record) => record.id)).catch((error) => {
      logger.error({ err: error, importBatchId }, "failed to enqueue imported expense analysis");
    });
  }

  return created.map(toDTO);
}

/**
 * One record, with everything known about where it came from.
 *
 * WHY THE EXTRA QUERIES: a record created by a receipt scan is a summary of
 * something more detailed — "Inventory PHP 1,850" was really buns, patties
 * and a tray of eggs, read off a photo, sitting alongside an Equipment record
 * from the same receipt. Opening it to edit and seeing only the summary gives
 * the owner no way to check the figure against reality, or even to remember
 * what the purchase was. The detail already exists in the database; it simply
 * was never sent.
 *
 * The provenance is deliberately assembled here rather than left to the
 * client to stitch together from three endpoints, because "what is this
 * record" is one question.
 */
export async function getExpenseRecord(userId: number, id: number) {
  const record = await prisma.expenseRecord.findFirst({
    where: { id, businessProfile: { userId } },
    include: {
      receiptItems: {
        orderBy: { lineNumber: "asc" },
        include: { category: { select: { id: true, name: true } } },
      },
      receiptScan: {
        select: { id: true, imageFile: true, extractedVendor: true, createdAt: true },
      },
      importBatch: {
        select: { id: true, title: true, uploadDate: true, fileReference: true, status: true },
      },
    },
  });
  if (!record) {
    throw new ApiError(404, "Expense record not found");
  }

  return { ...toDTO(record), origin: await buildOrigin(record) };
}

type RecordWithOrigin = ExpenseRecord & {
  receiptItems: (ReceiptScanItem & { category: { id: number; name: string } | null })[];
  receiptScan: { id: number; imageFile: string; extractedVendor: string | null; createdAt: Date } | null;
  importBatch: {
    id: number;
    title: string;
    uploadDate: Date;
    fileReference: string | null;
    status: string;
  } | null;
};

async function buildOrigin(record: RecordWithOrigin) {
  if (record.receiptScan) {
    /*
     * The other records this same receipt produced. A receipt covering
     * inventory and equipment becomes two records, and each one is only half
     * the story — without this, an owner looking at the Inventory record has
     * no way to see that the PHP 2,400 drinks chiller they remember buying is
     * filed separately rather than missing.
     */
    const siblings = await prisma.expenseRecord.findMany({
      where: { receiptScanId: record.receiptScan.id, id: { not: record.id } },
      select: { id: true, description: true, amount: true, category: { select: { id: true, name: true } } },
      orderBy: { id: "asc" },
    });

    const itemsSubtotal = record.receiptItems.reduce((sum, i) => sum + Math.round(Number(i.amount) * 100), 0) / 100;

    return {
      kind: "receipt_scan" as const,
      scanId: record.receiptScan.id,
      scannedAt: record.receiptScan.createdAt,
      extractedVendor: record.receiptScan.extractedVendor,
      imageUrl: await signedReceiptImageUrl(record.receiptScan.imageFile),
      items: record.receiptItems.map((i) => ({
        id: i.id,
        lineNumber: i.lineNumber,
        name: i.name,
        quantity: i.quantity === null ? null : Number(i.quantity),
        unitPrice: i.unitPrice === null ? null : Number(i.unitPrice),
        amount: Number(i.amount),
        categoryId: i.categoryId,
        categoryName: i.category?.name ?? null,
        addedByOwner: i.addedByOwner,
        // Survives onto the saved record, not just the confirm screen. Someone
        // reviewing this expense months later should still be able to tell
        // which lines were read off text and which a model inferred from a
        // photograph.
        extractedByVision: i.extractedByVision,
      })),
      /**
       * The items' own subtotal, kept separate from the record amount so the
       * panel can show the arithmetic — "1,000.00 of items + 120.00 tax" —
       * rather than presenting the total as though the items summed to it.
       */
      itemsSubtotal,
      siblings: siblings.map((s) => ({
        id: s.id,
        description: s.description,
        amount: Number(s.amount),
        categoryId: s.category.id,
        categoryName: s.category.name,
      })),
    };
  }

  if (record.importBatch) {
    /*
     * A CSV row has no line items — the spreadsheet row IS the record. So the
     * useful provenance is the batch: which file, when, and how many other
     * rows came in with it. A count rather than the rows themselves, since an
     * import is routinely hundreds of records and listing them here would
     * turn opening one record into a page-sized response.
     */
    const rowCount = await prisma.expenseRecord.count({
      where: { importBatchId: record.importBatch.id },
    });

    return {
      kind: "csv_import" as const,
      batchId: record.importBatch.id,
      title: record.importBatch.title,
      uploadDate: record.importBatch.uploadDate,
      fileReference: record.importBatch.fileReference,
      /*
       * The file itself, not just its stored path.
       *
       * A CSV row carries no evidence of its own the way a scanned receipt
       * does — there is no photo to compare against, so an owner who thinks a
       * figure looks wrong has nothing to check it against unless they still
       * have the spreadsheet they uploaded. This is that check. Null when the
       * link cannot be minted, which the panel reads as "no file to offer"
       * rather than as an error.
       */
      fileUrl: record.importBatch.fileReference ? await signedCsvFileUrl(record.importBatch.fileReference) : null,
      status: record.importBatch.status,
      rowCount,
    };
  }

  // Typed by hand, or a scan/import whose parent has since been deleted.
  return null;
}

export async function updateExpenseRecord(userId: number, id: number, input: UpdateInput) {
  const existing = await prisma.expenseRecord.findFirst({
    where: { id, businessProfile: { userId } },
    include: { businessProfile: true },
  });
  if (!existing) {
    throw new ApiError(404, "Expense record not found");
  }

  if (input.categoryId) {
    await verifyCategoryBelongsToProfile(input.categoryId, existing.businessProfileId);
  }

  const nextDate = input.date ? new Date(input.date) : existing.date;
  const nextAmount = input.amount !== undefined ? new Prisma.Decimal(input.amount) : existing.amount;
  const nextDescription = input.description ?? existing.description;

  // Re-run duplicate detection and the large-expense check whenever a
  // value field that affects them changes — a stale flag from before the
  // edit would be misleading.
  const valueFieldsChanged = input.date !== undefined || input.amount !== undefined || input.description !== undefined;
  let duplicateStatus = input.duplicateStatus ?? existing.duplicateStatus;
  let duplicateOfRecordId = existing.duplicateOfRecordId;
  let largeExpenseFlag = existing.largeExpenseFlag;
  let reviewStatus = input.reviewStatus ?? existing.reviewStatus;

  if (valueFieldsChanged) {
    const duplicate = await findDuplicate(existing.businessProfileId, nextDate, nextAmount, nextDescription, existing.id);
    duplicateStatus = duplicate ? "Flagged" : "Not a Duplicate";
    duplicateOfRecordId = duplicate?.id ?? null;

    largeExpenseFlag = Number(nextAmount) >= largeExpenseThresholdFor(existing.businessProfile);
    if (input.reviewStatus === undefined) {
      reviewStatus = largeExpenseFlag ? "Needs Review" : "Reviewed";
    }
  }

  const record = await prisma.expenseRecord.update({
    where: { id },
    data: {
      categoryId: input.categoryId,
      date: nextDate,
      description: nextDescription,
      vendor: input.vendor,
      amount: nextAmount,
      largeExpenseFlag,
      reviewStatus,
      duplicateStatus,
      duplicateOfRecordId,
    },
  });

  // Only alert on a fresh transition into the flagged state — not on
  // every edit to a record that was already flagged (or stays clear).
  if (duplicateStatus === "Flagged" && existing.duplicateStatus !== "Flagged") {
    await createNotification(
      userId,
      existing.businessProfileId,
      NOTIFICATION_TYPES.POSSIBLE_DUPLICATE,
      `Possible duplicate: "${nextDescription}" (PHP ${Number(nextAmount)}) on ${nextDate.toISOString().slice(0, 10)}`,
      record.id
    );
  }
  if (largeExpenseFlag && !existing.largeExpenseFlag) {
    await createNotification(
      userId,
      existing.businessProfileId,
      NOTIFICATION_TYPES.LARGE_EXPENSE_FLAG,
      `Large expense flagged: "${nextDescription}" (PHP ${Number(nextAmount)}) on ${nextDate.toISOString().slice(0, 10)}`,
      record.id
    );
  }

  if (valueFieldsChanged || input.vendor !== undefined || input.categoryId !== undefined) {
    await queueAnalysis(record.businessProfileId, record.id);
  }

  return toDTO(record);
}

export async function deleteExpenseRecord(userId: number, id: number) {
  const existing = await prisma.expenseRecord.findFirst({ where: { id, businessProfile: { userId } } });
  if (!existing) {
    throw new ApiError(404, "Expense record not found");
  }
  await prisma.expenseRecord.delete({ where: { id } });

  /*
   * The uploaded file this record came from goes too, once this was the last
   * record that came from it. Read the ids off `existing` BEFORE the delete —
   * afterwards there is no row left to read them from.
   *
   * After the delete rather than in a transaction with it: these touch object
   * storage, which cannot take part in a database transaction, and a storage
   * failure must not roll back a deletion the owner asked for.
   */
  await cleanUpReceiptScanIfOrphaned(existing.receiptScanId);
  await cleanUpImportBatchIfOrphaned(existing.importBatchId);
}

/**
 * Settles a whole set of duplicate flags at once.
 *
 * WHY THIS EXISTS: a re-imported spreadsheet flags every row it repeats, so
 * "you have 3 possible duplicates" and "you have 300" are the same mistake made
 * once. Resolving them one at a time asks the owner to answer the same question
 * three hundred times, and the answer they give the first time is the answer
 * they will give every time.
 *
 * WHY DISCARDING A WHOLE GROUP IS SAFE. Only COPIES carry the flag — both
 * findDuplicate and bulkCreateExpenseRecords leave the oldest matching record
 * as "Not a Duplicate" and flag what came after it. So a set of flagged records
 * never contains the original, and discarding all of them cannot take the
 * owner's real record with it. The screen says so in those words, because
 * "discard 40 records" read on its own sounds like it might.
 *
 * Ids that are not this profile's are silently skipped rather than rejected —
 * the same rule requireOwnedBusinessProfile follows, so a list of ids cannot be
 * used to find out which of them exist.
 *
 * Returns how many records were actually affected, so the caller reports what
 * happened rather than what was asked for.
 */
export async function bulkResolveExpenseDuplicates(
  userId: number,
  businessProfileId: number,
  ids: number[],
  action: "keep" | "discard",
): Promise<number> {
  if (ids.length === 0) return 0;
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const owned = await prisma.expenseRecord.findMany({
    where: { id: { in: ids }, businessProfileId },
    select: { id: true, receiptScanId: true, importBatchId: true },
  });
  if (owned.length === 0) return 0;
  const ownedIds = owned.map((r) => r.id);

  if (action === "keep") {
    const { count } = await prisma.expenseRecord.updateMany({
      where: { id: { in: ownedIds } },
      data: { duplicateStatus: "Not a Duplicate", reviewStatus: "Reviewed" },
    });
    return count;
  }

  await prisma.expenseRecord.deleteMany({ where: { id: { in: ownedIds } } });

  /*
   * The same source cleanup deleteExpenseRecord performs, but run once per
   * distinct source rather than once per record — deleting 300 rows of one
   * import should check that import once, not 300 times. Ids are read off the
   * rows fetched above, since after deleteMany there is nothing left to read.
   */
  const scanIds = [...new Set(owned.map((r) => r.receiptScanId).filter((v): v is number => v !== null))];
  const batchIds = [...new Set(owned.map((r) => r.importBatchId).filter((v): v is number => v !== null))];
  for (const scanId of scanIds) await cleanUpReceiptScanIfOrphaned(scanId);
  for (const batchId of batchIds) await cleanUpImportBatchIfOrphaned(batchId);

  return ownedIds.length;
}

export async function searchExpenseRecords(userId: number, filters: SearchFilters) {
  await requireOwnedBusinessProfile(userId, filters.businessProfileId);

  const cursorWhere = !filters.cursor
    ? undefined
    : filters.cursor.mode === "include-date"
      ? { date: { lte: filters.cursor.date } }
      : filters.cursor.mode === "exclude-date"
        ? { date: { lt: filters.cursor.date } }
        : { OR: [{ date: { lt: filters.cursor.date } }, { date: filters.cursor.date, id: { lt: filters.cursor.id } }] };

  const records = await prisma.expenseRecord.findMany({
    where: {
      businessProfileId: filters.businessProfileId,
      categoryId: filters.categoryId,
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

export async function listFlaggedExpenseRecords(userId: number, businessProfileId: number) {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  const records = await prisma.expenseRecord.findMany({
    where: {
      businessProfileId,
      OR: [{ reviewStatus: "Needs Review" }, { duplicateStatus: "Flagged" }],
    },
    orderBy: { date: "desc" },
  });
  return records.map(toDTO);
}
