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

/**
 * The server's row rules, mirrored so a bad row can be shown and fixed
 * BEFORE the import runs rather than reported after it.
 *
 * This is a deliberate second copy of csvImport.service's validateRows, for
 * the same reason the receipt split editor re-checks its own arithmetic: the
 * server is still the authority and re-runs every one of these checks on the
 * corrected value, so the worst a drift here can do is show the owner a
 * problem that turns out not to be one (or miss one, which the server then
 * reports exactly as it does today). It can never let a bad row through.
 * The checks and their order — description, then date, then amount, then
 * category — match the server's so the reported reason is the same one.
 */
export type RowProblem = { field: MappedField; reason: string } | null;

/** FinSight's own field names — the things a CSV column can become. */
export type MappedField = "Date" | "Description" | "Category" | "Vendor" | "Amount";

export interface MappedColumn {
  /** FinSight's own field name — the thing this column becomes on import. */
  field: MappedField;
  /** The CSV header currently feeding it, or "" when unmapped. */
  value: string;
  onChange: (v: string) => void;
  /** True while this is still FinSight's guess rather than the owner's choice. */
  auto: boolean;
  align?: "right";
  /** Leaving it unmapped is a valid choice — currently Vendor alone. */
  optional?: boolean;
}
