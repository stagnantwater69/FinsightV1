import { prisma } from "../config/prisma";
import type { BusinessProfile, Prisma } from "@prisma/client";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import {
  AMOUNT_EPSILON,
  applyMonthDataStatus,
  approximateElapsedOperatingDaysAsOf,
  computeRecoveryTarget,
  computeChangeSincePreviousDay,
  deriveBaselineAppearsOffFromPattern,
  deriveRecoveryCheckpoints,
  deriveRecoveryProjection,
  deriveSuggestedQuestionsForNextMonth,
  dayStatus,
  type DayStatus,
  impactBand,
  type MonthEndOpenDaySales,
  scanUnusualExpenses,
  selectStrongestAndWeakestOpenDay,
  PROJECTION_STALENESS_CALENDAR_DAYS,
  type RecoveryChangeSincePreviousDay,
  type RecoveryCheckpoint,
  type RecoveryConfidence,
  type RecoveryProjection,
  recoveryPaceTolerance,
  type RecoveryTargets,
} from "./analysis.service";

// All day boundaries are UTC — record dates are date-only values stored at
// UTC midnight, so local-time boundaries drop or double-count the edge days.
// See lib/dates.ts.
//
// Which calendar day counts as "today" is a separate question, and the answer
// is the business's own IANA timezone (resolveBusinessToday), not the server's
// clock — see RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.1. It still produces a
// UTC-midnight-encoded Date, so it plugs into these same date-only boundary
// helpers unchanged.
import {
  resolveBusinessToday,
  utcAddDays,
  utcDateKey,
  utcDayOfMonth,
  utcDaysInMonth,
  utcEndOfDay,
  utcMonthKey,
  utcStartOfMonth,
} from "../lib/dates";
import {
  describeWindow,
  resolveReportingWindow,
  windowDateFilter,
  type PeriodSelection,
} from "../lib/reportingPeriod";
import {
  loadBoundedCategoryHistory,
  loadBoundedCategoryHistoryForCategories,
  loadCategoryHistoryCoverage,
} from "./anomalyDetection/categoryStatistics.service";
import { DEFAULT_DETECTION_CONFIG } from "./anomalyDetection/config";
import { MAXIMUM_WINDOW_RECORDS } from "./anomalyDetection/trend.service";
import {
  deriveOperatingCounts,
  resolveExactOperatingCounts,
  resolveOperatingCalendar,
  type ExactOperatingCounts,
} from "./operatingCalendar.service";
import { evaluateRecoveryNotifications } from "./recoveryNotification.service";
import {
  calculateAvailableFundsForOwnedBusiness,
  resolveMonthlyExpenseBasisForOwnedBusiness,
  type MonthlyExpenseBasis,
} from "./financialPosition.service";
import {
  requireOwnedBusinessContext,
  type OwnedBusinessContext,
} from "./ownedBusinessContext.service";
import { nonnegativeMoneyAmountSchema } from "../lib/money";

/** Narrows an `ExactOperatingCounts` down to the subset `computeRecoveryTarget` accepts. */
function toRecoveryTargetCalendarInput(exact: ExactOperatingCounts | null) {
  return exact
    ? {
        operatingDaysThisMonth: exact.operatingDaysThisMonth,
        elapsedOperatingDays: exact.elapsedOperatingDays,
        remainingOperatingDays: exact.remainingOperatingDays,
      }
    : undefined;
}

/** Existing profile-taking exports receive profiles that their callers already ownership-checked. */
function ownedContextForProfile(profile: BusinessProfile): OwnedBusinessContext {
  return { userId: profile.userId, profile } as OwnedBusinessContext;
}

// ============================================================
// Recovery targets — the single fetch+compute path
// ============================================================
//
// Both the Dashboard summary and the Insights Recovery Target screen call
// this. Do not recompute any of these numbers in either caller; if a
// caller needs another figure, add it here.
//
// `today` is a caller-supplied date-only boundary, not computed here — see
// each caller for how it's resolved. Every caller now resolves it in the
// business's own local timezone via `resolveBusinessToday`: `getRecoveryInsight`
// and `simulateRecoveryScenario` below, `aiContext.service.ts`, and
// `dashboard.service.ts` (which used to pass `utcToday()`, so the Dashboard
// and the Recovery Target screen disagreed for the eight hours a day between
// Manila midnight and UTC midnight).
// `precomputedExactCalendar` is an optional third argument, additive to the
// original two-argument signature every existing caller (dashboard.service.ts,
// aiContext.service.ts) already uses unchanged. Pass it when a caller has
// already resolved the exact operating calendar for this profile+month
// (getRecoveryInsight does, so it also needs the calendar for dailyCoverage)
// to avoid a second identical schedule/override query; omit it and this
// function resolves its own, exactly as if the caller had passed nothing.
/**
 * Splits an arbitrary date range's sales into confirmed/provisional totals
 * (plan §9.6, Phase 3) with exactly ONE query — a `groupBy` over
 * `[businessProfileId, date]`, bucketed by `reviewStatus`/`duplicateStatus`.
 * Summing every bucket's `_sum.amount` reproduces the plain `aggregate`
 * total exactly, so this replaces that aggregate rather than running
 * alongside it (plan §15.1: "avoid a second full scan").
 *
 * Originally written for exactly one caller's need — the CURRENT month
 * through today (`loadRecoveryTargets`, below) — and widened, unchanged in
 * behavior for that caller, to a generic `[rangeStart, rangeEnd]` window so
 * `computeRecoveryProjection`'s lookback window (month-to-date-so-far
 * EXCLUDING today) can reuse the same query shape instead of a second,
 * subtly different implementation of the same confirmed/provisional split.
 */
async function loadSalesEligibilityForRange(businessProfileId: number, rangeStart: Date, rangeEnd: Date) {
  const groups = await prisma.salesReferenceRecord.groupBy({
    by: ["reviewStatus", "duplicateStatus"],
    where: { businessProfileId, date: { gte: rangeStart, lte: rangeEnd } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  let salesThisMonth = 0;
  let confirmedSalesThisMonth = 0;
  let pendingReviewSalesThisMonth = 0;
  let possibleDuplicateSalesThisMonth = 0;
  let recordCount = 0;
  for (const group of groups) {
    const amount = Number(group._sum.amount ?? 0);
    recordCount += group._count?._all ?? 0;
    salesThisMonth += amount;
    // Confirmed per §9.6: reviewStatus "Reviewed" AND duplicateStatus "Not a
    // Duplicate" — the same convention dashboard.service.ts's
    // `recordsNeedingReview` and the salesRecord/expenseRecord review queues
    // already use (OR of the two "needs attention" states = provisional).
    if (group.reviewStatus === "Reviewed" && group.duplicateStatus === "Not a Duplicate") {
      confirmedSalesThisMonth += amount;
    } else {
      if (group.reviewStatus === "Needs Review") pendingReviewSalesThisMonth += amount;
      if (group.duplicateStatus === "Flagged") possibleDuplicateSalesThisMonth += amount;
    }
  }

  return {
    salesThisMonth,
    confirmedSalesThisMonth,
    pendingReviewSalesThisMonth,
    possibleDuplicateSalesThisMonth,
    recordCount,
  };
}

async function loadRecoveryTargetSnapshot(
  profile: BusinessProfile,
  today: Date,
  precomputedExactCalendar?: ExactOperatingCounts | null,
  precomputedMonthlyExpenseBasis?: MonthlyExpenseBasis,
): Promise<{
  targets: RecoveryTargets;
  eligibility: Awaited<ReturnType<typeof loadSalesEligibilityForRange>>;
}> {
  const monthStart = utcStartOfMonth(today);
  const endOfToday = utcEndOfDay(today);

  const context = ownedContextForProfile(profile);
  const [monthEligibility, todayAgg, exactCalendar, monthlyExpenseBasis] = await Promise.all([
    loadSalesEligibilityForRange(profile.id, monthStart, endOfToday),
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: today, lte: endOfToday } },
      _sum: { amount: true },
    }),
    precomputedExactCalendar !== undefined
      ? Promise.resolve(precomputedExactCalendar)
      : resolveExactOperatingCounts(profile.id, today),
    precomputedMonthlyExpenseBasis
      ? Promise.resolve(precomputedMonthlyExpenseBasis)
      : resolveMonthlyExpenseBasisForOwnedBusiness(context, monthStart),
  ]);

  const targets = computeRecoveryTarget({
    expectedMonthlyExpenses: monthlyExpenseBasis.amount,
    monthlyExpenseBasis,
    operatingDays: profile.operatingDays,
    salesThisMonth: monthEligibility.salesThisMonth,
    salesToday: Number(todayAgg._sum.amount ?? 0),
    today,
    timezone: profile.timezone,
    exactOperatingCalendar: toRecoveryTargetCalendarInput(exactCalendar),
    recordEligibility: {
      confirmedSalesThisMonth: monthEligibility.confirmedSalesThisMonth,
      pendingReviewSalesThisMonth: monthEligibility.pendingReviewSalesThisMonth,
      possibleDuplicateSalesThisMonth: monthEligibility.possibleDuplicateSalesThisMonth,
    },
  });
  return { targets, eligibility: monthEligibility };
}

export async function loadRecoveryTargets(
  profile: BusinessProfile,
  today: Date,
  precomputedExactCalendar?: ExactOperatingCounts | null,
): Promise<RecoveryTargets> {
  return (await loadRecoveryTargetSnapshot(profile, today, precomputedExactCalendar)).targets;
}

// ============================================================
// Recovery Target — deterministic month-end projection (plan §9.8/§11 Phase
// 5)
// ============================================================
//
// NOT YET WIRED INTO ANY RESPONSE. Per §16.2 ("Gate forecasts behind
// backtesting thresholds") and §20 ("no default-enabled forecast until its
// release gate passes"), this is deliberately a standalone, tested,
// backend-only capability — `getRecoveryInsight` does not call it, no
// controller/route exposes it, and no web/mobile file reads it. Enabling it
// for real owners requires a stakeholder-approved backtesting error
// threshold (plan §19 open question #9), which is a product/financial-safety
// decision this task does not make. See
// backend/scripts/backtest-recovery-projection.ts for the harness that
// measures this formula's error on synthetic data so that decision can be
// made with real numbers later.

