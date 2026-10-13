import { looksLikeDate } from "./csvDates";
import { parseSignedAmount } from "./recordTypeDetection";

/**
 * Which column of an uploaded CSV holds which field, without asking the owner.
 *
 * The import used to open on a mapping form: four dropdowns to match
 * "transaction_date" to Date and "total" to Amount. Almost every file says
 * plainly what its columns are, so the importer reads them itself and the
 * owner only corrects the rare miss on the review screen.
 *
 * Three signals, strongest first:
 *   1. The heading, against the names owners' tools actually export
 *      ("Txn Date", "Supplier", "Amount (PHP)", "Petsa").
 *   2. The values, which must agree: a column is only a date if its cells read
 *      as dates, only an amount if they read as numbers. "Posted By" does not
 *      become the date because its heading contains "posted".
 *   3. When no heading matches at all, the values alone: the column that is
 *      all dates, the column that is all numbers, the longest text.
 *
 * Columns FinSight has nowhere to store (payment method, notes, a reference
 * number, a customer) are recognised and reported as not imported, so the
 * owner sees them named rather than silently dropped.
 */

export type DetectedField = "date" | "description" | "amount" | "category" | "vendor";

/** Recognised columns the record model has no field for. */
export type ExtraField = "paymentMethod" | "notes" | "reference" | "quantity" | "customer" | "unitPrice";

export interface ColumnDetection {
  mapping: Partial<Record<DetectedField, string>>;
  /** Every header not used by `mapping`, with what it appears to be when that is known. */
  unmapped: { header: string; field: ExtraField | null }[];
  /** What the headings and file name suggest the rows are, or null when nothing does. */
  suggestedRecordType: "expense" | "sales" | null;
}

