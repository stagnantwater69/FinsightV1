import { parse } from "csv-parse/sync";
import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { uploadCsvFile, downloadCsvFile } from "./storage.service";
import { bulkCreateExpenseRecords } from "./expenseRecord.service";
import { bulkCreateSalesRecords } from "./salesRecord.service";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import {
  classifyTypeValue,
  columnsWithSignedAmounts,
  DEFAULT_IMPORT_CATEGORY,
  DETECTION_SAMPLE_ROWS,
  detectTypeColumn,
  parseSignedAmount,
  type RowRecordType,
} from "../lib/recordTypeDetection";

export interface ColumnMapping {
  date: string;
  description: string;
  amount: string;
  category?: string;
  /**
   * Optional, unlike the others. ExpenseRecord.vendor is nullable and the Add
   * Expense form marks it optional, so a spreadsheet without a supplier column
   * still imports cleanly — it just can't fill one in. A row is never skipped
   * for lacking a vendor.
   */
  vendor?: string;
  /**
   * The column saying whether each row is a sale or an expense.
   *
   * Only meaningful when `recordType` is "mixed" with the "column" strategy;
   * ignored otherwise. See lib/recordTypeDetection.ts.
   */
  recordType?: string;
}

/**
 * What one import writes.
 *
 * "mixed" is the case an owner who keeps ONE spreadsheet for everything
 * actually has. It is not a guess at the file's contents — it is the owner
 * saying "this file has both", after which the rows are separated by whatever
 * the file itself states.
 */
export type ImportRecordType = "expense" | "sales" | "mixed";

/** How a mixed file distinguishes its rows. */
export type MixedStrategy = "column" | "sign";

export interface PreviewResult {
  headers: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
  /**
   * What the file appears to say about sales versus expenses, so the client can
   * OFFER a mixed import rather than making the owner know to ask for one.
   *
   * Both are suggestions and neither is acted on by itself — the owner still
   * chooses, and the preview shows every row's resolved type first. See
   * lib/recordTypeDetection.ts for why detection stops at what the file states.
   */
  detectedTypeColumn: string | null;
  /** Columns mixing negative and positive numbers — candidates for the sign strategy. */
  columnsWithNegatives: string[];
}

/** Replacement cell values, keyed by spreadsheet row number as a string. */
export type RowCorrections = Record<
  string,
  { date?: string; description?: string; amount?: string; category?: string }
>;

export interface ConfirmInput {
  businessProfileId: number;
  recordType: ImportRecordType;
  /** Required when `recordType` is "mixed", ignored otherwise. */
  mixedStrategy?: MixedStrategy;
  title: string;
  buffer: Buffer;
  originalname: string;
  columnMapping: ColumnMapping;
  corrections?: RowCorrections;
}

export interface SkippedRow {
  row: number;
  reason: string;
}

/**
 * The most data rows one import may carry.
 *
 * WHY ROWS AND NOT MEGABYTES. The upload is already capped at 5 MB by multer,
 * and that number says almost nothing about how much work the file represents.
 * A CSV is plain text, so its size tracks the CHARACTERS in it, not the records:
 *
 *   `2026-01-05,Load,120`            ~25 bytes  →  5 MB is ~200,000 rows
 *   a row with a full description   ~600 bytes  →  5 MB is ~8,000 rows
 *
 * A twenty-five-fold swing in work for an identical file size — and every row
 * becomes an ExpenseRecord with its own validation, duplicate check, large-
 * expense evaluation and downstream analysis job. Bytes are the wrong unit for
 * the thing that actually costs; rows are the thing that costs.
 *
 * WHERE 30,000 COMES FROM. Measured, against a local Postgres, on the real
 * bulkCreate path rather than on a guess:
 *
 *   30,000 typical rows                       ~5.0s
 *   30,000 with 15% duplicates, 10% flagged   ~4.7s
 *   30,000 rows that ALL repeat one another  ~18.1s  -> now ~5s, see below
 *
 * The writes are bulk (`createManyAndReturn`, `createMany`), so cost is linear
 * at roughly 160µs a row. The one path that was not bulk — relinking rows that
 * duplicate an earlier row of the same file — issued a statement per duplicate
 * and produced that 18s outlier; it is now grouped by target, so the
 * pathological file costs about what an ordinary one does.
 *
 * The earlier cap was 5,000, chosen for a shop recording expenses daily
 * (~365 rows a year). That reasoning undercounted the real case: a business
 * importing per-transaction SALES history can produce 50-100 rows a day, and
 * 5,000 is then under three months. 30,000 is about a year of that, or decades
 * of daily expense logging.
 *
 * It stays a guard against a runaway or mistaken file rather than a quota, and
 * the ceiling above it is a real one: this runs inside a single request, so a
 * materially larger file wants the AnalysisJob queue rather than a bigger
 * number here. If an owner meets this limit the answer is still to split the
 * file, and the message says so.
 */
