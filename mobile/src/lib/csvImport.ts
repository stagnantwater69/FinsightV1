/**
 * The CSV import screen's pure logic: header guessing, per-row validation,
 * the corrections payload, and the replay token that makes a retry safe.
 *
 * WHY IT IS A LIBRARY AND NOT PART OF THE SCREEN. Everything here is a rule
 * the SERVER also applies, and mobile had none of it — the app posted a
 * mapping and found out afterwards which rows were thrown away. Pulling the
 * rules out of the screen is what lets them be unit-tested against the
 * server's own reasons (there is no render harness on mobile, so anything
 * left inside a component is untestable by construction).
 *
 * IT IS A PRE-CHECK, NEVER A GATE. The server re-runs every one of these
 * checks on the corrected value (csvImport.service `validateRows`), so the
 * worst a drift here can do is show the owner a problem that turns out not to
 * be one, or miss one the server then reports exactly as it does today. It
 * can never let a bad row through — which is also why the reasons below are
 * copied from the server WORD FOR WORD: a row that gets skipped anyway should
 * say the same sentence in both places.
 */

import { FIELD_LIMITS } from "./fieldLimits";
import { parseCsvDate, type CsvDateFormat } from "./csvDates";
import { classifyTypeValue, parseSignedAmount, type RowRecordType } from "./recordTypeDetection";

/** What the file is read as. "mixed" splits it row by row. */
export type ImportRecordType = "expense" | "sales" | "mixed";
/** How a mixed file says which row is which. */
export type MixedStrategy = "column" | "sign";

/** The FinSight fields a CSV column can be pointed at. */
export type MappedField = "date" | "description" | "amount" | "category" | "vendor" | "recordType";

export type ColumnMapping = Record<MappedField, string>;

export const EMPTY_MAPPING: ColumnMapping = {
  date: "",
  description: "",
  amount: "",
  category: "",
  vendor: "",
  recordType: "",
};

/**
 * Header synonyms, mirroring web's list exactly.
 *
 * Owners export from Excel, Google Sheets, a POS app or a bookkeeper's
 * template, and the headings are mostly the obvious English words — plus the
 * Filipino ones that turn up on locally-made templates. Mobile previously
 * guessed with four ad-hoc regexes and had no vendor guess at all, so a
 * supplier column was never offered on a phone.
 *
 * The guess is a starting point, never a decision: every field stays editable.
 */
export const HEADER_SYNONYMS: Record<Exclude<MappedField, "recordType">, string[]> = {
  date: ["date", "txn date", "transaction date", "trans date", "posted", "day", "petsa"],
  description: ["description", "item", "particulars", "details", "detail", "memo", "notes", "note"],
  amount: ["amount", "total", "price", "cost", "value", "debit", "halaga"],
  category: ["category", "type", "class", "account", "group", "uri"],
  vendor: ["vendor", "supplier", "store", "shop", "merchant", "payee", "seller", "from", "tindahan"],
};

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

/**
 * The whole mapping, guessed from the headers plus what the server noticed
 * about the file's contents.
 *
 * A detected type column takes itself back from `category`, whose synonym
 * list contains "type": a Sale/Expense column auto-mapped as category names
 * would quietly create categories called "Sale" and "Expense".
 */
export function guessMapping(
  headers: string[],
  detected: { detectedTypeColumn?: string | null; columnsWithNegatives?: string[] },
): { mapping: ColumnMapping; recordType: ImportRecordType; mixedStrategy: MixedStrategy; autoMapped: MappedField[] } {
  const typeColumn = detected.detectedTypeColumn ?? "";
  const category = guessColumn(headers, "category");
  const amount = guessColumn(headers, "amount");

  const mapping: ColumnMapping = {
    date: guessColumn(headers, "date"),
    description: guessColumn(headers, "description"),
    amount,
    category: category && category === typeColumn ? "" : category,
    vendor: guessColumn(headers, "vendor"),
    recordType: typeColumn,
  };

  let recordType: ImportRecordType = "expense";
  let mixedStrategy: MixedStrategy = "column";
  if (typeColumn) {
    recordType = "mixed";
    mixedStrategy = "column";
  } else if (amount && (detected.columnsWithNegatives ?? []).includes(amount)) {
    recordType = "mixed";
    mixedStrategy = "sign";
  }

  const autoMapped = (Object.keys(mapping) as MappedField[]).filter((f) => mapping[f] !== "");
  return { mapping, recordType, mixedStrategy, autoMapped };
}

