import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { parse } from "csv-parse/sync";
import { AccountStatus, CsvImportProcessingStatus, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import {
  csvFileReference,
  uploadCsvFileAtReference,
  downloadCsvFile,
  deleteCsvFile,
} from "./storage.service";
import { bulkCreateExpenseRecords, duplicateKeyOf } from "./expenseRecord.service";
import { bulkCreateSalesRecords } from "./salesRecord.service";
import { createNotification, NOTIFICATION_TYPES } from "./notification.service";
import { enqueueExpenseAnalyses, enqueueProfileRefresh } from "./anomalyDetection/job.service";
import {
  enqueueCsvSourcePurgesIfOrphaned,
  enqueueDetachedCsvSourcePurge,
  enqueueCsvSourcePurgeForTerminalBatch,
} from "./csvSourcePurge.service";
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
import { categoryFromHistory, loadConfirmedCategoryHistory } from "../lib/categoryHistory";
import { expenseDuplicateKeysOf } from "../lib/expenseDuplicateIdentity";

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
  suggestedMapping: Partial<ColumnMapping>;
  categorySuggestions?: { row: number; categoryId: number; categoryName: string; source: "history" }[];
  categorySuggestionsTruncated?: boolean;
  /** Full-file validation; the error list is bounded to keep previews small. */
  validation?: {
    validRows: number;
    invalidRows: number;
    skipped: SkippedRow[];
    skippedTruncated: boolean;
    possibleDuplicateRows: number;
    duplicateRows: number[];
    duplicateRowsTruncated: boolean;
  };
}

export interface StagedPreviewResult extends PreviewResult {
  stagedUploadId: string;
  stageExpiresAt: string;
}

export interface CsvOperationTimings {
  totalMs: number;
  parseMs?: number;
  storageMs?: number;
  validationMs?: number;
  chunkEncodeMs?: number;
  chunkPersistMs?: number;
  chunkLoadMs?: number;
  decompressMs?: number;
  insertMs?: number;
}

export interface TimedCsvResult<T> {
  result: T;
  timings: CsvOperationTimings;
}