export const MAX_IMPORT_ROWS = 30_000;

function parseCsv(buffer: Buffer): Record<string, string>[] {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  /*
   * Checked HERE rather than at each call site, so preview and confirm cannot
   * disagree — an oversized file must be refused on the mapping screen, before
   * an owner spends time matching columns for an import that was never going to
   * run.
   */
  if (records.length > MAX_IMPORT_ROWS) {
    throw new ApiError(
      400,
      `This file has ${records.length.toLocaleString()} rows and the limit is ${MAX_IMPORT_ROWS.toLocaleString()}. ` +
        `Split it into smaller files — by month or by year — and import them one at a time.`,
    );
  }

  return records;
}

// The preview is a full-height table on the mapping screen now, not the
// seven-row window it was built for, so 20 rows left most of it empty on a
// laptop. 50 is still a trivial payload (a few tens of KB) and covers a full
// screen of scrolling on any display.
const PREVIEW_ROW_LIMIT = 50;

export function previewCsv(buffer: Buffer): PreviewResult {
  const records = parseCsv(buffer);
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  // Detection reads further than the preview shows: 50 rows is what fits on a
  // screen, but a type column can easily be uniform for the first 50 rows of a
  // file that is sorted by kind.
  const sample = records.slice(0, DETECTION_SAMPLE_ROWS);
  return {
    headers,
    previewRows: records.slice(0, PREVIEW_ROW_LIMIT),
    totalRows: records.length,
    detectedTypeColumn: detectTypeColumn(sample),
    columnsWithNegatives: columnsWithSignedAmounts(sample),
  };
}

export interface ImportBatchSummary {
  id: number;
  title: string;
  uploadDate: Date;
  status: string;
}

/**
 * Every CSV import a business profile has on file, newest first.
 *
 * Feeds the Records page's "which import" filter — an owner narrowing to CSV
 * Upload needs a way to say WHICH file, not just that a record came from one.
 */
export async function listImportBatches(userId: number, businessProfileId: number): Promise<ImportBatchSummary[]> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  return prisma.cSVImportBatch.findMany({
    where: { businessProfileId },
    select: { id: true, title: true, uploadDate: true, status: true },
    orderBy: { uploadDate: "desc" },
  });
}

/**
 * Re-reads a past import's own file as a table, for the "preview" toggle on a
 * CSV-sourced record's origin panel.
 *
 * Ownership is checked via the batch's business profile rather than by
 * accepting a businessProfileId argument — the caller only has a batchId (it
 * came from a record the owner already has open), and trusting a caller-
 * supplied businessProfileId instead would let one owner's batchId be probed
 * against another's profile id.
 *
 * Returns null — never throws — when the batch doesn't exist, isn't the
 * caller's, or the file itself can no longer be fetched (already swept by
 * sourceCleanup, or a storage hiccup). Every one of those is "no preview to
 * show", identical to how the panel already treats a missing fileUrl; a 404 or
 * 500 here would take down a page that has a record perfectly capable of
 * rendering without this.
 */
export async function previewImportBatch(userId: number, batchId: number): Promise<PreviewResult | null> {
  const batch = await prisma.cSVImportBatch.findFirst({
    where: { id: batchId, businessProfile: { userId } },
    select: { fileReference: true },
  });
  if (!batch) return null;

  const buffer = await downloadCsvFile(batch.fileReference);
  if (!buffer) return null;

  try {
    return previewCsv(buffer);
  } catch {
    // A file that no longer parses (corrupted in storage, truncated) is the
    // same "nothing to show" outcome as a missing one, not a 500.
    return null;
  }
}

/**
 * Splits the parsed file into rows that can be imported and rows that can't.
 *
 * Pure — no queries, no ordering dependency on the database. Pulling it out of
 * the old insert loop is what lets the inserts be batched at all, and it keeps
 * the skip reasons (and the order they are checked in) in one readable place.
 */
