import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { recordSortDirection, recordSortField, type RecordSort } from "../lib/recordSort";

/**
 * The record at one position of the combined expense+sales list.
 *
 * WHY THIS EXISTS. `search` pages with a keyset cursor, which only knows the
 * page after the one in hand. A client that wanted page 6,417 of a 64k-row
 * ledger had to walk the cursor chain — 6,400 sequential requests before
 * anything appeared. With the record that ENDS the page before the target,
 * `search` can mint the target page's cursor and answer in one request.
 *
 * ONE QUERY, NOT TWO. The position is in the merged stream, so neither table
 * can be offset on its own. Both halves are unioned here with the merge's
 * exact order — sort column, then expenses before sales, then id — which is
 * the order `makeComparator` in records.controller.ts reproduces in memory.
 *
 * The filters mirror searchExpenseWhere / searchSalesWhere. That duplication
 * is the price of one round trip, and tests/integration/recordPageJump.test.ts
 * pins it by comparing every jump against a walk of the cursor chain. The
 * keyword is passed to ILIKE unescaped on purpose: Prisma's `contains` does
 * the same, so `%` and `_` must behave identically in both.
 */
export interface RecordPositionFilters {
  businessProfileId: number;
  categoryId?: number;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  source?: "MANUAL_ENTRY" | "CSV_UPLOAD" | "RECEIPT_SCAN";
  importBatchId?: number;
}

export interface RecordAtPosition {
  type: "expense" | "sales";
  id: number;
  date: Date;
  amount: number;
}

const SOURCE_LABELS = {
  MANUAL_ENTRY: "Manual Entry",
  CSV_UPLOAD: "CSV Upload",
  RECEIPT_SCAN: "Receipt Scan",
} as const;

type RecordTable = "ExpenseRecord" | "SalesReferenceRecord";

const col = (table: RecordTable, name: string) => Prisma.raw(`"${table}"."${table}_${name}"`);

/** The filters as a WHERE clause for one table, matching searchExpenseWhere / searchSalesWhere. */
function conditions(table: RecordTable, filters: RecordPositionFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`"${Prisma.raw(table)}"."BusinessProfile_ID" = ${filters.businessProfileId}`];
  if (table === "ExpenseRecord" && filters.categoryId !== undefined) {
    conditions.push(Prisma.sql`"ExpenseRecord"."Category_ID" = ${filters.categoryId}`);
  }
  if (filters.source !== undefined) {
    const enumType = table === "ExpenseRecord" ? "ExpenseRecordSource" : "SalesRecordSource";
    conditions.push(Prisma.sql`${col(table, "Source")} = ${SOURCE_LABELS[filters.source]}::${Prisma.raw(`"${enumType}"`)}`);
  }
  if (filters.importBatchId !== undefined) {
    conditions.push(Prisma.sql`"${Prisma.raw(table)}"."ImportBatch_ID" = ${filters.importBatchId}`);
  }
  if (filters.dateFrom) conditions.push(Prisma.sql`${col(table, "Date")} >= ${filters.dateFrom}::date`);
  if (filters.dateTo) conditions.push(Prisma.sql`${col(table, "Date")} <= ${filters.dateTo}::date`);
  if (filters.keyword) conditions.push(Prisma.sql`${col(table, "Description")} ILIKE ${`%${filters.keyword}%`}`);
  return Prisma.join(conditions, " AND ");
}

function rowsOf(table: RecordTable, filters: RecordPositionFilters, extra?: Prisma.Sql): Prisma.Sql {
  const type = table === "ExpenseRecord" ? "expense" : "sales";
  const rank = table === "ExpenseRecord" ? 0 : 1;
  return Prisma.sql`
    SELECT ${type}::text AS "type", ${rank}::int AS "rank", ${col(table, "ID")} AS "id",
           ${col(table, "Date")} AS "date", ${col(table, "Amount")} AS "amount"
    FROM ${Prisma.raw(`"public"."${table}"`)}
    WHERE ${conditions(table, filters)}${extra ? Prisma.sql` AND ${extra}` : Prisma.empty}`;
}

/** Below this offset an amount jump sorts (see findRecordAtPosition). */
export const SORTED_AMOUNT_JUMP_LIMIT = 2_000;

type PositionOptions ={ includeExpenses: boolean; includeSales: boolean; sort: RecordSort; offset: number };
type PositionRow = { type: "expense" | "sales"; id: number; date: Date; amount: Prisma.Decimal };

function tablesFor(options: PositionOptions): RecordTable[] {
  return [
    ...(options.includeExpenses ? ["ExpenseRecord" as const] : []),
    ...(options.includeSales ? ["SalesReferenceRecord" as const] : []),
  ];
}

function toPosition(row: PositionRow | undefined): RecordAtPosition | null {
  return row ? { type: row.type, id: row.id, date: row.date, amount: Number(row.amount) } : null;
}

/**
 * Counts per group in both tables, then the group holding `offset` and how
 * many rows come before it. `group` is the grouping expression for a table,
 * `extra` an optional further condition (a bucket's range).
 */
function locate(
  tables: RecordTable[],
  filters: RecordPositionFilters,
  group: (table: RecordTable) => Prisma.Sql,
  dir: Prisma.Sql,
  offset: Prisma.Sql,
  extra?: (table: RecordTable) => Prisma.Sql,
): Prisma.Sql {
  const perTable = tables.map((table) => Prisma.sql`
    SELECT ${group(table)} AS "g", count(*) AS "n"
    FROM ${Prisma.raw(`"public"."${table}"`)}
    WHERE ${conditions(table, filters)}${extra ? Prisma.sql` AND ${extra(table)}` : Prisma.empty}
    GROUP BY 1`);
  return Prisma.sql`
    SELECT "g", "before" FROM (
      SELECT "g", "n", sum("n") OVER (ORDER BY "g" ${dir}) - "n" AS "before"
      FROM (SELECT "g", sum("n") AS "n" FROM (${Prisma.join(perTable, " UNION ALL ")}) AS per_table GROUP BY "g") AS per_group
    ) AS running
    WHERE "before" <= ${offset} AND "before" + "n" > ${offset}`;
}

