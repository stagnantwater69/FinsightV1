import { prisma } from "../config/prisma";
import type { BusinessProfile } from "@prisma/client";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import { ApiError } from "../middleware/error.middleware";
import {
  AMOUNT_EPSILON,
  applyMonthDataStatus,
  approximateElapsedOperatingDaysAsOf,
  computeCategoryStats,
  computeQuartiles,
  detectionMethod,
  computeRecoveryTarget,
  computeChangeSincePreviousDay,
  deriveBaselineAppearsOffFromPattern,
  deriveRecoveryCheckpoints,
  deriveRecoveryProjection,
  deriveSuggestedQuestionsForNextMonth,
  dayStatus,
  type DayStatus,
  impactBand,
  isUnusualExpense,
  type MonthEndOpenDaySales,
  selectStrongestAndWeakestOpenDay,
  zScore,
  MIN_HISTORY_FOR_DETECTION,
  PROJECTION_STALENESS_CALENDAR_DAYS,
  type RecoveryChangeSincePreviousDay,
  type RecoveryCheckpoint,
  type RecoveryProjection,
  type RecoveryTargets,
} from "./analysis.service";

// All day boundaries are UTC — record dates are date-only values stored at
// UTC midnight, so local-time boundaries drop or double-count the edge days.
// See lib/dates.ts.
//
// Recovery Target's "today", specifically, is resolved in the business's own
// IANA timezone instead (resolveBusinessToday) — see the comment on
// loadRecoveryTargets below and RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.1. It
// still produces a UTC-midnight-encoded Date, so it plugs into these same
// date-only boundary helpers unchanged.
import {
  resolveBusinessToday,
  utcAddDays,
  utcDateKey,
  utcDayOfMonth,
  utcDaysInMonth,
  utcEndOfDay,
  utcMonthKey,
  utcStartOfMonth,
  utcToday,
} from "../lib/dates";
import { loadBoundedCategoryHistory } from "./anomalyDetection/categoryStatistics.service";
import { DEFAULT_DETECTION_CONFIG } from "./anomalyDetection/config";
import {
  deriveOperatingCounts,
  resolveExactOperatingCounts,
  resolveOperatingCalendar,
  type ExactOperatingCounts,
} from "./operatingCalendar.service";
import { evaluateRecoveryNotifications } from "./recoveryNotification.service";

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

// ============================================================
// Recovery targets — the single fetch+compute path
// ============================================================
//
// Both the Dashboard summary and the Insights Recovery Target screen call
// this. Do not recompute any of these numbers in either caller; if a
// caller needs another figure, add it here.
//
// `today` is a caller-supplied date-only boundary, not computed here — see
// each caller for how it's resolved. `getRecoveryInsight` and
// `simulateRecoveryScenario` (below, in this file) resolve it in the
// business's own local timezone via `resolveBusinessToday`; `dashboard.service.ts`
// currently still passes `utcToday()`, which is out of scope for this task.
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
  });

  let salesThisMonth = 0;
  let confirmedSalesThisMonth = 0;
  let pendingReviewSalesThisMonth = 0;
  let possibleDuplicateSalesThisMonth = 0;
  for (const group of groups) {
    const amount = Number(group._sum.amount ?? 0);
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

  return { salesThisMonth, confirmedSalesThisMonth, pendingReviewSalesThisMonth, possibleDuplicateSalesThisMonth };
}