/**
 * Which fields must be mapped before the import can run, for this choice of
 * record type and strategy.
 *
 * Category is required for a PURE expense import and optional for a mixed
 * one — a combined export often has no category column at all, and those rows
 * land in "Uncategorised" rather than being rejected. Vendor is never
 * required: ExpenseRecord.vendor is nullable.
 */
export function requiredFields(recordType: ImportRecordType, mixedStrategy: MixedStrategy): MappedField[] {
  const fields: MappedField[] = ["date", "description", "amount"];
  if (recordType === "expense") fields.push("category");
  if (recordType === "mixed" && mixedStrategy === "column") fields.push("recordType");
  return fields;
}

/** Which fields may be mapped at all — sales rows carry no category or vendor. */
export function offeredFields(recordType: ImportRecordType, mixedStrategy: MixedStrategy): MappedField[] {
  const fields: MappedField[] = ["date", "description", "amount"];
  if (recordType !== "sales") fields.push("category", "vendor");
  if (recordType === "mixed" && mixedStrategy === "column") fields.push("recordType");
  return fields;
}

export interface MappingCheck {
  /** Fields still needing a column. */
  missing: MappedField[];
  /** Column names pointed at by more than one field. */
  duplicated: string[];
  ready: boolean;
}

/**
 * One CSV column mapped to two FinSight fields is always a mistake — it would
 * import the description as the amount — and nothing on mobile stopped it.
 */
export function checkMapping(
  mapping: ColumnMapping,
  recordType: ImportRecordType,
  mixedStrategy: MixedStrategy,
): MappingCheck {
  const missing = requiredFields(recordType, mixedStrategy).filter((f) => !mapping[f]);
  const used = offeredFields(recordType, mixedStrategy)
    .map((f) => mapping[f])
    .filter((col) => col !== "");
  const duplicated = [...new Set(used.filter((col, i) => used.indexOf(col) !== i))];
  return { missing, duplicated, ready: missing.length === 0 && duplicated.length === 0 };
}

// ---------------------------------------------------------------- Row rules

/** The cell limits the server enforces, named from the columns behind them. */
const CELL_LIMITS = {
  description: FIELD_LIMITS.recordDescription,
  vendor: FIELD_LIMITS.vendor,
  category: FIELD_LIMITS.categoryName,
} as const;

/** Decimal(12,2): ten integer digits, two fraction digits. */
const MAX_AMOUNT_EXCLUSIVE = 1e10;

export type CorrectableField = "date" | "description" | "amount" | "category";

/** The four cells a correction may replace — the server's `corrections` schema. */
export const CORRECTABLE_FIELDS: CorrectableField[] = ["date", "description", "amount", "category"];

export interface RowProblem {
  /** Which cell to put the correction field against. */
  field: MappedField;
  /** The server's own skip reason, word for word. */
  reason: string;
}

export type RowValues = Record<MappedField, string>;

export interface RowRules {
  recordType: ImportRecordType;
  mixedStrategy: MixedStrategy;
  /** The convention dates are read under — the owner's answer, or the file's. */
  dateFormat: CsvDateFormat;
}

/**
 * The first thing wrong with one row, or null.
 *
 * The checks and their ORDER mirror csvImport.service's `validateRows`:
 * description, description length, date, amount, amount range, amount scale,
 * row type, category, category length, vendor length. The order matters
 * because only the first problem is reported, and a row shown as "invalid
 * date" that the server skips as "missing description" sends the owner to fix
 * the wrong cell.
 */
