/**
 * Telling sales rows from expense rows inside ONE file.
 *
 * WHY THIS IS NARROW ON PURPOSE. An owner who keeps one spreadsheet for
 * everything should not have to split it by hand before importing — that is
 * the whole point. But this is money moving in versus money moving out, and
 * every downstream number depends on getting it right: the recovery target,
 * the daily sales target, spending impact, every insight the AI is given.
 * A row filed the wrong way is not a cosmetic error, and nothing on screen
 * would ever tell the owner it happened.
 *
 * So detection reads only what the file STATES, never what it implies:
 *
 *   1. A type column — "Type", "Kind", "Uri" — whose values say sale or
 *      expense in words.
 *   2. The sign of the amount, the bank-statement convention: money out is
 *      negative, money in is positive.
 *
 * What it deliberately does NOT do is guess from descriptions or category
 * names. "Load" is a sale in a sari-sari store and an expense in a delivery
 * business, and no amount of keyword tuning fixes that — it only moves which
 * owners get silently wrong books. When neither signal is present the importer
 * asks rather than guesses.
 *
 * Everything here is pure, so the clients can run the same detection on the
 * preview rows and show the owner what it decided BEFORE anything is written.
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
 * A type column is low-cardinality by nature. This guard is what stops a
 * DESCRIPTION column that happens to contain the word "payment" a few times
 * from being mistaken for one.
 */
const MAX_DISTINCT_TYPE_VALUES = 6;

/** How much of a column has to be recognisable before we believe it. */
const MIN_RECOGNISED_SHARE = 0.7;

/**
 * Picks the column that says which kind of record each row is, or null.
 *
 * Chosen by its VALUES rather than its heading, deliberately. The obvious
 * heading — "Type" — is already claimed by the category column's synonym list,
 * so a header-driven guess would fight it; and plenty of real exports label
 * this column something unguessable like "Dr/Cr" or "Uri" while its contents
 * are perfectly clear.
 */
export function detectTypeColumn(rows: Record<string, string>[]): string | null {
  if (rows.length === 0) return null;
  const headers = Object.keys(rows[0]!);

  let best: { header: string; recognised: number } | null = null;

  for (const header of headers) {
    const values = rows.map((r) => (r[header] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;

    const distinct = new Set(values.map(normalise));
    if (distinct.size > MAX_DISTINCT_TYPE_VALUES) continue;

    const recognised = values.filter((v) => classifyTypeValue(v) !== null).length;
    if (recognised / values.length < MIN_RECOGNISED_SHARE) continue;

    // Ties go to the column that recognised more rows — a real type column
    // beats a sparsely-filled one that happens to qualify.
    if (!best || recognised > best.recognised) best = { header, recognised };
  }

  return best?.header ?? null;
}

/**
 * Whether a column uses signs to mean direction.
 *
 * Requires BOTH a negative and a positive value. A column that is all positive
 * carries no direction information, and reading it as "everything is a sale"
 * would be exactly the silent misfiling this module exists to avoid; a column
 * that is all negative is a formatting choice, not a distinction.
 */
export function detectSignedAmounts(rows: Record<string, string>[], amountColumn: string): boolean {
  if (!amountColumn) return false;
  let negatives = 0;
  let positives = 0;

  for (const row of rows) {
    const parsed = parseSignedAmount(row[amountColumn]);
    if (parsed === null) continue;
    if (parsed < 0) negatives++;
    else if (parsed > 0) positives++;
  }

  return negatives > 0 && positives > 0;
}

/**
 * Every column that mixes negative and positive numbers.
 *
 * Returned by the preview so the client can offer the sign strategy the moment
 * the owner maps one of them as the amount — the server cannot know which
 * column that is yet, because mapping happens after the preview.
 */
export function columnsWithSignedAmounts(rows: Record<string, string>[]): string[] {
  if (rows.length === 0) return [];
  return Object.keys(rows[0]!).filter((header) => detectSignedAmounts(rows, header));
}

/**
 * How many rows to look at when detecting.
 *
 * Detection is string work over every column, and a 30,000-row file would pay
 * for it on every preview to learn what the first few hundred rows already say.
 * A type column that does not reveal itself in 500 rows is not one.
 */
export const DETECTION_SAMPLE_ROWS = 500;

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

/** The category expense rows fall back to when a mixed file names none. */
export const DEFAULT_IMPORT_CATEGORY = "Uncategorised";
