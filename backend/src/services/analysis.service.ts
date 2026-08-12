// Shared statistical/financial calculations — used by both the Dashboard
// summary endpoint and the Insights screens. Keep this the single source
// of truth for these formulas; don't let a second, slightly different
// version grow up in either caller.

// ============================================================
// Recovery target — month-to-date tracker
// ============================================================
//
// This replaces an earlier period-prorate model (periodTarget +
// perOperatingDayTarget). That model answered "what should this arbitrary
// N-day window have produced?", which is not the question the mockup or
// the manuscript actually asks. The question is "am I on pace to cover
// this month's expenses, and what do I need per day from here on?" — so
// the whole thing is anchored to the calendar month, not to a rolling
// window.
//
// Direct matches to the mockup's stated formulas:
//   Daily Needed Target  = Expected Monthly Expenses ÷ Operating Days
//   Remaining Target     = Expected Monthly Expenses − Sales So Far
//   Adjusted Daily Target = Remaining Target ÷ Remaining Operating Days
//
// INTERPRETED, not stated anywhere — see remainingOperatingDays below.

export type DayStatus = "above" | "at" | "below";

// Half a centavo. Comparing two Decimal-derived floats with === would
// make "at target" essentially unreachable; anything inside rounding
// noise of the target counts as having hit it.
const AMOUNT_EPSILON = 0.005;

export function dayStatus(sales: number, target: number): DayStatus {
  if (Math.abs(sales - target) < AMOUNT_EPSILON) return "at";
  return sales > target ? "above" : "below";
}

// Read in UTC because record dates are date-only values stored at UTC
// midnight — see lib/dates.ts for why local getters corrupt the result.
export { utcDaysInMonth as daysInMonth } from "../lib/dates";
import { utcDayOfMonth, utcDaysInMonth } from "../lib/dates";

export interface RecoveryTargetInput {
  expectedMonthlyExpenses: number;
  operatingDays: number;
  /** Sales reference recorded from the 1st of this month through today. */
  salesThisMonth: number;
  /** Sales reference recorded today only. */
  salesToday: number;
  today: Date;
}

export interface RecoveryTargets {
  expectedMonthlyExpenses: number;
  operatingDays: number;
  dailyNeededTarget: number;
  salesThisMonth: number;
  remainingTarget: number;
  daysInMonth: number;
  calendarDaysLeftInMonth: number;
  remainingOperatingDays: number;
  remainingOperatingDaysIsApproximated: boolean;
  adjustedDailyTarget: number;
  todaysTarget: number;
  todaysSales: number;
  todaysGap: number;
  todaysStatus: DayStatus;
  monthCoveragePercent: number;
  onTrack: boolean;
}

export function computeRecoveryTarget(input: RecoveryTargetInput): RecoveryTargets {
  const { expectedMonthlyExpenses, operatingDays, salesThisMonth, salesToday, today } = input;

  const dailyNeededTarget = operatingDays > 0 ? expectedMonthlyExpenses / operatingDays : 0;

  // Floored at 0: once the month's expenses are covered there is no
  // "negative target left to earn" — a negative remaining target would
  // produce a nonsense negative adjusted daily target.
  const remainingTarget = Math.max(0, expectedMonthlyExpenses - salesThisMonth);

  // APPROXIMATION, flagged. BusinessProfile stores operatingDays as a
  // count per month (e.g. 25), not a weekly schedule (e.g. "closed
  // Sundays"), so the exact operating days left in the month are
  // genuinely unknowable from the data model. We scale the monthly count
  // by the fraction of the month still ahead. Today counts as remaining —
  // sales can still be recorded against it.
  // Clamped to >= 1 so the last day of the month can't divide by zero (or
  // by a rounded-down 0 for a business with few operating days).
  const totalDays = utcDaysInMonth(today);
  const calendarDaysLeftInMonth = totalDays - utcDayOfMonth(today) + 1;
  const remainingOperatingDays = Math.max(1, Math.round(operatingDays * (calendarDaysLeftInMonth / totalDays)));

  const adjustedDailyTarget = remainingTarget / remainingOperatingDays;

  const todaysTarget = dailyNeededTarget;
  const todaysGap = salesToday - todaysTarget;

  return {
    expectedMonthlyExpenses,
    operatingDays,
    dailyNeededTarget,
    salesThisMonth,
    remainingTarget,
    daysInMonth: totalDays,
    calendarDaysLeftInMonth,
    remainingOperatingDays,
    remainingOperatingDaysIsApproximated: true,
    adjustedDailyTarget,
    todaysTarget,
    todaysSales: salesToday,
    todaysGap,
    todaysStatus: dayStatus(salesToday, todaysTarget),
    monthCoveragePercent: expectedMonthlyExpenses > 0 ? (salesThisMonth / expectedMonthlyExpenses) * 100 : 0,
    // "On track" at the month level = the adjusted daily target hasn't
    // drifted above the original flat target. If it has, the shortfall so
    // far is now being pushed onto fewer remaining days.
    onTrack: adjustedDailyTarget <= dailyNeededTarget + AMOUNT_EPSILON,
  };
}