export function rowProblem(values: RowValues, rules: RowRules): RowProblem | null {
  const description = values.description.trim();
  if (!description) return { field: "description", reason: "Missing description" };
  if (description.length > CELL_LIMITS.description) {
    return {
      field: "description",
      reason: `Description is longer than ${CELL_LIMITS.description} characters`,
    };
  }

  const rawDate = values.date.trim();
  if (!rawDate || !parseCsvDate(rawDate, rules.dateFormat)) {
    return { field: "date", reason: `Invalid date: "${rawDate}"` };
  }

  const rawAmount = values.amount.trim();
  const signed = parseSignedAmount(rawAmount);
  const usesSign = rules.recordType === "mixed" && rules.mixedStrategy === "sign";
  const amount = usesSign && signed !== null ? Math.abs(signed) : signed;

  if (amount === null || !Number.isFinite(amount) || amount <= 0) {
    return { field: "amount", reason: `Invalid amount: "${rawAmount}"` };
  }
  if (Math.abs(amount) >= MAX_AMOUNT_EXCLUSIVE) {
    return { field: "amount", reason: `Amount too large: "${rawAmount}"` };
  }
  if (Number(amount.toFixed(2)) !== amount) {
    return { field: "amount", reason: `Invalid amount: "${rawAmount}" has more than two decimal places` };
  }

  const rowType = resolveRowType(values, rules, signed);
  if (rowType === null) {
    const rawType = values.recordType.trim();
    return {
      field: "recordType",
      reason: rawType
        ? `Could not tell if "${rawType}" means a sale or an expense`
        : "Missing sale/expense value",
    };
  }

  if (rowType === "expense") {
    const category = values.category.trim();
    // Missing only matters for a single-type import: a mixed file's expense
    // rows fall back to "Uncategorised" rather than being thrown away.
    if (!category && rules.recordType !== "mixed") {
      return { field: "category", reason: "Missing category" };
    }
    if (category && category.length > CELL_LIMITS.category) {
      return { field: "category", reason: `Category name is longer than ${CELL_LIMITS.category} characters` };
    }
    const vendor = values.vendor.trim();
    if (vendor && vendor.length > CELL_LIMITS.vendor) {
      return { field: "vendor", reason: `Vendor is longer than ${CELL_LIMITS.vendor} characters` };
    }
  }

  return null;
}

/** What this row becomes — the owner's choice, or the file's own statement. */
export function resolveRowType(
  values: RowValues,
  rules: RowRules,
  signedAmount?: number | null,
): RowRecordType | null {
  if (rules.recordType !== "mixed") return rules.recordType;
  if (rules.mixedStrategy === "sign") {
    const signed = signedAmount === undefined ? parseSignedAmount(values.amount) : signedAmount;
    if (signed === null || signed === 0) return null;
    return signed < 0 ? "expense" : "sales";
  }
  return classifyTypeValue(values.recordType);
}

export interface AnalysedRow {
  /** The SPREADSHEET's own row number — header is row 1 — which is also the
   * key the server reports skips and accepts corrections against. */
  rowNumber: number;
  values: RowValues;
  problem: RowProblem | null;
  rowType: RowRecordType | null;
}

export type Corrections = Record<number, Partial<Record<CorrectableField, string>>>;

/**
 * Every previewed row read through the mapping and through any correction the
 * owner has typed.
 */
export function analyseRows(
  previewRows: Record<string, string>[],
  mapping: ColumnMapping,
  corrections: Corrections,
  rules: RowRules,
): AnalysedRow[] {
  return previewRows.map((row, i) => {
    const rowNumber = i + 2;
    const fix = corrections[rowNumber];
    const read = (field: MappedField): string => {
      const corrected = CORRECTABLE_FIELDS.includes(field as CorrectableField)
        ? fix?.[field as CorrectableField]
        : undefined;
      if (corrected !== undefined) return corrected;
      const column = mapping[field];
      return column ? (row[column] ?? "") : "";
    };
    const values: RowValues = {
      date: read("date"),
      description: read("description"),
      amount: read("amount"),
      category: read("category"),
      vendor: read("vendor"),
      recordType: read("recordType"),
    };
    return { rowNumber, values, problem: rowProblem(values, rules), rowType: resolveRowType(values, rules) };
  });
}

/**
 * Problem rows first, each group still in file order.
 *
 * A phone shows about two cards at a time. Leaving the four rows that need
 * fixing scattered through three hundred that do not is the same as hiding
 * them — and the whole reason for a review step is that they get fixed BEFORE
 * the import, not reported after it.
 */
export function problemsFirst(rows: AnalysedRow[]): AnalysedRow[] {
  return [...rows.filter((r) => r.problem !== null), ...rows.filter((r) => r.problem === null)];
}

/** How many rows on screen are still broken, and how many were fixed. */
export function reviewCounts(rows: AnalysedRow[], corrections: Corrections) {
  return {
    total: rows.length,
    problems: rows.filter((r) => r.problem !== null).length,
    corrected: Object.keys(corrections).length,
  };
}