/** A heading reduced to comparable words: "transactionDate", "Txn_Date (PHP)" and "txn date" agree. */
export function normaliseHeader(header: string): string {
  return header
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\((php|₱|peso|pesos)\)/g, " ")
    .replace(/[₱#]/g, " ")
    .replace(/[_\-./\\:()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Heading names per field, most specific first — the position is the tie
 * breaker, so "Total" beats "Price" when a file has both.
 */
const FIELD_NAMES: Record<DetectedField | ExtraField, string[]> = {
  date: [
    "date", "transaction date", "txn date", "trans date", "expense date", "purchase date", "sale date", "sales date",
    "order date", "invoice date", "receipt date", "payment date", "paid date", "posting date", "value date", "entry date",
    "bill date", "posted", "day", "petsa", "datetime", "timestamp",
  ],
  description: [
    "description", "item", "item name", "item description", "items", "particulars", "details", "detail", "product",
    "product name", "product service", "service", "product or service", "expense", "expense name", "purchase",
    "narration", "name", "memo", "notes", "note", "remarks",
  ],
  amount: [
    "amount", "total", "total amount", "amount paid", "net amount", "grand total", "sale amount", "sales amount",
    "expense amount", "payment amount", "revenue", "income", "debit", "cash out", "halaga", "value", "cost", "subtotal",
    "gross", "price",
  ],
  category: [
    "category", "expense category", "category name", "expense type", "classification", "class", "account", "group",
    "type", "uri",
  ],
  vendor: [
    "vendor", "supplier", "merchant", "store", "shop", "payee", "seller", "vendor name", "supplier name", "store name",
    "paid to", "company", "from", "tindahan",
  ],
  paymentMethod: ["payment method", "method", "mode of payment", "payment mode", "payment type", "paid via", "payment", "tender"],
  notes: ["notes", "note", "remarks", "remark", "comments", "comment", "memo"],
  reference: [
    "reference", "ref", "ref no", "reference no", "reference number", "receipt no", "receipt number", "or no", "or number",
    "invoice no", "invoice number", "transaction id", "txn id", "order id", "order no", "id", "no",
  ],
  quantity: ["quantity", "qty", "units", "pcs", "count"],
  customer: ["customer", "customer name", "client", "client name", "buyer", "sold to"],
  unitPrice: ["unit price", "unit cost", "price per unit", "rate", "srp"],
};

const SAMPLE_ROWS = 200;
/** Share of a column's non-empty cells that must agree with its heading. */
const VALUE_AGREEMENT = 0.6;
/** Share needed when the values are the only evidence. */
const VALUE_ONLY_AGREEMENT = 0.8;

function sampleValues(rows: Record<string, string>[], header: string): string[] {
  return rows.slice(0, SAMPLE_ROWS).map((row) => (row[header] ?? "").trim()).filter(Boolean);
}

function share(values: string[], test: (value: string) => boolean): number {
  if (values.length === 0) return 0;
  return values.filter(test).length / values.length;
}

const isAmount = (value: string) => parseSignedAmount(value) !== null;

/**
 * How well a heading names a field. An exact name beats the same name inside a
 * longer heading, but only by a little: position in the list matters more, so
 * "Expense Description" (contains the first description name) still beats an
 * exact "Notes" (the last one).
 */
function headingScore(normalised: string, names: string[]): number {
  const exact = names.indexOf(normalised);
  if (exact >= 0) return 200 - exact * 5;
  const padded = ` ${normalised} `;
  const contained = names.findIndex((name) => name.length > 2 && padded.includes(` ${name} `));
  return contained >= 0 ? 150 - contained * 5 : 0;
}

/** Headings that are never the row's total, whatever else they contain ("Unit Price", "Qty", "Ref No"). */
function isPerUnitOrReference(normalised: string): boolean {
  return [...FIELD_NAMES.unitPrice, ...FIELD_NAMES.quantity, ...FIELD_NAMES.reference].includes(normalised);
}

const SALES_HINTS = /\b(sales?|sold|revenue|income|customer|client|buyer|order|invoice|benta)\b/;
const EXPENSE_HINTS = /\b(expenses?|expenditure|spend|spent|purchases?|supplier|vendor|payee|merchant|bills?|gastos|category)\b/;

export function detectColumns(
  headers: string[],
  rows: Record<string, string>[],
  options: { typeColumn?: string | null; fileName?: string | null } = {},
): ColumnDetection {
  const candidates = headers.filter((header) => header !== options.typeColumn);
  const normalised = new Map(candidates.map((header) => [header, normaliseHeader(header)]));
  const values = new Map(candidates.map((header) => [header, sampleValues(rows, header)]));

  const dateShare = (header: string) => share(values.get(header)!, looksLikeDate);
  const amountShare = (header: string) => share(values.get(header)!, isAmount);
  const empty = (header: string) => values.get(header)!.length === 0;

  /** Whether a column's contents allow it to be this field at all. */
  function valuesAgree(field: DetectedField, header: string): boolean {
    if (empty(header)) return field !== "date" && field !== "amount";
    if (field === "amount" && isPerUnitOrReference(normalised.get(header)!)) return false;
    if (field === "date") return dateShare(header) >= VALUE_AGREEMENT;
    if (field === "amount") return amountShare(header) >= VALUE_AGREEMENT && dateShare(header) < VALUE_AGREEMENT;
    // A text field made only of dates or only of numbers is misnamed.
    return dateShare(header) < VALUE_ONLY_AGREEMENT && amountShare(header) < 1;
  }

  const fields: DetectedField[] = ["date", "amount", "description", "category", "vendor"];
  const scored: { header: string; field: DetectedField; score: number }[] = [];
  for (const header of candidates) {
    for (const field of fields) {
      const score = headingScore(normalised.get(header)!, FIELD_NAMES[field]);
      if (score > 0 && valuesAgree(field, header)) scored.push({ header, field, score });
    }
  }
  // Best match first; a header and a field are each used once.
  scored.sort((a, b) => b.score - a.score || headers.indexOf(a.header) - headers.indexOf(b.header));
  const mapping: Partial<Record<DetectedField, string>> = {};
  const used = new Set<string>();
  for (const { header, field } of scored) {
    if (mapping[field] || used.has(header)) continue;
    mapping[field] = header;
    used.add(header);
  }

  // No heading named them: fall back on what the columns contain.
  const unused = () => candidates.filter((header) => !used.has(header) && !empty(header));
  if (!mapping.date) {
    const header = unused().find((h) => dateShare(h) >= VALUE_ONLY_AGREEMENT);
    if (header) {
      mapping.date = header;
      used.add(header);
    }
  }
  if (!mapping.amount) {
    // The right-most numeric column: exports put the total after quantity and price.
    const numeric = unused().filter(
      (h) => amountShare(h) >= VALUE_ONLY_AGREEMENT && dateShare(h) < VALUE_AGREEMENT && !isPerUnitOrReference(normalised.get(h)!),
    );
    const header = numeric[numeric.length - 1];
    if (header) {
      mapping.amount = header;
      used.add(header);
    }
  }
  if (!mapping.description) {
    const text = unused().filter((h) => amountShare(h) < VALUE_AGREEMENT && dateShare(h) < VALUE_AGREEMENT);
    const averageLength = (h: string) => {
      const cells = values.get(h)!;
      return cells.reduce((total, cell) => total + cell.length, 0) / cells.length;
    };
    const header = [...text].sort((a, b) => averageLength(b) - averageLength(a))[0];
    if (header) {
      mapping.description = header;
      used.add(header);
    }
  }

  const extras: ExtraField[] = ["paymentMethod", "notes", "reference", "quantity", "customer", "unitPrice"];
  const unmapped = headers
    .filter((header) => !used.has(header) && header !== options.typeColumn)
    .map((header) => {
      const name = normaliseHeader(header);
      let best: { field: ExtraField; score: number } | null = null;
      for (const field of extras) {
        const score = headingScore(name, FIELD_NAMES[field]);
        if (score > 0 && (!best || score > best.score)) best = { field, score };
      }
      return { header, field: best?.field ?? null };
    });

  const hintText = [...headers.map(normaliseHeader), normaliseHeader(options.fileName?.replace(/\.[^.]+$/, "") ?? "")].join(" ");
  const salesHints = (hintText.match(new RegExp(SALES_HINTS, "g")) ?? []).length;
  const expenseHints = (hintText.match(new RegExp(EXPENSE_HINTS, "g")) ?? []).length;
  const suggestedRecordType = salesHints > expenseHints ? "sales" : expenseHints > salesHints ? "expense" : null;

  return { mapping, unmapped, suggestedRecordType };
}