export async function loadRecoveryTargets(
  profile: BusinessProfile,
  today: Date,
  precomputedExactCalendar?: ExactOperatingCounts | null,
): Promise<RecoveryTargets> {
  const monthStart = utcStartOfMonth(today);
  const endOfToday = utcEndOfDay(today);

  const [monthEligibility, todayAgg, exactCalendar] = await Promise.all([
    loadSalesEligibilityForRange(profile.id, monthStart, endOfToday),
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: today, lte: endOfToday } },
      _sum: { amount: true },
    }),
    precomputedExactCalendar !== undefined
      ? Promise.resolve(precomputedExactCalendar)
      : resolveExactOperatingCounts(profile.id, today),
  ]);

  return computeRecoveryTarget({
    expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses),
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
): Promise<RecoveryProjection> {
  const monthStart = utcStartOfMonth(today);
  const yesterday = utcAddDays(today, -1);
  const expectedMonthlyExpenses = Number(profile.expectedMonthlyExpenses);

  // Today is the 1st of the (business-local) month — no completed day exists
  // within this month yet to build a lookback average from. Short-circuits
  // before any query; deriveRecoveryProjection's own day-count guard would
  // reach the same "insufficient_data" conclusion, but querying a range that
  // starts after it ends is worth avoiding outright.
  if (yesterday < monthStart) {
    return deriveRecoveryProjection({
      lookbackOperatingDaysAvailable: 0,
      lookbackConfirmedSalesSum: 0,
      lookbackProvisionalSalesSum: 0,
      hasRecentSales: false,
      confirmedSalesThisMonth,
      remainingOperatingDays,
      expectedMonthlyExpenses,
    });
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

  return deriveRecoveryProjection({
    lookbackOperatingDaysAvailable,
    lookbackConfirmedSalesSum: lookbackEligibility.confirmedSalesThisMonth,
    lookbackProvisionalSalesSum: lookbackEligibility.salesThisMonth - lookbackEligibility.confirmedSalesThisMonth,
    hasRecentSales: Number(recentAgg._sum.amount ?? 0) > 0,
    confirmedSalesThisMonth,
    remainingOperatingDays,
    expectedMonthlyExpenses,
  });
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
  const expectedMonthlyExpenses = Number(profile.expectedMonthlyExpenses);

  const [calendar, dailyGroups] = await Promise.all([
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
  ]);

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
// Independently verified (see task context this was built against): the real
// Recovery Target — `loadRecoveryTargets` above — never reads `ExpenseRecord`
// at all, so an expense reduction has no path to affect it. §13.2's ONLY
// valid hypothetical is an explicit, owner-supplied change to
// `expectedMonthlyExpenses` — never one derived automatically from a
// reduction-opportunity simulation. This function takes that assumption as
// an explicit parameter; it is never inferred.
//
// READ-ONLY. This performs the exact same two `salesReferenceRecord`
// aggregate reads `loadRecoveryTargets` performs (duplicated here only so
// both the real and hypothetical figures can be computed from one profile
// fetch/one pair of reads) and then calls `computeRecoveryTarget` — the
// existing pure formula, completely unmodified and un-duplicated — twice:
// once with the real `expectedMonthlyExpenses`, once with the assumed one.
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
  /** Unchanged passthrough of the real, currently-configured target. */
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
  const [monthAgg, todayAgg, exactCalendar] = await Promise.all([
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: monthStart, lte: endOfToday } },
      _sum: { amount: true },
    }),
    prisma.salesReferenceRecord.aggregate({
      where: { businessProfileId: profile.id, date: { gte: today, lte: endOfToday } },
      _sum: { amount: true },
    }),
    resolveExactOperatingCounts(profile.id, today),
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

  const current = computeRecoveryTarget({ ...sharedInput, expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses) });
  const hypothetical = computeRecoveryTarget({ ...sharedInput, expectedMonthlyExpenses: assumedExpectedMonthlyExpenses });

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
  // [ADDED] Plan §5.2/§15 Phase 5 — owner-controlled cost-behavior classification.
  // `categories` already loads the full row (no `select`), so this is a plain
  // in-memory lookup, not an extra query. Lowercased to match this codebase's
  // existing enum-to-API convention (e.g. `direction`/`detectedBy` below).
  const categoryCostBehavior = new Map(categories.map((c) => [c.id, c.costBehavior]));

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

/**
 * Widens `DayStatus` with a `"closed"` state for the daily coverage table
 * only (plan §8.3). `dayStatus()` itself stays above/at/below-only — it has
 * no way to know about the operating calendar, and callers elsewhere
 * (`computeRecoveryTarget`'s `todaysStatus`) don't need `"closed"` at all.
 * This override is applied here, after calling `dayStatus()`, not inside it.
 */
export type RecoveryDayCoverageStatus = ReturnType<typeof dayStatus> | "closed";

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

