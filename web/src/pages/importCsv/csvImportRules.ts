import { parseCsvDate } from "../../lib/csvDates";
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
 * Header synonyms, for guessing the column mapping.
 *
 * Owners export from Excel, Google Sheets, a POS app or a bookkeeper's
 * template, and the headings are mostly the obvious English words. Making
 * someone map four dropdowns by hand when their file literally says
 * "date,description,amount,category" is the kind of friction UAT item 32
 * measures ("could record a day quickly enough to do it regularly").
 *
 * The guess is a starting point, never a decision: every field stays editable
 * and says that it was matched automatically.
 */
export const HEADER_SYNONYMS: Record<"date" | "description" | "amount" | "category" | "vendor", string[]> = {
  date: ["date", "txn date", "transaction date", "trans date", "posted", "day", "petsa"],
  description: ["description", "item", "particulars", "details", "detail", "memo", "notes", "note"],
  amount: ["amount", "total", "price", "cost", "value", "debit", "halaga"],
  category: ["category", "type", "class", "account", "group", "uri"],
  vendor: ["vendor", "supplier", "store", "shop", "merchant", "payee", "seller", "from", "tindahan"],
};

export function problemWith(
  values: Record<MappedField, string>,
  needsCategory: boolean,
  dateFormat: CsvDateFormat,
): RowProblem {
  if (!values.Description.trim()) return { field: "Description", reason: "Missing description" };

  /*
   * Parsed with the shared calendar parser, NOT `new Date(rawDate)`.
   *
   * The string constructor guessed month-first, parsed in browser-local time
   * and rolled Feb 31 over into March — so this check used to pass rows the
   * server then skipped and flag rows it would have accepted. A preview that
   * disagrees with the import is worse than no preview: the owner "fixes" a
   * row that was never wrong. See lib/csvDates.ts.
   */
  const rawDate = values.Date.trim();
  if (!rawDate || parseCsvDate(rawDate, dateFormat) === null) {
    return { field: "Date", reason: `Invalid date: "${rawDate}"` };
  }

  const rawAmount = values.Amount.trim();
  const amount = rawAmount ? Number(rawAmount.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { field: "Amount", reason: `Invalid amount: "${rawAmount}"` };
  }

  if (needsCategory && !values.Category.trim()) {
    return { field: "Category", reason: "Missing category" };
  }
  return null;
}

function normalise(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

/** Exact synonym match first, then a contains match, so "Txn Date (PHP)" lands. */
export function guessColumn(headers: string[], field: keyof typeof HEADER_SYNONYMS): string {
  const synonyms = HEADER_SYNONYMS[field];
  const exact = headers.find((h) => synonyms.includes(normalise(h)));
  if (exact) return exact;
  return headers.find((h) => synonyms.some((s) => normalise(h).includes(s))) ?? "";
}
