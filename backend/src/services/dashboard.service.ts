import { prisma } from "../config/prisma";
import type { Prisma } from "@prisma/client";
import { listNotifications } from "./notification.service";
import { loadRecoveryTargets } from "./insights.service";
import { resolveBusinessToday, utcAddDays, utcDateKey, utcEndOfDay, utcMonthKey } from "../lib/dates";
import {
  describeWindow,
  resolveReportingWindow,
  selectionFromQuery,
  windowDateFilter,
  type PeriodSelection,
} from "../lib/reportingPeriod";
import { requireOwnedBusinessContext } from "./ownedBusinessContext.service";
import { calculateAvailableFundsForOwnedBusiness } from "./financialPosition.service";

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
async function activitySpan(businessProfileId: number, today: Date) {
  // Up to the business's today: a future-dated record is not activity yet.
  const where = { businessProfileId, date: { lte: utcEndOfDay(today) } };
  const [expenseCount, salesCount, firstExpense, firstSale, latestExpense, latestSale] = await Promise.all([
    prisma.expenseRecord.count({ where }),
    prisma.salesReferenceRecord.count({ where }),
    prisma.expenseRecord.findFirst({
      where,
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.salesReferenceRecord.findFirst({
      where,
      orderBy: { date: "asc" },
      select: { date: true },
    }),
    prisma.expenseRecord.findFirst({
      where,
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    prisma.salesReferenceRecord.findFirst({
      where,
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

export async function getDashboardSummary(
  userId: number,
  businessProfileId: number,
  /**
   * The period the figures cover. A plain number is the legacy rolling
   * `periodDays` window (0 = all time), which the mobile client and the AI
   * context still send; the web period filter sends a selection.
   */
  period: number | PeriodSelection,
) {
  const context = await requireOwnedBusinessContext(userId, businessProfileId);
  const { profile } = context;

  /*
   * "Today" is the business's own calendar day, not the server's.
   *
   * Record dates are date-only values stored at UTC midnight, so the boundary
   * helpers below stay UTC — what this fixes is which calendar day counts as
   * today. A Manila business (UTC+8) turns over eight hours before UTC does:
   * between 00:00 and 08:00 local, utcToday() still reported yesterday, and an
   * expense the owner had just entered for today fell outside both the period
   * window and the upper bound. They saw their own morning's spending missing
   * from every figure on the page.
   *
   * Recovery Target already resolved it this way (plan §9.1); the rest of the
   * dashboard now agrees with it instead of disagreeing for eight hours a day.
   */
  const today = resolveBusinessToday(profile.timezone);
  const selection = typeof period === "number" ? selectionFromQuery({ periodDays: period }) : period;
  const window = resolveReportingWindow(selection, today);
  const allTime = window.kind === "all";
  const periodDays = selection.kind === "rolling" ? selection.days : allTime ? ALL_TIME_PERIOD : window.days!;

  /*
   * On "All time" there is no lower bound: a far-past `gte` would work today
   * and silently start truncating history once a business had more of it than
   * a constant assumed. Every window, all time included, stops at the end of
   * the business's today, so a future-dated record (invalid, and flagged for
   * correction) is in no total. See lib/reportingPeriod.ts.
   */
  const dateFilter = windowDateFilter(window, today);

  const [expenseTotals, salesAgg, reviewCounts, alerts, recoveryStatus, lifetime, availableFundsCalculation] = await Promise.all([
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
    listNotifications(userId, businessProfileId, 10),
    // Recovery is deliberately NOT scoped to the dashboard's period
    // selector — it's a month-to-date tracker, so it reads the same
    // whether the user is looking at Today, This week, or This month.
    //
    // Shares the dashboard's `today` above, which is now resolved in the
    // business's own timezone — see RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.1
    // and getRecoveryInsight's matching resolution in insights.service.ts,
    // which this must agree with so the Dashboard and the Recovery Target
    // screen never disagree right at a day boundary.
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
    activitySpan(businessProfileId, today),
    calculateAvailableFundsForOwnedBusiness(context, today),
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
    periodStart: allTime ? lifetime.earliestRecordDate : window.start,
    periodEnd: allTime ? today : window.end,
    /** The resolved window, as date keys — what the period filter labels itself from. */
    period: describeWindow(window),
    overview: {
      availableFunds: availableFundsCalculation.calculatedAmount,
      availableFundsCalculation,
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
 * data. Postgres groups stored date-only values before they reach the API;
 * the business's local day still determines which records enter the window.
 */
export async function getDashboardCashflow(
  userId: number,
  businessProfileId: number,
  granularity: CashflowGranularity = "daily",
): Promise<{ granularity: CashflowGranularity; points: CashflowPoint[] }> {
  const { profile } = await requireOwnedBusinessContext(userId, businessProfileId);

  // Same business-local "today" as the summary above: the chart's last bucket
  // has to be the day the owner is living in, or their morning's records land
  // outside the window entirely between local midnight and 08:00.
  const today = resolveBusinessToday(profile.timezone);

  const monthly = granularity === "monthly";
  const startDate = monthly
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (CASHFLOW_MONTHS - 1), 1))
    : utcAddDays(today, -(CASHFLOW_DAYS - 1));
  const endDate = utcEndOfDay(today);
  const bucket = monthly ? "month" : "day";
  const dateFormat = monthly ? "YYYY-MM" : "YYYY-MM-DD";
  const totals = await prisma.$queryRaw<Array<{ date: string; sales: Prisma.Decimal; expenses: Prisma.Decimal }>>`
    SELECT to_char(bucket, ${dateFormat}) AS date, SUM(sales) AS sales, SUM(expenses) AS expenses
    FROM (
      SELECT date_trunc(${bucket}, "SalesReferenceRecord_Date"::timestamp) AS bucket,
        SUM("SalesReferenceRecord_Amount") AS sales, 0::numeric AS expenses
      FROM "SalesReferenceRecord"
      WHERE "BusinessProfile_ID" = ${profile.id}
        AND "SalesReferenceRecord_Date" >= ${startDate}
        AND "SalesReferenceRecord_Date" <= ${endDate}
      GROUP BY 1
      UNION ALL
      SELECT date_trunc(${bucket}, "ExpenseRecord_Date"::timestamp) AS bucket,
        0::numeric AS sales, SUM("ExpenseRecord_Amount") AS expenses
      FROM "ExpenseRecord"
      WHERE "BusinessProfile_ID" = ${profile.id}
        AND "ExpenseRecord_Date" >= ${startDate}
        AND "ExpenseRecord_Date" <= ${endDate}
      GROUP BY 1
    ) AS cashflow
    GROUP BY bucket
    ORDER BY bucket
  `;

  const points = new Map<string, CashflowPoint>();
  const count = monthly ? CASHFLOW_MONTHS : CASHFLOW_DAYS;
  for (let index = 0; index < count; index += 1) {
    const key = monthly
      ? utcMonthKey(new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + index, 1)))
      : utcDateKey(utcAddDays(startDate, index));
    points.set(key, { date: key, sales: 0, expenses: 0 });
  }
  for (const total of totals) {
    const point = points.get(total.date)!;
    point.sales = Number(total.sales);
    point.expenses = Number(total.expenses);
  }
  return { granularity, points: [...points.values()] };
}
