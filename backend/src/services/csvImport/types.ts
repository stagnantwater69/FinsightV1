import type { CsvImportProcessingStatus } from "@prisma/client";
import type { CsvDateFormat } from "../../lib/csvDates";
import type { ExtraField } from "../../lib/csvColumnDetection";
import type { ImportCategoryDecision } from "../../lib/importCategoriser";

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
  availableFundsBaseline: {
    baselineAt: string;
    baselineDate: string;
    matchingRowCount: number;
  } | null;
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
  /**
   * The rest of what the importer read from the headings: columns FinSight
   * recognised but has no field for (shown as not imported, never silently
   * dropped), and whether the file looks like sales or expenses.
   */
  columnDetection?: {
    unmapped: { header: string; field: ExtraField | null }[];
    suggestedRecordType: "expense" | "sales" | null;
  };
  /** History-only suggestions for rows with no category. Kept for older clients. */
  categorySuggestions?: { row: number; categoryId: number; categoryName: string; source: "history" }[];
  categorySuggestionsTruncated?: boolean;
  /**
   * Rows past the preview sample that need the owner's eyes — skipped, possible
   * duplicates, or with no category — so they can be corrected on the review
   * screen instead of being fixed in the spreadsheet and uploaded again.
   */
  reviewRows?: { row: number; values: Record<string, string> }[];
  reviewRowsTruncated?: boolean;
  /** The category each on-screen expense row will be saved under, and why. */
  rowCategories?: ({ row: number } & ImportCategoryDecision)[];
  /** Category decisions across the whole file. */
  categorySummary?: {
    fromFile: number;
    suggested: number;
    uncategorised: number;
    /** Categories this import would create, with how many rows use each. */
    newCategories: { name: string; rows: number }[];
  };
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
  {
    date?: string;
    description?: string;
    amount?: string;
    category?: string;
    vendor?: string;
    includedInAvailableFundsBaseline?: boolean;
    /** The owner removed this row on the review screen; it is not imported. */
    exclude?: boolean;
  }
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
  includedInAvailableFundsBaseline?: boolean;
  availableFundsBaselineAt?: string;
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