export interface PreviewOptions {
  recordType: ImportRecordType;
  columnMapping: ColumnMapping;
  mixedStrategy?: MixedStrategy;
  corrections?: RowCorrections;
  dateFormat?: ConfirmDateFormat;
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

export type StagedConfirmInput = Omit<ConfirmInput, "businessProfileId" | "buffer" | "originalname" | "idempotencyKey">;

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
  /** Total skips, including rows omitted from the bounded details list. */
  skippedCount: number;
  skippedTruncated: boolean;
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

const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60_000;
export const STAGING_UPLOAD_LEASE_MS = 2 * 60_000;
const STAGE_CHUNK_ROWS = 1_000;
const STAGE_CHUNK_ENCODING = "header-matrix-json-gzip-v1";
const STAGE_TOTAL_MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const STAGE_CHUNK_MAX_INFLATED_BYTES = STAGE_TOTAL_MAX_INFLATED_BYTES;
const MAX_CSV_COLUMNS = 256;
const MAX_CSV_HEADER_LENGTH = 255;
const MAX_CSV_RECORD_SIZE = 256 * 1024;
const MAX_CSV_TOTAL_CELLS = 1_000_000;
const MAX_CSV_ESTIMATED_PARSED_BYTES = 32 * 1024 * 1024;
const ESTIMATED_CELL_OVERHEAD_BYTES = 32;
export const CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS = 5 * 60_000;
export const CSV_STAGE_OUTSTANDING_LIMIT = 5;
export const CSV_STAGE_OUTSTANDING_BYTES_LIMIT = 25 * 1024 * 1024;
export const CSV_STAGE_CREATION_HOURLY_LIMIT = 60;
const CSV_STAGE_CREATION_WINDOW_MS = 60 * 60_000;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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
const STAGE_WORKER_ID = `csv-stage:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const CSV_LEASE_MS = 2 * 60_000;
const CSV_MAX_ATTEMPTS = 5;

function stageCreationRateKey(userId: number): string {
  return `csv-stage-create:u${userId}:${randomUUID()}`;
}

async function assertCsvOutstandingCapacity(
  tx: Prisma.TransactionClient,
  userId: number,
  additionalBytes: number,
): Promise<void> {
  const outstanding = await tx.cSVImportBatch.aggregate({
    where: {
      processingStatus: {
        in: [
          CsvImportProcessingStatus.STAGING,
          CsvImportProcessingStatus.STAGED,
          CsvImportProcessingStatus.PENDING,
          CsvImportProcessingStatus.PROCESSING,
        ],
      },
      businessProfile: { userId },
    },
    _count: { _all: true },
    _sum: { fileSizeBytes: true },
  });
  if (outstanding._count._all >= CSV_STAGE_OUTSTANDING_LIMIT) {
    throw new ApiError(
      429,
      `You can keep up to ${CSV_STAGE_OUTSTANDING_LIMIT} CSV imports in progress. Finish or remove one and try again.`,
      { code: "CSV_STAGE_OUTSTANDING_LIMIT" },
    );
  }
  const outstandingBytes = outstanding._sum.fileSizeBytes ?? 0;
  if (outstandingBytes + additionalBytes > CSV_STAGE_OUTSTANDING_BYTES_LIMIT) {
    throw new ApiError(
      413,
      "Your in-progress CSV imports have reached the temporary storage limit. Finish or remove one and try again.",
      { code: "CSV_STAGE_STORAGE_LIMIT" },
    );
  }
}

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

/** Raised when a checkpoint or heartbeat finds the batch is no longer leased
 * by this attempt. The attempt must stop touching the row: another worker owns
 * it, and even a failure written from here would overwrite that worker's
 * state. Same discipline as ReceiptLeaseLostError in receiptScan/worker.ts. */
class CsvLeaseLostError extends Error {
  constructor(batchId: number) {
    super(`CSV import batch ${batchId} lease was reclaimed`);
    this.name = "CsvLeaseLostError";
  }
}

function stableCsvFailureCode(stage: string, error: unknown): string {
  if (error instanceof ApiError && error.code) return error.code;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  if (error instanceof ImportStageError) return `CSV_${error.stage.toUpperCase()}_FAILED`;
  const kind = error instanceof Error ? error.name : "UnknownError";
  return `CSV_${stage.toUpperCase()}_FAILED_${kind}`.replace(/[^A-Z0-9_]/g, "_").slice(0, 100);
}

function safeCsvFailureSummary(stage: string, error: unknown): string {
  return `CSV import failed during ${stage} (${stableCsvFailureCode(stage, error)})`.slice(0, 500);
}

interface ImportLease {
  workerId: string;
  attemptCount: number;
}

/**
 * Prove this attempt still owns the batch and push the heartbeat forward.
 *
 * Called between the worker's long phases (download, parse, validate), none of
 * which writes anything: a 10 MB file off degraded Storage can outlast
 * CSV_LEASE_MS before the first chunk checkpoint, and a healthy long download
 * then reads as an abandoned lease to the next worker tick.
 */
/**
 * The predicate every write by this attempt carries.
 *
 * `a2fff99` fixed the path that mattered — a reclaimed lease no longer
 * replays chunks from row 0 — but the TERMINAL transitions still wrote by id
 * alone. An attempt that has lost the row can still reach them (the loss is
 * only detected on the next guarded write), and each of them rewrites status,
 * workerId and nextAttemptAt: complete would mark the new owner's in-flight
 * attempt COMPLETE and send the owner a summary notification built from stale
 * counts; defer would reset it to PENDING mid-chunk. Unreachable today is not
 * the same as guarded.
 */
function ownedByAttempt(batchId: number, lease: ImportLease) {
  return {
    id: batchId,
    processingStatus: CsvImportProcessingStatus.PROCESSING,
    workerId: lease.workerId,
    attemptCount: lease.attemptCount,
  };
}

async function heartbeatImportBatch(batchId: number, lease: ImportLease): Promise<void> {
  const beat = await prisma.cSVImportBatch.updateMany({
    where: {
      id: batchId,
      processingStatus: CsvImportProcessingStatus.PROCESSING,
      workerId: lease.workerId,
      attemptCount: lease.attemptCount,
    },
    data: { heartbeatAt: new Date() },
  });
  if (beat.count !== 1) throw new CsvLeaseLostError(batchId);
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

interface ParsedCsv {
  records: Record<string, string>[];
  delimiter: string;
  headers: string[];
}

function parseCsv(buffer: Buffer): ParsedCsv {
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
  let headers: string[] = [];
  let records: Record<string, string>[];
  let parsedRows = 0;
  let parsedCells = 0;
  let estimatedParsedBytes = 0;
  try {
    records = parse(buffer, {
      columns: (columns: string[]) => {
        if (columns.length > MAX_CSV_COLUMNS) {
          throw new ApiError(400, `CSV files can have at most ${MAX_CSV_COLUMNS} columns.`, {
            code: "CSV_HEADER_LIMIT_EXCEEDED",
          });
        }
        if (columns.some((header) => header.length > MAX_CSV_HEADER_LENGTH)) {
          throw new ApiError(400, `CSV column headers must be ${MAX_CSV_HEADER_LENGTH} characters or fewer.`, {
            code: "CSV_HEADER_LIMIT_EXCEEDED",
          });
        }
        if (columns.some((header) => !header.trim())) {
          throw new ApiError(400, "Every CSV column needs a header. Name the empty columns and try again.");
        }
        if (new Set(columns.map((header) => header.toLowerCase())).size !== columns.length) {
          throw new ApiError(400, "CSV column headers must be unique. Rename repeated columns and try again.");
        }
        headers = columns;
        return columns;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter,
      max_record_size: MAX_CSV_RECORD_SIZE,
      on_record: (record: Record<string, string>) => {
        parsedRows += 1;
        if (parsedRows > MAX_IMPORT_ROWS) {
          throw new ApiError(
            400,
            `This file has at least ${parsedRows.toLocaleString()} rows and the limit is ` +
              `${MAX_IMPORT_ROWS.toLocaleString()}. ` +
              "Split it into smaller files — by month or by year — and import them one at a time.",
            { code: "CSV_ROW_LIMIT_EXCEEDED" },
          );
        }
        const values = Object.values(record);
        parsedCells += values.length;
        for (const value of values) {
          estimatedParsedBytes += Buffer.byteLength(value, "utf8") + ESTIMATED_CELL_OVERHEAD_BYTES;
        }
        if (
          parsedCells > MAX_CSV_TOTAL_CELLS ||
          estimatedParsedBytes > MAX_CSV_ESTIMATED_PARSED_BYTES
        ) {
          throw new ApiError(413, "This CSV is too large or complex to process safely. Split it into smaller files.", {
            code: "CSV_PARSE_LIMIT_EXCEEDED",
          });
        }
        return record;
      },
    }) as Record<string, string>[];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: unknown }).code === "CSV_MAX_RECORD_SIZE"
    ) {
      throw new ApiError(413, "A CSV row is too large to process safely. Split the file and try again.", {
        code: "CSV_PARSE_LIMIT_EXCEEDED",
      });
    }
    // Parser errors can contain raw financial cells. Neither log nor return them.
    throw new ApiError(400, "This CSV could not be read. Check its quotes and column counts, then try again.");
  }

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

  return { records, delimiter, headers };
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

const HEADER_SYNONYMS: Record<Exclude<keyof ColumnMapping, "recordType">, string[]> = {
  date: ["date", "txn date", "transaction date", "trans date", "posted", "day", "petsa"],
  description: ["description", "item", "particulars", "details", "detail", "memo", "notes", "note"],
  amount: ["amount", "total", "price", "cost", "value", "debit", "halaga", "cash out"],
  category: ["category", "type", "class", "account", "group", "uri"],
  vendor: ["vendor", "supplier", "store", "shop", "merchant", "payee", "seller", "from", "tindahan"],
};

function suggestMapping(headers: string[], typeColumn: string | null): Partial<ColumnMapping> {
  const suggested: Partial<ColumnMapping> = {};
  const normalise = (header: string) => header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  for (const field of Object.keys(HEADER_SYNONYMS) as (keyof typeof HEADER_SYNONYMS)[]) {
    const candidates = field === "category" ? headers.filter((header) => header !== typeColumn) : headers;
    const synonyms = HEADER_SYNONYMS[field];
    const match = candidates.find((header) => synonyms.includes(normalise(header)))
      ?? candidates.find((header) => synonyms.some((synonym) => normalise(header).includes(synonym)));
    if (match) suggested[field] = match;
  }
  if (typeColumn) suggested.recordType = typeColumn;
  return suggested;
}

function validateMapping(headers: string[], options: PreviewOptions): void {
  for (const header of Object.values(options.columnMapping)) {
    if (header && !headers.includes(header)) {
      throw new ApiError(400, "A mapped column is missing from this CSV. Check the column mapping and try again.");
    }
  }
  if (options.recordType === "mixed" && !options.mixedStrategy) {
    throw new ApiError(400, "Choose how this file identifies sales and expenses.");
  }
  if (options.recordType === "mixed" && options.mixedStrategy === "column" && !options.columnMapping.recordType) {
    throw new ApiError(400, "Choose the column that identifies sales and expenses.");
  }
}

function summarisePreviewDuplicates(outcomes: RowOutcome[], existingKeys: Set<string> = new Set()) {
  const seen = new Set(existingKeys);
  const duplicateRows: number[] = [];
  let possibleDuplicateRows = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "skip") continue;
    const keys = outcome.kind === "expense"
      ? expenseDuplicateKeysOf({
          date: outcome.data.date,
          amount: outcome.data.amount,
          description: outcome.data.description,
          vendor: outcome.data.vendor,
        }).map((key) => `expense:${key}`)
      : [`sales:${duplicateKeyOf(new Date(outcome.data.date), outcome.data.amount, outcome.data.description)}`];
    if (keys.some((key) => seen.has(key))) {
      possibleDuplicateRows += 1;
      if (duplicateRows.length < 100) duplicateRows.push(outcome.row);
    }
    for (const key of keys) seen.add(key);
  }
  return { possibleDuplicateRows, duplicateRows, duplicateRowsTruncated: possibleDuplicateRows > duplicateRows.length };
}

function prepareParsedCsvPreview(
  parsed: ParsedCsv,
  options?: PreviewOptions,
): { result: PreviewResult; outcomes: RowOutcome[]; records: Record<string, string>[] } {
  const { records, headers } = parsed;
  if (options && records.length > 0) validateMapping(headers, options);
  // Detection reads further than the preview shows: 50 rows is what fits on a
  // screen, but a type column can easily be uniform for the first 50 rows of a
  // file that is sorted by kind.
  const sample = records.slice(0, DETECTION_SAMPLE_ROWS);
  const dateDetection = options
    ? detectDateFormat(records.map((record, index) => options.corrections?.[String(index + 2)]?.date ?? record[options.columnMapping.date] ?? "").filter(Boolean))
    : detectDateFormatFromRecords(records);
  const typeColumn = detectTypeColumn(sample);
  const dateFormat = options?.dateFormat ?? dateDetection.format;
  let validation: PreviewResult["validation"];
  let outcomes: RowOutcome[] = [];
  if (options && (options.dateFormat || !dateDetection.ambiguous)) {
    outcomes = validateRows(records, options.columnMapping, options.recordType, options.corrections, options.mixedStrategy, dateFormat);
    const skipped = outcomes.filter((row): row is Extract<RowOutcome, { kind: "skip" }> => row.kind === "skip");
    validation = {
      validRows: outcomes.length - skipped.length,
      invalidRows: skipped.length,
      skipped: skipped.slice(0, 100).map(({ row, reason }) => ({ row, reason })),
      skippedTruncated: skipped.length > 100,
      ...summarisePreviewDuplicates(outcomes),
    };
  }
  const result: PreviewResult = {
    headers,
    previewRows: records.slice(0, PREVIEW_ROW_LIMIT),
    totalRows: records.length,
    detectedTypeColumn: typeColumn,
    columnsWithNegatives: columnsWithSignedAmounts(sample),
    detectedDateFormat: dateFormat,
    dateFormatAmbiguous: options?.dateFormat ? false : dateDetection.ambiguous,
    suggestedMapping: suggestMapping(headers, typeColumn),
    ...(validation ? { validation } : {}),
  };
  return { result, outcomes, records };
}

function prepareCsvPreview(
  buffer: Buffer,
  options?: PreviewOptions,
): { result: PreviewResult; outcomes: RowOutcome[]; records: Record<string, string>[]; parsed: ParsedCsv } {
  const parsed = parseCsv(buffer);
  return { ...prepareParsedCsvPreview(parsed, options), parsed };
}

export function previewCsv(buffer: Buffer, options?: PreviewOptions): PreviewResult {
  return prepareCsvPreview(buffer, options).result;
}

async function previewParsedCsvForProfile(
  businessProfileId: number,
  parsed: ParsedCsv,
  options?: PreviewOptions,
): Promise<PreviewResult> {
  const { result, outcomes, records } = prepareParsedCsvPreview(parsed, options);
  if (options && options.recordType !== "sales") {
    const history = await loadConfirmedCategoryHistory(businessProfileId);
    const categorySuggestions: NonNullable<PreviewResult["categorySuggestions"]> = [];
    let suggestionCount = 0;
    for (let index = 0; index < records.length; index += 1) {
      const row = records[index]!;
      const correction = options.corrections?.[String(index + 2)];
      const category = correction?.category ?? (options.columnMapping.category ? row[options.columnMapping.category] : "");
      if (category?.trim()) continue;
      if (options.recordType === "mixed") {
        const amount = parseSignedAmount(correction?.amount ?? row[options.columnMapping.amount]);
        const kind = options.mixedStrategy === "sign"
          ? (amount !== null && amount < 0 ? "expense" : "sales")
          : classifyTypeValue(options.columnMapping.recordType ? row[options.columnMapping.recordType] : undefined);
        if (kind !== "expense") continue;
      }
      const match = categoryFromHistory(history,
        correction?.description ?? row[options.columnMapping.description] ?? "",
        options.columnMapping.vendor ? row[options.columnMapping.vendor] : undefined);
      if (match) {
        suggestionCount += 1;
        if (categorySuggestions.length < 100) categorySuggestions.push({ row: index + 2, ...match });
      }
    }
    result.categorySuggestions = categorySuggestions;
    result.categorySuggestionsTruncated = suggestionCount > categorySuggestions.length;
  }
  if (!result.validation || outcomes.length === 0) return result;

  const existingKeys = new Set<string>();
  for (const kind of ["expense", "sales"] as const) {
    const dates = [...new Set(outcomes.flatMap((outcome) => outcome.kind === kind ? [outcome.data.date] : []))]
      .map((date) => new Date(date));
    // Bound query parameters even for files spanning many calendar days.
    for (let offset = 0; offset < dates.length; offset += 500) {
      const where = { businessProfileId, date: { in: dates.slice(offset, offset + 500) } };
      if (kind === "expense") {
        const candidates = await prisma.expenseRecord.findMany({
          where,
          select: { date: true, amount: true, description: true, vendor: true },
        });
        for (const candidate of candidates) {
          for (const key of expenseDuplicateKeysOf(candidate)) existingKeys.add(`expense:${key}`);
        }
      } else {
        const candidates = await prisma.salesReferenceRecord.findMany({
          where,
          select: { date: true, amount: true, description: true },
        });
        for (const candidate of candidates) {
          existingKeys.add(`sales:${duplicateKeyOf(candidate.date, candidate.amount, candidate.description)}`);
        }
      }
    }
  }
  Object.assign(result.validation, summarisePreviewDuplicates(outcomes, existingKeys));
  return result;
}

/** Optional ownership-scoped preflight against records already saved. */
export async function previewCsvForProfile(
  userId: number,
  businessProfileId: number,
  buffer: Buffer,
  options?: PreviewOptions,
): Promise<PreviewResult> {
  await requireOwnedBusinessProfile(userId, businessProfileId);
  return previewParsedCsvForProfile(businessProfileId, parseCsv(buffer), options);
}

// ============================================================
// Single-upload staging
// ============================================================

interface StageMetadata {
  encoding: typeof STAGE_CHUNK_ENCODING;
  parserVersion: string;
  fileHash: string;
  delimiter: string;
  headers: string[];
}

type StagedBatchWithChunks = Prisma.CSVImportBatchGetPayload<{
  include: { stageChunks: true };
}>;

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stageMetadataOf(batch: Pick<StagedBatchWithChunks, "mappingMeta" | "fileHash">): StageMetadata {
  const stage = jsonObject(batch.mappingMeta).stage;
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
    throw new ApiError(409, "Staged CSV data is unavailable. Choose the file again.", {
      code: "CSV_STAGE_UNAVAILABLE",
    });
  }
  const raw = stage as Record<string, unknown>;
  const headers = raw.headers;
  if (
    raw.encoding !== STAGE_CHUNK_ENCODING ||
    raw.parserVersion !== CSV_PARSER_VERSION ||
    typeof raw.fileHash !== "string" ||
    raw.fileHash !== batch.fileHash ||
    typeof raw.delimiter !== "string" ||
    !Array.isArray(headers) ||
    headers.length === 0 ||
    !headers.every((header) => typeof header === "string")
  ) {
    throw new ApiError(409, "Staged CSV data is unavailable. Choose the file again.", {
      code: "CSV_STAGE_UNAVAILABLE",
    });
  }
  return {
    encoding: STAGE_CHUNK_ENCODING,
    parserVersion: CSV_PARSER_VERSION,
    fileHash: raw.fileHash,
    delimiter: raw.delimiter,
    headers: headers as string[],
  };
}

async function encodeStageChunks(records: Record<string, string>[], headers: string[]) {
  const chunks: { chunkIndex: number; rowCount: number; payload: Buffer; payloadHash: string }[] = [];
  let totalInflatedBytes = 0;
  for (let offset = 0; offset < records.length; offset += STAGE_CHUNK_ROWS) {
    const matrix = records.slice(offset, offset + STAGE_CHUNK_ROWS).map((record) =>
      headers.map((header) => record[header] ?? ""),
    );
    const rawPayload = Buffer.from(JSON.stringify(matrix), "utf8");
    totalInflatedBytes += rawPayload.byteLength;
    if (
      rawPayload.byteLength > STAGE_CHUNK_MAX_INFLATED_BYTES ||
      totalInflatedBytes > STAGE_TOTAL_MAX_INFLATED_BYTES
    ) {
      throw new ApiError(413, "This CSV is too complex to prepare safely. Split it into smaller files and try again.", {
        code: "CSV_STAGE_TOO_LARGE",
      });
    }
    const payload = await gzipAsync(rawPayload);
    chunks.push({
      chunkIndex: chunks.length,
      rowCount: matrix.length,
      payload,
      payloadHash: createHash("sha256").update(payload).digest("hex"),
    });
  }
  return chunks;
}

async function decodeStageChunks(batch: StagedBatchWithChunks): Promise<{
  parsed: ParsedCsv;
  decompressMs: number;
}> {
  const metadata = stageMetadataOf(batch);
  const totalRows = batch.totalRows;
  const chunks = [...batch.stageChunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
  const expectedChunks = totalRows === null ? -1 : Math.ceil(totalRows / STAGE_CHUNK_ROWS);
  if (totalRows === null || totalRows <= 0 || chunks.length !== expectedChunks) {
    throw new ApiError(409, "Staged CSV data is unavailable. Choose the file again.", {
      code: "CSV_STAGE_UNAVAILABLE",
    });
  }

  const startedAt = performance.now();
  const records: Record<string, string>[] = [];
  let totalInflatedBytes = 0;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      if (
        chunk.chunkIndex !== index ||
        createHash("sha256").update(chunk.payload).digest("hex") !== chunk.payloadHash
      ) {
        throw new Error("stage chunk integrity mismatch");
      }
      const inflated = await gunzipAsync(chunk.payload, { maxOutputLength: STAGE_CHUNK_MAX_INFLATED_BYTES });
      totalInflatedBytes += inflated.byteLength;
      if (totalInflatedBytes > STAGE_TOTAL_MAX_INFLATED_BYTES) {
        throw new Error("stage chunk payload exceeds its bound");
      }
      const matrix: unknown = JSON.parse(inflated.toString("utf8"));
      if (!Array.isArray(matrix) || matrix.length !== chunk.rowCount) {
        throw new Error("stage chunk row count mismatch");
      }
      for (const rawRow of matrix) {
        if (
          !Array.isArray(rawRow) ||
          rawRow.length !== metadata.headers.length ||
          !rawRow.every((cell) => typeof cell === "string")
        ) {
          throw new Error("stage chunk row shape mismatch");
        }
        const record = Object.fromEntries(
          metadata.headers.map((header, column) => [header, rawRow[column] as string]),
        ) as Record<string, string>;
        records.push(record);
      }
    }
  } catch {
    throw new ApiError(409, "Staged CSV data is unavailable. Choose the file again.", {
      code: "CSV_STAGE_UNAVAILABLE",
    });
  }
  if (records.length !== totalRows) {
    throw new ApiError(409, "Staged CSV data is unavailable. Choose the file again.", {
      code: "CSV_STAGE_UNAVAILABLE",
    });
  }
  return {
    parsed: { records, headers: metadata.headers, delimiter: metadata.delimiter },
    decompressMs: performance.now() - startedAt,
  };
}

function scopedStageKey(businessProfileId: number, requestedKey: string): string {
  return createHash("sha256")
    .update(`csv-stage-idempotency-v1\0${businessProfileId}\0${requestedKey}`)
    .digest("hex");
}

async function compensateCsvUploadAttempt(
  businessProfileId: number,
  batchId: number,
  fileReference: string,
): Promise<void> {
  try {
    await enqueueDetachedCsvSourcePurge(businessProfileId, batchId, fileReference, {
      notBefore: new Date(Date.now() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS),
    });
  } catch (error) {
    logger.error(
      { batchId, cleanupStage: "enqueue-tombstone", failureKind: error instanceof Error ? error.name : "unknown" },
      "CSV upload compensation could not persist its delayed purge",
    );
  }

  const deleted = await deleteCsvFile(fileReference).catch((error) => {
    logger.error(
      { batchId, cleanupStage: "immediate-delete", failureKind: error instanceof Error ? error.name : "unknown" },
      "CSV upload compensation immediate delete failed",
    );
    return false;
  });
  if (!deleted) {
    logger.warn({ batchId, cleanupStage: "immediate-delete" }, "CSV upload compensation left cleanup to its purge tombstone");
  }
}

function stageResponse(
  batch: Pick<StagedBatchWithChunks, "stageId" | "stageExpiresAt">,
  result: PreviewResult,
): StagedPreviewResult {
  if (!batch.stageId || !batch.stageExpiresAt) {
    throw new ApiError(409, "Staged CSV data is unavailable. Choose the file again.", {
      code: "CSV_STAGE_UNAVAILABLE",
    });
  }
  return {
    ...result,
    stagedUploadId: batch.stageId,
    stageExpiresAt: batch.stageExpiresAt.toISOString(),
  };
}

async function ownedBatchByStageId(
  userId: number,
  businessProfileId: number,
  stageId: string,
): Promise<StagedBatchWithChunks> {
  const batch = await prisma.cSVImportBatch.findFirst({
    where: { stageId, businessProfileId, businessProfile: { userId } },
    include: { stageChunks: { orderBy: { chunkIndex: "asc" } } },
  });
  if (!batch) {
    throw new ApiError(404, "Staged CSV upload not found", { code: "CSV_STAGE_NOT_FOUND" });
  }
  return batch;
}

type PurgeStageOutcome = "missing" | "not-stage" | "not-expired" | "upload-active" | "purged";

async function purgeStagedBatch(
  batchId: number,
  options: {
    userId?: number;
    expiredBefore?: Date;
    staleStagingBefore?: Date;
    allowFreshStaging?: boolean;
  } = {},
): Promise<PurgeStageOutcome> {
  return prisma.$transaction(async (tx) => {
    const ownerFilter = options.userId === undefined
      ? Prisma.empty
      : Prisma.sql`AND p."User_ID" = ${options.userId}`;
    const rows = await tx.$queryRaw<{
      id: number;
      processingStatus: CsvImportProcessingStatus;
      stageExpiresAt: Date | null;
      createdAt: Date;
      heartbeatAt: Date | null;
    }[]>(Prisma.sql`
      SELECT
        b."ImportBatch_ID" AS id,
        b."ImportBatch_ProcessingStatus" AS "processingStatus",
        b."ImportBatch_StageExpiresAt" AS "stageExpiresAt",
        b."ImportBatch_CreatedAt" AS "createdAt",
        b."ImportBatch_HeartbeatAt" AS "heartbeatAt"
      FROM "CSVImportBatch" b
      JOIN "BusinessProfile" p ON p."BusinessProfile_ID" = b."BusinessProfile_ID"
      WHERE b."ImportBatch_ID" = ${batchId}
      ${ownerFilter}
      FOR UPDATE OF b
    `);
    const batch = rows[0];
    if (!batch) return "missing";
    if (
      batch.processingStatus !== CsvImportProcessingStatus.STAGING &&
      batch.processingStatus !== CsvImportProcessingStatus.STAGED
    ) return "not-stage";
    if (
      batch.processingStatus === CsvImportProcessingStatus.STAGING &&
      options.allowFreshStaging !== true &&
      batch.heartbeatAt !== null &&
      batch.heartbeatAt.getTime() > Date.now() - STAGING_UPLOAD_LEASE_MS
    ) return "upload-active";
    if (options.expiredBefore) {
      const expired = batch.stageExpiresAt !== null
        && batch.stageExpiresAt.getTime() <= options.expiredBefore.getTime();
      const staleUpload = batch.processingStatus === CsvImportProcessingStatus.STAGING
        && options.staleStagingBefore !== undefined
        && (batch.heartbeatAt === null || batch.heartbeatAt.getTime() <= options.staleStagingBefore.getTime());
      if (!expired && !staleUpload) return "not-expired";
    }

    const purgeOptions = batch.processingStatus === CsvImportProcessingStatus.STAGING
      ? { notBefore: new Date(Date.now() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS) }
      : {};
    await enqueueCsvSourcePurgesIfOrphaned(tx, [batch.id], purgeOptions);
    return "purged";
  });
}

async function assertStageUsable(batch: StagedBatchWithChunks): Promise<void> {
  if (batch.stageExpiresAt && batch.stageExpiresAt.getTime() <= Date.now()) {
    await purgeStagedBatch(batch.id, { expiredBefore: new Date(), allowFreshStaging: true });
    throw new ApiError(410, "This staged CSV upload has expired. Choose the file again.", {
      code: "CSV_STAGE_EXPIRED",
    });
  }
  if (batch.processingStatus === CsvImportProcessingStatus.STAGING) {
    const staleBefore = Date.now() - STAGING_UPLOAD_LEASE_MS;
    if (!batch.heartbeatAt || batch.heartbeatAt.getTime() <= staleBefore) {
      await purgeStagedBatch(batch.id, {
        staleStagingBefore: new Date(staleBefore),
      });
      throw new ApiError(410, "This staged CSV upload did not finish. Choose the file again.", {
        code: "CSV_STAGE_STALE",
      });
    }
    throw new ApiError(409, "This CSV upload is still being prepared. Try again shortly.", {
      code: "CSV_STAGE_UPLOADING",
    });
  }
  if (batch.processingStatus !== CsvImportProcessingStatus.STAGED) {
    throw new ApiError(409, "This staged CSV upload has already been confirmed.", {
      code: "CSV_STAGE_ALREADY_CONFIRMED",
    });
  }
}

export async function stageCsvUpload(
  userId: number,
  input: {
    businessProfileId: number;
    buffer: Buffer;
    originalname: string;
    idempotencyKey: string;
  },
): Promise<TimedCsvResult<StagedPreviewResult>> {
  const totalStartedAt = performance.now();
  await requireOwnedBusinessProfile(userId, input.businessProfileId);
  const fileHash = createHash("sha256").update(input.buffer).digest("hex");
  const idempotencyKey = scopedStageKey(input.businessProfileId, input.idempotencyKey);

  const replayStartedAt = performance.now();
  const existing = await prisma.cSVImportBatch.findFirst({
    where: { businessProfileId: input.businessProfileId, idempotencyKey },
    include: { stageChunks: { orderBy: { chunkIndex: "asc" } } },
  });
  if (existing) {
    if (existing.fileHash !== fileHash || existing.fileSizeBytes !== input.buffer.byteLength) {
      throw new ApiError(409, "This upload key was already used for a different CSV file.", {
        code: "CSV_STAGE_KEY_CONFLICT",
      });
    }
    await assertStageUsable(existing);
    const decoded = await decodeStageChunks(existing);
    const result = stageResponse(existing, prepareParsedCsvPreview(decoded.parsed).result);
    const timings = {
      totalMs: performance.now() - totalStartedAt,
      chunkLoadMs: performance.now() - replayStartedAt - decoded.decompressMs,
      decompressMs: decoded.decompressMs,
    };
    logger.info(
      { batchId: existing.id, rows: existing.totalRows, bytes: existing.fileSizeBytes, replayed: true, ...roundedTimings(timings) },
      "CSV upload stage ready",
    );
    return { result, timings };
  }

    const parseStartedAt = performance.now();
    const parsed = parseCsv(input.buffer);
    if (parsed.records.length === 0) {
      throw new ApiError(
        400,
        "This file has no data rows to import — only a header (or nothing at all). Check that the export included the rows.",
      );
    }
    const preview = prepareParsedCsvPreview(parsed).result;
    const parseMs = performance.now() - parseStartedAt;

    const encodeStartedAt = performance.now();
    const chunks = await encodeStageChunks(parsed.records, parsed.headers);
    const chunkEncodeMs = performance.now() - encodeStartedAt;
    const stageId = randomUUID();
    const fileReference = csvFileReference(input.businessProfileId, stageId, input.originalname);
    const now = new Date();
    const stageExpiresAt = new Date(now.getTime() + STAGED_UPLOAD_TTL_MS);
    const stageMetadata: StageMetadata = {
      encoding: STAGE_CHUNK_ENCODING,
      parserVersion: CSV_PARSER_VERSION,
      fileHash,
      delimiter: parsed.delimiter,
      headers: parsed.headers,
    };

    const persistStartedAt = performance.now();
    let reservation: { batch: StagedBatchWithChunks; replayed: boolean };
    try {
      reservation = await prisma.$transaction(async (tx) => {
        const active = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
          SELECT u."User_ID" AS id
          FROM "User" u
          JOIN "BusinessProfile" p ON p."User_ID" = u."User_ID"
          WHERE u."User_ID" = ${userId}
            AND p."BusinessProfile_ID" = ${input.businessProfileId}
            AND u."User_Status" = ${AccountStatus.ACTIVE}::"AccountStatus"
          FOR UPDATE OF u
        `);
        if (active.length !== 1) {
          throw new ApiError(403, "This account can no longer upload files.", { code: "ACCOUNT_NOT_ACTIVE" });
        }

        const concurrentReplay = await tx.cSVImportBatch.findFirst({
          where: { businessProfileId: input.businessProfileId, idempotencyKey },
          include: { stageChunks: { orderBy: { chunkIndex: "asc" } } },
        });
        if (concurrentReplay) return { batch: concurrentReplay, replayed: true };

        await assertCsvOutstandingCapacity(tx, userId, input.buffer.byteLength);

        const creationCutoff = new Date(now.getTime() - CSV_STAGE_CREATION_WINDOW_MS);
        const recentCreations = await tx.apiRateLimit.findMany({
          where: {
            key: { startsWith: `csv-stage-create:u${userId}:` },
            windowStart: { gt: creationCutoff },
            expiresAt: { gt: now },
          },
          orderBy: { expiresAt: "asc" },
          take: CSV_STAGE_CREATION_HOURLY_LIMIT,
          select: { expiresAt: true },
        });
        if (recentCreations.length >= CSV_STAGE_CREATION_HOURLY_LIMIT) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((recentCreations[0]!.expiresAt.getTime() - now.getTime()) / 1_000),
          );
          throw new ApiError(429, "Too many new CSV uploads were started recently. Try again later.", {
            code: "CSV_STAGE_HOURLY_LIMIT",
            responseDetails: { retryAfterSeconds },
          });
        }

        await tx.apiRateLimit.create({
          data: {
            key: stageCreationRateKey(userId),
            windowStart: now,
            count: 1,
            expiresAt: new Date(now.getTime() + CSV_STAGE_CREATION_WINDOW_MS),
          },
        });
        const created = await tx.cSVImportBatch.create({
          data: {
            businessProfileId: input.businessProfileId,
            title: "CSV import",
            uploadDate: now,
            status: "Needs Review",
            processingStatus: CsvImportProcessingStatus.STAGING,
            idempotencyKey,
            fileHash,
            fileSizeBytes: input.buffer.byteLength,
            fileReference,
            totalRows: parsed.records.length,
            stageId,
            stageExpiresAt,
            heartbeatAt: now,
            workerId: STAGE_WORKER_ID,
            mappingMeta: {
              parserVersion: CSV_PARSER_VERSION,
              stage: stageMetadata,
            } as unknown as Prisma.InputJsonObject,
            stageChunks: {
              createMany: {
                data: chunks.map((chunk) => ({
                  chunkIndex: chunk.chunkIndex,
                  rowCount: chunk.rowCount,
                  payload: Uint8Array.from(chunk.payload),
                  payloadHash: chunk.payloadHash,
                })),
              },
            },
          },
          include: { stageChunks: { orderBy: { chunkIndex: "asc" } } },
        });
        return { batch: created, replayed: false };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await prisma.cSVImportBatch.findFirst({
          where: { businessProfileId: input.businessProfileId, idempotencyKey },
          include: { stageChunks: { orderBy: { chunkIndex: "asc" } } },
        });
        if (winner) {
          if (winner.fileHash !== fileHash || winner.fileSizeBytes !== input.buffer.byteLength) {
            throw new ApiError(409, "This upload key was already used for a different CSV file.", {
              code: "CSV_STAGE_KEY_CONFLICT",
            });
          }
          await assertStageUsable(winner);
          const decoded = await decodeStageChunks(winner);
          return {
            result: stageResponse(winner, prepareParsedCsvPreview(decoded.parsed).result),
            timings: {
              totalMs: performance.now() - totalStartedAt,
              parseMs,
              chunkLoadMs: performance.now() - persistStartedAt - decoded.decompressMs,
              decompressMs: decoded.decompressMs,
            },
          };
        }
      }
      throw error;
    }

    const batch = reservation.batch;
    if (reservation.replayed) {
      if (batch.fileHash !== fileHash || batch.fileSizeBytes !== input.buffer.byteLength) {
        throw new ApiError(409, "This upload key was already used for a different CSV file.", {
          code: "CSV_STAGE_KEY_CONFLICT",
        });
      }
      await assertStageUsable(batch);
      const decoded = await decodeStageChunks(batch);
      return {
        result: stageResponse(batch, prepareParsedCsvPreview(decoded.parsed).result),
        timings: {
          totalMs: performance.now() - totalStartedAt,
          parseMs,
          chunkLoadMs: performance.now() - persistStartedAt - decoded.decompressMs,
          decompressMs: decoded.decompressMs,
        },
      };
    }
    const chunkPersistMs = performance.now() - persistStartedAt;

    const storageStartedAt = performance.now();
    let stageLeaseLost = false;
    const heartbeatTimer = setInterval(() => {
      void prisma.cSVImportBatch.updateMany({
        where: {
          id: batch.id,
          stageId,
          processingStatus: CsvImportProcessingStatus.STAGING,
          workerId: STAGE_WORKER_ID,
        },
        data: { heartbeatAt: new Date() },
      }).then((updated) => {
        if (updated.count !== 1) stageLeaseLost = true;
      }).catch(() => undefined);
    }, Math.floor(STAGING_UPLOAD_LEASE_MS / 3));
    heartbeatTimer.unref();
    try {
      await uploadCsvFileAtReference(input.businessProfileId, fileReference, input.buffer);
      if (stageLeaseLost) {
        throw new ApiError(409, "This staged CSV upload is no longer available.", {
          code: "CSV_STAGE_NOT_FOUND",
        });
      }
      const stagedAt = new Date();
      const staged = await prisma.$transaction(async (tx) => {
        const active = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
          SELECT u."User_ID" AS id
          FROM "User" u
          JOIN "BusinessProfile" p ON p."User_ID" = u."User_ID"
          WHERE u."User_ID" = ${userId}
            AND p."BusinessProfile_ID" = ${input.businessProfileId}
            AND u."User_Status" = ${AccountStatus.ACTIVE}::"AccountStatus"
          FOR UPDATE OF u
        `);
        if (active.length !== 1) return { count: 0 };
        return tx.cSVImportBatch.updateMany({
          where: {
            id: batch.id,
            stageId,
            processingStatus: CsvImportProcessingStatus.STAGING,
            workerId: STAGE_WORKER_ID,
          },
          data: {
            processingStatus: CsvImportProcessingStatus.STAGED,
            stagedAt,
            heartbeatAt: null,
            workerId: null,
          },
        });
      });
      if (staged.count !== 1) {
        throw new ApiError(409, "This staged CSV upload is no longer available.", {
          code: "CSV_STAGE_NOT_FOUND",
        });
      }
      batch.processingStatus = CsvImportProcessingStatus.STAGED;
      batch.stagedAt = stagedAt;
    } catch (error) {
      await purgeStagedBatch(batch.id, { allowFreshStaging: true }).catch((cleanupError) => {
        logger.error({ batchId: batch.id, failureKind: cleanupError instanceof Error ? cleanupError.name : "unknown" }, "CSV stage cleanup failed");
      });
      await compensateCsvUploadAttempt(input.businessProfileId, batch.id, fileReference);
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
    }
    const storageMs = performance.now() - storageStartedAt;
    const timings = {
      totalMs: performance.now() - totalStartedAt,
      parseMs,
      chunkEncodeMs,
      chunkPersistMs,
      storageMs,
    };
    logger.info(
      { batchId: batch.id, rows: parsed.records.length, bytes: input.buffer.byteLength, replayed: false, ...roundedTimings(timings) },
      "CSV upload stage ready",
    );
    return { result: stageResponse(batch, preview), timings };
}

export async function previewStagedCsv(
  userId: number,
  businessProfileId: number,
  stageId: string,
  options: PreviewOptions,
): Promise<TimedCsvResult<StagedPreviewResult>> {
  const totalStartedAt = performance.now();
  const loadStartedAt = performance.now();
  const batch = await ownedBatchByStageId(userId, businessProfileId, stageId);
  await assertStageUsable(batch);
  const queryMs = performance.now() - loadStartedAt;
  const decoded = await decodeStageChunks(batch);
  const validationStartedAt = performance.now();
  const preview = await previewParsedCsvForProfile(batch.businessProfileId, decoded.parsed, options);
  const validationMs = performance.now() - validationStartedAt;
  const timings = {
    totalMs: performance.now() - totalStartedAt,
    chunkLoadMs: queryMs,
    decompressMs: decoded.decompressMs,
    validationMs,
  };
  logger.info(
    { batchId: batch.id, rows: batch.totalRows, ...roundedTimings(timings) },
    "CSV staged preview validated",
  );
  return { result: stageResponse(batch, preview), timings };
}

export async function deleteStagedCsvUpload(userId: number, stageId: string): Promise<void> {
  const batch = await prisma.cSVImportBatch.findFirst({
    where: { stageId, businessProfile: { userId } },
    select: { id: true },
  });
  if (!batch) return;
  const outcome = await purgeStagedBatch(batch.id, { userId });
  if (outcome === "missing") return;
  if (outcome === "upload-active") {
    throw new ApiError(409, "This CSV upload is still being prepared. Try again shortly.", {
      code: "CSV_STAGE_UPLOADING",
    });
  }
  if (outcome !== "purged") {
    throw new ApiError(409, "This staged CSV upload has already been confirmed.", {
      code: "CSV_STAGE_ALREADY_CONFIRMED",
    });
  }
}

function roundedTimings(timings: CsvOperationTimings): Record<string, number> {
  return Object.fromEntries(
    Object.entries(timings).map(([key, value]) => [key, Math.round(value ?? 0)]),
  );
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
    where: {
      businessProfileId,
      processingStatus: { notIn: [CsvImportProcessingStatus.STAGING, CsvImportProcessingStatus.STAGED] },
    },
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
    where: {
      id: batchId,
      businessProfile: { userId },
      processingStatus: { notIn: [CsvImportProcessingStatus.STAGING, CsvImportProcessingStatus.STAGED] },
    },
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
async function resolveCategoriesWithCache(
  businessProfileId: number,
  names: string[],
  categoryIds?: Map<string, number>,
) {
  const byName = categoryIds ?? new Map<string, number>(
    (await prisma.expenseCategory.findMany({ where: { businessProfileId } }))
      .map((category) => [category.name.toLowerCase(), category.id] as const),
  );

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

export function resolveCategories(businessProfileId: number, names: string[]) {
  return resolveCategoriesWithCache(businessProfileId, names);
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
  lease: ImportLease;
  seed: { imported: number; skippedCount: number; flagged: number; progress: ProgressSummary };
}): Promise<void> {
  const { batchId, userId, profile, outcomes, startAtRow, lease, seed } = args;
  let imported = seed.imported;
  let skippedCount = seed.skippedCount;
  let flagged = seed.flagged;
  const progress = seed.progress;
  const hasExpenseRows = outcomes.slice(startAtRow).some((outcome) => outcome.kind === "expense");
  const categoryIds = hasExpenseRows
    ? await resolveCategoriesWithCache(profile.id, [])
    : new Map<string, number>();

  for (let at = startAtRow; at < outcomes.length; at += CHUNK_SIZE) {
    const chunk = outcomes.slice(at, at + CHUNK_SIZE);
    const expenseRows = chunk.filter((o): o is Extract<RowOutcome, { kind: "expense" }> => o.kind === "expense");
    const salesRows = chunk.filter((o): o is Extract<RowOutcome, { kind: "sales" }> => o.kind === "sales");
    const skips = chunk.filter((o): o is Extract<RowOutcome, { kind: "skip" }> => o.kind === "skip");

    // Outside the transaction on purpose: category creation is idempotent
    // (skipDuplicates + unique constraint), so a rolled-back chunk leaving a
    // created category behind is harmless — and keeping it out keeps the
    // transaction to exactly the writes the checkpoint vouches for.
    if (expenseRows.length > 0) {
      await resolveCategoriesWithCache(profile.id, expenseRows.map((o) => o.data.category!), categoryIds);
    }

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
        //
        // Conditional on the lease, and inside the chunk's own transaction, so
        // it is the inserts above that are gated: if another worker has
        // claimed this batch — which it may legitimately have done after a
        // long download — the row count is 0, the throw rolls this chunk's
        // expenses and sales back, and the loop stops. Without the predicate
        // both workers resume from the same checkpoint and every row lands
        // twice.
        const checkpoint = await tx.cSVImportBatch.updateMany({
          where: {
            id: batchId,
            processingStatus: CsvImportProcessingStatus.PROCESSING,
            workerId: lease.workerId,
            attemptCount: lease.attemptCount,
          },
          data: {
            processedRows: at + chunk.length,
            importedRows: imported,
            skippedRows: skippedCount,
            flaggedRows: flagged,
            heartbeatAt: new Date(),
            resultSummary: progress as unknown as Prisma.InputJsonObject,
          },
        });
        if (checkpoint.count !== 1) throw new CsvLeaseLostError(batchId);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    // After COMMIT, because the jobs reference the records by FK. A crash in
    // this gap loses only the enqueue, and the hourly reconcile in
    // enqueueDailyProfileAnalyses re-creates jobs for records that have none.
    if (createdExpenseIds.length > 0) {
      await enqueueExpenseAnalyses(profile.id, createdExpenseIds).catch((error) => {
        logger.error(
          { batchId, failureKind: error instanceof Error ? error.name : "unknown" },
          "failed to enqueue imported expense analysis",
        );
      });
    }
  }
}

/**
 * The terminal happy transition: PROCESSING → COMPLETE, plus everything the
 * old code did after its inserts — the owner-facing status, the one summary
 * notification, and the coalesced profile-refresh analysis job.
 */
async function completeBatch(batchId: number, userId: number, businessProfileId: number, lease: ImportLease) {
  const batch = await prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batchId } });
  const progress = readProgress(batch.resultSummary);

  // A large-expense flag sets the record's reviewStatus to "Needs Review", so a
  // batch containing one genuinely needs review — reporting "Completed" told
  // the owner there was nothing to look at while records sat in the queue.
  const needsReview = batch.skippedRows > 0 || batch.flaggedRows > 0 || progress.largeExpenseFlagged > 0;
  const status = needsReview ? "Needs Review" : "Completed";

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.cSVImportBatch.updateMany({
      where: ownedByAttempt(batchId, lease),
      data: {
        status,
        processingStatus: CsvImportProcessingStatus.COMPLETE,
        completedAt: new Date(),
        workerId: null,
        failureStage: null,
        lastError: null,
      },
    });
    if (result.count === 1) {
      await tx.cSVImportStageChunk.deleteMany({ where: { importBatchId: batchId } });
    }
    return result;
  });

  if (updated.count !== 1) {
    // Another attempt owns the row and will finish it, notification and
    // refresh included. Report what is actually there rather than what this
    // attempt believed.
    logger.warn({ batchId }, "csv import completion skipped: the lease was reclaimed");
    return prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batchId } });
  }

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
    logger.error(
      { batchId, failureKind: error instanceof Error ? error.name : "unknown" },
      "failed to enqueue profile refresh after import",
    );
  });

  return prisma.cSVImportBatch.findUniqueOrThrow({ where: { id: batchId } });
}

/**
 * Terminal failure: mark FAILED with the stage that broke, and compensate the
 * storage upload. The delete is best-effort — an orphaned object is a cost, a
 * throw here would mask the error that actually mattered.
 *
 * The status is claimed BEFORE the file is deleted, and only under this
 * attempt's lease. Deleting first would let an attempt that has already lost
 * the row destroy the stored file the new owner is about to download.
 */
async function failBatch(
  batchId: number,
  stage: string,
  error: unknown,
  lease: ImportLease,
  options: { deferSourcePurge?: boolean } = {},
): Promise<void> {
  const failed = await prisma.$transaction(async (tx) => {
    const result = await tx.cSVImportBatch.updateMany({
      where: ownedByAttempt(batchId, lease),
      data: {
        processingStatus: CsvImportProcessingStatus.FAILED,
        failureStage: stage,
        lastError: safeCsvFailureSummary(stage, error),
        workerId: null,
      },
    });
    if (result.count === 1) {
      await tx.cSVImportStageChunk.deleteMany({ where: { importBatchId: batchId } });
      await enqueueCsvSourcePurgeForTerminalBatch(
        tx,
        batchId,
        options.deferSourcePurge
          ? { notBefore: new Date(Date.now() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS) }
          : {},
      );
    }
    return result;
  });
  if (failed.count !== 1) {
    logger.warn({ batchId, stage }, "csv import failure not recorded: the lease was reclaimed");
    return;
  }

}

/** Retryable failure: back off and hand the batch to the worker; terminal
 * once the attempt budget is spent. Mirrors the analysis worker's schedule. */
async function deferBatch(
  batchId: number,
  stage: string,
  error: unknown,
  attemptCount: number,
  lease: ImportLease,
): Promise<void> {
  if (attemptCount >= CSV_MAX_ATTEMPTS) {
    await failBatch(batchId, stage, error, lease);
    return;
  }
  const delayMinutes = Math.min(2 ** attemptCount, 60);
  const deferred = await prisma.cSVImportBatch.updateMany({
    where: ownedByAttempt(batchId, lease),
    data: {
      processingStatus: CsvImportProcessingStatus.PENDING,
      failureStage: stage,
      lastError: safeCsvFailureSummary(stage, error),
      nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
      workerId: null,
    },
  });
  if (deferred.count !== 1) {
    logger.warn({ batchId, stage }, "csv import deferral skipped: the lease was reclaimed");
  }
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
    skippedRows: number;
    flaggedRows: number;
    resultSummary: Prisma.JsonValue | null;
    mappingMeta?: Prisma.JsonValue | null;
  },
  duplicateOfBatchId?: number,
): ConfirmResult {
  const progress = readProgress(batch.resultSummary);
  const storedDuplicate = jsonObject(batch.mappingMeta ?? null).duplicateOfBatchId;
  const duplicateId = duplicateOfBatchId ?? (typeof storedDuplicate === "number" ? storedDuplicate : undefined);
  return {
    batchId: batch.id,
    title: batch.title,
    status: batch.status,
    processingStatus: batch.processingStatus,
    totalRows: batch.totalRows ?? 0,
    imported: batch.importedRows,
    skipped: progress.skipped,
    skippedCount: batch.skippedRows,
    skippedTruncated: batch.skippedRows > progress.skipped.length,
    flagged: batch.flaggedRows,
    largeExpenseFlagged: progress.largeExpenseFlagged,
    importedExpenses: progress.importedExpenses,
    importedSales: progress.importedSales,
    uncategorised: progress.uncategorised,
    ...(duplicateId !== undefined ? { duplicateOfBatchId: duplicateId } : {}),
  };
}

// ============================================================
// Confirm
// ============================================================

/**
 * The key actually stored, which is the owner's key hashed WITH their profile.
 *
 * `CSVImportBatch.idempotencyKey` is globally unique, and the raw key used to
 * go into it verbatim. A client that sent something non-random — "import-1",
 * a date, a filename — therefore claimed that string for the whole
 * installation: every other business sending the same string got a 409 for an
 * import that was not theirs and could never be replayed, permanently. No data
 * crossed, but the key was theirs to hold forever.
 *
 * Hashing with the profile id is the same construction receiptScan/queue.ts
 * already uses for the upload key, so the two paths do not disagree about what
 * scoping an idempotency key means.
 */
function scopedImportKey(businessProfileId: number, requestedKey: string): string {
  return createHash("sha256").update(`csv-import-idempotency-v1\0${businessProfileId}\0${requestedKey}`).digest("hex");
}

/**
 * The batch a replay should observe.
 *
 * Two lookups because keys stored before scoping are raw. A legacy row is only
 * honoured for the profile that created it; one belonging to somebody else is
 * ignored rather than answered with a 409, which is the block this fixes.
 * Legacy rows age out, and nothing writes an unscoped key any more.
 */
async function findReplayableBatch(businessProfileId: number, scopedKey: string, requestedKey: string) {
  const candidates = await prisma.cSVImportBatch.findMany({
    where: { idempotencyKey: { in: [scopedKey, requestedKey] } },
  });
  return (
    candidates.find((batch) => batch.idempotencyKey === scopedKey) ??
    candidates.find((batch) => batch.businessProfileId === businessProfileId) ??
    null
  );
}

function stagedConfirmHash(input: StagedConfirmInput): string {
  const corrections = Object.entries(input.corrections ?? {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([row, value]) => [
      row,
      value.date ?? null,
      value.description ?? null,
      value.amount ?? null,
      value.category ?? null,
    ]);
  const canonical = [
    input.title,
    input.recordType,
    input.mixedStrategy ?? null,
    input.dateFormat ?? null,
    [
      input.columnMapping.date,
      input.columnMapping.description,
      input.columnMapping.amount,
      input.columnMapping.category ?? null,
      input.columnMapping.vendor ?? null,
      input.columnMapping.recordType ?? null,
    ],
    corrections,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function legacyConfirmHash(fileHash: string, input: ConfirmInput): string {
  return createHash("sha256")
    .update("csv-import-confirm-v1\0")
    .update(fileHash)
    .update("\0")
    .update(stagedConfirmHash(input))
    .digest("hex");
}

function assertMatchingLegacyConfirmation(
  batch: { fileHash: string | null; confirmInputHash: string | null },
  fileHash: string,
  confirmInputHash: string,
): void {
  if (
    batch.fileHash !== fileHash ||
    (batch.confirmInputHash !== null && batch.confirmInputHash !== confirmInputHash)
  ) {
    throw new ApiError(409, "This import key was already used with different CSV data or import details.", {
      code: "CSV_IMPORT_KEY_CONFLICT",
    });
  }
}

function assertMatchingStagedConfirmation(
  batch: Pick<StagedBatchWithChunks, "confirmInputHash">,
  confirmInputHash: string,
): void {
  if (batch.confirmInputHash !== confirmInputHash) {
    throw new ApiError(409, "This staged CSV was already confirmed with different details.", {
      code: "CSV_STAGE_CONFIRM_CONFLICT",
    });
  }
}

export async function confirmStagedImport(
  userId: number,
  businessProfileId: number,
  stageId: string,
  input: StagedConfirmInput,
): Promise<TimedCsvResult<ConfirmResult>> {
  const totalStartedAt = performance.now();
  const confirmInputHash = stagedConfirmHash(input);
  const loadStartedAt = performance.now();
  const batch = await ownedBatchByStageId(userId, businessProfileId, stageId);
  const chunkLoadMs = performance.now() - loadStartedAt;

  if (
    batch.processingStatus !== CsvImportProcessingStatus.STAGING &&
    batch.processingStatus !== CsvImportProcessingStatus.STAGED
  ) {
    assertMatchingStagedConfirmation(batch, confirmInputHash);
    const timings = { totalMs: performance.now() - totalStartedAt, chunkLoadMs };
    return { result: replayResponse(batch), timings };
  }

  await assertStageUsable(batch);
  const decoded = await decodeStageChunks(batch);
  const records = decoded.parsed.records;
  if (records.length === 0) {
    throw new ApiError(400, "This file has no data rows to import.");
  }

  const validationStartedAt = performance.now();
  validateMapping(decoded.parsed.headers, input);
  const rawDateSamples = records
    .map((record, index) => (
      input.corrections?.[String(index + 2)]?.date ?? record[input.columnMapping.date] ?? ""
    ).trim())
    .filter(Boolean);
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
          : "The dates in this file mix day-first and month-first conventions. Re-submit with dateFormat set to \"dmy\" or \"mdy\".",
      );
    }
    dateFormat = detection.format;
  }
  const outcomes = validateRows(
    records,
    input.columnMapping,
    input.recordType,
    input.corrections,
    input.mixedStrategy,
    dateFormat,
  );
  const duplicateOf = await prisma.cSVImportBatch.findFirst({
    where: {
      businessProfileId: batch.businessProfileId,
      fileHash: batch.fileHash,
      processingStatus: CsvImportProcessingStatus.COMPLETE,
    },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  const validationMs = performance.now() - validationStartedAt;
  const isAsync = records.length > SYNC_ROW_LIMIT;
  const confirmedAt = new Date();
  const mappingMeta = {
    ...jsonObject(batch.mappingMeta),
    parserVersion: CSV_PARSER_VERSION,
    columnMapping: input.columnMapping,
    recordType: input.recordType,
    mixedStrategy: input.mixedStrategy ?? null,
    dateFormat,
    delimiter: decoded.parsed.delimiter,
    corrections: input.corrections ?? null,
    duplicateOfBatchId: duplicateOf?.id ?? null,
  };
  const claim = await prisma.$transaction(async (tx) => {
    const active = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
      SELECT u."User_ID" AS id
      FROM "User" u
      JOIN "BusinessProfile" p ON p."User_ID" = u."User_ID"
      WHERE u."User_ID" = ${userId}
        AND p."BusinessProfile_ID" = ${batch.businessProfileId}
        AND u."User_Status" = ${AccountStatus.ACTIVE}::"AccountStatus"
      FOR UPDATE OF u
    `);
    if (active.length !== 1) {
      throw new ApiError(403, "This account can no longer import files.", { code: "ACCOUNT_NOT_ACTIVE" });
    }
    return tx.cSVImportBatch.updateMany({
      where: {
        id: batch.id,
        stageId,
        processingStatus: CsvImportProcessingStatus.STAGED,
        stageExpiresAt: { gt: confirmedAt },
      },
      data: {
        title: input.title,
        processingStatus: isAsync
          ? CsvImportProcessingStatus.PENDING
          : CsvImportProcessingStatus.PROCESSING,
        mappingMeta: mappingMeta as unknown as Prisma.InputJsonObject,
        confirmInputHash,
        confirmedAt,
        attemptCount: isAsync ? 0 : 1,
        startedAt: isAsync ? null : confirmedAt,
        heartbeatAt: isAsync ? null : confirmedAt,
        workerId: isAsync ? null : SYNC_WORKER_ID,
        nextAttemptAt: confirmedAt,
      },
    });
  });

  if (claim.count !== 1) {
    const current = await prisma.cSVImportBatch.findFirst({
      where: { stageId, businessProfileId, businessProfile: { userId } },
    });
    if (!current) {
      throw new ApiError(404, "Staged CSV upload not found", { code: "CSV_STAGE_NOT_FOUND" });
    }
    if (current.processingStatus === CsvImportProcessingStatus.STAGED) {
      throw new ApiError(410, "This staged CSV upload has expired. Choose the file again.", {
        code: "CSV_STAGE_EXPIRED",
      });
    }
    assertMatchingStagedConfirmation(current as StagedBatchWithChunks, confirmInputHash);
    const timings = {
      totalMs: performance.now() - totalStartedAt,
      chunkLoadMs,
      decompressMs: decoded.decompressMs,
      validationMs,
    };
    return { result: replayResponse(current), timings };
  }

  if (isAsync) {
    const result: ConfirmResult = {
      batchId: batch.id,
      title: input.title,
      status: batch.status,
      processingStatus: CsvImportProcessingStatus.PENDING,
      totalRows: records.length,
      imported: 0,
      skipped: [],
      skippedCount: 0,
      skippedTruncated: false,
      flagged: 0,
      largeExpenseFlagged: 0,
      importedExpenses: 0,
      importedSales: 0,
      uncategorised: 0,
      ...(duplicateOf ? { duplicateOfBatchId: duplicateOf.id } : {}),
    };
    const timings = {
      totalMs: performance.now() - totalStartedAt,
      parseMs: 0,
      chunkLoadMs,
      decompressMs: decoded.decompressMs,
      validationMs,
    };
    logger.info(
      { batchId: batch.id, rows: records.length, mode: "async", ...roundedTimings(timings) },
      "CSV staged import accepted",
    );
    return { result, timings };
  }

  const insertStartedAt = performance.now();
  try {
    const profile = await requireOwnedBusinessProfile(userId, batch.businessProfileId);
    await runImportChunks({
      batchId: batch.id,
      userId,
      profile,
      outcomes,
      startAtRow: 0,
      lease: { workerId: SYNC_WORKER_ID, attemptCount: 1 },
      seed: { imported: 0, skippedCount: 0, flagged: 0, progress: emptyProgress() },
    });
  } catch (error) {
    if (!(error instanceof CsvLeaseLostError)) {
      await deferBatch(batch.id, "insert", error, 1, { workerId: SYNC_WORKER_ID, attemptCount: 1 });
    }
    throw error;
  }
  const completed = await completeBatch(batch.id, userId, batch.businessProfileId, {
    workerId: SYNC_WORKER_ID,
    attemptCount: 1,
  });
  const insertMs = performance.now() - insertStartedAt;
  const progress = readProgress(completed.resultSummary);
  const result: ConfirmResult = {
    batchId: completed.id,
    title: completed.title,
    status: completed.status,
    processingStatus: completed.processingStatus,
    totalRows: records.length,
    imported: completed.importedRows,
    skipped: outcomes
      .filter((outcome): outcome is Extract<RowOutcome, { kind: "skip" }> => outcome.kind === "skip")
      .map((outcome) => ({ row: outcome.row, reason: outcome.reason })),
    skippedCount: completed.skippedRows,
    skippedTruncated: false,
    flagged: completed.flaggedRows,
    largeExpenseFlagged: progress.largeExpenseFlagged,
    importedExpenses: progress.importedExpenses,
    importedSales: progress.importedSales,
    uncategorised: progress.uncategorised,
    ...(duplicateOf ? { duplicateOfBatchId: duplicateOf.id } : {}),
  };
  const timings = {
    totalMs: performance.now() - totalStartedAt,
    parseMs: 0,
    chunkLoadMs,
    decompressMs: decoded.decompressMs,
    validationMs,
    insertMs,
  };
  logger.info(
    {
      batchId: batch.id,
      rows: records.length,
      mode: "sync",
      rowsPerSecond: insertMs > 0 ? Math.round((records.length / insertMs) * 1000) : records.length,
      ...roundedTimings(timings),
    },
    "CSV staged import completed",
  );
  return { result, timings };
}