interface ValidRow {
  date: string;
  description: string;
  amount: number;
  category?: string;
  vendor?: string;
}

function validateRows(
  records: Record<string, string>[],
  mapping: ColumnMapping,
  recordType: ImportRecordType,
  corrections: RowCorrections = {},
  mixedStrategy?: MixedStrategy,
) {
  const expenses: ValidRow[] = [];
  const sales: ValidRow[] = [];
  const skipped: SkippedRow[] = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i]!;
    const rowNumber = i + 2; // header is row 1, data is 1-indexed after it
    const fix = corrections[String(rowNumber)];

    // A correction stands in for the cell the file held, and is then checked
    // by exactly the same rules below — there is no path here that accepts a
    // corrected value the original format would have rejected.
    const rawDate = (fix?.date ?? row[mapping.date])?.trim();
    const rawDescription = (fix?.description ?? row[mapping.description])?.trim();
    const rawAmount = (fix?.amount ?? row[mapping.amount])?.trim();

    if (!rawDescription) {
      skipped.push({ row: rowNumber, reason: "Missing description" });
      continue;
    }

    const parsedDate = rawDate ? new Date(rawDate) : null;
    if (!rawDate || !parsedDate || Number.isNaN(parsedDate.getTime())) {
      skipped.push({ row: rowNumber, reason: `Invalid date: "${rawDate ?? ""}"` });
      continue;
    }

    /*
     * Signed amounts are only meaningful under the "sign" strategy, so the
     * sign is read first and then discarded: a negative in a file that is NOT
     * using the convention stays the invalid amount it has always been, rather
     * than quietly becoming a positive one.
     */
    const signedAmount = parseSignedAmount(rawAmount);
    const usesSign = recordType === "mixed" && mixedStrategy === "sign";
    const amountNum = usesSign && signedAmount !== null ? Math.abs(signedAmount) : signedAmount;

    if (amountNum === null || !Number.isFinite(amountNum) || amountNum <= 0) {
      skipped.push({ row: rowNumber, reason: `Invalid amount: "${rawAmount ?? ""}"` });
      continue;
    }

    // Which of the two this row is. For a single-type import that is simply
    // what the owner chose; for a mixed one it comes from the file.
    let rowType: RowRecordType;
    if (recordType !== "mixed") {
      rowType = recordType;
    } else if (mixedStrategy === "sign") {
      // signedAmount is non-null here: amountNum derives from it.
      rowType = signedAmount! < 0 ? "expense" : "sales";
    } else {
      const rawType = mapping.recordType ? row[mapping.recordType] : undefined;
      const classified = classifyTypeValue(rawType);
      if (!classified) {
        skipped.push({
          row: rowNumber,
          reason: rawType?.trim()
            ? `Could not tell if "${rawType.trim()}" means a sale or an expense`
            : "Missing sale/expense value",
        });
        continue;
      }
      rowType = classified;
    }

    const isoDate = parsedDate.toISOString().slice(0, 10);

    if (rowType === "expense") {
      const rawCategory = (fix?.category ?? (mapping.category ? row[mapping.category] : undefined))?.trim();
      /*
       * A missing category skips the row in a single-type import — the owner
       * mapped a category column and this row has a hole in it, which is worth
       * telling them about.
       *
       * In a MIXED file it falls back instead. Sales rows have no category by
       * nature, so plenty of combined exports carry no category column at all,
       * and skipping every expense in the file over a column that was never
       * going to be there would reject the exact file this feature exists to
       * accept. The rows land in "Uncategorised" and the result screen says how
       * many need sorting.
       */
      if (!rawCategory && recordType !== "mixed") {
        skipped.push({ row: rowNumber, reason: "Missing category" });
        continue;
      }
      // Checked last and never fatal — an empty vendor cell is simply no vendor.
      const rawVendor = (mapping.vendor ? row[mapping.vendor] : undefined)?.trim();
      expenses.push({
        date: isoDate,
        description: rawDescription,
        amount: amountNum,
        category: rawCategory || DEFAULT_IMPORT_CATEGORY,
        vendor: rawVendor || undefined,
      });
    } else {
      sales.push({ date: isoDate, description: rawDescription, amount: amountNum });
    }
  }

  return { expenses, sales, skipped };
}

