import type { CsvProcessingStatus } from "../../../lib/types";

/**
 * POST /records/csv-imports/confirm, and the summary shown when an import
 * ends. The backend's ConfirmResult; scripts/check-type-parity.mjs keeps it in
 * step with web's copy in web/src/pages/importCsv/types.ts.
 */
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
  /** Another completed import of this profile carried byte-identical content. */
  duplicateOfBatchId?: number;
  /** Total skipped rows. Exceeds `skipped.length` when the worker capped its list. */
  skippedCount?: number;
  skippedTruncated?: boolean;
}
