import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { businessTodayKey } from "../lib/transactionDate";

/**
 * The calendar months this business has at least one expense or sale in,
 * newest first, as YYYY-MM keys.
 *
 * Feeds the period filter's Month list, which must offer only months that
 * actually hold records: a fixed January-December list sends an owner to
 * eleven empty screens to find the one month their import covered.
 *
 * Computed in Postgres rather than by reading records into the client, and
 * without reading every record either. Each table is walked month by month,
 * newest first: the latest record dated on or before today names a month, the
 * latest record before that month's first day names the next, and so on. Each
 * step is one probe of the (business, date, id) index, so the cost follows the
 * number of months (a few dozen), not the number of records. A single grouped
 * pass sorted the whole ledger instead, ~250 ms at 500,000 records
 * (tests/load/query-plans.ts). DISTINCT removes a month present in both tables.
 *
 * Ownership first, and the business id filters both tables, so another
 * owner's records cannot contribute a month. A record dated after the
 * business's today is invalid and does not put a future month in the list.
 */
export async function listRecordMonths(userId: number, businessProfileId: number): Promise<string[]> {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  const today = businessTodayKey(profile.timezone);
  const rows = await prisma.$queryRaw<{ month: string }[]>`
    WITH RECURSIVE
      expense_months(start) AS (
        SELECT date_trunc('month', max("ExpenseRecord_Date"))::date
        FROM "ExpenseRecord"
        WHERE "BusinessProfile_ID" = ${businessProfileId} AND "ExpenseRecord_Date" <= ${today}::date
        UNION ALL
        SELECT (
          SELECT date_trunc('month', max("ExpenseRecord_Date"))::date
          FROM "ExpenseRecord"
          WHERE "BusinessProfile_ID" = ${businessProfileId} AND "ExpenseRecord_Date" < expense_months.start
        )
        FROM expense_months
        WHERE expense_months.start IS NOT NULL
      ),
      sales_months(start) AS (
        SELECT date_trunc('month', max("SalesReferenceRecord_Date"))::date
        FROM "SalesReferenceRecord"
        WHERE "BusinessProfile_ID" = ${businessProfileId} AND "SalesReferenceRecord_Date" <= ${today}::date
        UNION ALL
        SELECT (
          SELECT date_trunc('month', max("SalesReferenceRecord_Date"))::date
          FROM "SalesReferenceRecord"
          WHERE "BusinessProfile_ID" = ${businessProfileId} AND "SalesReferenceRecord_Date" < sales_months.start
        )
        FROM sales_months
        WHERE sales_months.start IS NOT NULL
      )
    SELECT DISTINCT to_char(start, 'YYYY-MM') AS month
    FROM (SELECT start FROM expense_months UNION ALL SELECT start FROM sales_months) AS found
    WHERE start IS NOT NULL
    ORDER BY month DESC
  `;
  return rows.map((row) => row.month);
}
