import { parseCsvDate } from "../../lib/csvDates";
import { parseSignedAmount } from "../../lib/recordTypeDetection";
import type { CsvDateFormat, CsvImportStatus } from "../../lib/types";
import type { ImportResult, MappedField, RowProblem } from "./types";

/**
 * The summary, rebuilt from a finished asynchronous import.
 *
 * A large file's confirm returns 202 with zero counts — the numbers only exist
 * once the worker is done, and they arrive through the status endpoint. This
 * maps that shape onto the one the summary screen already renders, so there is
 * exactly one summary screen rather than a second one for big files.
 */
export function resultFromStatus(status: CsvImportStatus, title: string): ImportResult {
  const summary = status.resultSummary ?? {};
  return {
    batchId: status.batchId,
    title,
    status: status.status,
    processingStatus: status.processingStatus,
    totalRows: status.totalRows,
    imported: status.importedRows,
    skipped: summary.skipped ?? [],
    skippedCount: status.skippedRows,
    skippedTruncated: summary.skippedTruncated ?? false,
    flagged: status.flaggedRows,
    largeExpenseFlagged: summary.largeExpenseFlagged ?? 0,
    importedExpenses: summary.importedExpenses,
    importedSales: summary.importedSales,
    uncategorised: summary.uncategorised,
  };
}

/**
 * How often the import status is asked for while a large file runs.
 *
 * The endpoint is two indexed reads with no parsing and no writes, and is
 * deliberately NOT rate limited on the server for exactly this reason — a
 * limit sized for confirms would start rejecting the polling the async import
 * depends on.
 */
export const STATUS_POLL_INTERVAL_MS = 1500;

/**
 * What is wrong with a row, if anything, in the words the review screen shows:
 * "Amount required", "Invalid date".
 *
 * A deliberate mirror of csvImport.service's validateRows, checked in the same
 * order (description, date, amount) so the row's badge names the same field the
 * server would skip it for. The server is still the authority and re-checks
 * every corrected value, so a drift here can only show a problem that is not
 * one, never let a bad row through.
 *
 * Category is not checked: an expense row with none is given one on import
 * (the owner's history, then FinSight's suggestion, then Uncategorised).
 */
export function problemWith(
  values: Record<MappedField, string>,
  dateFormat: CsvDateFormat,
  usesSignedAmounts = false,
  /** The business's today (YYYY-MM-DD); a later date is refused, as the server does. */
  today?: string,
): RowProblem {
  if (!values.Description.trim()) return { field: "Description", reason: "Description required" };

  // The shared calendar parser, NOT `new Date(rawDate)`, which guesses
  // month-first in browser-local time. See lib/csvDates.ts.
  const rawDate = values.Date.trim();
  if (!rawDate) return { field: "Date", reason: "Date required" };
  const isoDate = parseCsvDate(rawDate, dateFormat);
  if (isoDate === null) return { field: "Date", reason: "Invalid date" };
  if (today && isoDate > today) return { field: "Date", reason: "Date can't be in the future" };

  const rawAmount = values.Amount.trim();
  if (!rawAmount) return { field: "Amount", reason: "Amount required" };
  const signedAmount = parseSignedAmount(rawAmount);
  const amount = usesSignedAmounts && signedAmount !== null ? Math.abs(signedAmount) : signedAmount;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    return { field: "Amount", reason: "Invalid amount" };
  }
  // The server's Decimal(12,2) column: a third decimal place is a skip there.
  if (Number(amount.toFixed(2)) !== amount) return { field: "Amount", reason: "Too many decimals" };
  return null;
}
