import { prisma } from "../config/prisma";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { listNotifications } from "./notification.service";
import { loadRecoveryTargets } from "./insights.service";
import { utcAddDays, utcDateKey, utcEndOfDay, utcMonthKey, utcToday } from "../lib/dates";

/**
 * The period selector's "All time" setting.
 *
 * Zero rather than a large number of days, because "every record this business
 * has" is not a lookback window and picking one — 3,650 days, say — would
 * quietly start excluding history the moment a business outlived it. Zero means
 * "no lower bound", and the date filter is dropped entirely.
 */
export const ALL_TIME_PERIOD = 0;

/**
 * What this business has ever recorded, and the span it covers.
 *
 * Counts rather than rows, and one indexed date lookup per end per table rather
 * than a scan — a business with 30,000 imported records must not pay for a full
 * read to answer "is there anything here".
 */
async function activitySpan(businessProfileId: number) {
  const [expenseCount, salesCount, firstExpense, firstSale, latestExpense, latestSale] = await Promise.all([
    prisma.expenseRecord.count({ where: { businessProfileId } }),
    prisma.salesReferenceRecord.count({ where: { businessProfileId } }),
    prisma.expenseRecord.findFirst({
      where: { businessProfileId },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.salesReferenceRecord.findFirst({
      where: { businessProfileId },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.expenseRecord.findFirst({
      where: { businessProfileId },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.salesReferenceRecord.findFirst({
      where: { businessProfileId },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
  ]);

  const earliest = [firstExpense?.date, firstSale?.date].filter((d): d is Date => Boolean(d));
  const latest = [latestExpense?.date, latestSale?.date].filter((d): d is Date => Boolean(d));

  return {
    recordCount: expenseCount + salesCount,
    earliestRecordDate: earliest.length > 0 ? new Date(Math.min(...earliest.map((d) => d.getTime()))) : null,
    latestRecordDate: latest.length > 0 ? new Date(Math.max(...latest.map((d) => d.getTime()))) : null,
  };
}

export async function getDashboardSummary(userId: number, businessProfileId: number, periodDays: number) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = utcToday();
  const allTime = periodDays === ALL_TIME_PERIOD;
  const startDate = allTime ? null : utcAddDays(today, -(periodDays - 1));

  /*
   * Upper bound is the END of today, not its midnight: a record dated today
   * is stored at 00:00:00.000Z, and an `lte: midnight` bound was excluding
   * every record dated today on any server not running in UTC.
   *
   * On "All time" the filter is dropped entirely rather than widened. A
   * far-past `gte` would work today and silently start truncating history once
   * a business had more of it than the constant assumed; and the upper bound
   * would exclude future-dated records, which a spreadsheet can legitimately
   * contain and which an owner would then never find.
   */
  const dateFilter = allTime ? undefined : { gte: startDate!, lte: utcEndOfDay(today) };

  const [expenseTotals, salesAgg, reviewCounts, alerts, recoveryStatus, lifetime] = await Promise.all([
    /*
     * GROUPED IN POSTGRES, not read into memory and reduced here.
     *
     * This used to `findMany` every expense in the period with its category
     * joined, then sum in JS. That was fine while the widest period was 366
     * days; "All time" makes it a full table read for the business — 30,000
     * rows and their categories, to produce a handful of totals. The group is
     * bounded by the number of CATEGORIES instead, which is small by nature.
     */
    prisma.expenseRecord.groupBy({
      by: ["categoryId"],
      where: { businessProfileId, ...(dateFilter ? { date: dateFilter } : {}) },
      _sum: { amount: true },
    }),
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId, ...(dateFilter ? { date: dateFilter } : {}) },
      _sum: { amount: true },
    }),
    Promise.all([
      prisma.expenseRecord.count({
        where: { businessProfileId, OR: [{ reviewStatus: "Needs Review" }, { duplicateStatus: "Flagged" }] },
      }),
      prisma.salesReferenceRecord.count({
        where: { businessProfileId, OR: [{ reviewStatus: "Needs Review" }, { duplicateStatus: "Flagged" }] },
      }),
    ]),
    listNotifications(userId, businessProfileId),
    // Recovery is deliberately NOT scoped to the dashboard's period
    // selector — it's a month-to-date tracker, so it reads the same
    // whether the user is looking at Today, This week, or This month.
    loadRecoveryTargets(profile, today),
    /*
     * WHAT THIS BUSINESS HAS EVER RECORDED, deliberately outside the period.
     *
     * Everything above answers "what happened in the last N days", which is
     * the dashboard's job. But two things on the page are not period questions
     * and were being answered with period data:
     *
     *   - the setup checklist's "Record your first expense or sale", which told
     *     an owner who had just imported 21,097 rows of history that they had
     *     recorded nothing, because none of it fell inside 30 days;
     *   - the empty state, which said nothing at all and so read as a failed
     *     import rather than as an empty window.
     *
     * `latestRecordDate` is what turns the second one from a dead end into a
     * direction: it can say WHERE the data actually is.
     */
    activitySpan(businessProfileId),
  ]);

  const totalExpenses = expenseTotals.reduce((sum, g) => sum + Number(g._sum.amount ?? 0), 0);
  const totalSalesReference = Number(salesAgg._sum.amount ?? 0);
  const recordsNeedingReview = reviewCounts[0] + reviewCounts[1];

  // Names for the grouped ids only — one query bounded by the categories that
  // actually appear in the period, not by the records in it.
  const categoryNames = new Map(
    (
      await prisma.expenseCategory.findMany({
        where: { id: { in: expenseTotals.map((g) => g.categoryId) } },
        select: { id: true, name: true },
      })
    ).map((c) => [c.id, c.name]),
  );

  const expenseCategoryBreakdown = expenseTotals
    .map((g) => {
      const total = Number(g._sum.amount ?? 0);
      return {
        categoryId: g.categoryId,
        categoryName: categoryNames.get(g.categoryId) ?? "Uncategorised",
        total,
        percent: totalExpenses > 0 ? (total / totalExpenses) * 100 : 0,
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    periodDays,
    /*
     * On "All time" this is where the data actually starts, not null — the
     * period genuinely spans the business's whole history, and a UI showing
     * "Aug 2023 – today" is telling the truth about what the figures cover.
     * Null only when there is nothing to span.
     */
    periodStart: allTime ? lifetime.earliestRecordDate : startDate,
    periodEnd: today,
    overview: {
      availableFunds: Number(profile.availableFunds),
      totalExpenses,
      totalSalesReference,
    },
    expenseCategoryBreakdown,
    recoveryStatus,
    recordsNeedingReview,
    alerts: alerts.slice(0, 10),
    /** Outside the period on purpose — see the note on activitySpan. */
    lifetime,
  };
}

export type CashflowGranularity = "daily" | "monthly";

export interface CashflowPoint {
  date: string;
  sales: number;
  expenses: number;
}

/** One point per day, over a week — enough to read as a trend without the axis crowding on a phone. */
const CASHFLOW_DAYS = 7;
/** One point per calendar month, over half a year — same reasoning, at the monthly scale. */
const CASHFLOW_MONTHS = 6;

/**
 * Money in vs money out, one row per day or per calendar month depending on
 * `granularity` — Home's cashflow chart. Independent of the dashboard
 * summary's period selector above; the chart has its own fixed windows.
 *
 * Zero-filled: a bucket with no records still gets a row, so the chart's
 * line has one point per day/month rather than a gap that reads as missing
 * data. Grouped by `utcDateKey`/`utcMonthKey`, the same helpers
 * `getDashboardSummary`'s documented UTC bug fix relies on — a record dated
 * today must land in today's bucket regardless of the server's local
 * timezone.
 */
export async function getDashboardCashflow(
  userId: number,
  businessProfileId: number,
  granularity: CashflowGranularity = "daily",
): Promise<{ granularity: CashflowGranularity; points: CashflowPoint[] }> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = utcToday();

  if (granularity === "monthly") {
    const startMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (CASHFLOW_MONTHS - 1), 1));
    const dateFilter = { gte: startMonth, lte: utcEndOfDay(today) };

    const [expenseRecords, salesRecords] = await Promise.all([
      prisma.expenseRecord.findMany({ where: { businessProfileId, date: dateFilter }, select: { date: true, amount: true } }),
      prisma.salesReferenceRecord.findMany({
        where: { businessProfileId, date: dateFilter },
        select: { date: true, amount: true },
      }),
    ]);

    const byMonth = new Map<string, CashflowPoint>();
    for (let i = 0; i < CASHFLOW_MONTHS; i++) {
      const key = utcMonthKey(new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + i, 1)));
      byMonth.set(key, { date: key, sales: 0, expenses: 0 });
    }
    for (const r of expenseRecords) byMonth.get(utcMonthKey(r.date))!.expenses += Number(r.amount);
    for (const r of salesRecords) byMonth.get(utcMonthKey(r.date))!.sales += Number(r.amount);

    return { granularity, points: [...byMonth.values()] };
  }

  const startDate = utcAddDays(today, -(CASHFLOW_DAYS - 1));
  const dateFilter = { gte: startDate, lte: utcEndOfDay(today) };

  const [expenseRecords, salesRecords] = await Promise.all([
    prisma.expenseRecord.findMany({ where: { businessProfileId, date: dateFilter }, select: { date: true, amount: true } }),
    prisma.salesReferenceRecord.findMany({
      where: { businessProfileId, date: dateFilter },
      select: { date: true, amount: true },
    }),
  ]);

  const byDay = new Map<string, CashflowPoint>();
  for (let i = 0; i < CASHFLOW_DAYS; i++) {
    const key = utcDateKey(utcAddDays(startDate, i));
    byDay.set(key, { date: key, sales: 0, expenses: 0 });
  }
  for (const r of expenseRecords) byDay.get(utcDateKey(r.date))!.expenses += Number(r.amount);
  for (const r of salesRecords) byDay.get(utcDateKey(r.date))!.sales += Number(r.amount);

  return { granularity, points: [...byDay.values()] };
}
