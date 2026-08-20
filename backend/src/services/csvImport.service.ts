import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { parse } from "csv-parse/sync";
import { CsvImportProcessingStatus, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { uploadCsvFile, downloadCsvFile, deleteCsvFile } from "./storage.service";
import { bulkCreateExpenseRecords } from "./expenseRecord.service";
import { bulkCreateSalesRecords } from "./salesRecord.service";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import { enqueueExpenseAnalyses, enqueueProfileRefresh } from "./anomalyDetection/job.service";
import {
  ambiguousDateExample,
  detectDateFormat,
  looksLikeDate,
  parseCsvDate,
  type CsvDateFormat,
} from "../lib/csvDates";
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

/** The date conventions a client may state explicitly. "month-name" is only
 * ever detected, never chosen — a month spelled out is not ambiguous. */
export type ConfirmDateFormat = "iso" | "dmy" | "mdy";

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
  /**
   * The date convention the file appears to use, read off the first
   * date-shaped column. When `dateFormatAmbiguous` is true, every sampled
   * date fits both day-first and month-first readings and confirm will refuse
   * the file until the owner states which — the client should ask up front.
   */
  detectedDateFormat: CsvDateFormat;
  dateFormatAmbiguous: boolean;
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
  /**
   * Client-supplied replay token. A retry with the same key returns the SAME
   * logical import at whatever stage it reached — never a second copy of the
   * records. Optional only for direct service callers (and, until Phase 4,
   * the web client — see the controller's deprecation shim); when absent a
   * random one is generated, which keeps the batch row well-formed but buys
   * that caller no replay protection.
   */
  idempotencyKey?: string;
  /** The owner's answer when the file's dates are ambiguous. */
  dateFormat?: ConfirmDateFormat;
}

export interface SkippedRow {
  row: number;
  reason: string;
}