/**
 * The record at zero-based `offset`, or null past the end. Only the halves
 * `search` itself would query are included, so positions agree with it.
 *
 * WITHOUT SORTING THE LEDGER. Ordering every row and skipping `offset` of them
 * sorted the whole business on disk: ~410 ms by date and ~730 ms by amount for
 * a jump 80% into 500,000 records (tests/load/query-plans.ts). Instead, still
 * in one round trip:
 *
 *   1. count rows per group (a day, or a whole-peso amount bucket) and find,
 *      by running total in the sort direction, the group holding `offset`;
 *   2. for amounts, count exact amounts inside that bucket the same way;
 *   3. among the few rows sharing that exact date or amount, take the one at
 *      the remaining offset in the merge's tie order: expenses before sales,
 *      then id in the sort direction.
 *
 * Measured at 500,000 records: date jumps ~38 ms at any depth (sorting:
 * 65-330 ms). Amount jumps shallower than SORTED_AMOUNT_JUMP_LIMIT still sort,
 * which is faster there.
 *
 * findRecordAtPositionBySorting is the one-sort version; the tests hold the
 * two equal.
 */
export async function findRecordAtPosition(
  userId: number,
  filters: RecordPositionFilters,
  options: PositionOptions,
): Promise<RecordAtPosition | null> {
  // A shallow amount jump is cheaper sorted: the sort keeps only offset + 1
  // rows, while counting always reads the whole ledger's amounts. Measured
  // crossover at 500,000 records: between 2,500 and 5,000.
  if (recordSortField(options.sort) === "amount" && options.offset < SORTED_AMOUNT_JUMP_LIMIT) {
    return findRecordAtPositionBySorting(userId, filters, options);
  }
  return findRecordAtPositionByCounting(userId, filters, options);
}

/** The counting path of findRecordAtPosition, at any offset. Exported for the tests. */
export async function findRecordAtPositionByCounting(
  userId: number,
  filters: RecordPositionFilters,
  options: PositionOptions,
): Promise<RecordAtPosition | null> {
  await requireOwnedBusinessProfile(userId, filters.businessProfileId);
  const tables = tablesFor(options);
  if (tables.length === 0) return null;

  const dir = Prisma.raw(recordSortDirection(options.sort) === "desc" ? "DESC" : "ASC");
  const field = recordSortField(options.sort);
  const key = (table: RecordTable) => col(table, field === "amount" ? "Amount" : "Date");
  const offset = Prisma.sql`${options.offset}::bigint`;

  // The exact sort-key value holding the offset, and rows before it.
  let exactKey: Prisma.Sql;
  if (field === "date") {
    exactKey = Prisma.sql`(${locate(tables, filters, key, dir, offset)})`;
  } else {
    // Bucket = whole pesos, [lo, lo + 1): an exact range on the
    // (business, amount, id) index, holding at most 100 distinct amounts.
    exactKey = Prisma.sql`(
      SELECT exact."g", bucket."before" + exact."before" AS "before"
      FROM (${locate(
        tables, filters,
        (table) => Prisma.sql`floor(${key(table)})::bigint`,
        dir, offset,
      )}) AS bucket
      CROSS JOIN LATERAL (${locate(
        tables, filters, key, dir,
        Prisma.sql`(${offset} - bucket."before")`,
        (table) => Prisma.sql`${key(table)} >= bucket."g" AND ${key(table)} < bucket."g" + 1`,
      )}) AS exact
    )`;
  }

  const atKey = tables.map((table) => rowsOf(table, filters, Prisma.sql`${key(table)} = located."g"`));
  const rows = await prisma.$queryRaw<PositionRow[]>(Prisma.sql`
    SELECT picked."type", picked."id", picked."date", picked."amount"
    FROM ${exactKey} AS located
    CROSS JOIN LATERAL (
      SELECT * FROM (
        SELECT *, row_number() OVER (ORDER BY "rank" ASC, "id" ${dir}) - 1 AS "position"
        FROM (${Prisma.join(atKey, " UNION ALL ")}) AS same_key
      ) AS ranked
      WHERE ranked."position" = ${offset} - located."before"
    ) AS picked`);
  return toPosition(rows[0]);
}

/**
 * The same position found by sorting every row and skipping `offset`: the
 * definition findRecordAtPosition must agree with. Not for request paths; it
 * sorts the whole ledger. Used by the tests.
 */
export async function findRecordAtPositionBySorting(
  userId: number,
  filters: RecordPositionFilters,
  options: PositionOptions,
): Promise<RecordAtPosition | null> {
  await requireOwnedBusinessProfile(userId, filters.businessProfileId);
  const tables = tablesFor(options);
  if (tables.length === 0) return null;

  const dir = Prisma.raw(recordSortDirection(options.sort) === "desc" ? "DESC" : "ASC");
  const key = Prisma.raw(recordSortField(options.sort) === "amount" ? `"amount"` : `"date"`);
  const rows = await prisma.$queryRaw<PositionRow[]>(Prisma.sql`
    SELECT "type", "id", "date", "amount"
    FROM (${Prisma.join(tables.map((table) => rowsOf(table, filters)), " UNION ALL ")}) AS merged
    ORDER BY ${key} ${dir}, "rank" ASC, "id" ${dir}
    OFFSET ${options.offset} LIMIT 1`);
  return toPosition(rows[0]);
}