// ============================================================
// Spending-impact banding
// ============================================================
//
// INTERPRETED CUTOFFS, not adviser-confirmed. The mockup hardcoded 25% of
// Available Business Funds as "high impact" with a "noticeable" band
// starting at 10%. Rather than hardcode both numbers, the top boundary is
// the owner's configurable largeExpenseThresholdPercent and the lower
// boundary is 40% of it — which reproduces the mockup's 10% cutoff
// exactly when the threshold is left at the mockup's 25%.
//
// Note the mockup also had a fourth "Very High Impact" band above 50%
// (2x threshold). Not built — the spec for this step defines three bands.
export const NOTICEABLE_BAND_FRACTION = 0.4;

export type ImpactBand = "Low Impact" | "Noticeable Impact" | "High Impact";

export function impactBand(percentOfFunds: number, thresholdPercent: number): ImpactBand {
  if (percentOfFunds > thresholdPercent) return "High Impact";
  if (percentOfFunds >= thresholdPercent * NOTICEABLE_BAND_FRACTION) return "Noticeable Impact";
  return "Low Impact";
}

// PLACEHOLDER RULE, not adviser-confirmed — a 2 standard-deviation
// Z-score cutoff is a common statistical convention for "unusual" (flags
// roughly the outer ~5% under a normal-ish distribution) but nothing in
// the manuscript pins this sensitivity down. A different threshold is a
// legitimate adviser call.
export const Z_SCORE_THRESHOLD = 2;

// Below this many historical records in a category, mean/stddev are too
// noisy to be a meaningful baseline — report "insufficient history"
// rather than a number that looks precise but isn't.
//
// Raised from 5 to 8 after measurement. At 5 records, leave-one-out scoring
// estimates the baseline standard deviation from only 4 points; removing an
// extreme tightens that baseline enough that the extreme then clears 2 sd. The
// result was 2 false positives in 5 on ordinary categories — both the highest
// and lowest record reported as "unusual". At 8+ that collapses to under 1 in 8,
// while genuine outliers are still caught at every sample size.
export const MIN_HISTORY_FOR_DETECTION = 8;

// A record must ALSO differ from its category mean by at least this fraction
// before being reported. The z-score answers "is this statistically unusual for
// this category?", which on a tightly-clustered category can be true of a
// difference far too small to matter: PHP 187.50 on a category averaging
// PHP 5,000 (3.7%) scored 2.20 and was reported to the owner.
//
// A sari-sari store owner does not consider PHP 5,200 unusual where PHP 5,000
// is normal. This floor is the practical-significance half of the test, sitting
// alongside the statistical half.
export const MIN_DEVIATION_FRACTION = 0.15;

export interface CategoryStats {
  mean: number;
  stdDev: number;
  count: number;
}

// Sample standard deviation (n-1), not population (n) — with the small
// sample sizes this runs on (5-a few dozen records), population stddev
// underestimates spread and would over-flag borderline records.
export function computeCategoryStats(amounts: number[]): CategoryStats {
  const count = amounts.length;
  const mean = amounts.reduce((sum, a) => sum + a, 0) / count;
  const variance = count > 1 ? amounts.reduce((sum, a) => sum + (a - mean) ** 2, 0) / (count - 1) : 0;
  return { mean, stdDev: Math.sqrt(variance), count };
}

export function zScore(amount: number, stats: CategoryStats): number {
  if (stats.stdDev === 0) return 0;
  return (amount - stats.mean) / stats.stdDev;
}

/** How far the amount sits from the category mean, as a fraction of the mean. */
export function deviationFraction(amount: number, stats: CategoryStats): number {
  if (stats.mean === 0) return 0;
  return Math.abs(amount - stats.mean) / Math.abs(stats.mean);
}

