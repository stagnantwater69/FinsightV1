import { prisma } from "../config/prisma";
import type { BusinessProfile } from "@prisma/client";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import {
  computeCategoryStats,
  computeQuartiles,
  detectionMethod,
  computeRecoveryTarget,
  dayStatus,
  impactBand,
  isUnusualExpense,
  zScore,
  MIN_HISTORY_FOR_DETECTION,
  type RecoveryTargets,
} from "./analysis.service";

// All day boundaries are UTC — record dates are date-only values stored at
// UTC midnight, so local-time boundaries drop or double-count the edge days.
// See lib/dates.ts.
import {
  utcAddDays,
  utcDateKey,
  utcDayOfMonth,
  utcEndOfDay,
  utcStartOfMonth,
  utcToday,
} from "../lib/dates";
import { loadBoundedCategoryHistory } from "./anomalyDetection/categoryStatistics.service";
import { DEFAULT_DETECTION_CONFIG } from "./anomalyDetection/config";

// ============================================================
// Recovery targets — the single fetch+compute path
// ============================================================
//
// Both the Dashboard summary and the Insights Recovery Target screen call
// this. Do not recompute any of these numbers in either caller; if a
// caller needs another figure, add it here.
export async function loadRecoveryTargets(profile: BusinessProfile, today: Date): Promise<RecoveryTargets> {
  const monthStart = utcStartOfMonth(today);
  const endOfToday = utcEndOfDay(today);

  const [monthAgg, todayAgg] = await Promise.all([
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: monthStart, lte: endOfToday } },
      _sum: { amount: true },
    }),
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: today, lte: endOfToday } },
      _sum: { amount: true },
    }),
  ]);

  return computeRecoveryTarget({
    expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses),
    operatingDays: profile.operatingDays,
    salesThisMonth: Number(monthAgg._sum.amount ?? 0),
    salesToday: Number(todayAgg._sum.amount ?? 0),
    today,
  });
}

// ============================================================
// Expense Behavior Analysis
// ============================================================

/**
 * The most recent expense a business has, or null.
 *
 * WHAT IT IS FOR. Every window on this page is measured back from a point, and
 * that point has always been today. For a business that is recording daily
 * that is right. For one whose history was imported — the case CSV import now
 * actively invites — today can be a year past the last record, and every window
 * lands in a gap: the page loads, finds nothing, and says "no expenses
 * recorded", which for someone who has just imported hundreds is simply false.
 *
 * Returning the date lets the client OFFER the window that has data, by name,
 * instead of leaving the owner to guess that a control exists and which value
 * to give it.
 */
