import { prisma } from "../config/prisma";
import { utcDateKey } from "../lib/dates";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { businessTodayKey, startOfBusinessTomorrow } from "../lib/transactionDate";

/**
 * Records dated after the business's today, which the owner must correct.
 *
 * New writes refuse a future date (lib/transactionDate.ts), but records saved
 * before that rule existed can still carry one. The web app blocks its
 * transaction and insight pages until this list is empty, and the insight
 * queries already leave these records out of every figure in the meantime.
 */

export interface FutureDatedRecord {
  id: number;
  type: "expense" | "sales";
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  amount: number;
  vendor: string | null;
  categoryName: string | null;
}

export interface FutureDatedRecords {
  /** The business's today as YYYY-MM-DD: the latest date a record may have. */
  today: string;
  /** Every future-dated record, including any beyond `records`. */
  total: number;
  records: FutureDatedRecord[];
  truncated: boolean;
}

/** Enough to correct in one sitting; the rest appear as these are fixed. */
export const FUTURE_DATED_LIST_LIMIT = 100;

export async function listFutureDatedRecords(userId: number, businessProfileId: number): Promise<FutureDatedRecords> {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  const today = businessTodayKey(profile.timezone);
  const where = { businessProfileId, date: { gte: startOfBusinessTomorrow(profile.timezone) } };
  const orderBy = [{ date: "asc" as const }, { id: "asc" as const }];

  const [expenseCount, salesCount, expenses, sales] = await Promise.all([
    prisma.expenseRecord.count({ where }),
    prisma.salesReferenceRecord.count({ where }),
    prisma.expenseRecord.findMany({
      where,
      orderBy,
      take: FUTURE_DATED_LIST_LIMIT,
      select: { id: true, date: true, description: true, amount: true, vendor: true, category: { select: { name: true } } },
    }),
    prisma.salesReferenceRecord.findMany({
      where,
      orderBy,
      take: FUTURE_DATED_LIST_LIMIT,
      select: { id: true, date: true, description: true, amount: true },
    }),
  ]);

  const records: FutureDatedRecord[] = [
    ...expenses.map((r) => ({
      id: r.id,
      type: "expense" as const,
      date: utcDateKey(r.date),
      description: r.description,
      amount: Number(r.amount),
      vendor: r.vendor,
      categoryName: r.category?.name ?? null,
    })),
    ...sales.map((r) => ({
      id: r.id,
      type: "sales" as const,
      date: utcDateKey(r.date),
      description: r.description,
      amount: Number(r.amount),
      vendor: null,
      categoryName: null,
    })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.id - b.id)
    .slice(0, FUTURE_DATED_LIST_LIMIT);

  const total = expenseCount + salesCount;
  return { today, total, records, truncated: total > records.length };
}
