/**
 * Telling a sales row from an expense row, mirrored from the server.
 *
 * A DELIBERATE SECOND COPY of backend/src/lib/recordTypeDetection.ts, for the
 * same reason ImportCsv already mirrors the server's row rules: the preview has
 * to show every row's resolved type BEFORE the import runs, and it cannot ask
 * the server what each of 50 rows would become without sending the file back.
 *
 * Only the two pure readers are copied — the column and sign DETECTION that
 * chooses a strategy stays on the server and arrives in the preview response,
 * so there is one implementation of the part that decides.
 *
 * THE WORD LISTS MUST MATCH THE SERVER. A row this file badges as a sale and
 * the server files as an expense is the worst outcome available here: the
 * preview would be a lie about what was imported. They are pinned together in
 * backend/tests/contract/recordTypeDetection.test.ts.
 */

export type RowRecordType = "sales" | "expense";

/**
 * The words a type column actually contains, in English and Filipino.
 *
 * `debit`/`credit` are included and are the riskiest entries here: in
 * double-entry bookkeeping their meaning depends on the account, while on a
 * bank or e-wallet statement — which is what these files usually are — credit
 * is money in and debit is money out. The statement reading is the one that
 * matches the files owners actually export, and the preview shows every row's
 * resolved type before the import runs, so a file using the accounting
 * convention is visibly wrong rather than quietly wrong.
 */
export const SALES_WORDS = new Set([
  "sale",
  "sales",
  "income",
  "revenue",
  "credit",
  "cr",
  "in",
  "inflow",
  "deposit",
  "received",
  "benta",
  "kita",
  "pumasok",
]);

export const EXPENSE_WORDS = new Set([
  "expense",
  "expenses",
  "cost",
  "costs",
  "purchase",
  "purchases",
  "debit",
  "dr",
  "out",
  "outflow",
  "withdrawal",
  "payment",
  "paid",
  "spend",
  "spent",
  "gastos",
  "gasto",
  "bayad",
  "bili",
  "labas",
]);

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** What one cell of a type column means, or null when it means nothing we know. */
export function classifyTypeValue(raw: string | undefined | null): RowRecordType | null {
  if (!raw) return null;
  const value = normalise(raw);
  if (!value) return null;
  if (SALES_WORDS.has(value)) return "sales";
  if (EXPENSE_WORDS.has(value)) return "expense";
  return null;
}

/**
 * Reads an amount that may be negative, may carry thousands separators, a
 * currency symbol, or accounting parentheses — `(1,200.00)` is how a great many
 * spreadsheets write a negative.
 *
 * Returns null when there is no number here at all, which the caller reports as
 * an invalid amount rather than silently treating as zero.
 */
export function parseSignedAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let text = raw.trim();
  if (!text) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  // Strip currency symbols, the PHP/P prefix and separators, keeping sign and point.
  text = text.replace(/(php|piso|₱|p)\s*/gi, "").replace(/,/g, "").trim();
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

