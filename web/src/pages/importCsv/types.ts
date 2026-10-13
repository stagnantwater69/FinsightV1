import type { CsvDateFormat, CsvProcessingStatus } from "../../lib/types";

export interface PreviewResult {
  headers: string[];
  previewRows: Record<string, string>[];
  totalRows: number;
  /** The server's guess at a sale/expense column, from its values. May be absent on older responses. */
  detectedTypeColumn?: string | null;
  /** Columns mixing negative and positive numbers — candidates for the sign convention. */
  columnsWithNegatives?: string[];
  /**
   * The date convention the file appears to use, read off its first
   * date-shaped column.
   */
  detectedDateFormat?: CsvDateFormat;
  /**
   * True when every sampled date fits BOTH day-first and month-first readings.
   * Confirm refuses such a file until the owner says which, so this screen has
   * to ask before it will let them import — see the date-convention card.
   */
  dateFormatAmbiguous?: boolean;
  suggestedMapping?: Partial<Record<"date" | "description" | "amount" | "category" | "vendor" | "recordType", string>>;
  /** Headings FinSight recognised but has no field for, and whether the file looks like sales or expenses. */
  columnDetection?: {
    unmapped: { header: string; field: ExtraField | null }[];
    suggestedRecordType: "expense" | "sales" | null;
  };
  categorySuggestions?: { row: number; categoryId: number; categoryName: string; source: "history" }[];
  categorySuggestionsTruncated?: boolean;
  /** Rows past the 50-row sample that need review (skipped, duplicate, uncategorised). */
  reviewRows?: { row: number; values: Record<string, string> }[];
  reviewRowsTruncated?: boolean;
  /** The category each on-screen expense row will be saved under. */
  rowCategories?: RowCategory[];
  categorySummary?: {
    fromFile: number;
    suggested: number;
    uncategorised: number;
    newCategories: { name: string; rows: number }[];
  };
  validation?: {
    validRows: number;
    invalidRows: number;
    skipped: { row: number; reason: string }[];
    skippedTruncated: boolean;
    possibleDuplicateRows?: number;
    duplicateRows?: number[];
    duplicateRowsTruncated?: boolean;
  };
  /** Same-day rows that need an explicit relationship to the current balance anchor. */
  availableFundsBaseline?: {
    baselineAt: string;
    baselineDate: string;
    matchingRowCount: number;
  } | null;
}

/**
 * The first preview also creates the private, owner-scoped upload that every
 * later check and confirm reuses. Keeping this separate from PreviewResult
 * makes the upload boundary explicit: validation responses do not need to
 * mint or echo another handle.
 */
export interface StagedPreviewResult extends PreviewResult {
  stagedUploadId: string;
}

export interface ImportResult {
  batchId: number;
  title: string;
  status: string;
  totalRows: number;
  imported: number;
  skipped: { row: number; reason: string }[];
  flagged: number;
  largeExpenseFlagged: number;
  importedExpenses?: number;
  importedSales?: number;
  uncategorised?: number;
  /** Where the WRITE got to, as opposed to the owner-facing review status. */
  processingStatus?: CsvProcessingStatus;
  /**
   * Another completed import of this profile carried byte-identical content.
   * A warning, never a block: re-importing a corrected export is legitimate,
   * but importing the same file twice by accident is the single most common
   * way an owner doubles a month of records.
   */
  duplicateOfBatchId?: number;
  /** Total skipped rows. Exceeds `skipped.length` when the worker capped its list. */
  skippedCount?: number;
  skippedTruncated?: boolean;
}

/** What the file is being read as. "mixed" splits it row by row. */
export type ImportRecordType = "expense" | "sales" | "mixed";
/** How a mixed file says which row is which. */
export type MixedStrategy = "column" | "sign";

/** A recognised heading FinSight has no field for. */
export type ExtraField = "paymentMethod" | "notes" | "reference" | "quantity" | "customer" | "unitPrice";

/** Where a row's category came from — see backend lib/importCategoriser. */
export type RowCategorySource = "file" | "history" | "suggested" | "none";

export interface RowCategory {
  row: number;
  name: string;
  source: RowCategorySource;
  /** Not a category of this business yet; confirming the import creates it. */
  isNew: boolean;
  confidence: "high" | "medium" | "low";
}

/** Result of checking one row on the client, before the server re-checks it. */
export type RowProblem = { field: MappedField; reason: string } | null;

/** FinSight's own field names — the things a CSV column can become. */
export type MappedField = "Date" | "Description" | "Category" | "Vendor" | "Amount";

/** The owner's edits to one row, keyed by spreadsheet row number. */
export type RowCorrection = Partial<Record<MappedField, string>> & {
  exclude?: boolean;
  includedInAvailableFundsBaseline?: boolean;
};

/** Which CSV heading feeds each FinSight field; "" when none does. */
export type ColumnChoice = Record<"date" | "description" | "amount" | "category" | "vendor", string>;
