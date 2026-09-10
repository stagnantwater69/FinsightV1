import { Prisma } from "@prisma/client";

/**
 * Server-side ordering for the combined records list.
 *
 * The Records table used to be sorted client-side over whatever page happened
 * to be loaded, so "Amount, highest first" answered with the largest amount
 * among the most recent N rows — a confidently wrong answer on a ledger of any
 * real size. The sort has to happen in the database, and it has to stay
 * compatible with the keyset cursor `search` already pages with.
 *
 * That is the whole constraint here: a keyset cursor is only safe when the
 * columns it carries are exactly the columns the query is ordered by. So every
 * supported sort is `[<sort column> <dir>, id <dir>]` — the unique `id`
 * tiebreak makes the position total even when many rows share an amount or a
 * date, and the cursor carries both halves of that key.
 */
export const RECORD_SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;

export type RecordSort = (typeof RECORD_SORTS)[number];

/** Exactly the order this endpoint has always returned. */
export const DEFAULT_RECORD_SORT: RecordSort = "date_desc";

type Direction = "asc" | "desc";

export function recordSortField(sort: RecordSort): "date" | "amount" {
  return sort === "amount_asc" || sort === "amount_desc" ? "amount" : "date";
}

export function recordSortDirection(sort: RecordSort): Direction {
  return sort === "date_asc" || sort === "amount_asc" ? "asc" : "desc";
}

/**
 * A cursor position in the *combined* expense+sales stream.
 *
 * Both key columns travel regardless of which one is in use, because the
 * controller mints one cursor for two tables and only the sort decides which
 * half matters.
 *
 * `mode` resolves the cross-table part. The merge orders equal keys as
 * expenses-then-sales, so when the last row handed out was a sales row every
 * expense sharing its key is already spent (`exclude-key`), and when it was an
 * expense row the sales rows sharing that key are still owed (`include-key`).
 * `same-type` is the strict keyset step within the table the cursor came from.
 */
export interface RecordCursor {
  date: Date;
  /** Decimal string, read only when sorting by amount. */
  amount?: string;
  id: number;
  mode: "same-type" | "include-key" | "exclude-key";
}

type Comparison<T> = { lt?: T; lte?: T; gt?: T; gte?: T };

/** Structurally compatible with both records' Prisma `WhereInput`. */
export interface RecordCursorWhere {
  date?: Date | Comparison<Date>;
  amount?: Prisma.Decimal | Comparison<Prisma.Decimal>;
  id?: Comparison<number>;
  OR?: RecordCursorWhere[];
}

export function recordOrderBy(sort: RecordSort = DEFAULT_RECORD_SORT) {
  const direction = recordSortDirection(sort);
  return recordSortField(sort) === "amount"
    ? [{ amount: direction }, { id: direction }]
    : [{ date: direction }, { id: direction }];
}

export function recordCursorWhere(
  cursor: RecordCursor | undefined,
  sort: RecordSort = DEFAULT_RECORD_SORT,
): RecordCursorWhere | undefined {
  if (!cursor) return undefined;

  const direction = recordSortDirection(sort);
  const past = direction === "desc" ? "lt" : "gt";
  const pastOrAt = direction === "desc" ? "lte" : "gte";

  if (recordSortField(sort) === "amount") {
    // A cursor minted under a date sort has no amount; refusing it is the
    // controller's job, but never silently page from position zero.
    const value = new Prisma.Decimal(cursor.amount ?? "0");
    if (cursor.mode === "include-key") return { amount: { [pastOrAt]: value } };
    if (cursor.mode === "exclude-key") return { amount: { [past]: value } };
    return { OR: [{ amount: { [past]: value } }, { amount: value, id: { [past]: cursor.id } }] };
  }

  if (cursor.mode === "include-key") return { date: { [pastOrAt]: cursor.date } };
  if (cursor.mode === "exclude-key") return { date: { [past]: cursor.date } };
  return { OR: [{ date: { [past]: cursor.date } }, { date: cursor.date, id: { [past]: cursor.id } }] };
}
