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

function branch(
  table: "ExpenseRecord" | "SalesReferenceRecord",
  filters: RecordPositionFilters,
): Prisma.Sql {
  const col = (name: string) => Prisma.raw(`"${table}"."${table}_${name}"`);
  const conditions: Prisma.Sql[] = [Prisma.sql`"${Prisma.raw(table)}"."BusinessProfile_ID" = ${filters.businessProfileId}`];
  if (table === "ExpenseRecord" && filters.categoryId !== undefined) {
    conditions.push(Prisma.sql`"ExpenseRecord"."Category_ID" = ${filters.categoryId}`);
  }
  if (filters.source !== undefined) {
    const enumType = table === "ExpenseRecord" ? "ExpenseRecordSource" : "SalesRecordSource";
    conditions.push(Prisma.sql`${col("Source")} = ${SOURCE_LABELS[filters.source]}::${Prisma.raw(`"${enumType}"`)}`);
  }
  if (filters.importBatchId !== undefined) {
    conditions.push(Prisma.sql`"${Prisma.raw(table)}"."ImportBatch_ID" = ${filters.importBatchId}`);
  }
  if (filters.dateFrom) conditions.push(Prisma.sql`${col("Date")} >= ${filters.dateFrom}::date`);
  if (filters.dateTo) conditions.push(Prisma.sql`${col("Date")} <= ${filters.dateTo}::date`);
  if (filters.keyword) conditions.push(Prisma.sql`${col("Description")} ILIKE ${`%${filters.keyword}%`}`);

  const type = table === "ExpenseRecord" ? "expense" : "sales";
  const rank = table === "ExpenseRecord" ? 0 : 1;
  return Prisma.sql`
    SELECT ${type}::text AS "type", ${rank}::int AS "rank", ${col("ID")} AS "id",
           ${col("Date")} AS "date", ${col("Amount")} AS "amount"
    FROM ${Prisma.raw(`"public"."${table}"`)}
    WHERE ${Prisma.join(conditions, " AND ")}`;
}

/**
 * The record at zero-based `offset`, or null past the end. Only the halves
 * `search` itself would query are included, so positions agree with it.
 */
export async function findRecordAtPosition(
  userId: number,
  filters: RecordPositionFilters,
  options: { includeExpenses: boolean; includeSales: boolean; sort: RecordSort; offset: number },
): Promise<RecordAtPosition | null> {
  await requireOwnedBusinessProfile(userId, filters.businessProfileId);
  const branches = [
    ...(options.includeExpenses ? [branch("ExpenseRecord", filters)] : []),
    ...(options.includeSales ? [branch("SalesReferenceRecord", filters)] : []),
  ];
  if (branches.length === 0) return null;

  const dir = Prisma.raw(recordSortDirection(options.sort) === "desc" ? "DESC" : "ASC");
  const key = Prisma.raw(recordSortField(options.sort) === "amount" ? `"amount"` : `"date"`);
  const rows = await prisma.$queryRaw<Array<{ type: "expense" | "sales"; id: number; date: Date; amount: Prisma.Decimal }>>(Prisma.sql`
    SELECT "type", "id", "date", "amount"
    FROM (${Prisma.join(branches, " UNION ALL ")}) AS merged
    ORDER BY ${key} ${dir}, "rank" ASC, "id" ${dir}
    OFFSET ${options.offset} LIMIT 1`);
  const row = rows[0];
  return row ? { type: row.type, id: row.id, date: row.date, amount: Number(row.amount) } : null;
}