export interface ConfirmResult {
  batchId: number;
  title: string;
  status: string;
  processingStatus: CsvImportProcessingStatus;
  totalRows: number;
  imported: number;
  skipped: SkippedRow[];
  flagged: number;
  largeExpenseFlagged: number;
  // Reported separately so a mixed import can say what it did with each half,
  // rather than one total that hides having filed everything one way.
  importedExpenses: number;
  importedSales: number;
  uncategorised: number;
  /**
   * Another COMPLETE import of this profile carried byte-identical file
   * content. A warning, never a block — re-importing a corrected export is
   * legitimate, but importing the same file twice by accident is the single
   * most common way an owner doubles a month of records.
   */
  duplicateOfBatchId?: number;
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
 * It stays a guard against a runaway or mistaken file rather than a quota.
 * Files above SYNC_ROW_LIMIT no longer run inside the request at all — they
 * go to the durable worker — so the cap now bounds the worker's chunked pass,
 * not a response time. If an owner meets this limit the answer is still to
 * split the file, and the message says so.
 */
export const MAX_IMPORT_ROWS = 30_000;

/**
 * The largest import still run inside the HTTP request.
 *
 * At the measured ~160µs a row, 2,000 rows is well under a second of insert
 * work — a wait a spinner covers honestly. Anything larger returns 202 with a
 * batch to poll, because a request that takes tens of seconds is a request a
 * gateway, a phone network or an impatient owner will kill halfway, and a
 * killed import is exactly the half-committed state this state machine exists
 * to make impossible.
 */
export const SYNC_ROW_LIMIT = 2_000;

/**
 * Rows committed per worker transaction. Small enough that one chunk's
 * transaction is short-lived (~0.2s measured), large enough that a full
 * 30,000-row file is 30 checkpoints, not 3,000 round trips.
 */
const CHUNK_SIZE = 1_000;

/** Recorded in mappingMeta so a stored batch says which parser produced it. */
export const CSV_PARSER_VERSION = "csv-import-v2";

/** Per-row skip reasons persisted on the batch. Capped so a wholly-broken
 * 30,000-row file cannot turn resultSummary into a megabyte of JSON. */
const SKIPPED_SUMMARY_CAP = 500;

// Cell caps mirror the VARCHAR widths in schema.prisma. Checked at validation
// so an over-long cell becomes a named, fixable skip — before this, it was a
// raw Postgres 22001 thrown MID-INSERT, after earlier rows had already
// committed.
const CELL_LIMITS = { description: 255, vendor: 150, category: 100 } as const;

// Decimal(12,2): ten integer digits, two fraction digits. An amount that
// doesn't round-trip through two decimals would be silently reshaped by the
// column; both cases are rejected as the row's own problem instead.
const MAX_AMOUNT_EXCLUSIVE = 1e10;

const CSV_WORKER_ID = `csv:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const SYNC_WORKER_ID = `csv-sync:${hostname()}:${process.pid}`;
const CSV_LEASE_MS = 2 * 60_000;
const CSV_MAX_ATTEMPTS = 5;

/** Carries WHICH stage failed up to the retry bookkeeping, so failureStage is
 * a diagnosis ("download", "parse") rather than a catch-all. */
class ImportStageError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportStageError";
  }
}

// ============================================================
// Parsing
// ============================================================

const CANDIDATE_DELIMITERS = [",", ";", "\t"] as const;

/**
 * Which character actually separates this file's columns.
 *
 * European spreadsheet exports use semicolons (comma is their decimal mark),
 * and some bank exports use tabs. csv-parse's default of comma-only made such
 * a file parse as ONE column — every row then skipped for a missing
 * description, with nothing telling the owner why. Counted on the header line
 * only: it is the one line guaranteed to contain every separator, and data
 * cells may legitimately contain the others ("Rice; Eggs").
 */
function detectDelimiter(buffer: Buffer): string {
  const head = buffer.toString("utf8", 0, Math.min(buffer.length, 64 * 1024)).replace(/^﻿/, "");
  const newlineAt = head.indexOf("\n");
  const headerLine = newlineAt === -1 ? head : head.slice(0, newlineAt);

  let best: string = ",";
  let bestColumns = 1;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const columns = headerLine.split(delimiter).length;
    // Strictly greater, so a tie keeps the earlier (comma-first) candidate —
    // ambiguity resolves toward the overwhelmingly common case.
    if (columns > bestColumns) {
      best = delimiter;
      bestColumns = columns;
    }
  }
  return best;
}

function parseCsv(buffer: Buffer): { records: Record<string, string>[]; delimiter: string } {
  /*
   * A NUL byte never appears in a text CSV but appears constantly in the
   * things owners upload by mistake — .xlsx files renamed to .csv, PDFs,
   * UTF-16 exports. Refused with a message that says what to do, instead of
   * letting csv-parse produce one garbage column whose every row "fails
   * validation".
   */
  if (buffer.includes(0)) {
    throw new ApiError(
      400,
      "This file is not a plain-text CSV — it contains binary data. " +
        "If it came from Excel, use File → Save As → CSV and upload that file instead.",
    );
  }

  const delimiter = detectDelimiter(buffer);
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter,
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

  return { records, delimiter };
}

// The preview is a full-height table on the mapping screen now, not the
// seven-row window it was built for, so 20 rows left most of it empty on a
// laptop. 50 is still a trivial payload (a few tens of KB) and covers a full
// screen of scrolling on any display.
const PREVIEW_ROW_LIMIT = 50;

/**
 * Finds the first date-shaped column and reads its convention.
 *
 * The preview runs BEFORE the owner maps any columns, so which column holds
 * the dates has to be inferred: a column counts when at least 80% of its
 * sampled non-empty cells are date-shaped, which tolerates the odd typo
 * without letting an amount column full of "12.05" masquerade as one (it
 * can't — the numeric date shape requires a 4-digit year).
 */
function detectDateFormatFromRecords(records: Record<string, string>[]) {
  const sample = records.slice(0, DETECTION_SAMPLE_ROWS);
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  for (const header of headers) {
    const values = sample.map((r) => (r[header] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    const dateLike = values.filter(looksLikeDate);
    if (dateLike.length >= Math.ceil(values.length * 0.8)) {
      return detectDateFormat(values);
    }
  }
  return { format: "iso" as CsvDateFormat, ambiguous: false };
}

export function previewCsv(buffer: Buffer): PreviewResult {
  const { records } = parseCsv(buffer);
  const headers = records.length > 0 ? Object.keys(records[0]!) : [];
  // Detection reads further than the preview shows: 50 rows is what fits on a
  // screen, but a type column can easily be uniform for the first 50 rows of a
  // file that is sorted by kind.
  const sample = records.slice(0, DETECTION_SAMPLE_ROWS);
  const dateDetection = detectDateFormatFromRecords(records);
  return {
    headers,
    previewRows: records.slice(0, PREVIEW_ROW_LIMIT),
    totalRows: records.length,
    detectedTypeColumn: detectTypeColumn(sample),
    columnsWithNegatives: columnsWithSignedAmounts(sample),
    detectedDateFormat: dateDetection.format,
    dateFormatAmbiguous: dateDetection.ambiguous,
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
  if (!batch?.fileReference) return null;

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
 * The machine-facing progress of one import, for the polling client behind a
 * 202. Ownership via the batch's own profile, 404 for anything that is not
 * this owner's — the same non-disclosure rule as every other lookup.
 */
export async function getImportBatchStatus(userId: number, batchId: number) {
  const batch = await prisma.cSVImportBatch.findFirst({
    where: { id: batchId, businessProfile: { userId } },
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

// ============================================================
// Validation
// ============================================================

interface ValidRow {
  date: string;
  description: string;
  amount: number;
  category?: string;
  vendor?: string;
}

/**
 * Every data row's fate, in file order.
 *
 * Ordered outcomes rather than three separate arrays because the durable
 * worker resumes by ROW ORDINAL: "the first 3,000 data rows are committed"
 * only means something if validation is deterministic and order-preserving,
 * which a pure function over the parsed rows guarantees.
 */
type RowOutcome =
  | { kind: "skip"; row: number; reason: string }
  | { kind: "expense"; row: number; data: ValidRow }
  | { kind: "sales"; row: number; data: ValidRow };

/**
 * Splits the parsed file into rows that can be imported and rows that can't.
 *
 * Pure — no queries, no ordering dependency on the database. Pulling it out of
 * the old insert loop is what lets the inserts be batched at all, and it keeps
 * the skip reasons (and the order they are checked in) in one readable place.
 */
function validateRows(
  records: Record<string, string>[],
  mapping: ColumnMapping,
  recordType: ImportRecordType,
  corrections: RowCorrections = {},
  mixedStrategy?: MixedStrategy,
  dateFormat: CsvDateFormat = "iso",
): RowOutcome[] {
  const outcomes: RowOutcome[] = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i]!;
    const rowNumber = i + 2; // header is row 1, data is 1-indexed after it
    const fix = corrections[String(rowNumber)];
    const skip = (reason: string) => outcomes.push({ kind: "skip", row: rowNumber, reason });

    // A correction stands in for the cell the file held, and is then checked
    // by exactly the same rules below — there is no path here that accepts a
    // corrected value the original format would have rejected.
    const rawDate = (fix?.date ?? row[mapping.date])?.trim();
    const rawDescription = (fix?.description ?? row[mapping.description])?.trim();
    const rawAmount = (fix?.amount ?? row[mapping.amount])?.trim();

    if (!rawDescription) {
      skip("Missing description");
      continue;
    }
    // Rejected, never truncated: a silently shortened description is a record
    // the owner can no longer match to their spreadsheet. Before this check
    // the row reached Postgres and threw a bare 22001 after earlier rows had
    // already committed.
    if (rawDescription.length > CELL_LIMITS.description) {
      skip(`Description is longer than ${CELL_LIMITS.description} characters`);
      continue;
    }

    /*
     * Parsed by the explicit calendar parser, never `new Date(rawDate)` — the
     * string constructor reads slash-dates month-first in SERVER-LOCAL time,
     * which on a UTC+8 host landed every such record one day early AND
     * swapped day with month whenever the day was ≤ 12. See lib/csvDates.ts.
     */
    const isoDate = rawDate ? parseCsvDate(rawDate, dateFormat) : null;
    if (!rawDate || !isoDate) {
      skip(`Invalid date: "${rawDate ?? ""}"`);
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
      skip(`Invalid amount: "${rawAmount ?? ""}"`);
      continue;
    }
    // Decimal(12,2) guards: a figure the column would reshape is the row's
    // problem, named per row — not a mid-insert Postgres overflow.
    if (Math.abs(amountNum) >= MAX_AMOUNT_EXCLUSIVE) {
      skip(`Amount too large: "${rawAmount}"`);
      continue;
    }
    if (Number(amountNum.toFixed(2)) !== amountNum) {
      skip(`Invalid amount: "${rawAmount}" has more than two decimal places`);
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
        skip(
          rawType?.trim()
            ? `Could not tell if "${rawType.trim()}" means a sale or an expense`
            : "Missing sale/expense value",
        );
        continue;
      }
      rowType = classified;
    }

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
        skip("Missing category");
        continue;
      }
      if (rawCategory && rawCategory.length > CELL_LIMITS.category) {
        skip(`Category name is longer than ${CELL_LIMITS.category} characters`);
        continue;
      }
      // Checked last and never fatal when EMPTY — an empty vendor cell is
      // simply no vendor. An over-long one is still a rejection, not a silent
      // truncation.
      const rawVendor = (mapping.vendor ? row[mapping.vendor] : undefined)?.trim();
      if (rawVendor && rawVendor.length > CELL_LIMITS.vendor) {
        skip(`Vendor is longer than ${CELL_LIMITS.vendor} characters`);
        continue;
      }
      outcomes.push({
        kind: "expense",
        row: rowNumber,
        data: {
          date: isoDate,
          description: rawDescription,
          amount: amountNum,
          category: rawCategory || DEFAULT_IMPORT_CATEGORY,
          vendor: rawVendor || undefined,
        },
      });
    } else {
      outcomes.push({
        kind: "sales",
        row: rowNumber,
        data: { date: isoDate, description: rawDescription, amount: amountNum },
      });
    }
  }

  return outcomes;
}

/**
 * Resolves every category name the file mentions to an id, creating the ones
 * that don't exist yet — in two queries rather than one per unseen name.
 *
 * Names are deduplicated case-insensitively, which is what stops a file
 * containing both "Inventory" and "inventory" from silently creating two
 * categories that the owner then has to merge by hand.
 *
 * RACE-SAFE, in two layers. Two concurrent imports can both miss the same new
 * name in findMany; `skipDuplicates` (backed by the
 * @@unique([businessProfileId, name]) constraint) turns the loser's insert
 * into a no-op instead of a duplicate row, the P2002 catch covers a client
 * that surfaces the conflict as an error anyway, and the re-fetch afterwards
 * picks up WHOEVER won — so the returned map is complete either way.
 *
 * Exported for the concurrency test; production callers are this module only.
 */
export async function resolveCategories(businessProfileId: number, names: string[]) {
  const existing = await prisma.expenseCategory.findMany({ where: { businessProfileId } });
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));

  const missing = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!byName.has(key) && !missing.has(key)) missing.set(key, name);
  }

  if (missing.size > 0) {
    try {
      await prisma.expenseCategory.createMany({
        data: [...missing.values()].map((name) => ({ businessProfileId, name })),
        skipDuplicates: true,
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
    const refreshed = await prisma.expenseCategory.findMany({ where: { businessProfileId } });
    for (const c of refreshed) {
      if (!byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c.id);
    }
    for (const key of missing.keys()) {
      if (!byName.has(key)) {
        // Unreachable unless the constraint or re-fetch misbehaves; better a
        // named 500 than a null categoryId reaching createMany.
        throw new ApiError(500, `Could not resolve category "${missing.get(key)}"`);
      }
    }
  }

  return byName;
}

// ============================================================
// Batch bookkeeping
// ============================================================

/** The slice of resultSummary that accumulates across chunks and survives a
 * retry — everything the response reports that is not an Int column. */
interface ProgressSummary {
  importedExpenses: number;
  importedSales: number;
  largeExpenseFlagged: number;
  uncategorised: number;
  skipped: SkippedRow[];
  skippedTruncated: boolean;
}

function emptyProgress(): ProgressSummary {
  return { importedExpenses: 0, importedSales: 0, largeExpenseFlagged: 0, uncategorised: 0, skipped: [], skippedTruncated: false };
}

function readProgress(json: Prisma.JsonValue | null): ProgressSummary {
  const base = emptyProgress();
  if (!json || typeof json !== "object" || Array.isArray(json)) return base;
  const raw = json as Record<string, unknown>;
  return {
    importedExpenses: typeof raw.importedExpenses === "number" ? raw.importedExpenses : 0,
    importedSales: typeof raw.importedSales === "number" ? raw.importedSales : 0,
    largeExpenseFlagged: typeof raw.largeExpenseFlagged === "number" ? raw.largeExpenseFlagged : 0,
    uncategorised: typeof raw.uncategorised === "number" ? raw.uncategorised : 0,
    skipped: Array.isArray(raw.skipped) ? (raw.skipped as SkippedRow[]) : [],
    skippedTruncated: raw.skippedTruncated === true,
  };
}

interface StoredMappingMeta {
  columnMapping: ColumnMapping;
  recordType: ImportRecordType;
  mixedStrategy?: MixedStrategy;
  dateFormat: CsvDateFormat;
  corrections?: RowCorrections;
}

/** Rehydrates what the worker needs from the batch's own row. Written by this
 * module at confirm time; the checks defend against a hand-edited row, not a
 * hostile one. */
function readMappingMeta(json: Prisma.JsonValue | null): StoredMappingMeta {
  const meta = (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const columnMapping = meta.columnMapping as ColumnMapping | undefined;
  if (!columnMapping?.date || !columnMapping.description || !columnMapping.amount) {
    throw new ImportStageError("validate", "Import metadata is missing its column mapping");
  }
  return {
    columnMapping,
    recordType: (meta.recordType as ImportRecordType | undefined) ?? "expense",
    mixedStrategy: (meta.mixedStrategy as MixedStrategy | null | undefined) ?? undefined,
    dateFormat: (meta.dateFormat as CsvDateFormat | undefined) ?? "iso",
    corrections: (meta.corrections as RowCorrections | null | undefined) ?? undefined,
  };
}

type ImportProfile = {
  id: number;
  expectedMonthlyExpenses: Prisma.Decimal;
  largeExpenseThresholdPercent: Prisma.Decimal;
};

/**
 * Inserts the validated rows in bounded, transactional chunks with a
 * persisted checkpoint after each — the mechanism both the sync path and the
 * durable worker share.
 *
 * RESUME CONTRACT. `processedRows` counts data-row ORDINALS whose fate
 * (inserted or skipped) has COMMITTED, and it commits in the same transaction
 * as the inserts it describes. A retry therefore starts exactly after the
 * last committed chunk: it can neither re-insert rows that landed (the
 * checkpoint says they did) nor lose rows that didn't (the rollback took the
 * checkpoint with them). This only holds because validateRows is pure and
 * order-preserving over the same stored file and stored mappingMeta.
 */
async function runImportChunks(args: {
  batchId: number;
  userId: number;
  profile: ImportProfile;
  outcomes: RowOutcome[];
  startAtRow: number;
  seed: { imported: number; skippedCount: number; flagged: number; progress: ProgressSummary };
}): Promise<void> {
  const { batchId, userId, profile, outcomes, startAtRow, seed } = args;
  let imported = seed.imported;
  let skippedCount = seed.skippedCount;
  let flagged = seed.flagged;
  const progress = seed.progress;

  for (let at = startAtRow; at < outcomes.length; at += CHUNK_SIZE) {
    const chunk = outcomes.slice(at, at + CHUNK_SIZE);
    const expenseRows = chunk.filter((o): o is Extract<RowOutcome, { kind: "expense" }> => o.kind === "expense");
    const salesRows = chunk.filter((o): o is Extract<RowOutcome, { kind: "sales" }> => o.kind === "sales");
    const skips = chunk.filter((o): o is Extract<RowOutcome, { kind: "skip" }> => o.kind === "skip");

    // Outside the transaction on purpose: category creation is idempotent
    // (skipDuplicates + unique constraint), so a rolled-back chunk leaving a
    // created category behind is harmless — and keeping it out keeps the
    // transaction to exactly the writes the checkpoint vouches for.
    const categoryIds =
      expenseRows.length > 0
        ? await resolveCategories(profile.id, expenseRows.map((o) => o.data.category!))
        : new Map<string, number>();

    const createdExpenseIds: number[] = [];

    await prisma.$transaction(
      async (tx) => {
        let chunkFlagged = 0;
        let chunkLarge = 0;

        if (expenseRows.length > 0) {
          const created = await bulkCreateExpenseRecords(
            userId,
            profile,
            batchId,
            expenseRows.map((o) => ({
              categoryId: categoryIds.get(o.data.category!.toLowerCase())!,
              date: o.data.date,
              description: o.data.description,
              amount: o.data.amount,
              vendor: o.data.vendor,
            })),
            tx,
          );
          chunkFlagged += created.filter((r) => r.duplicateStatus === "Flagged").length;
          chunkLarge += created.filter((r) => r.largeExpenseFlag).length;
          createdExpenseIds.push(...created.map((r) => r.id));
        }

        if (salesRows.length > 0) {
          const created = await bulkCreateSalesRecords(
            userId,
            profile.id,
            batchId,
            salesRows.map((o) => o.data),
            tx,
          );
          chunkFlagged += created.filter((r) => r.duplicateStatus === "Flagged").length;
        }

        imported += expenseRows.length + salesRows.length;
        skippedCount += skips.length;
        flagged += chunkFlagged;
        progress.importedExpenses += expenseRows.length;
        progress.importedSales += salesRows.length;
        progress.largeExpenseFlagged += chunkLarge;
        progress.uncategorised += expenseRows.filter((o) => o.data.category === DEFAULT_IMPORT_CATEGORY).length;
        for (const s of skips) {
          if (progress.skipped.length < SKIPPED_SUMMARY_CAP) progress.skipped.push({ row: s.row, reason: s.reason });
          else progress.skippedTruncated = true;
        }

        // Absolute figures rather than increments: this statement may be
        // retried by a reclaimed lease, and "set to what has committed" is
        // idempotent where "add what I think I did" is not.
        await tx.cSVImportBatch.update({
          where: { id: batchId },
          data: {
            processedRows: at + chunk.length,
            importedRows: imported,
            skippedRows: skippedCount,
            flaggedRows: flagged,
            heartbeatAt: new Date(),
            resultSummary: progress as unknown as Prisma.InputJsonObject,
          },
        });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    // After COMMIT, because the jobs reference the records by FK. A crash in
    // this gap loses only the enqueue, and the hourly reconcile in
    // enqueueDailyProfileAnalyses re-creates jobs for records that have none.
    if (createdExpenseIds.length > 0) {
      await enqueueExpenseAnalyses(profile.id, createdExpenseIds).catch((error) => {
        logger.error({ err: error, batchId }, "failed to enqueue imported expense analysis");
      });
    }
  }
}

/**
 * The terminal happy transition: PROCESSING → COMPLETE, plus everything the
 * old code did after its inserts — the owner-facing status, the one summary
 * notification, and the coalesced profile-refresh analysis job.
 */
async function completeBatch(batchId: number, userId: number, businessProfileId: number) {
  const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batchId } });
  const progress = readProgress(batch.resultSummary);

  // A large-expense flag sets the record's reviewStatus to "Needs Review", so a
  // batch containing one genuinely needs review — reporting "Completed" told
  // the owner there was nothing to look at while records sat in the queue.
  const needsReview = batch.skippedRows > 0 || batch.flaggedRows > 0 || progress.largeExpenseFlagged > 0;
  const status = needsReview ? "Needs Review" : "Completed";

  const updated = await prisma.cSVImportBatch.update({
    where: { id: batchId },
    data: {
      status,
      processingStatus: CsvImportProcessingStatus.COMPLETE,
      completedAt: new Date(),
      workerId: null,
      failureStage: null,
      lastError: null,
    },
  });

  if (needsReview) {
    const parts = [`${batch.skippedRows} row(s) skipped`, `${batch.flaggedRows} flagged as possible duplicates`];
    if (progress.largeExpenseFlagged > 0) {
      parts.push(`${progress.largeExpenseFlagged} flagged as a large expense`);
    }
    await createNotification(
      userId,
      businessProfileId,
      NOTIFICATION_TYPES.NEEDS_REVIEW,
      `CSV import "${batch.title}": ${parts.join(", ")}`,
    );
  }

  // One refresh per profile per day no matter how many imports land — the
  // per-record TRANSACTION jobs are already enqueued per chunk.
  await enqueueProfileRefresh(businessProfileId).catch((error) => {
    logger.error({ err: error, batchId }, "failed to enqueue profile refresh after import");
  });

  return updated;
}

/**
 * Terminal failure: mark FAILED with the stage that broke, and compensate the
 * storage upload. The delete is best-effort — an orphaned object is a cost, a
 * throw here would mask the error that actually mattered.
 */
async function failBatch(batchId: number, stage: string, error: unknown): Promise<void> {
  const batch = await prisma.cSVImportBatch.findUnique({
    where: { id: batchId },
    select: { fileReference: true },
  });
  let fileReference = batch?.fileReference ?? null;
  if (fileReference) {
    const gone = await deleteCsvFile(fileReference).catch(() => false);
    if (gone) fileReference = null;
  }
  await prisma.cSVImportBatch.update({
    where: { id: batchId },
    data: {
      processingStatus: CsvImportProcessingStatus.FAILED,
      failureStage: stage,
      lastError: String(error).slice(0, 1000),
      workerId: null,
      fileReference,
    },
  });
}

/** Retryable failure: back off and hand the batch to the worker; terminal
 * once the attempt budget is spent. Mirrors the analysis worker's schedule. */
async function deferBatch(batchId: number, stage: string, error: unknown, attemptCount: number): Promise<void> {
  if (attemptCount >= CSV_MAX_ATTEMPTS) {
    await failBatch(batchId, stage, error);
    return;
  }
  const delayMinutes = Math.min(2 ** attemptCount, 60);
  await prisma.cSVImportBatch.update({
    where: { id: batchId },
    data: {
      processingStatus: CsvImportProcessingStatus.PENDING,
      failureStage: stage,
      lastError: String(error).slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
      workerId: null,
    },
  });
}

/** The response a replayed idempotency key gets: the SAME logical import at
 * whatever stage it reached, rebuilt from the batch's own persisted counts. */
function replayResponse(
  batch: {
    id: number;
    title: string;
    status: string;
    processingStatus: CsvImportProcessingStatus;
    totalRows: number | null;
    importedRows: number;
    flaggedRows: number;
    resultSummary: Prisma.JsonValue | null;
  },
  duplicateOfBatchId?: number,
): ConfirmResult {
  const progress = readProgress(batch.resultSummary);
  return {
    batchId: batch.id,
    title: batch.title,
    status: batch.status,
    processingStatus: batch.processingStatus,
    totalRows: batch.totalRows ?? 0,
    imported: batch.importedRows,
    skipped: progress.skipped,
    flagged: batch.flaggedRows,
    largeExpenseFlagged: progress.largeExpenseFlagged,
    importedExpenses: progress.importedExpenses,
    importedSales: progress.importedSales,
    uncategorised: progress.uncategorised,
    ...(duplicateOfBatchId !== undefined ? { duplicateOfBatchId } : {}),
  };
}

// ============================================================
// Confirm
// ============================================================

export async function confirmImport(userId: number, input: ConfirmInput): Promise<ConfirmResult> {
  const profile = await requireOwnedBusinessProfile(userId, input.businessProfileId);

  // Direct service callers (tests, scripts) may omit the key; they get a
  // fresh import each call, exactly the pre-idempotency behaviour. The HTTP
  // layer always sends one — its own or the deprecation shim's.
  const idempotencyKey = input.idempotencyKey ?? `service-${randomUUID()}`;

  /*
   * REPLAY CHECK FIRST — before parsing, before storage, before anything that
   * costs. A retried confirm (timeout, refresh, double-click) must observe
   * the import it already started, never start a second one.
   */
  const existing = await prisma.cSVImportBatch.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.businessProfileId !== input.businessProfileId) {
      // A key is scoped to the import it named. Reusing it against a
      // different profile is a client bug (or a probe); replaying the other
      // profile's counts here would leak them.
      throw new ApiError(409, "This idempotency key was already used by a different import");
    }
    return replayResponse(existing);
  }

  const fileHash = createHash("sha256").update(input.buffer).digest("hex");
  const { records, delimiter } = parseCsv(input.buffer);

  if (records.length === 0) {
    throw new ApiError(
      400,
      "This file has no data rows to import — only a header (or nothing at all). Check that the export included the rows.",
    );
  }

  /*
   * The date convention is settled BEFORE any row is judged. If the owner
   * stated one it wins; otherwise the file must be unambiguous on its own,
   * because importing "05/01/2026" on a guess files the record four months
   * away and reports success.
   */
  const rawDateSamples = records.map((r) => (r[input.columnMapping.date] ?? "").trim()).filter(Boolean);
  let dateFormat: CsvDateFormat;
  if (input.dateFormat) {
    dateFormat = input.dateFormat;
  } else {
    const detection = detectDateFormat(rawDateSamples);
    if (detection.ambiguous) {
      const example = ambiguousDateExample(rawDateSamples);
      throw new ApiError(
        422,
        example
          ? `The dates in this file are ambiguous: "${example.raw}" could mean ${example.dmyIso} (day first) or ` +
              `${example.mdyIso} (month first). Re-submit with dateFormat set to "dmy" or "mdy".`
          : `The dates in this file mix day-first and month-first conventions. Re-submit with dateFormat set to "dmy" or "mdy".`,
      );
    }
    dateFormat = detection.format;
  }

  // Same bytes already imported? Surfaced, not blocked — see ConfirmResult.
  const duplicateOf = await prisma.cSVImportBatch.findFirst({
    where: {
      businessProfileId: input.businessProfileId,
      fileHash,
      processingStatus: CsvImportProcessingStatus.COMPLETE,
    },
    orderBy: { id: "desc" },
    select: { id: true },
  });

  const isAsync = records.length > SYNC_ROW_LIMIT;

  /*
   * Everything the durable worker needs to redo this import from the stored
   * file alone — the request body does not survive the request, so the batch
   * row has to.
   */
  const mappingMeta = {
    parserVersion: CSV_PARSER_VERSION,
    columnMapping: input.columnMapping,
    recordType: input.recordType,
    mixedStrategy: input.mixedStrategy ?? null,
    dateFormat,
    delimiter,
    corrections: input.corrections ?? null,
  };

  /*
   * BATCH ROW BEFORE STORAGE UPLOAD — the reverse of the old order, which
   * uploaded first and could orphan an object nothing referenced if the
   * insert then failed. A row without its object is recoverable (the worker
   * retries, the sweep eventually fails it); an object without its row is
   * invisible forever.
   *
   * Both paths start life leased: the request itself holds the lease while it
   * uploads (and, on the sync path, inserts), so a worker tick cannot claim a
   * batch whose file is still in flight. The async path releases the lease —
   * flips to PENDING — only once the file is safely in storage.
   */
  let batch;
  try {
    batch = await prisma.cSVImportBatch.create({
      data: {
        businessProfileId: input.businessProfileId,
        title: input.title,
        uploadDate: new Date(),
        status: "Needs Review",
        processingStatus: CsvImportProcessingStatus.PROCESSING,
        idempotencyKey,
        fileHash,
        fileSizeBytes: input.buffer.length,
        totalRows: records.length,
        mappingMeta: mappingMeta as unknown as Prisma.InputJsonObject,
        attemptCount: isAsync ? 0 : 1,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        workerId: SYNC_WORKER_ID,
      },
    });
  } catch (error) {
    // Two concurrent confirms with the same key: exactly one insert wins the
    // unique constraint; the loser replays the winner's import.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.cSVImportBatch.findUnique({ where: { idempotencyKey } });
      if (winner && winner.businessProfileId === input.businessProfileId) {
        return replayResponse(winner, duplicateOf?.id);
      }
    }
    throw error;
  }

  try {
    const fileReference = await uploadCsvFile(input.businessProfileId, input.buffer, input.originalname);
    await prisma.cSVImportBatch.update({ where: { id: batch.id }, data: { fileReference } });
  } catch (error) {
    // Terminal, not retryable: the bytes lived only in this request, so
    // there is nothing for a later attempt to download.
    await failBatch(batch.id, "upload", error);
    throw error;
  }

  if (isAsync) {
    // Release the request's lease; the worker owns it from here.
    await prisma.cSVImportBatch.update({
      where: { id: batch.id },
      data: { processingStatus: CsvImportProcessingStatus.PENDING, workerId: null, nextAttemptAt: new Date() },
    });
    return {
      batchId: batch.id,
      title: batch.title,
      status: batch.status,
      processingStatus: CsvImportProcessingStatus.PENDING,
      totalRows: records.length,
      imported: 0,
      skipped: [],
      flagged: 0,
      largeExpenseFlagged: 0,
      importedExpenses: 0,
      importedSales: 0,
      uncategorised: 0,
      ...(duplicateOf ? { duplicateOfBatchId: duplicateOf.id } : {}),
    };
  }

  // ---- Synchronous path: same stage functions, inside the request ----
  const outcomes = validateRows(
    records,
    input.columnMapping,
    input.recordType,
    input.corrections,
    input.mixedStrategy,
    dateFormat,
  );

  try {
    await runImportChunks({
      batchId: batch.id,
      userId,
      profile,
      outcomes,
      startAtRow: 0,
      seed: { imported: 0, skippedCount: 0, flagged: 0, progress: emptyProgress() },
    });
  } catch (error) {
    /*
     * NOT terminal: the file is in storage and the checkpoint says exactly
     * how far the committed chunks got, so the durable worker can finish what
     * the request could not. The owner sees an error now and a completed
     * import shortly — never a silent half-import.
     */
    await deferBatch(batch.id, "insert", error, 1);
    throw error;
  }

  const completed = await completeBatch(batch.id, userId, input.businessProfileId);
  const progress = readProgress(completed.resultSummary);

  return {
    batchId: completed.id,
    title: completed.title,
    status: completed.status,
    processingStatus: completed.processingStatus,
    totalRows: records.length,
    imported: completed.importedRows,
    // The full list, not the persisted (capped) copy — the sync path still
    // has every outcome in memory and small files are what it serves.
    skipped: outcomes.filter((o): o is Extract<RowOutcome, { kind: "skip" }> => o.kind === "skip")
      .map((o) => ({ row: o.row, reason: o.reason })),
    flagged: completed.flaggedRows,
    largeExpenseFlagged: progress.largeExpenseFlagged,
    importedExpenses: progress.importedExpenses,
    importedSales: progress.importedSales,
    uncategorised: progress.uncategorised,
    ...(duplicateOf ? { duplicateOfBatchId: duplicateOf.id } : {}),
  };
}

// ============================================================
// Durable worker
// ============================================================

/**
 * Atomically lease one eligible batch — the same findFirst + conditional
 * updateMany race guard receiptScan.service uses. Eligible means "PENDING and
 * due" or "PROCESSING with a dead heartbeat" (a crashed request or worker).
 */
async function claimImportBatch() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CSV_LEASE_MS);
  const eligible: Prisma.CSVImportBatchWhereInput = {
    OR: [
      { processingStatus: CsvImportProcessingStatus.PENDING, nextAttemptAt: { lte: now } },
      {
        processingStatus: CsvImportProcessingStatus.PROCESSING,
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      },
    ],
  };
  const candidate = await prisma.cSVImportBatch.findFirst({
    where: eligible,
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!candidate) return null;
  const claimed = await prisma.cSVImportBatch.updateMany({
    where: { id: candidate.id, ...eligible },
    data: {
      processingStatus: CsvImportProcessingStatus.PROCESSING,
      workerId: CSV_WORKER_ID,
      heartbeatAt: now,
      startedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;
  // Re-read AFTER the claim so attemptCount and the checkpoint reflect it.
  return prisma.cSVImportBatch.findUnique({ where: { id: candidate.id } });
}

type ClaimedBatch = NonNullable<Awaited<ReturnType<typeof claimImportBatch>>>;

async function processClaimedBatch(batch: ClaimedBatch): Promise<void> {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: batch.businessProfileId },
    select: { id: true, userId: true, expectedMonthlyExpenses: true, largeExpenseThresholdPercent: true },
  });
  if (!profile) {
    // Cascade deletes normally take the batch with the profile; this is the
    // window where they raced.
    throw new ImportStageError("validate", "Business profile no longer exists");
  }
  if (!batch.fileReference) {
    throw new ImportStageError("download", "No stored file to import — the upload never completed");
  }
  const buffer = await downloadCsvFile(batch.fileReference);
  if (!buffer) {
    throw new ImportStageError("download", `Could not download "${batch.fileReference}" from storage`);
  }

  const meta = readMappingMeta(batch.mappingMeta);

  let records: Record<string, string>[];
  try {
    ({ records } = parseCsv(buffer));
  } catch (error) {
    throw new ImportStageError("parse", String(error));
  }

  let outcomes: RowOutcome[];
  try {
    outcomes = validateRows(records, meta.columnMapping, meta.recordType, meta.corrections, meta.mixedStrategy, meta.dateFormat);
  } catch (error) {
    throw new ImportStageError("validate", String(error));
  }

  await runImportChunks({
    batchId: batch.id,
    userId: profile.userId,
    profile,
    outcomes,
    startAtRow: batch.processedRows,
    seed: {
      imported: batch.importedRows,
      skippedCount: batch.skippedRows,
      flagged: batch.flaggedRows,
      progress: readProgress(batch.resultSummary),
    },
  });

  await completeBatch(batch.id, profile.userId, batch.businessProfileId);
}

/** Runs at most one durable import attempt; the server scheduler calls this
 * repeatedly, beside the receipt and analysis workers. */
export async function runCsvImportWorkerOnce(): Promise<boolean> {
  const batch = await claimImportBatch();
  if (!batch) return false;
  try {
    await processClaimedBatch(batch);
  } catch (error) {
    const stage = error instanceof ImportStageError ? error.stage : "insert";
    logger.error({ err: error, batchId: batch.id, stage }, "csv import attempt failed");
    await deferBatch(batch.id, stage, error, batch.attemptCount);
  }
  return true;
}

/**
 * Orphan sweep: any batch still PENDING/PROCESSING a full day after it was
 * created, with its attempt budget spent, is dead — a process crashed between
 * the last increment and its bookkeeping. Marked FAILED so the owner's
 * history stops saying "importing…" about a file from yesterday, and so the
 * unique idempotency key stops pinning a zombie.
 */
export async function sweepStalledCsvImports(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  const { count } = await prisma.cSVImportBatch.updateMany({
    where: {
      processingStatus: { in: [CsvImportProcessingStatus.PENDING, CsvImportProcessingStatus.PROCESSING] },
      createdAt: { lt: cutoff },
      attemptCount: { gte: CSV_MAX_ATTEMPTS },
    },
    data: {
      processingStatus: CsvImportProcessingStatus.FAILED,
      failureStage: "stalled",
      lastError: "Import did not finish within 24 hours and its retries were exhausted",
      workerId: null,
    },
  });
  if (count > 0) logger.warn({ count }, "swept stalled csv imports to FAILED");
  return count;
}