/**
 * Plan §9.8's deterministic month-end projection, with the exactly-two reads
 * this needs: the confirmed/provisional split over the completed-open-days
 * lookback window (month-to-date so far, EXCLUDING today — today hasn't
 * finished), and a staleness check over the most recent
 * `PROJECTION_STALENESS_CALENDAR_DAYS` calendar days. All the threshold/
 * confidence logic itself lives in `deriveRecoveryProjection`
 * (analysis.service.ts), which is pure and unit-tested without a database;
 * this function only assembles its inputs.
 *
 * `confirmedSalesThisMonth`/`remainingOperatingDays` are passed in rather
 * than re-derived — both are already computed by `loadRecoveryTargets` for
 * the SAME profile/today, and re-querying/re-approximating them here would
 * risk the two drifting apart.
 */
export async function computeRecoveryProjection(
  businessProfileId: number,
  profile: BusinessProfile,
  today: Date,
  exactCalendar: ExactOperatingCounts | null,
  confirmedSalesThisMonth: number,
  remainingOperatingDays: number,
  precomputedMonthlyExpenseBasis?: MonthlyExpenseBasis,
): Promise<RecoveryProjection & {
  /** @deprecated Use `monthlyExpenseBasis.amount`. */
  expectedMonthlyExpenses: number;
  monthlyExpenseBasis: MonthlyExpenseBasis;
}> {
  const monthStart = utcStartOfMonth(today);
  const yesterday = utcAddDays(today, -1);
  const monthlyExpenseBasis = precomputedMonthlyExpenseBasis
    ?? await resolveMonthlyExpenseBasisForOwnedBusiness(ownedContextForProfile(profile), monthStart);
  const expectedMonthlyExpenses = monthlyExpenseBasis.amount;
  const withExpenseBasis = (projection: RecoveryProjection) => ({
    ...projection,
    expectedMonthlyExpenses,
    monthlyExpenseBasis,
  });

  // Today is the 1st of the (business-local) month — no completed day exists
  // within this month yet to build a lookback average from. Short-circuits
  // before any query; deriveRecoveryProjection's own day-count guard would
  // reach the same "insufficient_data" conclusion, but querying a range that
  // starts after it ends is worth avoiding outright.
  if (yesterday < monthStart) {
    return withExpenseBasis(deriveRecoveryProjection({
      lookbackOperatingDaysAvailable: 0,
      lookbackConfirmedSalesSum: 0,
      lookbackProvisionalSalesSum: 0,
      hasRecentSales: false,
      confirmedSalesThisMonth,
      remainingOperatingDays,
      expectedMonthlyExpenses,
    }));
  }

  // Completed open days from the 1st of the month through yesterday — exact
  // when a schedule is configured, the same proportional approximation
  // `computeRecoveryTarget` uses otherwise (see
  // `approximateElapsedOperatingDaysAsOf`'s doc comment).
  const lookbackOperatingDaysAvailable = exactCalendar
    ? deriveOperatingCounts(exactCalendar.calendar, utcDateKey(yesterday)).elapsedOperatingDays
    : approximateElapsedOperatingDaysAsOf(profile.operatingDays, yesterday);

  const stalenessStart = utcAddDays(today, -PROJECTION_STALENESS_CALENDAR_DAYS);
  const [lookbackEligibility, recentAgg] = await Promise.all([
    loadSalesEligibilityForRange(businessProfileId, monthStart, utcEndOfDay(yesterday)),
    // Staleness reads ANY sale regardless of review/duplicate status — a
    // provisional-only run of sales still means the business recorded
    // something recently, which is what "stale" is asking.
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId, date: { gte: stalenessStart, lte: utcEndOfDay(yesterday) } },
      _sum: { amount: true },
    }),
  ]);

  return withExpenseBasis(deriveRecoveryProjection({
    lookbackOperatingDaysAvailable,
    lookbackConfirmedSalesSum: lookbackEligibility.confirmedSalesThisMonth,
    lookbackProvisionalSalesSum: lookbackEligibility.salesThisMonth - lookbackEligibility.confirmedSalesThisMonth,
    hasRecentSales: Number(recentAgg._sum.amount ?? 0) > 0,
    confirmedSalesThisMonth,
    remainingOperatingDays,
    expectedMonthlyExpenses,
  }));
}

// ============================================================
// Recovery Target — month-end review (plan §10.9/§11 Phase 7)
// ============================================================
//
// READ-ONLY. This function NEVER writes anything — no `BusinessProfile`
// field (`expectedMonthlyExpenses`, `operatingDays`, or any other) is ever
// updated here, under any circumstance, matching plan §10.9's closing line
// ("suggestions must not automatically update the next month's settings")
// and §7's Phase 7 entry ("require explicit approval for any next-month
// baseline update"). There is no "apply this suggestion" mutation path here
// or anywhere this function calls — a future task adding one needs its own
// explicit-approval UI flow, entirely out of scope here.
//
// NOT YET WIRED into any controller/route/web/mobile file — same
// build-first, wire-later posture as `computeRecoveryProjection` above (see
// its doc comment): this is finished and safe to eventually expose, it is
// simply being built calculation-first the same way every other phase was.
//
// OUT OF SCOPE (see this function's counterpart doc comment in
// analysis.service.ts): season-aware, weekday-weighted target allocation.
// This function compares nothing across months — it summarizes exactly one
// already-completed month from data that already exists for it.

/** One profile-month's month-end review (plan §10.9). */
export type RecoveryMonthEndReview =
  | {
      /** The requested month has not fully elapsed yet, business-locally — no
       * summary is computed. Never returned for a month that has ended. */
      status: "not_yet_reviewable";
      /** YYYY-MM, echoing the requested month. */
      month: string;
    }
  | {
      status: "reviewable";
      /** YYYY-MM. */
      month: string;
      /** Expense amount and source used as this month's coverage target. */
      monthlyExpenseBasis: MonthlyExpenseBasis;
      /** Final `salesThisMonth / expectedMonthlyExpenses * 100`, 0 when no baseline is configured (matches `computeRecoveryTarget`'s own `monthCoveragePercent` guard). */
      coveragePercent: number;
      /** `salesThisMonth - expectedMonthlyExpenses`. Positive = surplus over the coverage goal, negative = shortfall under it — the mirror-image sign of `RecoveryTargets.remainingTarget` (which is floored at 0 and only ever expresses a shortfall). */
      surplusOrShortfall: number;
      /** Highest-confirmed-sales open day this month, or `null` when the month had zero open days (see `selectStrongestAndWeakestOpenDay`'s doc comment for the zero-sales-but-real-day case). */
      strongestOpenDay: MonthEndOpenDaySales | null;
      /** Lowest-confirmed-sales open day this month, or `null` under the same zero-open-days condition as `strongestOpenDay`. */
      weakestOpenDay: MonthEndOpenDaySales | null;
      /** Count of open days that were either entirely missing (zero total sales recorded) or partially/fully provisional (needs review or flagged as a possible duplicate) — see `computeMonthEndReview`'s doc comment for why this is one combined count rather than two. */
      missingOrProvisionalDayCount: number;
      /** Total open days this month, out of which `missingOrProvisionalDayCount` is drawn — provided for context (e.g. "3 of 26 open days"). */
      openDayCount: number;
      /** `expectedMonthlyExpenses / operatingDaysThisMonth` for this month — the plain, un-adjusted daily target computable at month start, same formula as `computeRecoveryTarget`'s `dailyNeededTarget`. */
      originalDailyTarget: number;
      /** What `computeRecoveryTarget`'s `adjustedDailyTarget` would have read as on the month's own last day, or `null` for the one case that formula's own fallback can't cleanly express as a per-day rate — see `computeMonthEndReview`'s doc comment. */
      finalAdjustedDailyTarget: number | null;
      /** True when `coveragePercent` lands materially away from 100% (`MONTH_END_BASELINE_MATERIALITY_FRACTION`, analysis.service.ts) — an honest signal only, never a suggested replacement number. */
      baselineAppearsOffFromPattern: boolean;
      /** 2-4 plain, deterministic, templated strings — never AI-generated, never an instruction to change a setting. See `deriveSuggestedQuestionsForNextMonth`. */
      suggestedQuestionsForNextMonth: string[];
      /** True when a `BusinessOperatingDay` schedule was configured for this month. When false, every calendar day in the month was treated as a potential open day for `strongestOpenDay`/`weakestOpenDay`/the missing-day count — see this function's doc comment. */
      operatingScheduleConfigured: boolean;
    };

/**
 * Plan §10.9. `monthDate` is any date-only value within the target month
 * (UTC-midnight-encoded, like every other date in this codebase) — the
 * CALLER decides which month to review; this never assumes "last month"
 * automatically.
 *
 * "Has this month ended" is resolved business-locally via the same
 * `resolveBusinessToday` every other Recovery Target calculation uses — a
 * month is only reviewable once the business's own local calendar has moved
 * into a later month than the one requested.
 *
 * FALLBACK WHEN NO OPERATING SCHEDULE IS CONFIGURED: unlike
 * `computeRecoveryTarget`'s approximation (which only ever needs a COUNT of
 * open days, not which specific dates), this summary walks individual
 * calendar dates to find the strongest/weakest day and the missing/
 * provisional count. There is no way to know which specific days were
 * "open" for a profile with no `BusinessOperatingDay` schedule, so every
 * calendar day in the month is treated as a potential open day for those
 * figures — mirroring `getRecoveryInsight`'s existing `dailyCoverage`
 * fallback ("every day is a potential target day") above. `originalDailyTarget`
 * is unaffected by this — it uses `profile.operatingDays` (the stored
 * monthly count), the exact same denominator `computeRecoveryTarget`'s own
 * approximation already uses.
 *
 * "Missing or provisional days" (plan §10.9) is returned as a SINGLE
 * combined count rather than two separate ones — matching the plan's own
 * phrasing of it as one bullet ("Missing or provisional days"). `openDayCount`
 * is also returned so a caller can express it as a fraction (e.g. "3 of 26
 * open days") without a second pass over the data.
 */