// ============================================================
// The second detector: interquartile range
// ============================================================
// Tukey's convention. A point more than 1.5 IQRs outside the quartiles is the
// standard definition of an outlier and is what the 1.5 refers to; it is not a
// tuned parameter and should not be treated as one.
export const IQR_FENCE_MULTIPLIER = 1.5;

export interface CategoryQuartiles {
  q1: number;
  q3: number;
  iqr: number;
}

/**
 * Linear interpolation between order statistics — the same convention numpy
 * and R use by default, chosen so the numbers here can be checked against
 * either without arguing about quartile definitions first.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const index = p * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (index - lower) * (sorted[upper]! - sorted[lower]!);
}

export function computeQuartiles(amounts: number[]): CategoryQuartiles {
  const sorted = [...amounts].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  return { q1, q3, iqr: q3 - q1 };
}

/** Whether the amount falls outside Tukey's fences for this category. */
export function isOutsideIqrFence(
  amount: number,
  quartiles: CategoryQuartiles,
  fenceMultiplier: number = IQR_FENCE_MULTIPLIER,
): boolean {
  const margin = fenceMultiplier * quartiles.iqr;
  return amount < quartiles.q1 - margin || amount > quartiles.q3 + margin;
}

/**
 * Whether a record should be reported to the owner as unusual.
 *
 * Two independent statistical tests, then one practical gate:
 *
 *   (z-score says unusual  OR  IQR says unusual)  AND  materially different
 *
 * WHY TWO TESTS RATHER THAN ONE. The z-score measures a record against a mean
 * and standard deviation that the record itself helps define, which makes it
 * blind in two situations that are ordinary in a small shop's books. Both were
 * measured on the leave-one-out baselines this actually runs against:
 *
 *   - A CATEGORY WITH NO SPREAD. Rent paid at exactly the same amount every
 *     month gives a baseline standard deviation of 0, so zScore divides by
 *     zero and its guard returns 0. A month at ten times the usual rent scores
 *     z = 0.00 and is invisible — not "borderline", structurally undetectable.
 *     This is the case that most deserves an owner's attention and it was the
 *     one case the old rule could never report.
 *   - MASKING BY OTHER OUTLIERS. With three unusually large records out of
 *     ten, each one inflates the standard deviation the others are measured
 *     against: |z| falls to 1.76 and none are flagged.
 *
 * The IQR is built from quartiles, which barely move when a few extreme
 * records are present, so it catches both. It flags every one of the cases
 * above. That complementarity is the reason for having both rather than
 * picking whichever looks better on average.
 *
 * WHY THE TESTS ARE OR-ED BUT THE FLOOR IS AND-ED. Each test is blind in a
 * different place, so requiring both to agree would inherit both blind spots.
 * The deviation floor is not a third opinion about whether something is
 * unusual — it is the question "is this difference large enough for a shop
 * owner to care", and that has to hold no matter which test fired. It is also
 * what keeps the no-spread case honest: with an IQR of 0 every fence collapses
 * onto the quartile, so without the floor a category of identical PHP 500
 * records would report PHP 501 as unusual.
 */
export function isUnusualExpense(
  amount: number,
  stats: CategoryStats,
  quartiles: CategoryQuartiles,
  thresholds: { zScoreThreshold?: number; iqrFenceMultiplier?: number; minimumDeviationFraction?: number } = {},
): boolean {
  const zScoreThreshold = thresholds.zScoreThreshold ?? Z_SCORE_THRESHOLD;
  const minimumDeviationFraction = thresholds.minimumDeviationFraction ?? MIN_DEVIATION_FRACTION;
  const statisticallyUnusual =
    Math.abs(zScore(amount, stats)) > zScoreThreshold
    || isOutsideIqrFence(amount, quartiles, thresholds.iqrFenceMultiplier);

  return statisticallyUnusual && deviationFraction(amount, stats) >= minimumDeviationFraction;
}

/** Which test reported the record. Carried to the owner-facing output so a
 *  flag can be explained rather than just asserted. */
export function detectionMethod(
  amount: number,
  stats: CategoryStats,
  quartiles: CategoryQuartiles,
  thresholds: { zScoreThreshold?: number; iqrFenceMultiplier?: number } = {},
): "z-score" | "iqr" | "both" {
  const byZ = Math.abs(zScore(amount, stats)) > (thresholds.zScoreThreshold ?? Z_SCORE_THRESHOLD);
  const byIqr = isOutsideIqrFence(amount, quartiles, thresholds.iqrFenceMultiplier);
  if (byZ && byIqr) return "both";
  return byZ ? "z-score" : "iqr";
}
