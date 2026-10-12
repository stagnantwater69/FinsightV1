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
 * Computed in Postgres rather than by reading records into the client: one
 * grouped pass over this business's own rows returns a few dozen short
 * strings, where the alternative is downloading every transaction to build a
 * dropdown. UNION (not UNION ALL) removes a month that appears in both tables.
 *
 * Ownership first, and the business id filters both tables, so another
 * owner's records cannot contribute a month. A record dated after the
 * business's today is invalid and does not put a future month in the list.
 */
export async function listRecordMonths(userId: number, businessProfileId: number): Promise<string[]> {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  const today = businessTodayKey(profile.timezone);
  const rows = await prisma.$queryRaw<{ month: string }[]>`
    SELECT to_char("ExpenseRecord_Date", 'YYYY-MM') AS month
    FROM "ExpenseRecord"
    WHERE "BusinessProfile_ID" = ${businessProfileId} AND "ExpenseRecord_Date" <= ${today}::date
    UNION
    SELECT to_char("SalesReferenceRecord_Date", 'YYYY-MM') AS month
    FROM "SalesReferenceRecord"
    WHERE "BusinessProfile_ID" = ${businessProfileId} AND "SalesReferenceRecord_Date" <= ${today}::date
    ORDER BY month DESC
  `;
  return rows.map((row) => row.month);
}