async function latestExpenseDate(businessProfileId: number): Promise<Date | null> {
  const row = await prisma.expenseRecord.findFirst({
    where: { businessProfileId },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

export async function getExpenseBehavior(
  userId: number,
  businessProfileId: number,
  periodDays: number,
  /**
   * The day the window ENDS on. Defaults to today, which is every existing
   * caller's behaviour.
   *
   * Deliberately an end date rather than a start date: the period is described
   * to the owner as "the last N days", so the anchor is the recent end and the
   * length stays the thing they chose. It is also the primitive a custom date
   * range would need, so this is not throwaway.
   */
  endDate?: Date,
) {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = endDate ?? utcToday();
  const periodStart = utcAddDays(today, -(periodDays - 1));
  const previousPeriodEnd = utcAddDays(periodStart, -1);
  const previousPeriodStart = utcAddDays(previousPeriodEnd, -(periodDays - 1));

  const [currentRecords, previousRecords, categories] = await Promise.all([
    prisma.expenseRecord.findMany({
      where: { businessProfileId, date: { gte: periodStart, lte: utcEndOfDay(today) } },
    }),
    prisma.expenseRecord.findMany({
      where: { businessProfileId, date: { gte: previousPeriodStart, lte: previousPeriodEnd } },
      select: { categoryId: true, amount: true },
    }),
    prisma.expenseCategory.findMany({ where: { businessProfileId } }),
  ]);

  const boundedCategoryHistory = await loadBoundedCategoryHistory(
    businessProfileId,
    today,
    DEFAULT_DETECTION_CONFIG.baselineDays,
    DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
  );

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const currentTotals = new Map<number, number>();
  // How many expenses make up each category's total. A category can be large
  // because of one big purchase or because of forty small ones, and those are
  // completely different problems — the count is what tells them apart.
  const currentCounts = new Map<number, number>();
  for (const r of currentRecords) {
    currentTotals.set(r.categoryId, (currentTotals.get(r.categoryId) ?? 0) + Number(r.amount));
    currentCounts.set(r.categoryId, (currentCounts.get(r.categoryId) ?? 0) + 1);
  }
  const previousTotals = new Map<number, number>();
  for (const r of previousRecords) previousTotals.set(r.categoryId, (previousTotals.get(r.categoryId) ?? 0) + Number(r.amount));

  const categoryIds = new Set([...currentTotals.keys(), ...previousTotals.keys()]);
  const categoryTrends = [...categoryIds]
    .map((categoryId) => {
      const current = currentTotals.get(categoryId) ?? 0;
      const previous = previousTotals.get(categoryId) ?? 0;
      const direction: "up" | "down" | "flat" = current > previous ? "up" : current < previous ? "down" : "flat";
      // null = "new spending this period, no prior baseline to compare against" —
      // distinct from 0%, which means genuinely unchanged.
      const percentChange = previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? null : 0;
      return {
        categoryId,
        categoryName: categoryName.get(categoryId) ?? "Unknown",
        current,
        previous,
        direction,
        percentChange,
        recordCount: currentCounts.get(categoryId) ?? 0,
        // The absolute peso movement, alongside the percentage. A 300% rise on
        // a PHP 200 category is a rounding error; a 12% rise on rent is not.
        // Percent alone routinely puts the first at the top of a "biggest
        // change" list and buries the second.
        change: current - previous,
      };
    })
    .sort((a, b) => b.current - a.current);

  // ============================================================
  // Period totals
  // ============================================================
  // Summed here rather than in the client so every surface that shows "total
  // expenses this period" reads the same number. The share percentages on the
  // client all divide by `totals.current`, which is what keeps the donut and
  // the summary table from disagreeing.
  const totalCurrent = [...currentTotals.values()].reduce((s, v) => s + v, 0);
  const totalPrevious = [...previousTotals.values()].reduce((s, v) => s + v, 0);

  // ============================================================
  // Daily spend series
  // ============================================================
  // Answers "when does the money actually leave?" — the question a category
  // breakdown cannot. Every day in the period is emitted, including the ones
  // with no spending: dropping empty days would silently compress the x-axis
  // and turn a quiet fortnight into a flat line that looks like steady
  // spending.
  const dailyMap = new Map<string, { total: number; count: number }>();
  for (let i = 0; i < periodDays; i++) {
    dailyMap.set(utcDateKey(utcAddDays(periodStart, i)), { total: 0, count: 0 });
  }
  for (const r of currentRecords) {
    const key = utcDateKey(r.date);
    const entry = dailyMap.get(key);
    if (entry) {
      entry.total += Number(r.amount);
      entry.count += 1;
    }
  }
  const dailyTotals = [...dailyMap.entries()].map(([date, v]) => ({
    date,
    total: v.total,
    count: v.count,
  }));

  // Unusual-expense detection: leave-one-out Z-score/IQR against a bounded
  // rolling baseline. Years-old prices no longer distort today's normal, and
  // a high-volume category cannot make this request load unlimited history.
  // Current-period candidates are merged even when they sit just outside the
  // baseline (the API permits a 366-day view), so a visible row is never
  // silently omitted from eligibility checks.
  const recordsByCategory = new Map<number, Map<number, { id: number; amount: number }>>();
  for (const r of boundedCategoryHistory) {
    const records = recordsByCategory.get(r.categoryId) ?? new Map();
    records.set(r.id, { id: r.id, amount: Number(r.amount) });
    recordsByCategory.set(r.categoryId, records);
  }
  for (const r of currentRecords) {
    const records = recordsByCategory.get(r.categoryId) ?? new Map();
    records.set(r.id, { id: r.id, amount: Number(r.amount) });
    recordsByCategory.set(r.categoryId, records);
  }
  const byCategory = new Map(
    [...recordsByCategory].map(([categoryId, records]) => [categoryId, [...records.values()]]),
  );
  const currentRecordById = new Map(currentRecords.map((r) => [r.id, r]));

  const unusualExpenses: {
    id: number;
    description: string;
    amount: number;
    date: Date;
    categoryId: number;
    categoryName: string;
    zScore: number;
    categoryMean: number;
    categoryStdDev: number;
    detectedBy: "z-score" | "iqr" | "both";
  }[] = [];
  const insufficientHistoryCategories: { categoryId: number; categoryName: string; historyCount: number }[] = [];

  for (const [categoryId, records] of byCategory) {
    if (records.length < MIN_HISTORY_FOR_DETECTION) {
      insufficientHistoryCategories.push({
        categoryId,
        categoryName: categoryName.get(categoryId) ?? "Unknown",
        historyCount: records.length,
      });
      continue;
    }

    for (const candidate of records) {
      const currentRecord = currentRecordById.get(candidate.id);
      if (!currentRecord) continue; // only flag within the selected period

      const baseline = records.filter((r) => r.id !== candidate.id).map((r) => r.amount);
      const stats = computeCategoryStats(baseline);
      const quartiles = computeQuartiles(baseline);
      const z = zScore(candidate.amount, stats);

      // Unusual by z-score OR by IQR, AND materially different in peso terms —
      // see isUnusualExpense. The two statistical tests are blind in different
      // places, and the peso floor is what stops either of them reporting a
      // difference too small for an owner to care about.
      if (isUnusualExpense(candidate.amount, stats, quartiles)) {
        unusualExpenses.push({
          id: candidate.id,
          description: currentRecord.description,
          amount: candidate.amount,
          date: currentRecord.date,
          categoryId,
          categoryName: categoryName.get(categoryId) ?? "Unknown",
          zScore: z,
          categoryMean: stats.mean,
          categoryStdDev: stats.stdDev,
          // Which test caught it. A flag an owner can be shown the reason for
          // is worth more than one they have to take on trust.
          detectedBy: detectionMethod(candidate.amount, stats, quartiles),
        });
      }
    }
  }
  unusualExpenses.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return {
    periodStart,
    periodEnd: today,
    previousPeriodStart,
    previousPeriodEnd,
    periodDays,
    totals: { current: totalCurrent, previous: totalPrevious },
    dailyTotals,
    categoryTrends,
    unusualExpenses,
    insufficientHistoryCategories,
    /**
     * Where this business's expenses actually are, independent of the window
     * above — so an empty period can tell the owner the difference between
     * "you have never recorded an expense" and "you have plenty, just none
     * lately", which are opposite situations that looked identical.
     */
    latestExpenseDate: await latestExpenseDate(businessProfileId),
  };
}

// ============================================================
// Target-Based Recovery Insight
// ============================================================

export async function getRecoveryInsight(userId: number, businessProfileId: number, coverageDays: number) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = utcToday();
  const targets = await loadRecoveryTargets(profile, today);

  // Daily coverage table — "recent days" per the mockup. Scoped to the
  // current month, since a day before the 1st belongs to a different
  // month's target and would be misleading in this table.
  const monthStart = utcStartOfMonth(today);
  const daysElapsedThisMonth = utcDayOfMonth(today);
  const coverageStart = utcAddDays(today, -(Math.min(coverageDays, daysElapsedThisMonth) - 1));
  const endOfToday = utcEndOfDay(today);

  const coverageRecords = await prisma.salesReferenceRecord.findMany({
    where: { businessProfileId, date: { gte: coverageStart, lte: endOfToday } },
    select: { date: true, amount: true },
  });

  const salesByDay = new Map<string, number>();
  for (const r of coverageRecords) {
    const key = utcDateKey(r.date);
    salesByDay.set(key, (salesByDay.get(key) ?? 0) + Number(r.amount));
  }

  const dailyCoverage: {
    date: string;
    neededTarget: number;
    sales: number;
    gap: number;
    status: ReturnType<typeof dayStatus>;
  }[] = [];
  for (let d = new Date(coverageStart); d <= today; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const sales = salesByDay.get(key) ?? 0;
    dailyCoverage.push({
      date: key,
      neededTarget: targets.dailyNeededTarget,
      sales,
      gap: sales - targets.dailyNeededTarget,
      status: dayStatus(sales, targets.dailyNeededTarget),
    });
  }

  /*
   * WHETHER THIS BUSINESS HAS TRADED AT ALL LATELY.
   *
   * Recovery is month-to-date by design and has no period to select, so for a
   * business whose records were imported and stop a year ago it reports zero
   * sales against the full monthly target — "you are catastrophically behind".
   * That is worse than an empty screen: it is a confident, wrong claim about
   * someone's business, and nothing on the page says the month simply has no
   * records in it.
   *
   * These two let the client say so. Deliberately NOT a change to the targets
   * themselves — the arithmetic is right, it is the framing that was missing.
   */
  const latestSale = await prisma.salesReferenceRecord.findFirst({
    where: { businessProfileId },
    orderBy: { date: "desc" },
    select: { date: true },
  });

  return {
    ...targets,
    monthStart,
    today,
    coverageDays: dailyCoverage.length,
    dailyCoverage,
    /** True when not one sale is recorded in the month this page is reporting on. */
    monthHasNoRecords: dailyCoverage.every((d) => d.sales === 0),
    /** The most recent sale on file, so an empty month can point at where the data is. */
    latestSaleDate: latestSale?.date ?? null,
  };
}

// ============================================================
// Spending-Impact Assessment (pure calculation, nothing persisted)
// ============================================================

export async function simulateSpendingImpact(
  userId: number,
  businessProfileId: number,
  plannedAmount: number,
  periodDays = 30
) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = utcToday();
  const periodStart = utcAddDays(today, -(periodDays - 1));
  const endOfToday = utcEndOfDay(today);

  const expenseAgg = await prisma.expenseRecord.aggregate({
    where: { businessProfileId, date: { gte: periodStart, lte: endOfToday } },
    _sum: { amount: true },
  });

  const availableFunds = Number(profile.availableFunds);
  const resultingFunds = availableFunds - plannedAmount;
  const percentOfFunds = availableFunds > 0 ? (plannedAmount / availableFunds) * 100 : plannedAmount > 0 ? Infinity : 0;
  const exceedsFunds = plannedAmount > availableFunds;

  // Threshold base differs by context, deliberately: Records flags a large
  // expense against Expected Monthly Expenses (is this big for my cost
  // base?), while this simulator measures it against Available Business
  // Funds (can I absorb this right now?). Same configurable percentage
  // either way — see A2 in the build notes.
  const thresholdPercent = Number(profile.largeExpenseThresholdPercent);

  const currentPeriodExpenses = Number(expenseAgg._sum.amount ?? 0);
  const updatedPeriodExpenses = currentPeriodExpenses + plannedAmount;

  return {
    periodDays,
    periodStart,
    periodEnd: today,
    plannedAmount,
    thresholdPercent,
    thresholdAmount: availableFunds * (thresholdPercent / 100),
    // Infinity is possible here (zero funds, nonzero spend); the
    // controller caps it, since JSON has no Infinity.
    percentOfFunds,
    impactBand: Number.isFinite(percentOfFunds)
      ? impactBand(percentOfFunds, thresholdPercent)
      : ("High Impact" as const),
    exceedsFunds,
    funds: { before: availableFunds, after: resultingFunds },
    periodExpenses: { before: currentPeriodExpenses, after: updatedPeriodExpenses },
    // Retained for the existing callers that read these flat names.
    availableFunds,
    resultingFunds,
  };
}


// ============================================================
// Price context — "is this a fair price?", answered from their own records
// ============================================================

/**
 * What this owner has actually paid, next to what they are about to pay.
 *
 * WHY THIS IS NOT AN AI ANSWER. "Is ₱11,000 the right price for a display
 * fridge?" is a question about the Cebu appliance market on the day it is
 * asked, and a language model does not know that — it would produce a
 * confident range with nothing behind it, which is the one failure this
 * codebase spends most of its grounding rules preventing. What FinSight
 * genuinely knows is the owner's OWN history: what they paid the last time
 * they bought something described this way, and what a purchase in this
 * category usually costs them. That is a real answer to "is this normal for
 * me", computed here and never written by a model.
 *
 * TWO SIGNALS, strongest first:
 *   1. Records whose description contains the same significant words — the
 *      closest thing to "the last time I bought this exact thing".
 *   2. The spread of amounts in the category the item would be filed under.
 *
 * A business with no history gets `comparison: "no-history"` and the card says
 * so, rather than a comparison against a median of nothing.
 */

export type PriceComparison = "no-history" | "no-amount" | "below" | "in-line" | "above" | "far-above";

export interface SimilarPurchase {
  description: string;
  amount: number;
  date: Date;
  categoryName: string;
}

export interface PurchasePriceContext {
  categoryId: number | null;
  categoryName: string | null;
  /** Records in that category over the window, whatever the description. */
  recordCount: number;
  /** The median, which a single ₱80,000 outlier cannot drag around. */
  typicalAmount: number | null;
  smallestAmount: number | null;
  largestAmount: number | null;
  /** The planned amount over the median. Null without an amount or a history. */
  multipleOfTypical: number | null;
  comparison: PriceComparison;
  /** Up to three past records that look like the same item, newest first. */
  similar: SimilarPurchase[];
  /** How far back this looked. */
  windowDays: number;
}

/** A year: long enough to catch an annual repurchase, short enough to still be today's prices. */
const PRICE_HISTORY_DAYS = 365;

/**
 * The words worth searching on.
 *
 * "Display fridge for the drinks" searches for "display" and "fridge" and
 * ignores the rest — three-letter-and-under words match half the ledger, and
 * a handful of common filler words ("for", "the", "new") are worse than
 * useless because they match everything while looking specific.
 */
const PRICE_STOP_WORDS = new Set([
  "and", "for", "the", "with", "new", "old", "our", "from", "this", "that", "one", "two",
  "buy", "buying", "purchase", "get", "some", "more", "extra", "pcs", "set", "unit", "units",
]);

export function significantWords(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !PRICE_STOP_WORDS.has(word))
    // Three is plenty: each one is a LIKE over the description column, and the
    // fourth word of a phrase rarely narrows anything the first three did not.
    .slice(0, 3);
}