export async function getRecoveryInsight(userId: number, businessProfileId: number, coverageDays: number) {
  const profile = await requireOwnedBusinessProfile(userId, businessProfileId);

  const today = resolveBusinessToday(profile.timezone);
  const exactCalendar = await resolveExactOperatingCounts(businessProfileId, today);
  const targets = await loadRecoveryTargets(profile, today, exactCalendar);

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
    /** True when this date is an operating day. Defaults to true for every
     * date when no schedule is configured — matching current behavior,
     * where every day is treated as a potential target day (plan §8.3). */
    isOperatingDay: boolean;
    neededTarget: number | null;
    sales: number;
    gap: number | null;
    status: RecoveryDayCoverageStatus;
  }[] = [];
  for (let d = new Date(coverageStart); d <= today; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const sales = salesByDay.get(key) ?? 0;
    // No schedule configured => every day is a potential target day, exactly
    // as before Phase 2. A configured schedule with no entry for this
    // specific date (shouldn't happen — resolveOperatingCalendar covers the
    // whole month) defensively also reads as closed, never open.
    const isOperatingDay = exactCalendar ? (exactCalendar.calendar.get(key) ?? false) : true;
    if (!isOperatingDay) {
      // §8.3: closed days have target=null, gap=null, status="closed" — they
      // must not reduce pace or create a missed-target warning.
      dailyCoverage.push({ date: key, isOperatingDay: false, neededTarget: null, sales, gap: null, status: "closed" });
      continue;
    }
    dailyCoverage.push({
      date: key,
      isOperatingDay: true,
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
  const [latestSale, monthRecordCount] = await Promise.all([
    prisma.salesReferenceRecord.findFirst({
      where: { businessProfileId },
      orderBy: { date: "desc" },
      select: { date: true },
    }),
    // Independent of `coverageDays` and of `dailyCoverage`'s displayed window —
    // a sale recorded on day 1 of a 20-day-old month must not read as "no
    // sales this month" just because it falls outside the last N days shown.
    prisma.salesReferenceRecord.count({
      where: { businessProfileId, date: { gte: monthStart, lte: endOfToday } },
    }),
  ]);

  const monthHasNoRecords = monthRecordCount === 0;
  // §9.7 precedence step 2, folded on top of the pure per-snapshot status —
  // see applyMonthDataStatus's doc comment for why this can't be decided
  // inside computeRecoveryTarget itself.
  const { status, confidence } = applyMonthDataStatus(targets, monthHasNoRecords);

  const changeSincePreviousDay = computeRecoveryChangeSincePreviousDay(profile, today, targets, exactCalendar);
  const weeklyCheckpoints = await computeWeeklyCheckpoints(businessProfileId, profile, today, targets.dailyNeededTarget, exactCalendar);

  /*
   * Recovery Target notifications (plan §10.8/§11 Phase 6) — a side effect,
   * not part of this response's shape/values. Runs on EVERY load of this
   * screen/the Dashboard (there is no scheduler), which is why
   * `evaluateRecoveryNotifications` is itself idempotent (durable
   * cooldown/dedup state) and never throws — a failure here must not take
   * down the Recovery Target page itself.
   *
   * The "last three completed operating days" come straight out of
   * `dailyCoverage` above rather than a second query — see
   * `decideBehindThreeDaysTrigger`'s doc comment for why fewer than three
   * available rows (e.g. a short coverage window, or early in the month)
   * simply means that trigger can't fire on THIS evaluation.
   */
  const todayKey = targets.asOfDate;
  const lastThreeCompletedOperatingDayStatuses = dailyCoverage
    .filter((row) => row.isOperatingDay && row.date !== todayKey)
    .map((row) => row.status as DayStatus)
    .slice(-3);
  // Pass the FINAL, `no_current_month_data`-corrected status (`status`
  // above), not `targets.status` — that field is the pure per-snapshot value
  // `computeRecoveryTarget` produced before `applyMonthDataStatus` folds in
  // the full-month record count, and BEHIND_THREE_DAYS/COVERAGE_REACHED must
  // key off the same status the client actually sees.
  await evaluateRecoveryNotifications({ profile, targets: { ...targets, status }, lastThreeCompletedOperatingDayStatuses });

  return {
    ...targets,
    status,
    confidence,
    monthStart,
    today,
    coverageDays: dailyCoverage.length,
    dailyCoverage,
    /** True when not one sale is recorded in the month this page is reporting on. */
    monthHasNoRecords,
    /** The most recent sale on file, so an empty month can point at where the data is. */
    latestSaleDate: latestSale?.date ?? null,
    /** When this response was computed — lets a client label a cached/stale result. */
    computedAt: new Date().toISOString(),
    /** "Why your target changed" (plan §8.2/§10.3, Phase 3) — see helper doc comment. */
    changeSincePreviousDay,
    /** Weekly Recovery Target checkpoints for the current month (plan §10.4, Phase 4) — see `computeWeeklyCheckpoints`. */
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
 *   - yesterday's `expectedMonthlyExpenses`/`operatingDays` = today's profile
 *     values. Past-dated schedule/expense changes are not reconstructed —
 *     plan §8.2 explicitly scopes that out ("read as of NOW... don't
 *     overthink historical-schedule-versioning"). This means an owner who
 *     edited `expectedMonthlyExpenses` TODAY is exactly the `baseline_changed`
 *     case the delta is meant to surface, at the cost of not being able to
 *     tell that apart from a schedule edit — see `classifyRecoveryChangeReason`'s
 *     doc comment for why both collapse into `data_changed`.
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
    expectedMonthlyExpenses: Number(profile.expectedMonthlyExpenses),
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