/**
 * Category names in the file this business does not have yet.
 *
 * Worth saying out loud because confirmImport CREATES every name it cannot
 * match, silently. That is the right behaviour — an import must not fail
 * because a category does not exist — but it means one typo becomes a
 * permanent second category, found weeks later in a report that has split the
 * same spending across two lines. Matched case-insensitively because the
 * server matches that way.
 */
export function newCategoryNames(rows: AnalysedRow[], existingNames: string[]): string[] {
  const existing = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const seen = new Map<string, string>();
  for (const { values, rowType } of rows) {
    if (rowType === "sales") continue;
    const raw = values.category.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!existing.has(key) && !seen.has(key)) seen.set(key, raw);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- Payloads

/**
 * A title the server will accept, from a file name.
 *
 * THE BUG THIS FIXES: mobile posted `file.name` raw. The server caps the
 * title at 150 characters, so a long file name — an export named by a bank
 * app, or anything from a phone's Downloads folder — 400'd the whole import
 * with a validation error that named a field the screen never showed. The
 * extension goes because "expenses.csv" is a file name, not what an owner
 * calls a month of records, and the truncation is on a word boundary where
 * one is available so the result reads as a name rather than as a cut string.
 */
export function defaultImportTitle(fileName: string, limit: number = FIELD_LIMITS.importTitle): string {
  const base = fileName.replace(/\.csv$/i, "").trim();
  if (!base) return "Imported records";
  if (base.length <= limit) return base;
  const cut = base.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a word if that keeps most of the allowance — otherwise a
  // name with one early space would be cut down to almost nothing.
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The replay token for one confirm.
 *
 * THIS IS WHAT MAKES A RETRY SAFE. A confirm sent twice — a tap on a slow
 * connection, a retry after a timeout that actually succeeded — imports the
 * file twice, and doubling a month of books is the worst thing this screen
 * can do. The server deduplicates on this key and returns the SAME logical
 * import for a replay.
 *
 * Generated ONCE PER FILE SELECTION and reused on every retry of that file.
 * Regenerating it on each attempt would defeat the entire mechanism, so the
 * screen holds it in state next to the file rather than making one at send
 * time.
 *
 * Format: 8..100 characters of the server's accepted range, with enough
 * randomness that two phones importing at the same second cannot collide.
 */
export function newIdempotencyKey(): string {
  const random = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `m-${Date.now().toString(36)}-${random()}-${random()}`;
}

/**
 * The `corrections` multipart field, keyed by spreadsheet row number.
 *
 * Empty rows and untouched fields are dropped: an empty object would still be
 * a correction as far as the server is concerned, and an empty string is a
 * meaningful correction (it clears a cell) so it is NOT dropped.
 */
export function correctionsPayload(corrections: Corrections): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [rowNumber, fields] of Object.entries(corrections)) {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, string][];
    if (entries.length === 0) continue;
    out[rowNumber] = Object.fromEntries(entries);
  }
  return out;
}

/**
 * The `columnMapping` multipart field.
 *
 * Optional columns are OMITTED rather than sent empty — the server's schema
 * takes them as absent, and `""` fails its `min(1)`.
 */
export function columnMappingPayload(
  mapping: ColumnMapping,
  recordType: ImportRecordType,
  mixedStrategy: MixedStrategy,
): Record<string, string> {
  const payload: Record<string, string> = {
    date: mapping.date,
    description: mapping.description,
    amount: mapping.amount,
  };
  if (recordType !== "sales") {
    if (mapping.category) payload.category = mapping.category;
    if (mapping.vendor) payload.vendor = mapping.vendor;
  }
  if (recordType === "mixed" && mixedStrategy === "column" && mapping.recordType) {
    payload.recordType = mapping.recordType;
  }
  return payload;
}

/**
 * How far a large import has got, as a fraction of its rows.
 *
 * Returns null when the server has not said how many rows there are — an
 * honest "still working" beats a bar that moves on a number nobody measured.
 * ADR-4's rule: never fake determinate progress.
 */
export function importProgress(status: {
  totalRows?: number | null;
  processedRows?: number | null;
}): { done: number; total: number; fraction: number } | null {
  const total = status.totalRows ?? 0;
  const done = status.processedRows ?? 0;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { done, total, fraction: Math.max(0, Math.min(1, done / total)) };
}