/**
 * Resolves every category name the file mentions to an id, creating the ones
 * that don't exist yet — in two queries rather than one per unseen name.
 *
 * Names are deduplicated case-insensitively, which is what stops a file
 * containing both "Inventory" and "inventory" from silently creating two
 * categories that the owner then has to merge by hand.
 */
async function resolveCategories(businessProfileId: number, names: string[]) {
  const existing = await prisma.expenseCategory.findMany({ where: { businessProfileId } });
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));

  const missing = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!byName.has(key) && !missing.has(key)) missing.set(key, name);
  }

  if (missing.size > 0) {
    const created = await prisma.expenseCategory.createManyAndReturn({
      data: [...missing.values()].map((name) => ({ businessProfileId, name })),
    });
    for (const c of created) byName.set(c.name.toLowerCase(), c.id);
  }

  return byName;
}

export async function confirmImport(userId: number, input: ConfirmInput) {
  const profile = await requireOwnedBusinessProfile(userId, input.businessProfileId);

  const records = parseCsv(input.buffer);
  const fileReference = await uploadCsvFile(input.businessProfileId, input.buffer, input.originalname);

  const batch = await prisma.cSVImportBatch.create({
    data: {
      businessProfileId: input.businessProfileId,
      title: input.title,
      uploadDate: new Date(),
      fileReference,
      status: "Needs Review",
    },
  });

  const { expenses, sales, skipped } = validateRows(
    records,
    input.columnMapping,
    input.recordType,
    input.corrections,
    input.mixedStrategy,
  );

  // Duplicate flags and large-expense flags are counted separately: the two
  // mean different things to the owner, and the batch status has to account for
  // both. Counting only duplicates marked a batch "Completed" while its records
  // were sitting in the review queue.
  let flagged = 0;
  let largeExpenseFlagged = 0;
  let uncategorised = 0;

  /*
   * Both halves write into the SAME batch. CSVImportBatch already relates to
   * expenseRecords and salesReferenceRecords both, so a mixed file stays one
   * import in the owner's history — one row in the "which import" filter, one
   * file to re-open, one thing to undo — rather than splitting into two
   * batches that happen to share a name.
   */
  if (expenses.length > 0) {
    const categoryIds = await resolveCategories(
      input.businessProfileId,
      expenses.map((r) => r.category!),
    );
    const created = await bulkCreateExpenseRecords(userId, profile, batch.id,
      expenses.map((r) => ({
        categoryId: categoryIds.get(r.category!.toLowerCase())!,
        date: r.date,
        description: r.description,
        amount: r.amount,
        vendor: r.vendor,
      })),
    );
    flagged += created.filter((r) => r.duplicateStatus === "Flagged").length;
    largeExpenseFlagged += created.filter((r) => r.largeExpenseFlag).length;
    uncategorised = expenses.filter((r) => r.category === DEFAULT_IMPORT_CATEGORY).length;
  }

  if (sales.length > 0) {
    const created = await bulkCreateSalesRecords(userId, input.businessProfileId, batch.id, sales);
    flagged += created.filter((r) => r.duplicateStatus === "Flagged").length;
  }

  const imported = expenses.length + sales.length;

  // A large-expense flag sets the record's reviewStatus to "Needs Review", so a
  // batch containing one genuinely needs review — reporting "Completed" told
  // the owner there was nothing to look at while records sat in the queue.
  const needsReview = skipped.length > 0 || flagged > 0 || largeExpenseFlagged > 0;
  const status = needsReview ? "Needs Review" : "Completed";
  const updatedBatch = await prisma.cSVImportBatch.update({ where: { id: batch.id }, data: { status } });

  if (needsReview) {
    const parts = [`${skipped.length} row(s) skipped`, `${flagged} flagged as possible duplicates`];
    if (largeExpenseFlagged > 0) {
      parts.push(`${largeExpenseFlagged} flagged as a large expense`);
    }
    await createNotification(
      userId,
      input.businessProfileId,
      NOTIFICATION_TYPES.NEEDS_REVIEW,
      `CSV import "${input.title}": ${parts.join(", ")}`
    );
  }

  return {
    batchId: updatedBatch.id,
    title: updatedBatch.title,
    status: updatedBatch.status,
    totalRows: records.length,
    imported,
    skipped,
    flagged,
    largeExpenseFlagged,
    // Reported separately so a mixed import can say what it did with each half,
    // rather than one total that hides having filed everything one way.
    importedExpenses: expenses.length,
    importedSales: sales.length,
    uncategorised,
  };
}