export async function confirmImport(userId: number, input: ConfirmInput): Promise<ConfirmResult> {
  const profile = await requireOwnedBusinessProfile(userId, input.businessProfileId);

  // Direct service callers (tests, scripts) may omit the key; they get a
  // fresh import each call, exactly the pre-idempotency behaviour. The HTTP
  // layer always sends one — its own or the deprecation shim's.
  const requestedKey = input.idempotencyKey ?? `service-${randomUUID()}`;
  const idempotencyKey = scopedImportKey(input.businessProfileId, requestedKey);
  const fileHash = createHash("sha256").update(input.buffer).digest("hex");
  const confirmInputHash = legacyConfirmHash(fileHash, input);

  /*
   * REPLAY CHECK FIRST — before parsing, before storage, before anything that
   * costs. A retried confirm (timeout, refresh, double-click) must observe
   * the import it already started, never start a second one.
   */
  const existing = await findReplayableBatch(input.businessProfileId, idempotencyKey, requestedKey);
  if (existing) {
    if (existing.businessProfileId !== input.businessProfileId) {
      // Unreachable now that the stored key carries the profile — a match
      // means a SHA-256 collision, not a reused key. Kept because replaying
      // another profile's counts would be a leak, and this is the one line
      // between that and a hash assumption.
      throw new ApiError(409, "This idempotency key was already used by a different import", {
        code: "CSV_IMPORT_KEY_CONFLICT",
      });
    }
    assertMatchingLegacyConfirmation(existing, fileHash, confirmInputHash);
    return replayResponse(existing);
  }

  const { records, delimiter, headers } = parseCsv(input.buffer);

  if (records.length === 0) {
    throw new ApiError(
      400,
      "This file has no data rows to import — only a header (or nothing at all). Check that the export included the rows.",
    );
  }
  validateMapping(headers, input);

  /*
   * The date convention is settled BEFORE any row is judged. If the owner
   * stated one it wins; otherwise the file must be unambiguous on its own,
   * because importing "05/01/2026" on a guess files the record four months
   * away and reports success.
   */
  const rawDateSamples = records.map((r, index) => (input.corrections?.[String(index + 2)]?.date ?? r[input.columnMapping.date] ?? "").trim()).filter(Boolean);
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
    duplicateOfBatchId: duplicateOf?.id ?? null,
  };
  const fileReference = csvFileReference(input.businessProfileId, randomUUID(), input.originalname);

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
  let reservation: { batch: Prisma.CSVImportBatchGetPayload<Record<string, never>>; replayed: boolean };
  try {
    reservation = await prisma.$transaction(async (tx) => {
      const active = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
        SELECT u."User_ID" AS id
        FROM "User" u
        JOIN "BusinessProfile" p ON p."User_ID" = u."User_ID"
        WHERE u."User_ID" = ${userId}
          AND p."BusinessProfile_ID" = ${input.businessProfileId}
          AND u."User_Status" = ${AccountStatus.ACTIVE}::"AccountStatus"
        FOR UPDATE OF u
      `);
      if (active.length !== 1) {
        throw new ApiError(403, "This account can no longer import files.", { code: "ACCOUNT_NOT_ACTIVE" });
      }

      const replayCandidates = await tx.cSVImportBatch.findMany({
        where: {
          businessProfileId: input.businessProfileId,
          idempotencyKey: { in: [idempotencyKey, requestedKey] },
        },
      });
      const concurrentReplay = replayCandidates.find((candidate) => candidate.idempotencyKey === idempotencyKey)
        ?? replayCandidates[0];
      if (concurrentReplay) {
        assertMatchingLegacyConfirmation(concurrentReplay, fileHash, confirmInputHash);
        return { batch: concurrentReplay, replayed: true };
      }

      await assertCsvOutstandingCapacity(tx, userId, input.buffer.byteLength);
      const created = await tx.cSVImportBatch.create({
        data: {
          businessProfileId: input.businessProfileId,
          title: input.title,
          uploadDate: new Date(),
          status: "Needs Review",
          processingStatus: CsvImportProcessingStatus.PROCESSING,
          idempotencyKey,
          fileHash,
          confirmInputHash,
          fileSizeBytes: input.buffer.length,
          fileReference,
          totalRows: records.length,
          mappingMeta: mappingMeta as unknown as Prisma.InputJsonObject,
          attemptCount: isAsync ? 0 : 1,
          startedAt: new Date(),
          heartbeatAt: new Date(),
          workerId: SYNC_WORKER_ID,
        },
      });
      return { batch: created, replayed: false };
    });
  } catch (error) {
    // Two concurrent confirms with the same key: exactly one insert wins the
    // unique constraint; the loser replays the winner's import.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.cSVImportBatch.findUnique({ where: { idempotencyKey } });
      if (winner && winner.businessProfileId === input.businessProfileId) {
        assertMatchingLegacyConfirmation(winner, fileHash, confirmInputHash);
        return replayResponse(winner);
      }
    }
    throw error;
  }
  if (reservation.replayed) return replayResponse(reservation.batch);
  const batch = reservation.batch;

  let uploadLeaseLost = false;
  const uploadHeartbeat = setInterval(() => {
    void prisma.cSVImportBatch.updateMany({
      where: {
        id: batch.id,
        processingStatus: CsvImportProcessingStatus.PROCESSING,
        workerId: SYNC_WORKER_ID,
        attemptCount: batch.attemptCount,
      },
      data: { heartbeatAt: new Date() },
    }).then((updated) => {
      if (updated.count !== 1) uploadLeaseLost = true;
    }).catch(() => undefined);
  }, Math.floor(CSV_LEASE_MS / 3));
  uploadHeartbeat.unref();
  try {
    await uploadCsvFileAtReference(input.businessProfileId, fileReference, input.buffer);
    const finalized = uploadLeaseLost
      ? { count: 0 }
      : await prisma.$transaction(async (tx) => {
          const active = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`
            SELECT u."User_ID" AS id
            FROM "User" u
            JOIN "BusinessProfile" p ON p."User_ID" = u."User_ID"
            WHERE u."User_ID" = ${userId}
              AND p."BusinessProfile_ID" = ${input.businessProfileId}
              AND u."User_Status" = ${AccountStatus.ACTIVE}::"AccountStatus"
            FOR UPDATE OF u
          `);
          if (active.length !== 1) return { count: 0 };
          return tx.cSVImportBatch.updateMany({
            where: {
              id: batch.id,
              processingStatus: CsvImportProcessingStatus.PROCESSING,
              workerId: SYNC_WORKER_ID,
              attemptCount: batch.attemptCount,
            },
            data: isAsync
              ? {
                  processingStatus: CsvImportProcessingStatus.PENDING,
                  workerId: null,
                  heartbeatAt: null,
                  nextAttemptAt: new Date(),
                }
              : { heartbeatAt: new Date() },
          });
        });
    if (finalized.count !== 1) {
      const lost = new ApiError(409, "This CSV import is no longer available.", {
        code: "CSV_IMPORT_RESERVATION_LOST",
      });
      throw lost;
    }
  } catch (error) {
    // Terminal, not retryable: the bytes lived only in this request, so
    // there is nothing for a later attempt to download.
    await failBatch(batch.id, "upload", error, {
      workerId: SYNC_WORKER_ID,
      attemptCount: batch.attemptCount,
    }, { deferSourcePurge: true }).catch((cleanupError) => {
      logger.error(
        { batchId: batch.id, cleanupStage: "persist-terminal-purge", failureKind: cleanupError instanceof Error ? cleanupError.name : "unknown" },
        "CSV upload failure could not persist terminal cleanup",
      );
    });
    await compensateCsvUploadAttempt(input.businessProfileId, batch.id, fileReference);
    throw error;
  } finally {
    clearInterval(uploadHeartbeat);
  }

  if (isAsync) {
    return {
      batchId: batch.id,
      title: batch.title,
      status: batch.status,
      processingStatus: CsvImportProcessingStatus.PENDING,
      totalRows: records.length,
      imported: 0,
      skipped: [],
      skippedCount: 0,
      skippedTruncated: false,
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
      // The batch row was created with this worker id and attemptCount 1, so
      // the request holds the lease it is about to check itself against.
      lease: { workerId: SYNC_WORKER_ID, attemptCount: 1 },
      seed: { imported: 0, skippedCount: 0, flagged: 0, progress: emptyProgress() },
    });
  } catch (error) {
    /*
     * NOT terminal: the file is in storage and the checkpoint says exactly
     * how far the committed chunks got, so the durable worker can finish what
     * the request could not. The owner sees an error now and a completed
     * import shortly — never a silent half-import.
     *
     * Unless the worker has already taken the batch over (a request slow
     * enough for its heartbeat to go stale): then the row belongs to that
     * attempt and this one must not rewrite its status.
     */
    if (!(error instanceof CsvLeaseLostError)) {
      await deferBatch(batch.id, "insert", error, 1, { workerId: SYNC_WORKER_ID, attemptCount: 1 });
    }
    throw error;
  }

  const completed = await completeBatch(batch.id, userId, input.businessProfileId, {
    workerId: SYNC_WORKER_ID,
    attemptCount: 1,
  });
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
    skippedCount: completed.skippedRows,
    skippedTruncated: false,
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
    businessProfile: { user: { status: AccountStatus.ACTIVE } },
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
  const totalStartedAt = performance.now();
  const queueWaitMs = Math.max(0, Date.now() - batch.nextAttemptAt.getTime());
  const lease: ImportLease = { workerId: CSV_WORKER_ID, attemptCount: batch.attemptCount };
  let storageMs = 0;
  let parseMs = 0;
  let chunkLoadMs = 0;
  let decompressMs = 0;
  let validationMs = 0;
  let insertMs = 0;
  let stage = "restore";
  try {
    const profile = await prisma.businessProfile.findUnique({
      where: { id: batch.businessProfileId },
      select: { id: true, userId: true, expectedMonthlyExpenses: true, largeExpenseThresholdPercent: true },
    });
    if (!profile) {
      throw new ImportStageError("validate", "Business profile no longer exists");
    }
    const meta = readMappingMeta(batch.mappingMeta);
    let records: Record<string, string>[];

    if (batch.stageId) {
      const chunkLoadStartedAt = performance.now();
      const staged = await prisma.cSVImportBatch.findUnique({
        where: { id: batch.id },
        include: { stageChunks: { orderBy: { chunkIndex: "asc" } } },
      });
      chunkLoadMs = performance.now() - chunkLoadStartedAt;
      if (!staged) throw new CsvLeaseLostError(batch.id);
      try {
        const decoded = await decodeStageChunks(staged);
        records = decoded.parsed.records;
        decompressMs = decoded.decompressMs;
      } catch {
        throw new ImportStageError("restore", "Staged CSV data failed its integrity check");
      }
    } else {
      if (!batch.fileReference) {
        throw new ImportStageError("download", "No stored file is available for this import");
      }
      stage = "download";
      const storageStartedAt = performance.now();
      const buffer = await downloadCsvFile(batch.fileReference);
      storageMs = performance.now() - storageStartedAt;
      if (!buffer) throw new ImportStageError("download", "Stored CSV data could not be downloaded");
      await heartbeatImportBatch(batch.id, lease);

      stage = "parse";
      const parseStartedAt = performance.now();
      try {
        ({ records } = parseCsv(buffer));
      } catch {
        throw new ImportStageError("parse", "Stored CSV data could not be parsed");
      }
      parseMs = performance.now() - parseStartedAt;
    }
    await heartbeatImportBatch(batch.id, lease);

    stage = "validate";
    const validationStartedAt = performance.now();
    let outcomes: RowOutcome[];
    try {
      outcomes = validateRows(records, meta.columnMapping, meta.recordType, meta.corrections, meta.mixedStrategy, meta.dateFormat);
    } catch {
      throw new ImportStageError("validate", "Stored CSV rows could not be validated");
    }
    validationMs = performance.now() - validationStartedAt;
    await heartbeatImportBatch(batch.id, lease);

    stage = "insert";
    const insertStartedAt = performance.now();
    await runImportChunks({
      batchId: batch.id,
      userId: profile.userId,
      profile,
      outcomes,
      startAtRow: batch.processedRows,
      lease,
      seed: {
        imported: batch.importedRows,
        skippedCount: batch.skippedRows,
        flagged: batch.flaggedRows,
        progress: readProgress(batch.resultSummary),
      },
    });

    await completeBatch(batch.id, profile.userId, batch.businessProfileId, lease);
    insertMs = performance.now() - insertStartedAt;
    const totalMs = performance.now() - totalStartedAt;
    const rowsProcessed = Math.max(0, outcomes.length - batch.processedRows);
    logger.info(
      {
        batchId: batch.id,
        attempt: batch.attemptCount,
        outcome: "complete",
        rows: outcomes.length,
        rowsProcessed,
        rowsPerSecond: insertMs > 0 ? Math.round((rowsProcessed / insertMs) * 1000) : rowsProcessed,
        queueWaitMs: Math.round(queueWaitMs),
        storageMs: Math.round(storageMs),
        parseMs: Math.round(parseMs),
        chunkLoadMs: Math.round(chunkLoadMs),
        decompressMs: Math.round(decompressMs),
        validationMs: Math.round(validationMs),
        insertMs: Math.round(insertMs),
        totalMs: Math.round(totalMs),
      },
      "CSV import worker attempt",
    );
  } catch (error) {
    const failureStage = error instanceof ImportStageError ? error.stage : stage;
    logger.info(
      {
        batchId: batch.id,
        attempt: batch.attemptCount,
        outcome: error instanceof CsvLeaseLostError ? "lease-lost" : "failed",
        failureStage,
        queueWaitMs: Math.round(queueWaitMs),
        storageMs: Math.round(storageMs),
        parseMs: Math.round(parseMs),
        chunkLoadMs: Math.round(chunkLoadMs),
        decompressMs: Math.round(decompressMs),
        validationMs: Math.round(validationMs),
        insertMs: Math.round(insertMs),
        totalMs: Math.round(performance.now() - totalStartedAt),
      },
      "CSV import worker attempt",
    );
    throw error;
  }
}

/** Runs at most one durable import attempt; the server scheduler calls this
 * repeatedly, beside the receipt and analysis workers. */
export async function runCsvImportWorkerOnce(): Promise<boolean> {
  const batch = await claimImportBatch();
  if (!batch) return false;
  try {
    await processClaimedBatch(batch);
  } catch (error) {
    // A newer attempt owns the row now; deferring it here would reset the
    // status, workerId and nextAttemptAt out from under that worker.
    if (error instanceof CsvLeaseLostError) {
      logger.warn({ batchId: batch.id }, "csv import lease reclaimed mid-attempt");
      return true;
    }
    const stage = error instanceof ImportStageError ? error.stage : "insert";
    logger.error(
      {
        batchId: batch.id,
        stage,
        failureKind: error instanceof Error ? error.name : "unknown",
        failureCode: stableCsvFailureCode(stage, error),
      },
      "csv import attempt failed",
    );
    await deferBatch(batch.id, stage, error, batch.attemptCount, {
      workerId: CSV_WORKER_ID,
      attemptCount: batch.attemptCount,
    });
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
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const staleBefore = new Date(now.getTime() - CSV_LEASE_MS);
  const count = await prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<{
      id: number;
      processingStatus: CsvImportProcessingStatus;
      stageId: string | null;
    }[]>(Prisma.sql`
      SELECT
        "ImportBatch_ID" AS id,
        "ImportBatch_ProcessingStatus" AS "processingStatus",
        "ImportBatch_StageID" AS "stageId"
      FROM "CSVImportBatch"
      WHERE "ImportBatch_CreatedAt" < ${cutoff}
        AND "ImportBatch_AttemptCount" >= ${CSV_MAX_ATTEMPTS}
        AND (
          (
            "ImportBatch_ProcessingStatus" = ${CsvImportProcessingStatus.PENDING}::"CsvImportProcessingStatus"
            AND "ImportBatch_NextAttemptAt" <= CURRENT_TIMESTAMP
          )
          OR (
            "ImportBatch_ProcessingStatus" = ${CsvImportProcessingStatus.PROCESSING}::"CsvImportProcessingStatus"
            AND (
              "ImportBatch_HeartbeatAt" IS NULL
              OR "ImportBatch_HeartbeatAt" <= ${staleBefore}
            )
          )
        )
      ORDER BY "ImportBatch_ID"
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `);
    const ids = candidates.map((candidate) => candidate.id);
    if (ids.length === 0) return 0;
    const failed = await tx.cSVImportBatch.updateMany({
      where: { id: { in: ids } },
      data: {
        processingStatus: CsvImportProcessingStatus.FAILED,
        failureStage: "stalled",
        lastError: "Import did not finish within 24 hours and its retries were exhausted",
        workerId: null,
        heartbeatAt: null,
      },
    });
    await tx.cSVImportStageChunk.deleteMany({ where: { importBatchId: { in: ids } } });
    for (const candidate of candidates) {
      const wasLegacyUploadReservation = candidate.stageId === null
        && candidate.processingStatus === CsvImportProcessingStatus.PROCESSING;
      await enqueueCsvSourcePurgeForTerminalBatch(
        tx,
        candidate.id,
        wasLegacyUploadReservation
          ? { notBefore: new Date(now.getTime() + CSV_AMBIGUOUS_UPLOAD_TOMBSTONE_GRACE_MS) }
          : {},
      );
    }
    return failed.count;
  });
  if (count > 0) logger.warn({ count }, "swept stalled csv imports to FAILED");
  return count;
}

/**
 * Removes abandoned upload reservations and review stages in bounded passes.
 * The purge helper re-locks every row before deleting it, so a stage confirmed
 * or heartbeated after this candidate read is preserved.
 */
export async function sweepExpiredCsvStages(): Promise<number> {
  const now = new Date();
  const staleStagingBefore = new Date(now.getTime() - STAGING_UPLOAD_LEASE_MS);
  const candidates = await prisma.cSVImportBatch.findMany({
    where: {
      OR: [
        {
          processingStatus: CsvImportProcessingStatus.STAGED,
          stageExpiresAt: { lte: now },
        },
        {
          processingStatus: CsvImportProcessingStatus.STAGING,
          OR: [
            { heartbeatAt: null },
            { heartbeatAt: { lte: staleStagingBefore } },
          ],
        },
      ],
    },
    select: { id: true },
    orderBy: [{ stageExpiresAt: "asc" }, { id: "asc" }],
    take: 100,
  });

  let purged = 0;
  for (const candidate of candidates) {
    const outcome = await purgeStagedBatch(candidate.id, {
      expiredBefore: now,
      staleStagingBefore,
    });
    if (outcome === "purged") purged += 1;
  }
  if (purged > 0) logger.info({ purged }, "swept expired CSV upload stages");
  return purged;
}