export async function computeMonthEndReview(
  businessProfileId: number,
  profile: BusinessProfile,
  monthDate: Date,
): Promise<RecoveryMonthEndReview> {
  const month = utcMonthKey(monthDate);
  const monthStart = utcStartOfMonth(monthDate);
  const today = resolveBusinessToday(profile.timezone);
  const currentMonthStart = utcStartOfMonth(today);

  if (monthStart >= currentMonthStart) {
    // The current (still in-progress) month, or a future month — never
    // compute a partial/misleading summary for one; plan §10.9 is explicit
    // this is for a month that has already ended.
    return { status: "not_yet_reviewable", month };
  }

  const monthEnd = utcAddDays(monthStart, utcDaysInMonth(monthStart) - 1);
  const endOfMonth = utcEndOfDay(monthEnd);

  const [calendar, dailyGroups, monthlyExpenseBasis] = await Promise.all([
    resolveOperatingCalendar(businessProfileId, monthStart, monthEnd),
    // One bounded groupBy over the whole month (plan §15.1: no per-day
    // queries), grouped finely enough (by date AND review/duplicate state)
    // to derive both the day-by-day confirmed split and the month total from
    // a single read.
    prisma.salesReferenceRecord.groupBy({
      by: ["date", "reviewStatus", "duplicateStatus"],
      where: { businessProfileId, date: { gte: monthStart, lte: endOfMonth } },
      _sum: { amount: true },
    }),
    resolveMonthlyExpenseBasisForOwnedBusiness(ownedContextForProfile(profile), monthStart),
  ]);
  const expectedMonthlyExpenses = monthlyExpenseBasis.amount;

  // Per-day confirmed/total split, keyed by date — same confirmed convention
  // as `loadSalesEligibilityForRange` above (reviewStatus "Reviewed" AND
  // duplicateStatus "Not a Duplicate").
  const dailyTotals = new Map<string, { total: number; confirmed: number }>();
  for (const group of dailyGroups) {
    const key = utcDateKey(group.date);
    const amount = Number(group._sum.amount ?? 0);
    const entry = dailyTotals.get(key) ?? { total: 0, confirmed: 0 };
    entry.total += amount;
    if (group.reviewStatus === "Reviewed" && group.duplicateStatus === "Not a Duplicate") entry.confirmed += amount;
    dailyTotals.set(key, entry);
  }

  let salesThisMonth = 0;
  for (const entry of dailyTotals.values()) salesThisMonth += entry.total;

  const operatingScheduleConfigured = calendar != null;
  const monthEndKey = utcDateKey(monthEnd);
  const monthCounts = calendar ? deriveOperatingCounts(calendar, monthEndKey) : null;
  const operatingDaysThisMonth = monthCounts ? monthCounts.operatingDaysThisMonth : profile.operatingDays;

  const originalDailyTarget = operatingDaysThisMonth > 0 ? expectedMonthlyExpenses / operatingDaysThisMonth : 0;

  // finalAdjustedDailyTarget: reuse `computeRecoveryTarget`, unmodified, with
  // `today` = the month's own last day — "what would this profile's adjusted
  // daily target have read as on the final day of the month". Every month
  // structurally counts the last day itself in `remainingOperatingDays` when
  // that day is open (`ExactOperatingCounts` counts "today" in both elapsed
  // and remaining — see operatingCalendar.service.ts), so this is really
  // "the last OPEN day's rate", not a divide-by-zero case. The one case this
  // can't produce a meaningful per-day rate for is a schedule-configured
  // month whose literal last calendar day was CLOSED
  // (`remainingOperatingDays === 0` as of that date) — `computeRecoveryTarget`'s
  // own formula falls back to returning `remainingTarget` itself in that
  // case (a real number, just not a per-day rate). This function chooses to
  // return `null` instead of surfacing that fallback number as if it were a
  // rate. In approximation mode (no schedule configured), `remainingOperatingDays`
  // is always clamped to >= 1 inside `computeRecoveryTarget`, so this `null`
  // case cannot occur there.
  let finalAdjustedDailyTarget: number | null = null;
  const remainingOnLastDay = monthCounts ? monthCounts.remainingOperatingDays : null;
  if (!calendar || (remainingOnLastDay !== null && remainingOnLastDay > 0)) {
    const finalTargets = computeRecoveryTarget({
      expectedMonthlyExpenses,
      monthlyExpenseBasis,
      operatingDays: profile.operatingDays,
      salesThisMonth,
      salesToday: dailyTotals.get(monthEndKey)?.total ?? 0,
      today: monthEnd,
      timezone: profile.timezone,
      exactOperatingCalendar: monthCounts
        ? {
            operatingDaysThisMonth: monthCounts.operatingDaysThisMonth,
            elapsedOperatingDays: monthCounts.elapsedOperatingDays,
            remainingOperatingDays: monthCounts.remainingOperatingDays,
          }
        : undefined,
    });
    finalAdjustedDailyTarget = finalTargets.adjustedDailyTarget;
  }

  // Per-open-day CONFIRMED sales, walked in chronological order — the
  // population plan §10.9 wants for strongest/weakest ("confirmed open
  // days"), and also drives the missing/provisional count below. See this
  // function's doc comment for the no-schedule-configured fallback.
  const openDaySales: MonthEndOpenDaySales[] = [];
  let missingOrProvisionalDayCount = 0;
  for (let d = new Date(monthStart); d <= monthEnd; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const isOpen = calendar ? (calendar.get(key) ?? false) : true;
    if (!isOpen) continue;
    const entry = dailyTotals.get(key) ?? { total: 0, confirmed: 0 };
    openDaySales.push({ date: key, sales: entry.confirmed });
    const provisional = entry.total - entry.confirmed;
    if (entry.total <= AMOUNT_EPSILON || provisional > AMOUNT_EPSILON) missingOrProvisionalDayCount++;
  }

  const { strongest: strongestOpenDay, weakest: weakestOpenDay } = selectStrongestAndWeakestOpenDay(openDaySales);

  const coveragePercent = expectedMonthlyExpenses > 0 ? (salesThisMonth / expectedMonthlyExpenses) * 100 : 0;
  const surplusOrShortfall = salesThisMonth - expectedMonthlyExpenses;
  const baselineAppearsOffFromPattern = deriveBaselineAppearsOffFromPattern(coveragePercent, expectedMonthlyExpenses);

  const suggestedQuestionsForNextMonth = deriveSuggestedQuestionsForNextMonth({
    baselineAppearsOffFromPattern,
    expectedMonthlyExpenses,
    monthlyExpenseBasisSource: monthlyExpenseBasis.source,
    monthlyExpenseBasisSourceMonth: monthlyExpenseBasis.sourceMonth,
    coveragePercent,
    missingOrProvisionalDayCount,
    openDayCount: openDaySales.length,
    strongestOpenDay,
    weakestOpenDay,
    originalDailyTarget,
    finalAdjustedDailyTarget,
  });

  return {
    status: "reviewable",
    month,
    monthlyExpenseBasis,
    coveragePercent,
    surplusOrShortfall,
    strongestOpenDay,
    weakestOpenDay,
    missingOrProvisionalDayCount,
    openDayCount: openDaySales.length,
    originalDailyTarget,
    finalAdjustedDailyTarget,
    baselineAppearsOffFromPattern,
    suggestedQuestionsForNextMonth,
    operatingScheduleConfigured,
  };
}

/**
 * Ownership-gated wrapper around `computeMonthEndReview` for the HTTP layer
 * (`GET /insights/recovery/month-end-review`) — mirrors `getRecoveryInsight`'s
 * own shape: fetch-and-check the caller's own profile via
 * `requireOwnedBusinessProfile`, then hand it to the pure calculation.
 * `month` is `YYYY-MM`; the controller is responsible for validating its
 * format before calling this.
 */
export async function getMonthEndReview(
  userId: number,
  businessProfileId: number,
  month: string,
): Promise<RecoveryMonthEndReview> {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  const monthDate = new Date(`${month}-01T00:00:00.000Z`);
  return computeMonthEndReview(businessProfileId, profile, monthDate);
}

// ============================================================
// Recovery Target — hypothetical scenario (§13.2 / §15 Phase 5)
//
// The current branch uses the same resolved monthly expense basis as the live
// target. The hypothetical branch remains an explicit owner-supplied amount;
// it is never inferred from a reduction-opportunity simulation.
//
// READ-ONLY. This performs the exact same two `salesReferenceRecord`
// aggregate reads `loadRecoveryTargets` performs (duplicated here only so
// both the real and hypothetical figures can be computed from one profile
// fetch/one pair of reads) and then calls `computeRecoveryTarget` — the
// existing pure formula, completely unmodified and un-duplicated — twice:
// once with the resolved current basis, once with the assumed amount.
// Nothing here writes to `BusinessProfile` or anywhere else; see
// tests/integration/recoveryScenario.test.ts for the no-write assertion.
// ============================================================

/**
 * Plan §8.4/§9.9, Phase 4 — comparisons between `current` and `hypothetical`,
 * for a client to show side-by-side without re-deriving the diffs itself.
 */
export interface RecoveryScenarioDelta {
  /**
   * `hypothetical.expectedMonthlyExpenses - current.expectedMonthlyExpenses`.
   * Named `totalCoverageGoal` for forward-compatibility with plan §8.4's
   * eventual `RecoveryScenarioV2` field name. No safety-buffer feature exists
   * yet (§9.3: "Safety buffer is zero until the optional feature is
   * explicitly enabled"), so `totalCoverageGoal` and `expectedMonthlyExpenses`
   * are exactly the same quantity today — this field documents that
   * equivalence rather than computing something different.
   */
  totalCoverageGoal: number;
  remainingTarget: number;
  adjustedDailyTarget: number;
  /**
   * ALWAYS `null` for now. Plan §9.9 defines
   * `estimatedTransactionsPerDay = ceil(adjustedDailyTarget ÷
   * recentAverageTransactionValue)`, but only "when transaction-level sales
   * references reliably represent transactions" — and whether they do is
   * §19's still-OPEN stakeholder question #7 ("Are imported sales rows
   * transaction-level, daily aggregates, or both, and how is that provenance
   * represented?"). `SalesReferenceRecord` has no field distinguishing the
   * two cases, so there is no way to know whether
   * `recentAverageTransactionValue` would be meaningful. Per §9.9's explicit
   * instruction ("the API must return null with a reason instead of showing
   * a misleading number"), this is a deliberate, permanent-until-resolved
   * deferral of an open plan question — NOT a bug or a TODO to fill in by
   * guessing/inferring provenance from record counts or patterns.
   */
  estimatedTransactionsPerDay: number | null;
  /**
   * Why `estimatedTransactionsPerDay` is null. A single literal for now — a
   * real enum only makes sense once a second unavailability reason exists.
   */
  estimatedTransactionsPerDayUnavailableReason: "transaction_provenance_unknown";
}