/**
 * Where the planned amount sits against what this owner usually pays.
 *
 * The bands are deliberately wide. Prices move, sizes differ, and a 15%
 * difference from a median of four records is noise — calling that "above
 * what you usually pay" would train the owner to ignore the line entirely.
 */
export function comparePrice(plannedAmount: number | null, typicalAmount: number | null): PriceComparison {
  if (plannedAmount === null) return "no-amount";
  if (typicalAmount === null || typicalAmount <= 0) return "no-history";
  const multiple = plannedAmount / typicalAmount;
  if (multiple < 0.7) return "below";
  if (multiple <= 1.4) return "in-line";
  if (multiple <= 2.5) return "above";
  return "far-above";
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export async function buildPurchasePriceContext(
  userId: number,
  businessProfileId: number,
  description: string,
  plannedAmount: number | null,
  categoryId: number | null,
): Promise<PurchasePriceContext> {
  await requireOwnedBusinessProfile(userId, businessProfileId);

  const since = utcAddDays(utcToday(), -PRICE_HISTORY_DAYS);
  const words = significantWords(description);

  /*
   * Every query here is scoped to this business profile, which the ownership
   * check above has already tied to this user. A description search that
   * reached across profiles would be a data leak wearing a helpful face.
   */
  const [similarRecords, categoryRecords] = await Promise.all([
    words.length
      ? prisma.expenseRecord.findMany({
          where: {
            businessProfileId,
            date: { gte: since },
            // AND, not OR: "display fridge" should find the fridge, not every
            // record with the word "display" in it.
            AND: words.map((word) => ({
              description: { contains: word, mode: "insensitive" as const },
            })),
          },
          select: { description: true, amount: true, date: true, category: { select: { name: true } } },
          orderBy: { date: "desc" },
          take: 3,
        })
      : Promise.resolve([]),
    categoryId
      ? prisma.expenseRecord.findMany({
          where: { businessProfileId, categoryId, date: { gte: since } },
          select: { amount: true },
          // Bounded: a busy category can hold thousands, and a median over the
          // most recent 200 is the same answer for a fraction of the read.
          orderBy: { date: "desc" },
          take: 200,
        })
      : Promise.resolve([]),
  ]);

  const category = categoryId
    ? await prisma.expenseCategory.findFirst({
        where: { id: categoryId, businessProfileId },
        select: { id: true, name: true },
      })
    : null;

  const amounts = categoryRecords.map((r) => Number(r.amount)).sort((a, b) => a - b);
  const typicalAmount = median(amounts);

  return {
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    recordCount: amounts.length,
    typicalAmount,
    smallestAmount: amounts[0] ?? null,
    largestAmount: amounts[amounts.length - 1] ?? null,
    multipleOfTypical:
      plannedAmount !== null && typicalAmount && typicalAmount > 0
        ? Number((plannedAmount / typicalAmount).toFixed(2))
        : null,
    comparison: comparePrice(plannedAmount, typicalAmount),
    similar: similarRecords.map((r) => ({
      description: r.description,
      amount: Number(r.amount),
      date: r.date,
      categoryName: r.category.name,
    })),
    windowDays: PRICE_HISTORY_DAYS,
  };
}