export interface RecoveryScenario {
  /** The explicit hypothetical the owner supplied — never derived automatically. */
  assumedExpectedMonthlyExpenses: number;
  /** Unchanged passthrough of the currently resolved target. */
  current: RecoveryTargets;
  /** What the target would be if `expectedMonthlyExpenses` were the assumed value. Not saved anywhere. */
  hypothetical: RecoveryTargets;
  delta: RecoveryScenarioDelta;
  /** Always `false` — confirms to any client that nothing here was persisted (plan §8.4). This function has never written anywhere; see tests/integration/recoveryScenario.test.ts. */
  persisted: false;
}

export async function simulateRecoveryScenario(
  userId: number,
  businessProfileId: number,
  assumedExpectedMonthlyExpenses: number,
): Promise<RecoveryScenario> {
  if (!Number.isFinite(assumedExpectedMonthlyExpenses) || assumedExpectedMonthlyExpenses < 0) {
    throw new ApiError(400, "assumedExpectedMonthlyExpenses must be a finite number greater than or equal to 0");
  }

  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);
  const today = resolveBusinessToday(profile.timezone);
  const monthStart = utcStartOfMonth(today);
  const endOfToday = utcEndOfDay(today);

  // Same reads `loadRecoveryTargets` performs — see the comment above for why
  // they are duplicated rather than shared, and why that duplication is
  // reads-only and does not touch the formula itself.
  const [monthAgg, todayAgg, exactCalendar, monthlyExpenseBasis] = await Promise.all([
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: monthStart, lte: endOfToday } },
      _sum: { amount: true },
    }),
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: today, lte: endOfToday } },
      _sum: { amount: true },
    }),
    resolveExactOperatingCounts(profile.id, today),
    resolveMonthlyExpenseBasisForOwnedBusiness(ownedContextForProfile(profile), monthStart),
  ]);

  // NOTE (plan §9.6, Phase 3): `recordEligibility` is deliberately omitted
  // here, unlike `loadRecoveryTargets`. `computeRecoveryTarget` then treats
  // every sale as confirmed, which is a documented shortcut — the scenario
  // only ever varies `expectedMonthlyExpenses`, so the confirmed/provisional
  // review-state split doesn't change either branch's meaning, and this
  // avoids duplicating `loadMonthSalesEligibility`'s groupBy query here too.
  const sharedInput = {
    operatingDays: profile.operatingDays,
    salesThisMonth: Number(monthAgg._sum.amount ?? 0),
    salesToday: Number(todayAgg._sum.amount ?? 0),
    today,
    timezone: profile.timezone,
    exactOperatingCalendar: toRecoveryTargetCalendarInput(exactCalendar),
  };

  const current = computeRecoveryTarget({
    ...sharedInput,
    expectedMonthlyExpenses: monthlyExpenseBasis.amount,
    monthlyExpenseBasis,
  });
  const hypotheticalBasis: MonthlyExpenseBasis = {
    amount: assumedExpectedMonthlyExpenses,
    source: "owner_estimate",
    sourceMonth: null,
    ownerEstimate: assumedExpectedMonthlyExpenses,
    recordsCompleteThroughMonth: null,
    recordsCompleteThroughConfirmedAt: null,
    eligibleRecordCount: 0,
  };
  const hypothetical = computeRecoveryTarget({
    ...sharedInput,
    expectedMonthlyExpenses: assumedExpectedMonthlyExpenses,
    monthlyExpenseBasis: hypotheticalBasis,
  });

  return {
    assumedExpectedMonthlyExpenses,
    current,
    hypothetical,
    delta: {
      totalCoverageGoal: hypothetical.expectedMonthlyExpenses - current.expectedMonthlyExpenses,
      remainingTarget: hypothetical.remainingTarget - current.remainingTarget,
      adjustedDailyTarget: hypothetical.adjustedDailyTarget - current.adjustedDailyTarget,
      estimatedTransactionsPerDay: null,
      estimatedTransactionsPerDayUnavailableReason: "transaction_provenance_unknown",
    },
    persisted: false,
  };
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
async function latestExpenseDate(businessProfileId: number, latest: Date): Promise<Date | null> {
  const row = await prisma.expenseRecord.findFirst({
    // Up to the business's today: a future-dated record is not the latest expense.
    where: { businessProfileId, date: { lte: utcEndOfDay(latest) } },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

/**
 * Spending over the window as a chart series, one point per day, or per month
 * when the window is all time.
 *
 * Every day in range is emitted, including the ones with no spending: dropping
 * empty days would silently compress the x-axis and turn a quiet fortnight
 * into a flat line that looks like steady spending.
 *
 * A week or month still in progress stops at today (or at the last record, if
 * one is dated later). Plotting the rest of September as zero-spend days
 * would pull the chart's "usual day" line down with days that have not
 * happened. A legacy rolling window keeps its full length, as it always has.
 *
 * All time is bucketed by calendar month, from the first month with an expense
 * to the last: three years of daily points is a solid bar, not a chart.
 */
export function spendSeries(
  window: ReturnType<typeof resolveReportingWindow>,
  today: Date,
  byDay: { date: Date; _sum: { amount: Prisma.Decimal | number | null }; _count: number }[],
): { dailyTotals: { date: string; total: number; count: number }[]; dailyBucket: "day" | "month" } {
  if (!window.start || !window.end) {
    if (byDay.length === 0) return { dailyTotals: [], dailyBucket: "month" };
    const times = byDay.map((group) => group.date.getTime());
    const first = utcStartOfMonth(new Date(Math.min(...times)));
    const last = utcStartOfMonth(new Date(Math.max(...times)));
    const monthly = new Map<string, { total: number; count: number }>();
    for (let d = first; d <= last; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
      monthly.set(utcMonthKey(d), { total: 0, count: 0 });
    }
    for (const group of byDay) {
      const entry = monthly.get(utcMonthKey(group.date));
      if (entry) {
        entry.total += Number(group._sum.amount ?? 0);
        entry.count += group._count;
      }
    }
    return {
      dailyTotals: [...monthly.entries()].map(([month, v]) => ({ date: `${month}-01`, total: v.total, count: v.count })),
      dailyBucket: "month",
    };
  }

  let seriesEnd = window.end;
  if (window.kind !== "rolling" && today < window.end) {
    const latestRecord = byDay.reduce<Date | null>((latest, group) => (!latest || group.date > latest ? group.date : latest), null);
    const lastShown = latestRecord && latestRecord > today ? latestRecord : today;
    seriesEnd = lastShown < window.start ? window.start : lastShown;
  }

  const dailyMap = new Map<string, { total: number; count: number }>();
  for (let d = window.start; d <= seriesEnd; d = utcAddDays(d, 1)) {
    dailyMap.set(utcDateKey(d), { total: 0, count: 0 });
  }
  for (const group of byDay) {
    const entry = dailyMap.get(utcDateKey(group.date));
    if (entry) {
      entry.total = Number(group._sum.amount ?? 0);
      entry.count = group._count;
    }
  }
  return {
    dailyTotals: [...dailyMap.entries()].map(([date, v]) => ({ date, total: v.total, count: v.count })),
    dailyBucket: "day",
  };
}

export async function getExpenseBehaviorForOwnedBusiness(
  context: OwnedBusinessContext,
  /**
   * The period to read. A number is the legacy rolling window of that many
   * days, which the mobile client and the AI context still ask for; the web
   * period filter sends a selection (this week, a calendar month, all time).
   * See lib/reportingPeriod.ts for what each one covers.
   */
  period: number | PeriodSelection,
  /**
   * The day a legacy rolling window ENDS on. Defaults to today, which is every
   * existing caller's behaviour. Ignored when `period` is a selection.
   */
  endDate?: Date,
  options: { maximumAnalysisCategories?: number } = {},
) {
  const { profile } = context;
  const businessProfileId = profile.id;

  // The business's own calendar day, not the server's: between local midnight
  // and 08:00 in Manila, a UTC "today" put the owner's newest expense outside
  // both the current window and the previous one, so a morning's spending
  // showed up in neither the period total nor the comparison against it.
  const businessToday = resolveBusinessToday(profile.timezone);
  const selection: PeriodSelection =
    typeof period === "number" ? { kind: "rolling", days: period, ...(endDate ? { endDate } : {}) } : period;
  const window = resolveReportingWindow(selection, businessToday);
  // Where the unusual-expense baseline is anchored: the end of a finished
  // period, otherwise today. A past month is judged against what was normal
  // then, not against spending that came after it.
  const today = window.end && window.end < businessToday ? window.end : businessToday;
  const periodDays = window.days ?? 0;

  const dateFilter = windowDateFilter(window, businessToday);
  const currentWindow = { businessProfileId, ...(dateFilter ? { date: dateFilter } : {}) };
  const previousWindow = window.previous
    ? { businessProfileId, date: windowDateFilter(window.previous, businessToday) }
    : null;
  const maximumAnalysisCategories = options.maximumAnalysisCategories === undefined
    ? null
    : Math.max(1, Math.floor(options.maximumAnalysisCategories));
  const cappedCurrentByCategory = maximumAnalysisCategories === null
    ? null
    : await prisma.expenseRecord.groupBy({
        by: ["categoryId"],
        where: currentWindow,
        _sum: { amount: true },
        _count: true,
        orderBy: [{ _sum: { amount: "desc" } }, { categoryId: "asc" }],
        take: maximumAnalysisCategories,
      });
  let selectedAnalysisCategoryIds: number[] | null = cappedCurrentByCategory
    ? cappedCurrentByCategory.map((group) => group.categoryId)
    : null;
  if (
    selectedAnalysisCategoryIds !== null
    && maximumAnalysisCategories !== null
    && selectedAnalysisCategoryIds.length < maximumAnalysisCategories
    && previousWindow
  ) {
    const remaining = maximumAnalysisCategories - selectedAnalysisCategoryIds.length;
    const previousOnly = await prisma.expenseRecord.groupBy({
      by: ["categoryId"],
      where: {
        ...previousWindow,
        ...(selectedAnalysisCategoryIds.length > 0
          ? { categoryId: { notIn: selectedAnalysisCategoryIds } }
          : {}),
      },
      _sum: { amount: true },
      orderBy: [{ _sum: { amount: "desc" } }, { categoryId: "asc" }],
      take: remaining,
    });
    selectedAnalysisCategoryIds = [
      ...selectedAnalysisCategoryIds,
      ...previousOnly.map((group) => group.categoryId),
    ];
  }
  const selectedCategoryFilter = selectedAnalysisCategoryIds
    ? { categoryId: { in: selectedAnalysisCategoryIds } }
    : {};
  const selectedCurrentWindow = { ...currentWindow, ...selectedCategoryFilter };
  const selectedPreviousWindow = previousWindow
    ? { ...previousWindow, ...selectedCategoryFilter }
    : null;
  const coverageCurrentWindow = {
    ...(dateFilter.gte ? { start: dateFilter.gte } : {}),
    end: dateFilter.lte,
  };
  const coveragePreviousWindow = previousWindow
    ? {
        ...(previousWindow.date.gte ? { start: previousWindow.date.gte } : {}),
        end: previousWindow.date.lte,
      }
    : undefined;

  // Capped AI calls restrict category detail queries to the selected ids.
  // Separate aggregates keep the period totals exact across every category.
  const [
    currentRecords,
    currentByCategory,
    currentByDay,
    previousByCategory,
    categories,
    boundedCategoryHistory,
    categoryHistoryCoverage,
    currentTotal,
    previousTotal,
    latestExpense,
  ] = await Promise.all([
    prisma.expenseRecord.findMany({
      // Explicit projection, not the whole row. A 366-day window on a busy
      // account is thousands of records, and every column this does not name
      // is bytes over the wire and a Decimal/Date object built for nothing.
      // These five are exactly what the unusual-expense scan and its output read.
      where: selectedCurrentWindow,
      select: { id: true, categoryId: true, amount: true, date: true, description: true },
      // Bounded on the trend detector's ceiling, newest first: past it, an
      // account loses the oldest end of the window, not what was just entered.
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: MAXIMUM_WINDOW_RECORDS,
    }),
    cappedCurrentByCategory
      ?? prisma.expenseRecord.groupBy({
        by: ["categoryId"],
        where: currentWindow,
        _sum: { amount: true },
        _count: true,
      }),
    // Record dates are date-only values stored at UTC midnight, so the column
    // itself is the daily bucket — no truncation or raw SQL needed.
    prisma.expenseRecord.groupBy({ by: ["date"], where: currentWindow, _sum: { amount: true }, _count: true }),
    // All time has nothing before it to compare with.
    selectedPreviousWindow
      ? prisma.expenseRecord.groupBy({
          by: ["categoryId"],
          where: selectedPreviousWindow,
          _sum: { amount: true },
        })
      : Promise.resolve([] as { categoryId: number; _sum: { amount: Prisma.Decimal | null } }[]),
    prisma.expenseCategory.findMany({
      where: {
        businessProfileId,
        ...(selectedAnalysisCategoryIds ? { id: { in: selectedAnalysisCategoryIds } } : {}),
      },
    }),
    selectedAnalysisCategoryIds
      ? loadBoundedCategoryHistoryForCategories(
          businessProfileId,
          today,
          selectedAnalysisCategoryIds,
          DEFAULT_DETECTION_CONFIG.baselineDays,
          DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
        )
      : loadBoundedCategoryHistory(
          businessProfileId,
          today,
          DEFAULT_DETECTION_CONFIG.baselineDays,
          DEFAULT_DETECTION_CONFIG.maximumCategoryRecords,
        ),
    selectedAnalysisCategoryIds
      ? loadCategoryHistoryCoverage(
          businessProfileId,
          today,
          DEFAULT_DETECTION_CONFIG.baselineDays,
          coverageCurrentWindow,
          coveragePreviousWindow,
        )
      : Promise.resolve(null),
    selectedAnalysisCategoryIds
      ? prisma.expenseRecord.aggregate({ where: currentWindow, _sum: { amount: true } })
      : Promise.resolve(null),
    selectedAnalysisCategoryIds && previousWindow
      ? prisma.expenseRecord.aggregate({ where: previousWindow, _sum: { amount: true } })
      : Promise.resolve(null),
    latestExpenseDate(businessProfileId, businessToday),
  ]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  // [ADDED] Plan §5.2/§15 Phase 5 — owner-controlled cost-behavior classification.
  // `categories` already loads the full row (no `select`), so this is a plain
  // in-memory lookup, not an extra query. Lowercased to match this codebase's
  // existing enum-to-API convention (e.g. `direction`/`detectedBy` below).
  const categoryCostBehavior = new Map(categories.map((c) => [c.id, c.costBehavior]));

  const currentTotals = new Map(currentByCategory.map((g) => [g.categoryId, Number(g._sum.amount ?? 0)]));
  // How many expenses make up each category's total. A category can be large
  // because of one big purchase or because of forty small ones, and those are
  // completely different problems — the count is what tells them apart.
  const currentCounts = new Map(currentByCategory.map((g) => [g.categoryId, g._count]));
  const previousTotals = new Map(previousByCategory.map((g) => [g.categoryId, Number(g._sum.amount ?? 0)]));

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
        // [ADDED] Plan §5.2/§15 Phase 5. "unclassified" (the default) when a
        // category id isn't in `categories` at all — cannot happen in
        // practice since `categoryIds` is derived from records against these
        // same categories, but keeps this total.
        costBehavior: (categoryCostBehavior.get(categoryId) ?? "UNCLASSIFIED").toLowerCase() as
          | "fixed"
          | "variable"
          | "mixed"
          | "unclassified",
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
  const totalCurrent = selectedAnalysisCategoryIds
    ? Number(currentTotal?._sum.amount ?? 0)
    : [...currentTotals.values()].reduce((s, v) => s + v, 0);
  const totalPrevious = selectedAnalysisCategoryIds
    ? Number(previousTotal?._sum.amount ?? 0)
    : [...previousTotals.values()].reduce((s, v) => s + v, 0);

  // ============================================================
  // Daily spend series
  // ============================================================
  // Answers "when does the money actually leave?" — the question a category
  // breakdown cannot. Every day in the period is emitted, including the ones
  // with no spending: dropping empty days would silently compress the x-axis
  // and turn a quiet fortnight into a flat line that looks like steady
  // spending.
  const { dailyTotals, dailyBucket } = spendSeries(window, businessToday, currentByDay);

  // Unusual-expense detection: leave-one-out Z-score/IQR against a bounded
  // rolling baseline. Years-old prices no longer distort today's normal, and
  // a high-volume category cannot make this request load unlimited history.
  // Current-period candidates are merged even when they sit just outside the
  // baseline (the API permits a 366-day view), so a visible row is never
  // silently omitted from eligibility checks.
  //
  // THE MERGE CARRIES THE SAME PER-CATEGORY CEILING THE BASELINE DOES.
  // `loadBoundedCategoryHistory` caps each category in SQL; the merge used to
  // add the selected period on top without a limit, so a category with 20,000
  // records in the window handed all 20,000 to a leave-one-out scan on a
  // synchronous path an authenticated GET holds. `maximumCategoryRecords` is
  // the ceiling every sibling detector applies. Newest first, so what it can
  // drop is the oldest end of the window, not spending just entered.
  const maximumPerCategory = DEFAULT_DETECTION_CONFIG.maximumCategoryRecords;
  const recordsByCategory = new Map<number, Map<number, { id: number; amount: number }>>();
  for (const categoryId of selectedAnalysisCategoryIds ?? []) {
    recordsByCategory.set(categoryId, new Map());
  }
  for (const r of boundedCategoryHistory) {
    const records = recordsByCategory.get(r.categoryId) ?? new Map();
    records.set(r.id, { id: r.id, amount: Number(r.amount) });
    recordsByCategory.set(r.categoryId, records);
  }
  const currentNewestFirst = [...currentRecords].sort(
    (a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id,
  );
  const selectedAnalysisCategories = selectedAnalysisCategoryIds
    ? new Set(selectedAnalysisCategoryIds)
    : null;
  for (const r of currentNewestFirst) {
    if (selectedAnalysisCategories && !selectedAnalysisCategories.has(r.categoryId)) continue;
    const records = recordsByCategory.get(r.categoryId) ?? new Map();
    if (!records.has(r.id) && records.size >= maximumPerCategory) continue;
    records.set(r.id, { id: r.id, amount: Number(r.amount) });
    recordsByCategory.set(r.categoryId, records);
  }
  const byCategory = new Map(
    [...recordsByCategory].map(([categoryId, records]) => [categoryId, [...records.values()]]),
  );
  const currentRecordById = new Map(currentRecords.map((r) => [r.id, r]));

  /*
   * Unusual by z-score OR by IQR, AND materially different in peso terms — see
   * isUnusualExpense. The two statistical tests are blind in different places,
   * and the peso floor is what stops either of them reporting a difference too
   * small for an owner to care about.
   *
   * The leave-one-out arithmetic itself now lives in `scanUnusualExpenses`,
   * which amortises it across the category instead of rebuilding (and
   * re-sorting) every candidate's baseline from scratch. Same tests, same
   * thresholds, same numbers — see the note above that function for why the
   * one input family an O(1) update cannot handle is still computed the old
   * way. Only candidates inside the selected period are reportable, which is
   * what `currentRecordById.has` expresses; the whole bounded history still
   * forms the baseline.
   */
  const scan = scanUnusualExpenses(byCategory, (id) => currentRecordById.has(id));

  const unusualExpenses = scan.unusual.map((hit) => {
    const currentRecord = currentRecordById.get(hit.id)!;
    return {
      id: hit.id,
      description: currentRecord.description,
      amount: hit.amount,
      date: currentRecord.date,
      categoryId: hit.categoryId,
      categoryName: categoryName.get(hit.categoryId) ?? "Unknown",
      zScore: hit.zScore,
      categoryMean: hit.categoryMean,
      categoryStdDev: hit.categoryStdDev,
      // Which test caught it. A flag an owner can be shown the reason for
      // is worth more than one they have to take on trust.
      detectedBy: hit.detectedBy,
    };
  });
  const insufficientHistoryCategories = scan.insufficientHistory.map((entry) => ({
    categoryId: entry.categoryId,
    categoryName: categoryName.get(entry.categoryId) ?? "Unknown",
    historyCount: entry.historyCount,
  }));
  const analysisCoverage = categoryHistoryCoverage
    ? {
        eligibleCategoryCount: categoryHistoryCoverage.eligibleCategoryCount,
        analyzedCategoryCount: selectedAnalysisCategoryIds?.length ?? byCategory.size,
        omittedCategoryCount: Math.max(
          0,
          categoryHistoryCoverage.eligibleCategoryCount - (selectedAnalysisCategoryIds?.length ?? byCategory.size),
        ),
        insufficientHistoryCategoryCount: Math.max(
          categoryHistoryCoverage.insufficientHistoryCategoryCount,
          insufficientHistoryCategories.length,
        ),
      }
    : null;

  unusualExpenses.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  const recordDays = currentByDay.map((group) => group.date.getTime());
  return {
    // All time spans what the business actually has, not an invented range.
    periodStart: window.start ?? (recordDays.length ? new Date(Math.min(...recordDays)) : businessToday),
    periodEnd: window.end ?? (recordDays.length ? new Date(Math.max(...recordDays)) : businessToday),
    previousPeriodStart: window.previous?.start ?? null,
    previousPeriodEnd: window.previous?.end ?? null,
    periodDays,
    /** The resolved window, as date keys. */
    period: describeWindow(window),
    totals: { current: totalCurrent, previous: totalPrevious },
    dailyTotals,
    /** "month" when the series is too long to read one point per day (all time). */
    dailyBucket,
    categoryTrends,
    unusualExpenses,
    insufficientHistoryCategories,
    ...(analysisCoverage ? { analysisCoverage } : {}),
    /**
     * Where this business's expenses actually are, independent of the window
     * above — so an empty period can tell the owner the difference between
     * "you have never recorded an expense" and "you have plenty, just none
     * lately", which are opposite situations that looked identical.
     */
    latestExpenseDate: latestExpense,
  };
}

export type ExpenseBehaviorResult = Awaited<ReturnType<typeof getExpenseBehaviorForOwnedBusiness>>;

export async function getExpenseBehavior(
  userId: number,
  businessProfileId: number,
  period: number | PeriodSelection,
  endDate?: Date,
  options: { maximumAnalysisCategories?: number } = {},
): Promise<ExpenseBehaviorResult> {
  const context = await requireOwnedBusinessContext(userId, businessProfileId);
  return getExpenseBehaviorForOwnedBusiness(context, period, endDate, options);
}

// ============================================================
// Target-Based Recovery Insight
// ============================================================

/**
 * Widens `DayStatus` with a `"closed"` state for the daily coverage table
 * only (plan §8.3). `dayStatus()` itself stays above/at/below-only — it has
 * no way to know about the operating calendar, and callers elsewhere
 * (`computeRecoveryTarget`'s `todaysStatus`) don't need `"closed"` at all.
 * This override is applied here, after calling `dayStatus()`, not inside it.
 */
export type RecoveryDayCoverageStatus = ReturnType<typeof dayStatus> | "closed";

export type RecoveryReportingSelection =
  | { kind: "week" }
  | { kind: "month"; month: string };

export type RecoveryReportingPeriodStatus =
  | "needs_setup"
  | "no_data"
  | "ahead"
  | "on_pace"
  | "behind"
  | "covered";

export interface RecoveryReportingPeriod {
  kind: RecoveryReportingSelection["kind"];
  month: string | null;
  start: string;
  end: string;
  asOfDate: string;
  timezone: string;
  /** True when the selected interval contains the business-local current day. */
  isCurrent: boolean;
  /** True only after the selected interval has ended, never while its final day is still in progress. */
  isComplete: boolean;
  targetBasis: "prorated_monthly_expenses" | "monthly_expenses";
  /** One entry per calendar month touched by the selected interval. */
  monthlyExpenseBases: Array<{ targetMonth: string; basis: MonthlyExpenseBasis }>;
  target: number;
  sales: number;
  confirmedSales: number;
  provisionalSales: number;
  remainingTarget: number;
  coveragePercent: number;
  dailyTarget: number;
  /** Null when the interval has ended or has no remaining target-bearing days. */
  adjustedDailyTarget: number | null;
  operatingDays: number;
  elapsedOperatingDays: number;
  remainingOperatingDays: number;
  operatingScheduleConfigured: boolean;
  operatingDaysIsApproximated: boolean;
  expectedSalesToDate: number;
  paceVarianceAmount: number;
  status: RecoveryReportingPeriodStatus;
  confidence: RecoveryConfidence;
  recordCount: number;
  dataWarnings: RecoveryTargets["dataWarnings"];
}

interface ResolvedRecoveryReportingPeriod {
  summary: RecoveryReportingPeriod;
  isOperatingDay: Map<string, boolean>;
  targetByDate: Map<string, number>;
}

function recoveryDataWarnings(
  eligibility: Awaited<ReturnType<typeof loadSalesEligibilityForRange>>,
): RecoveryTargets["dataWarnings"] {
  const warnings: RecoveryTargets["dataWarnings"] = [];
  if (eligibility.salesThisMonth - eligibility.confirmedSalesThisMonth <= AMOUNT_EPSILON) return warnings;
  if (eligibility.pendingReviewSalesThisMonth > AMOUNT_EPSILON) warnings.push("records_pending_review");
  if (eligibility.possibleDuplicateSalesThisMonth > AMOUNT_EPSILON) warnings.push("possible_duplicates");
  if (warnings.length === 0) warnings.push("records_pending_review");
  return warnings;
}

/** A week sums each date's share of the monthly expense baseline, including each month's own rate at a boundary. */
async function resolveRecoveryReportingPeriod(
  profile: BusinessProfile,
  businessToday: Date,
  selection: RecoveryReportingSelection,
  targets: RecoveryTargets,
  targetExactCalendar: ExactOperatingCounts | null,
  precomputedEligibility?: Awaited<ReturnType<typeof loadSalesEligibilityForRange>>,
): Promise<ResolvedRecoveryReportingPeriod> {
  const window = resolveReportingWindow(selection, businessToday);
  const start = window.start!;
  const end = window.end!;

  if (start > businessToday) {
    throw new ApiError(400, "Recovery Target does not support future months");
  }

  const asOf = end < businessToday ? end : businessToday;
  const isCurrent = start <= businessToday && businessToday <= end;
  const isComplete = end < businessToday;
  const configured = targetExactCalendar !== null;
  const isOperatingDay = new Map<string, boolean>();
  const targetByDate = new Map<string, number>();
  const operatingDayWeight = new Map<string, number>();

  const monthKeys = new Set<string>();
  for (let d = new Date(start); d <= end; d = utcAddDays(d, 1)) monthKeys.add(utcMonthKey(d));

  const monthlyExpenseBasisByMonth = new Map<string, MonthlyExpenseBasis>();
  const targetsMonth = utcMonthKey(new Date(`${targets.asOfDate}T00:00:00.000Z`));
  await Promise.all(
    [...monthKeys].map(async (monthKey) => {
      if (monthKey === targetsMonth) {
        monthlyExpenseBasisByMonth.set(monthKey, targets.monthlyExpenseBasis);
        return;
      }
      const monthStart = new Date(`${monthKey}-01T00:00:00.000Z`);
      const basis = await resolveMonthlyExpenseBasisForOwnedBusiness(ownedContextForProfile(profile), monthStart);
      monthlyExpenseBasisByMonth.set(monthKey, basis);
    }),
  );

  const monthlyCalendars = new Map<string, Map<string, boolean>>();
  if (configured) {
    await Promise.all(
      [...monthKeys].map(async (monthKey) => {
        const monthStart = new Date(`${monthKey}-01T00:00:00.000Z`);
        const monthEnd = utcAddDays(monthStart, utcDaysInMonth(monthStart) - 1);
        if (utcMonthKey(targets.asOfDate ? new Date(`${targets.asOfDate}T00:00:00.000Z`) : asOf) === monthKey) {
          monthlyCalendars.set(monthKey, targetExactCalendar!.calendar);
          return;
        }
        const calendar = await resolveOperatingCalendar(profile.id, monthStart, monthEnd);
        if (calendar) monthlyCalendars.set(monthKey, calendar);
      }),
    );
  }

  for (let d = new Date(start); d <= end; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const basis = monthlyExpenseBasisByMonth.get(utcMonthKey(d));
    if (!basis) throw new Error(`Missing monthly expense basis for ${utcMonthKey(d)}`);
    if (!configured) {
      // Spread an undated monthly operating-day count across calendar dates.
      // This preserves the monthly target without inventing closed weekdays.
      const daysInMonth = utcDaysInMonth(d);
      isOperatingDay.set(key, true);
      operatingDayWeight.set(key, profile.operatingDays > 0 ? profile.operatingDays / daysInMonth : 0);
      targetByDate.set(key, basis.amount / daysInMonth);
      continue;
    }

    const calendar = monthlyCalendars.get(utcMonthKey(d));
    const open = calendar?.get(key) ?? false;
    isOperatingDay.set(key, open);
    operatingDayWeight.set(key, open ? 1 : 0);
    if (!open) {
      targetByDate.set(key, 0);
      continue;
    }
    let openDaysInMonth = 0;
    for (const value of calendar?.values() ?? []) if (value) openDaysInMonth++;
    targetByDate.set(
      key,
      openDaysInMonth > 0 ? basis.amount / openDaysInMonth : 0,
    );
  }

  const eligibility = precomputedEligibility
    ?? await loadSalesEligibilityForRange(profile.id, start, utcEndOfDay(asOf));
  const sales = eligibility.salesThisMonth;
  const confirmedSales = eligibility.confirmedSalesThisMonth;
  const provisionalSales = sales - confirmedSales;

  let target = 0;
  let expectedSalesToDate = 0;
  let operatingDays = 0;
  let elapsedOperatingDays = 0;
  let remainingOperatingDays = 0;
  const asOfKey = utcDateKey(asOf);
  for (let d = new Date(start); d <= end; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const weight = operatingDayWeight.get(key) ?? 0;
    const dayTarget = targetByDate.get(key) ?? 0;
    target += dayTarget;
    operatingDays += weight;
    if (key <= asOfKey) {
      elapsedOperatingDays += weight;
      expectedSalesToDate += dayTarget;
    }
    if (!isComplete && key >= asOfKey) remainingOperatingDays += weight;
  }
  // Avoid floating-point accumulation making a whole calendar month read as
  // 30,999.999999999996 instead of the configured 31,000.
  if (selection.kind === "month") {
    target = monthlyExpenseBasisByMonth.get(selection.month)?.amount ?? target;
    if (isComplete) expectedSalesToDate = target;
  }
  const dailyTarget = operatingDays > 0 ? target / operatingDays : 0;

  const remainingTarget = Math.max(0, target - sales);
  const coveragePercent = target > 0 ? (sales / target) * 100 : 0;
  const paceVarianceAmount = sales - expectedSalesToDate;
  const adjustedDailyTarget = !isComplete && remainingOperatingDays > 0
    ? remainingTarget / remainingOperatingDays
    : null;

  let status: RecoveryReportingPeriodStatus;
  let confidence: RecoveryConfidence;
  const hasMissingBasis = [...monthlyExpenseBasisByMonth.values()].some(
    (basis) => basis.source === "owner_estimate" && basis.amount <= 0,
  );
  if (hasMissingBasis) {
    status = "needs_setup";
    confidence = "unavailable";
  } else if (target < AMOUNT_EPSILON) {
    status = "covered";
    confidence = "moderate";
  } else if (eligibility.recordCount === 0) {
    status = "no_data";
    confidence = "limited";
  } else if (remainingTarget < AMOUNT_EPSILON) {
    status = "covered";
    confidence = "moderate";
  } else if (isComplete) {
    status = "behind";
    confidence = "moderate";
  } else {
    const tolerance = recoveryPaceTolerance(dailyTarget);
    status = paceVarianceAmount > tolerance
      ? "ahead"
      : paceVarianceAmount < -tolerance
        ? "behind"
        : "on_pace";
    confidence = "moderate";
  }

  return {
    summary: {
      kind: selection.kind,
      month: selection.kind === "month" ? selection.month : null,
      start: utcDateKey(start),
      end: utcDateKey(end),
      asOfDate: utcDateKey(asOf),
      timezone: profile.timezone,
      isCurrent,
      isComplete,
      targetBasis: selection.kind === "month" ? "monthly_expenses" : "prorated_monthly_expenses",
      monthlyExpenseBases: [...monthlyExpenseBasisByMonth.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([targetMonth, basis]) => ({ targetMonth, basis })),
      target,
      sales,
      confirmedSales,
      provisionalSales,
      remainingTarget,
      coveragePercent,
      dailyTarget,
      adjustedDailyTarget,
      operatingDays,
      elapsedOperatingDays,
      remainingOperatingDays,
      operatingScheduleConfigured: configured,
      operatingDaysIsApproximated: !configured,
      expectedSalesToDate,
      paceVarianceAmount,
      status,
      confidence,
      recordCount: eligibility.recordCount,
      dataWarnings: recoveryDataWarnings(eligibility),
    },
    isOperatingDay,
    targetByDate,
  };
}

/**
 * Weekly Recovery Target checkpoints for the CURRENT month (plan §10.4,
 * Phase 4). Does the one bounded read this needs — the month's sales grouped
 * by day — and hands it to `deriveRecoveryCheckpoints` (analysis.service.ts)
 * for the actual checkpoint-date/target/status math; see that function's doc
 * comment for the date-alignment convention and target formula.
 *
 * A dedicated query rather than reusing `getRecoveryInsight`'s
 * `dailyCoverage` window: `coverageDays` can be shorter (or, near the start
 * of a month, effectively longer) than "the whole month so far", and a
 * checkpoint's cumulative target/recorded-amount must always be anchored to
 * the 1st of the month regardless of what window the daily table is showing.
 * A single month's sales summed by day is the same shape of cheap,
 * already-indexed read `dailyCoverage` already performs (plan §15.1).
 *
 * No new persistence — purely derived from `SalesReferenceRecord` plus the
 * already-resolved operating calendar (or the approximation, when none is
 * configured).
 */
export async function computeWeeklyCheckpoints(
  businessProfileId: number,
  profile: BusinessProfile,
  today: Date,
  dailyNeededTarget: number,
  exactCalendar: ExactOperatingCounts | null,
): Promise<RecoveryCheckpoint[]> {
  const monthStart = utcStartOfMonth(today);
  const endOfToday = utcEndOfDay(today);

  const records = await prisma.salesReferenceRecord.findMany({
    where: { businessProfileId, date: { gte: monthStart, lte: endOfToday } },
    select: { date: true, amount: true },
  });

  const salesByDay = new Map<string, number>();
  for (const r of records) {
    const key = utcDateKey(r.date);
    salesByDay.set(key, (salesByDay.get(key) ?? 0) + Number(r.amount));
  }

  return deriveRecoveryCheckpoints({
    today,
    dailyNeededTarget,
    operatingDays: profile.operatingDays,
    exactCalendar: exactCalendar?.calendar,
    salesByDay,
  });
}

export async function getRecoveryInsight(
  userId: number,
  businessProfileId: number,
  coverageDays: number,
  period?: RecoveryReportingSelection,
  // Ask FinSight reads these figures as context and must not evaluate alerts:
  // the screens already do, and the writes sat on every chat reply's path.
  options: { evaluateAlerts?: boolean } = {},
) {
  const context = await requireOwnedBusinessContext(userId, businessProfileId);
  const { profile } = context;

  const businessToday = resolveBusinessToday(profile.timezone);
  const selection: RecoveryReportingSelection = period ?? {
    kind: "month",
    month: utcMonthKey(businessToday),
  };
  const selectedWindow = resolveReportingWindow(selection, businessToday);
  const selectedStart = selectedWindow.start!;
  const selectedEnd = selectedWindow.end!;
  if (selectedStart > businessToday) {
    throw new ApiError(400, "Recovery Target does not support future months");
  }

  // Legacy top-level fields stay monthly; `reportingPeriod` owns selected-week names and math.
  // A completed month is anchored to its final day.
  const targetAsOf = selection.kind === "month" && selectedEnd < businessToday
    ? selectedEnd
    : businessToday;
  const exactCalendar = await resolveExactOperatingCounts(businessProfileId, targetAsOf);
  const targetSnapshot = await loadRecoveryTargetSnapshot(profile, targetAsOf, exactCalendar);
  const targets = targetSnapshot.targets;
  const resolvedPeriod = await resolveRecoveryReportingPeriod(
    profile,
    businessToday,
    selection,
    targets,
    exactCalendar,
    selection.kind === "month" ? targetSnapshot.eligibility : undefined,
  );

  const monthStart = utcStartOfMonth(targetAsOf);
  const periodAsOf = new Date(`${resolvedPeriod.summary.asOfDate}T00:00:00.000Z`);
  const boundedCoverageStart = utcAddDays(periodAsOf, -(coverageDays - 1));
  const coverageStart = boundedCoverageStart > selectedStart ? boundedCoverageStart : selectedStart;
  const coverageEnd = utcEndOfDay(periodAsOf);

  // Independent reads: issued together so they cost one round trip, not three.
  const [coverageRecords, latestSale, weeklyCheckpoints] = await Promise.all([
    prisma.salesReferenceRecord.findMany({
      where: { businessProfileId, date: { gte: coverageStart, lte: coverageEnd } },
      select: { date: true, amount: true },
    }),
    prisma.salesReferenceRecord.findFirst({
      where: { businessProfileId, date: { lte: utcEndOfDay(businessToday) } },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    selection.kind === "month"
      ? computeWeeklyCheckpoints(
          businessProfileId,
          profile,
          targetAsOf,
          targets.dailyNeededTarget,
          exactCalendar,
        )
      : [],
  ]);

  const salesByDay = new Map<string, number>();
  for (const r of coverageRecords) {
    const key = utcDateKey(r.date);
    salesByDay.set(key, (salesByDay.get(key) ?? 0) + Number(r.amount));
  }

  const dailyCoverage: {
    date: string;
    /** True when this date is an operating day. Defaults to true for every
     * date when no schedule is configured — matching current behavior,
     * where every day is treated as a potential target day (plan §8.3). */
    isOperatingDay: boolean;
    neededTarget: number | null;
    sales: number;
    gap: number | null;
    status: RecoveryDayCoverageStatus;
  }[] = [];
  for (let d = new Date(coverageStart); d <= periodAsOf; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const sales = salesByDay.get(key) ?? 0;
    const isOperatingDay = period
      ? (resolvedPeriod.isOperatingDay.get(key) ?? false)
      : exactCalendar
        ? (exactCalendar.calendar.get(key) ?? false)
        : true;
    if (!isOperatingDay) {
      dailyCoverage.push({ date: key, isOperatingDay: false, neededTarget: null, sales, gap: null, status: "closed" });
      continue;
    }
    const neededTarget = period
      ? (resolvedPeriod.targetByDate.get(key) ?? resolvedPeriod.summary.dailyTarget)
      : targets.dailyNeededTarget;
    dailyCoverage.push({
      date: key,
      isOperatingDay: true,
      neededTarget,
      sales,
      gap: sales - neededTarget,
      status: dayStatus(sales, neededTarget),
    });
  }

  const monthHasNoRecords = targetSnapshot.eligibility.recordCount === 0;
  // §9.7 precedence step 2, folded on top of the pure per-snapshot status —
  // see applyMonthDataStatus's doc comment for why this can't be decided
  // inside computeRecoveryTarget itself.
  const { status, confidence } = applyMonthDataStatus(targets, monthHasNoRecords);

  const currentMonthSelected = selection.kind === "month" && selection.month === utcMonthKey(businessToday);
  const changeSincePreviousDay = currentMonthSelected
    ? computeRecoveryChangeSincePreviousDay(profile, targetAsOf, targets, exactCalendar)
    : null;

  // Only current-month reads evaluate alerts; filtered and historical reads stay side-effect free.
  // The evaluator is idempotent because Dashboard and Recovery can both call it.
  if (currentMonthSelected && options.evaluateAlerts !== false) {
    const todayKey = targets.asOfDate;
    const lastThreeCompletedOperatingDayStatuses = dailyCoverage
      .filter((row) => row.isOperatingDay && row.date !== todayKey)
      .map((row) => row.status as DayStatus)
      .slice(-3);
    await evaluateRecoveryNotifications({
      profile,
      targets: { ...targets, status },
      lastThreeCompletedOperatingDayStatuses,
    });
  }

  return {
    ...targets,
    status,
    confidence,
    monthStart,
    today: targetAsOf,
    coverageDays: dailyCoverage.length,
    dailyCoverage,
    reportingPeriod: resolvedPeriod.summary,
    /** True when not one sale is recorded in the month this page is reporting on. */
    monthHasNoRecords,
    /** The most recent sale on file, so an empty month can point at where the data is. */
    latestSaleDate: latestSale?.date ?? null,
    /** When this response was computed — lets a client label a cached/stale result. */
    computedAt: new Date().toISOString(),
    /** "Why your target changed" (plan §8.2/§10.3, Phase 3) — see helper doc comment. */
    changeSincePreviousDay,
    /** Weekly checkpoints for the selected month; omitted as an empty list for a week view. */
    weeklyCheckpoints,
  };
}

/**
 * §8.2/§10.3 "Why your target changed" (Phase 3).
 *
 * NO PERSISTENCE EXISTS for a prior day's computed target (plan §7.5), so
 * this deterministically RE-RUNS the exact same `computeRecoveryTarget` path
 * as of business-local yesterday and diffs the two results
 * (`computeChangeSincePreviousDay` in analysis.service.ts). Every input below
 * is either already loaded by the caller or derived in-memory from it — no
 * second sales or schedule/override query:
 *
 *   - yesterday's `salesThisMonth` = today's `salesThisMonth` minus today's
 *     `todaysSales` (excluding today's date from the same month total).
 *   - yesterday's exact operating-day counts (when a schedule is configured)
 *     = `deriveOperatingCounts` re-run over the SAME calendar Map already
 *     resolved for today, just anchored to yesterday's date key instead of
 *     hitting the DB again.
 *   - yesterday reuses today's resolved expense basis and schedule. There is
 *     no historical snapshot that could reconstruct a same-day edit or import.
 *
 * Returns `null` on the 1st of the (business-local) month — there is no
 * "yesterday" within the same month to compare against, and comparing across
 * a month boundary would diff two different targets — and whenever
 * `targets.needsSetup` is true, since the comparison needs a real expense
 * baseline to be meaningful.
 */
function computeRecoveryChangeSincePreviousDay(
  profile: BusinessProfile,
  today: Date,
  targets: RecoveryTargets,
  exactCalendar: ExactOperatingCounts | null,
): RecoveryChangeSincePreviousDay | null {
  if (utcDayOfMonth(today) === 1) return null;
  if (targets.needsSetup) return null;

  const yesterday = utcAddDays(today, -1);
  const yesterdaySalesThisMonth = targets.salesThisMonth - targets.todaysSales;
  const yesterdayExactCalendar = exactCalendar
    ? deriveOperatingCounts(exactCalendar.calendar, utcDateKey(yesterday))
    : undefined;

  const yesterdayTargets = computeRecoveryTarget({
    expectedMonthlyExpenses: targets.expectedMonthlyExpenses,
    monthlyExpenseBasis: targets.monthlyExpenseBasis,
    operatingDays: profile.operatingDays,
    salesThisMonth: yesterdaySalesThisMonth,
    // Not used by any field this comparison reads (adjustedDailyTarget,
    // salesThisMonth, remainingOperatingDays) — only todaysTarget/Gap/Status
    // depend on it, and those aren't part of the diff.
    salesToday: 0,
    today: yesterday,
    timezone: profile.timezone,
    exactOperatingCalendar: yesterdayExactCalendar,
  });

  return computeChangeSincePreviousDay(targets, yesterdayTargets);
}

// ============================================================
// Spending-Impact Assessment (pure calculation, nothing persisted)
// ============================================================

export async function simulateSpendingImpact(
  userId: number,
  businessProfileId: number,
  plannedAmount: number,
  /** A legacy rolling `periodDays`, or a period filter selection. */
  period: number | PeriodSelection = 30
) {
  const parsedAmount = nonnegativeMoneyAmountSchema.safeParse(plannedAmount);
  if (!parsedAmount.success) {
    throw new ApiError(400, parsedAmount.error.issues[0]?.message ?? "Planned amount is invalid");
  }

  const context = await requireOwnedBusinessContext(userId, businessProfileId);
  const { profile } = context;

  // Business-local "today" — see getExpenseBehavior above. The recent-spending
  // baseline this compares a planned purchase against must not silently drop
  // the day the owner is standing in.
  const today = resolveBusinessToday(profile.timezone);
  const selection: PeriodSelection = typeof period === "number" ? { kind: "rolling", days: period } : period;
  const window = resolveReportingWindow(selection, today);
  const dates = windowDateFilter(window, today);
  const periodDays = window.days ?? 0;
  const periodStart = window.start;

  const [expenseAgg, availableFundsCalculation] = await Promise.all([
    prisma.expenseRecord.aggregate({
      where: { businessProfileId, ...(dates ? { date: dates } : {}) },
      _sum: { amount: true },
    }),
    calculateAvailableFundsForOwnedBusiness(context, today),
  ]);

  const availableFunds = availableFundsCalculation.calculatedAmount;
  const spendableFunds = Math.max(0, availableFunds);
  const resultingFunds = availableFunds - plannedAmount;
  const percentOfFunds = availableFunds > 0 ? (plannedAmount / availableFunds) * 100 : plannedAmount > 0 ? Infinity : 0;
  const exceedsFunds = plannedAmount > spendableFunds;

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
    periodEnd: window.end ?? today,
    period: describeWindow(window),
    plannedAmount,
    thresholdPercent,
    thresholdAmount: spendableFunds * (thresholdPercent / 100),
    // Infinity is possible here (zero funds, nonzero spend); the
    // controller caps it, since JSON has no Infinity.
    percentOfFunds,
    impactBand: Number.isFinite(percentOfFunds)
      ? impactBand(percentOfFunds, thresholdPercent)
      : ("High Impact" as const),
    exceedsFunds,
    funds: { before: availableFunds, after: resultingFunds },
    availableFundsCalculation,
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
 * The term handed to SQL for a search word.
 *
 * A plural and its singular are the same purchase — an owner who typed
 * "chairs" means the record that says "chair". The prefilter searches the
 * shorter form so both come back, and `describesSameItem` below decides
 * which of them actually count.
 */
export function searchTerm(word: string): string {
  return word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word;
}

const WORD_SPLIT = /[^a-z0-9]+/;

/** `chair` and `chairs`, `box` and `boxes` — the same thing, typed differently. */
function sameWord(a: string, b: string): boolean {
  return a === b || a + "s" === b || b + "s" === a || a + "es" === b || b + "es" === a;
}

/**
 * Does this record describe the item the owner asked about?
 *
 * THIS EXISTS BECAUSE `contains` IS A SUBSTRING MATCH, AND A SUBSTRING MATCH
 * LIES. An owner pricing a "house" was shown a snack receipt, because one of
 * its lines read "Piattos Roadhouse BBQ" and "Roadhouse" contains "house".
 * The same trap catches "oven" in "proven", "rice" in "price", "cart" in
 * "cartons" and "pack" in "backpack" — all of them ordinary words in an
 * ordinary ledger.
 *
 * That kind of wrong answer is worse here than anywhere else in FinSight: the
 * card presents this half as counted from the owner's own records rather than
 * written by AI, which is exactly the label that tells them to trust it.
 *
 * So the SQL `contains` stays as a cheap prefilter, and every candidate is
 * re-checked here against whole words before it is allowed to count.
 */
export function describesSameItem(description: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const tokens = description.toLowerCase().split(WORD_SPLIT).filter(Boolean);
  return words.every((word) => tokens.some((token) => sameWord(token, word)));
}

/**
 * A description holding a whole basket rather than one purchase.
 *
 * A confirmed receipt scan writes every line it read into one record: "Piattos
 * Roadhouse BBQ (40g) - Bag, Mr. Chips Nacho Cheese (24g) - Bag, Presto Creams
 * Peanut Butter (30g) - Pack of 10, ...". The amount on that record is the
 * whole shop, so quoting it as what the owner paid "last time you bought
 * something like this" overstates the item's price by however many other
 * things were in the basket — even when the word match is genuine.
 *
 * Four or more comma-separated parts is the signal. Three or fewer is the
 * ordinary way anyone writes one thing down: "Rice, 25kg sack, premium".
 */
export function looksLikeBasket(description: string): boolean {
  return description.split(",").filter((part) => part.trim().length > 0).length >= 4;
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
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  const businessToday = resolveBusinessToday(profile.timezone);
  const since = utcAddDays(businessToday, -PRICE_HISTORY_DAYS);
  // Price history is what was actually paid, so it stops at today.
  const historyDates = { gte: since, lte: utcEndOfDay(businessToday) };
  const words = significantWords(description);

  /*
   * Every query here is scoped to this business profile, which the ownership
   * check above has already tied to this user. A description search that
   * reached across profiles would be a data leak wearing a helpful face.
   */
  const [candidateRecords, categoryRecords] = await Promise.all([
    words.length
      ? prisma.expenseRecord.findMany({
          where: {
            businessProfileId,
            date: historyDates,
            // AND, not OR: "display fridge" should find the fridge, not every
            // record with the word "display" in it.
            //
            // This is only the PREFILTER. `contains` is a substring match, so
            // it also returns "Roadhouse" for "house"; describesSameItem below
            // is what decides. Searching the singular stem keeps a plural and
            // its singular in the same result set for it to judge.
            AND: words.map((word) => ({
              description: { contains: searchTerm(word), mode: "insensitive" as const },
            })),
          },
          select: { description: true, amount: true, date: true, category: { select: { name: true } } },
          orderBy: { date: "desc" },
          // Deliberately more than the three that are shown: most of what the
          // substring prefilter returns is about to be thrown away, and taking
          // three here would mean three false matches crowding out the real
          // one further down the list.
          take: 30,
        })
      : Promise.resolve([]),
    categoryId
      ? prisma.expenseRecord.findMany({
          where: { businessProfileId, categoryId, date: historyDates },
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

  /*
   * What survives both checks, newest first, capped at the three the card
   * shows. An empty list here is the honest outcome when the only records
   * mentioning the word were mentioning a different thing: the card falls
   * back to the category spread, and says it has no matching purchase rather
   * than offering one it cannot stand behind.
   */
  const similarRecords = candidateRecords
    .filter((r) => describesSameItem(r.description, words) && !looksLikeBasket(r.description))
    .slice(0, 3);

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
