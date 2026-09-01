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
export const AMOUNT_EPSILON = 0.005;

export function dayStatus(sales: number, target: number): DayStatus {
  if (Math.abs(sales - target) < AMOUNT_EPSILON) return "at";
  return sales > target ? "above" : "below";
}

// Read in UTC because record dates are date-only values stored at UTC
// midnight — see lib/dates.ts for why local getters corrupt the result.
export { utcDaysInMonth as daysInMonth } from "../lib/dates";
import { utcDateKey, utcDayOfMonth, utcDaysInMonth, utcStartOfMonth } from "../lib/dates";
import { deriveOperatingCounts } from "./operatingCalendar.service";

// ============================================================
// Recovery Target — explicit statuses (RECOVERY-TARGET-IMPROVEMENT-PLAN.md
// §8.1, §9.7, Phase 1)
// ============================================================
//
// Phase 1 slice only for the STATUS precedence logic below. Two of the
// plan's seven statuses are intentionally never emitted by this function:
//   - "data_incomplete" — Phase 3 (§9.6) DID add pending-review/flagged-
//     duplicate detection for sales records (`dataWarnings`,
//     `confirmedSalesThisMonth`, `provisionalSalesThisMonth`, below) — the
//     DATA this status would need now exists. Status classification simply
//     never reads it: emitting "data_incomplete" from those warnings is a
//     deliberate, still-current deferral (plan §9.7/§19 open question), not
//     a missing capability.
//   - the "operating_schedule_missing" half of "needs_setup" — Phase 2 DID
//     add a schedule model (`operatingCalendar.service.ts`) and Phase 3
//     surfaces "operating_schedule_missing" as its own `setupIssues` entry
//     below, but `needsSetup`/`status` itself still only ever means a
//     missing/zero expected-expenses baseline: a missing schedule is
//     informational (`setupIssues`), not blocking, so it deliberately does
//     not fold into `needs_setup`.
export type RecoveryStatus =
  | "needs_setup"
  | "no_current_month_data"
  | "data_incomplete"
  | "ahead"
  | "on_pace"
  | "behind"
  | "covered";

// Phase 1 minimal rule (plan §9.7/§11 Phase 1): "unavailable" for needs_setup,
// "limited" for no_current_month_data, "moderate" otherwise. Nothing here
// earns "strong" yet — that needs an exact operating schedule (Phase 2+).
export type RecoveryConfidence = "unavailable" | "limited" | "moderate" | "strong";

// INTERPRETED CUTOFF, not adviser-confirmed — see NOTICEABLE_BAND_FRACTION and
// Z_SCORE_THRESHOLD above for this file's convention of flagging uninformed
// judgment calls. §9.7 asks for "the greater of a centavo floor and a small
// percentage of the daily target"; 5% is a starting guess pending stakeholder
// validation of the `on_pace` tolerance (plan §19, open decision #5).
export const PACE_TOLERANCE_FRACTION = 0.05;

/** The greater of a centavo floor and PACE_TOLERANCE_FRACTION of the daily target. */
export function recoveryPaceTolerance(dailyNeededTarget: number): number {
  return Math.max(AMOUNT_EPSILON, dailyNeededTarget * PACE_TOLERANCE_FRACTION);
}

export interface RecoveryTargetInput {
  expectedMonthlyExpenses: number;
  operatingDays: number;
  /** Sales reference recorded from the 1st of this month through today. */
  salesThisMonth: number;
  /** Sales reference recorded today only. */
  salesToday: number;
  today: Date;
  /**
   * IANA timezone identifier the `today` boundary was resolved for. Optional
   * and defaulting to "Asia/Manila" so existing callers/tests that predate
   * business-timezone support keep compiling unchanged — this is a purely
   * additive, informational passthrough into the response, not an input the
   * formula itself branches on.
   */
  timezone?: string;
  /**
   * Exact open/elapsed/remaining day counts for the current month, derived
   * from a configured `BusinessOperatingDay` schedule
   * (`operatingCalendar.service.ts`, plan §9.2, Phase 2). Optional and
   * omitted by default — when absent, this function behaves EXACTLY as
   * before, using the `operatingDays`-based proportional approximation. When
   * present, these counts REPLACE that approximation for
   * `dailyNeededTarget`'s denominator and for the elapsed/remaining
   * operating-day figures; `operatingDays` itself is left untouched in the
   * output as the stored profile value.
   */
  exactOperatingCalendar?: {
    operatingDaysThisMonth: number;
    elapsedOperatingDays: number;
    remainingOperatingDays: number;
  };
  /**
   * Confirmed vs. provisional split of `salesThisMonth` (plan §9.6, Phase 3).
   * "Confirmed" = `reviewStatus === "Reviewed" && duplicateStatus === "Not a
   * Duplicate"`; everything else (needs review OR flagged as a possible
   * duplicate) is provisional — matching the existing convention in
   * `dashboard.service.ts`'s `recordsNeedingReview` count and
   * `expenseRecord.service.ts`/`salesRecord.service.ts`'s review queues.
   *
   * Optional and additive: when omitted, every sale is treated as confirmed
   * (`confirmedSalesThisMonth = salesThisMonth`, no data warnings). This is
   * the shortcut `simulateRecoveryScenario` takes — its two branches only
   * ever vary `expectedMonthlyExpenses`, so the finer review-state split
   * doesn't change anything it needs, and defaulting to "all confirmed"
   * keeps that function's existing reads unchanged rather than requiring a
   * second groupBy query there too.
   *
   * Per §9.6's fallback rule, `salesThisMonth` itself is UNCHANGED by this —
   * it still sums confirmed + provisional exactly as before. This input only
   * adds the breakdown and warning fields; it never feeds into
   * `remainingTarget`/`adjustedDailyTarget`/`expectedSalesToDate` math.
   */
  recordEligibility?: {
    confirmedSalesThisMonth: number;
    /**
     * Portion of this month's total attributable to "Needs Review" status.
     * May overlap `possibleDuplicateSalesThisMonth` (a record can be both
     * pending review and flagged as a duplicate) — these are two independent
     * `dataWarnings` triggers, not a partition that sums to
     * `provisionalSalesThisMonth`.
     */
    pendingReviewSalesThisMonth: number;
    /** Portion of this month's total attributable to a flagged duplicate. */
    possibleDuplicateSalesThisMonth: number;
  };
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
  /** @deprecated superseded by `status` — kept during the client migration window (plan §8.1). */
  onTrack: boolean;
  /** True when there's no expected-monthly-expenses baseline configured yet —
   * every other figure here is still arithmetically valid but meaningless,
   * since a zero baseline is missing setup, not a covered target. */
  needsSetup: boolean;

  // ---- Phase 1 additions (plan §8.2/§9.4/§9.7) ----
  /**
   * Explicit status, authoritative over `onTrack`/`needsSetup` for display.
   * NOTE: this is the status computable from a single profile+sales snapshot;
   * callers that also know whether the current month has zero sales records
   * at all (a `no_current_month_data` condition this function cannot see on
   * its own) should apply that override — see `getRecoveryInsight`.
   */
  status: RecoveryStatus;
  confidence: RecoveryConfidence;
  /** Cumulative target allocated to the open days elapsed so far this month (§9.4). */
  expectedSalesToDate: number;
  /** Recorded sales minus expected-to-date — positive means ahead of pace. */
  paceVarianceAmount: number;
  /** Stepping-stone toward the plan's eventual v2 contract (§8.2) — this is not yet that full shape. */
  contractVersion: 1;
  timezone: string;
  /** YYYY-MM-DD, business-local calendar day this calculation was anchored to. */
  asOfDate: string;

  // ---- Phase 2 additions (plan §8.2/§9.2) ----
  /**
   * True when `exactOperatingCalendar` was supplied, i.e. this profile has a
   * configured `BusinessOperatingDay` schedule and every operating-day count
   * below is exact rather than approximated. Matches plan §8.2's
   * `operatingScheduleConfigured` field name for forward-compatibility with
   * the eventual v2 contract.
   */
  operatingScheduleConfigured: boolean;
  /**
   * Open days in the current calendar month — exact when
   * `operatingScheduleConfigured` is true, otherwise equal to `operatingDays`
   * (the same value the pre-Phase-2 approximation already treated as "this
   * month's operating days").
   */
  operatingDaysThisMonth: number;

  // ---- Phase 3 additions (plan §8.2/§9.6/§11 Phase 3) ----
  /** `salesThisMonth` restricted to reviewStatus "Reviewed" + duplicateStatus "Not a Duplicate". */
  confirmedSalesThisMonth: number;
  /** `salesThisMonth - confirmedSalesThisMonth` — needs-review OR flagged-duplicate amounts. */
  provisionalSalesThisMonth: number;
  /**
   * Present when `provisionalSalesThisMonth > 0`, split by cause where the
   * caller distinguished them (`recordEligibility`); when a caller supplies
   * only a plain confirmed/total split without the sub-amounts, this falls
   * back to `records_pending_review` alone (documented in
   * `computeRecoveryTarget` below).
   */
  dataWarnings: Array<"records_pending_review" | "possible_duplicates">;
  /**
   * Direct-action eligibility flags (plan §8.2). `operating_schedule_missing`
   * is informational, not blocking — approximation mode is fully functional;
   * it just lets a client offer "complete your setup" as an optional upgrade.
   */
  setupIssues: Array<"expected_expenses_missing" | "operating_schedule_missing">;
}

export function computeRecoveryTarget(input: RecoveryTargetInput): RecoveryTargets {
  const {
    expectedMonthlyExpenses,
    operatingDays,
    salesThisMonth,
    salesToday,
    today,
    timezone = "Asia/Manila",
    exactOperatingCalendar,
    recordEligibility,
  } = input;
  const needsSetup = expectedMonthlyExpenses <= 0;
  const operatingScheduleConfigured = exactOperatingCalendar != null;

  // ---- Phase 3: confirmed/provisional split and data warnings (§9.6) ----
  const confirmedSalesThisMonth = recordEligibility ? recordEligibility.confirmedSalesThisMonth : salesThisMonth;
  const provisionalSalesThisMonth = salesThisMonth - confirmedSalesThisMonth;
  const dataWarnings: Array<"records_pending_review" | "possible_duplicates"> = [];
  if (provisionalSalesThisMonth > AMOUNT_EPSILON) {
    const pendingReview = recordEligibility?.pendingReviewSalesThisMonth ?? 0;
    const possibleDuplicate = recordEligibility?.possibleDuplicateSalesThisMonth ?? 0;
    if (pendingReview > AMOUNT_EPSILON) dataWarnings.push("records_pending_review");
    if (possibleDuplicate > AMOUNT_EPSILON) dataWarnings.push("possible_duplicates");
    // Neither sub-cause was distinguished (a caller passed confirmed/total
    // only) — still surface SOMETHING rather than silently dropping a
    // provisional amount, defaulting to the more common cause per §9.6.
    if (dataWarnings.length === 0) dataWarnings.push("records_pending_review");
  }

  const setupIssues: Array<"expected_expenses_missing" | "operating_schedule_missing"> = [];
  if (needsSetup) setupIssues.push("expected_expenses_missing");
  if (!operatingScheduleConfigured) setupIssues.push("operating_schedule_missing");

  const operatingDaysThisMonth = exactOperatingCalendar ? exactOperatingCalendar.operatingDaysThisMonth : operatingDays;
  const dailyNeededTarget = operatingDaysThisMonth > 0 ? expectedMonthlyExpenses / operatingDaysThisMonth : 0;

  // Floored at 0: once the month's expenses are covered there is no
  // "negative target left to earn" — a negative remaining target would
  // produce a nonsense negative adjusted daily target.
  const remainingTarget = Math.max(0, expectedMonthlyExpenses - salesThisMonth);

  const totalDays = utcDaysInMonth(today);
  const calendarDaysLeftInMonth = totalDays - utcDayOfMonth(today) + 1;

  let remainingOperatingDays: number;
  let elapsedOperatingDays: number;
  if (exactOperatingCalendar) {
    // EXACT (plan §9.2, Phase 2). Both counts come straight from the
    // resolved calendar — see operatingCalendar.service.ts for why today is
    // deliberately counted in both.
    remainingOperatingDays = exactOperatingCalendar.remainingOperatingDays;
    elapsedOperatingDays = exactOperatingCalendar.elapsedOperatingDays;
  } else {
    // APPROXIMATION, flagged. BusinessProfile stores operatingDays as a
    // count per month (e.g. 25), not a weekly schedule (e.g. "closed
    // Sundays"), so the exact operating days left in the month are
    // genuinely unknowable from the data model. We scale the monthly count
    // by the fraction of the month still ahead. Today counts as remaining —
    // sales can still be recorded against it.
    // Clamped to >= 1 so the last day of the month can't divide by zero (or
    // by a rounded-down 0 for a business with few operating days).
    remainingOperatingDays = Math.max(1, Math.round(operatingDays * (calendarDaysLeftInMonth / totalDays)));
    // elapsedOperatingDays uses the SAME proportional approximation as
    // remainingOperatingDays above — there is no exact operating calendar
    // for this profile, so "days elapsed" is derived from it rather than
    // independently estimated, which would risk the two not summing to
    // `operatingDays`.
    elapsedOperatingDays = Math.max(0, operatingDays - remainingOperatingDays);
  }

  // §9.5: in exact mode, zero true remaining open days with a positive
  // remaining target must not be masked by a fabricated "at least 1 day"
  // floor — it should read as `remainingTarget` itself, which naturally
  // routes the existing pace-variance status logic below to `behind`
  // (or `covered`, if remainingTarget is already 0) rather than needing a
  // dedicated status branch. Approximation mode never reaches
  // remainingOperatingDays === 0 (it's clamped to >= 1 above), so this
  // ternary is a no-op for it.
  const adjustedDailyTarget = remainingOperatingDays > 0 ? remainingTarget / remainingOperatingDays : remainingTarget;

  const todaysTarget = dailyNeededTarget;
  const todaysGap = salesToday - todaysTarget;

  // ---- Phase 1: expected pace to date and status (plan §9.4/§9.7) ----
  const expectedSalesToDate = dailyNeededTarget * elapsedOperatingDays;
  const paceVarianceAmount = salesThisMonth - expectedSalesToDate;

  let status: RecoveryStatus;
  let confidence: RecoveryConfidence;
  if (needsSetup) {
    // §9.7 precedence step 1. The full schedule-based "essential schedule
    // configuration unavailable" condition is skipped — no schedule model
    // exists until Phase 2.
    status = "needs_setup";
    confidence = "unavailable";
  } else if (remainingTarget < AMOUNT_EPSILON) {
    // §9.7 step 4 (steps 2-3 — no-current-month-data and data-incomplete —
    // are not decidable from this pure snapshot; see getRecoveryInsight).
    status = "covered";
    confidence = "moderate";
  } else if (remainingOperatingDays === 0) {
    // §9.5: zero remaining open days with a positive remaining target must
    // read as an explicit "behind" end-of-period state rather than being
    // inferred from pace variance. When elapsedOperatingDays is also 0 (the
    // whole month/period is closed, not just "no days left after some
    // elapsed"), expectedSalesToDate collapses to 0 and paceVarianceAmount
    // (= salesThisMonth - 0) can land inside tolerance whenever
    // salesThisMonth is small/zero — masking a fully-uncovered target as
    // "on_pace". Pace variance is structurally unable to distinguish
    // "nothing was expected because nothing was measurable" from "on pace"
    // in that case, so this is handled as an explicit branch instead of
    // relying solely on the pace-variance math below. This does not change
    // the elapsedOperatingDays > 0 case (days already elapsed this period,
    // only the *remaining* days are zero) — that one already resolves to
    // "behind" via a naturally-negative pace variance and continues to do
    // so here.
    status = "behind";
    confidence = "moderate";
  } else {
    const tolerance = recoveryPaceTolerance(dailyNeededTarget);
    if (paceVarianceAmount > tolerance) status = "ahead";
    else if (paceVarianceAmount < -tolerance) status = "behind";
    else status = "on_pace";
    confidence = "moderate";
  }

  return {
    expectedMonthlyExpenses,
    operatingDays,
    dailyNeededTarget,
    salesThisMonth,
    remainingTarget,
    daysInMonth: totalDays,
    calendarDaysLeftInMonth,
    remainingOperatingDays,
    remainingOperatingDaysIsApproximated: !operatingScheduleConfigured,
    adjustedDailyTarget,
    todaysTarget,
    todaysSales: salesToday,
    todaysGap,
    todaysStatus: dayStatus(salesToday, todaysTarget),
    monthCoveragePercent: expectedMonthlyExpenses > 0 ? (salesThisMonth / expectedMonthlyExpenses) * 100 : 0,
    // "On track" at the month level = the adjusted daily target hasn't
    // drifted above the original flat target. If it has, the shortfall so
    // far is now being pushed onto fewer remaining days. Never true without
    // a configured baseline — a zero expected-expenses value would otherwise
    // trivially satisfy this and read as a successfully covered month.
    onTrack: !needsSetup && adjustedDailyTarget <= dailyNeededTarget + AMOUNT_EPSILON,
    needsSetup,
    status,
    confidence,
    expectedSalesToDate,
    paceVarianceAmount,
    contractVersion: 1,
    timezone,
    asOfDate: utcDateKey(today),
    operatingScheduleConfigured,
    operatingDaysThisMonth,
    confirmedSalesThisMonth,
    provisionalSalesThisMonth,
    dataWarnings,
    setupIssues,
  };
}

// ============================================================
// "Why your target changed" — deterministic re-run comparison (plan §8.2/
// §10.3, Phase 3)
// ============================================================
//
// There is no persisted snapshot of "yesterday's" recovery target (plan §7.5
// forbids adding one in this phase), so "what changed" is derived by
// re-running this exact same pure formula with yesterday's inputs and
// diffing the two results. Both `computeRecoveryTarget` calls happen in the
// caller (`getRecoveryInsight`); this file only holds the pure diff/
// classification logic so it can be unit-tested without a database.

export type RecoveryChangeReason =
  | "sales_added"
  | "open_day_elapsed"
  | "baseline_changed"
  | "schedule_changed"
  | "data_changed"
  | "no_material_change";

export interface RecoveryChangeSincePreviousDay {
  adjustedDailyTargetDelta: number;
  salesAdded: number;
  remainingOpenDaysDelta: number;
  primaryReason: RecoveryChangeReason;
}

/**
 * INTERPRETED HEURISTIC, not adviser-confirmed — plan §8.2/§10.3 explicitly
 * lists the exact attribution rule as an open stakeholder question (§19).
 * `baseline_changed` and `schedule_changed` are never emitted by this
 * function: reliably telling "the owner changed expectedMonthlyExpenses
 * today" apart from "the operating schedule changed" apart from any other
 * unmodeled cause would require the very history persistence Phase 3
 * deliberately does not add (plan §7.5). Both collapse into the
 * `data_changed` fallback below; the type still carries the two dedicated
 * values so a future phase with real history can emit them without another
 * contract change.
 *
 * Precedence, applied in order:
 *   1. `no_material_change` — the delta itself is inside the existing
 *      `recoveryPaceTolerance` band (same tolerance §9.7 already uses for
 *      the on_pace/ahead/behind cutoff, scaled off `dailyNeededTarget`).
 *   2. `sales_added` — a material amount of sales came in today AND the
 *      target moved in the direction that explains ("dominant driver of a
 *      DECREASE" per plan §8.2): more sales recorded should make the
 *      adjusted daily target easier, not harder. Only claims this when the
 *      easier-target direction is unambiguous — if sales were material but
 *      the target still got *harder* (or held), sales alone don't explain
 *      the delta and this falls through to the next check instead.
 *   3. `open_day_elapsed` — the count of remaining open days moved (the
 *      ordinary day-over-day case: one fewer day remains). This fires
 *      whenever the day count moved, even if a material amount of sales was
 *      also recorded that day: a business can record real (but
 *      insufficient-to-offset) sales while still losing ground purely
 *      because a day elapsed, and that day-elapse effect is the dominant,
 *      more specific explanation for a delta that still went the "harder"
 *      direction despite the sales.
 *   4. `data_changed` — neither of the above moved at all (no material
 *      sales, no day-count change) yet the delta is still material: an
 *      expense baseline edit, a schedule/override edit, or some combination.
 *
 * KNOWN LIMITATION (documentation, not a bug): because step 1 is a
 * tolerance-based comparison, two real changes that happen to offset each
 * other (e.g. a baseline increase net against a sales increase landing the
 * delta back inside tolerance) can also read as `no_material_change` — this
 * mirrors the same tolerance-based suppression already accepted for the
 * ahead/on_pace/behind status itself.
 */
export function classifyRecoveryChangeReason(params: {
  adjustedDailyTargetDelta: number;
  salesAdded: number;
  remainingOpenDaysDelta: number;
  dailyNeededTarget: number;
}): RecoveryChangeReason {
  const { adjustedDailyTargetDelta, salesAdded, remainingOpenDaysDelta, dailyNeededTarget } = params;
  const tolerance = recoveryPaceTolerance(dailyNeededTarget);

  if (Math.abs(adjustedDailyTargetDelta) <= tolerance) return "no_material_change";

  const materialSales = Math.abs(salesAdded) > tolerance;
  if (materialSales && adjustedDailyTargetDelta < 0) return "sales_added";
  if (remainingOpenDaysDelta !== 0) return "open_day_elapsed";
  return "data_changed";
}

/**
 * Diffs today's vs. yesterday's `computeRecoveryTarget` results into the
 * §8.2 `changeSincePreviousDay` shape. Pure — the caller is responsible for
 * producing `yesterday` via a second `computeRecoveryTarget` call with
 * yesterday's date/inputs, and for deciding when the comparison is not
 * meaningful at all (1st of the month, `needsSetup`, etc. — see
 * `getRecoveryInsight`, which returns `null` in those cases instead of
 * calling this).
 */
export function computeChangeSincePreviousDay(
  today: Pick<RecoveryTargets, "adjustedDailyTarget" | "salesThisMonth" | "remainingOperatingDays" | "dailyNeededTarget">,
  yesterday: Pick<RecoveryTargets, "adjustedDailyTarget" | "salesThisMonth" | "remainingOperatingDays">,
): RecoveryChangeSincePreviousDay {
  const adjustedDailyTargetDelta = today.adjustedDailyTarget - yesterday.adjustedDailyTarget;
  const salesAdded = today.salesThisMonth - yesterday.salesThisMonth;
  const remainingOpenDaysDelta = today.remainingOperatingDays - yesterday.remainingOperatingDays;
  const primaryReason = classifyRecoveryChangeReason({
    adjustedDailyTargetDelta,
    salesAdded,
    remainingOpenDaysDelta,
    dailyNeededTarget: today.dailyNeededTarget,
  });
  return { adjustedDailyTargetDelta, salesAdded, remainingOpenDaysDelta, primaryReason };
}

/**
 * §9.7 precedence step 2, applied on top of `computeRecoveryTarget`'s result.
 *
 * `computeRecoveryTarget` cannot see whether the current month has any sales
 * records at all — that requires a full-month `_count` query independent of
 * this function's aggregate-sum inputs (a zero-amount month full of ₱0
 * records is not the same as an empty month). Callers that have that count
 * (`getRecoveryInsight`) call this to fold it in; callers that don't
 * (`simulateRecoveryScenario`'s hypothetical branch) leave the pure result as-is.
 *
 * `needs_setup` still takes precedence over `no_current_month_data`, matching
 * the plan's ordering.
 */
export function applyMonthDataStatus(
  targets: Pick<RecoveryTargets, "status" | "confidence" | "needsSetup">,
  monthHasNoRecords: boolean,
): Pick<RecoveryTargets, "status" | "confidence"> {
  if (targets.needsSetup || !monthHasNoRecords) {
    return { status: targets.status, confidence: targets.confidence };
  }
  return { status: "no_current_month_data", confidence: "limited" };
}

// ============================================================
// Weekly checkpoints (plan §10.4, Phase 4)
// ============================================================
//
// No new persistence exists for a prior checkpoint snapshot (same constraint
// as "Why your target changed" above) — every checkpoint is derived fresh
// each call from the month's per-day sales and the resolved operating
// calendar. This is the pure math half; `insights.service.ts`'s
// `computeWeeklyCheckpoints` does the one bounded DB read (a month's sales
// grouped by day) and calls this.

export type RecoveryCheckpointStatus = "ahead" | "on_pace" | "behind" | "pending";

export interface RecoveryCheckpoint {
  /** YYYY-MM-DD, business-local. */
  endDate: string;
  /** The open-day target rate times cumulative open days from the 1st of the month through `endDate`, inclusive. */
  cumulativeTarget: number;
  /** Actual sales from the 1st of the month through `endDate`, or `null` when `endDate` is still in the future. */
  recordedAmount: number | null;
  /** `recordedAmount - cumulativeTarget`, or `null` when `recordedAmount` is `null`. */
  variance: number | null;
  status: RecoveryCheckpointStatus;
}

export interface DeriveRecoveryCheckpointsInput {
  /** Business-local "today" boundary (UTC-midnight-encoded date-only value, per the rest of this module). */
  today: Date;
  /** `computeRecoveryTarget`'s `dailyNeededTarget` for the same month — already resolved for exact vs. approximation mode by the caller. */
  dailyNeededTarget: number;
  /** The profile's stored monthly operating-day count, used only as the approximation-mode fallback below. */
  operatingDays: number;
  /** The exact resolved per-date open/closed calendar for this month, when a schedule is configured. Omit for approximation mode. */
  exactCalendar?: Map<string, boolean>;
  /** Raw (non-cumulative) sales total per day, keyed by YYYY-MM-DD, for every day in the month through today. Days with no sales may be omitted. */
  salesByDay: Map<string, number>;
}

/**
 * Checkpoint DATES land on calendar day-of-month 7, 14, 21, 28, and — when
 * the month has more days than the last multiple of 7 — the month's final
 * calendar day as one extra checkpoint. E.g. a 31-day month checkpoints on
 * 7/14/21/28/31; a 28-day month (a non-leap February) checkpoints on
 * 7/14/21/28 only, exactly 4; a 29-day leap February checkpoints on
 * 7/14/21/28/29.
 *
 * This is a deliberate choice among the several reasonable "weekly"
 * conventions plan §10.4 leaves open (ISO week-of-year alignment being the
 * other candidate) — every-7-calendar-days-from-the-1st is simplest to
 * explain to an owner ("every 7 days from the start of the month") and needs
 * no ISO-week-boundary logic. Bounded to the current month only (plan
 * §15.1) — this never looks past `today`'s month.
 *
 * Each checkpoint's `cumulativeTarget` is `dailyNeededTarget` times the
 * cumulative OPEN days from the 1st of the month through that checkpoint's
 * `endDate`: the EXACT count (from `exactCalendar`, via
 * `deriveOperatingCounts`) when a schedule is configured, or the SAME
 * proportional approximation `computeRecoveryTarget` itself falls back to
 * when not (`operatingDays` scaled by the fraction of the month elapsed as
 * of that checkpoint's day-of-month) — never a naive equal split across
 * checkpoints.
 *
 * `recordedAmount`/`variance` are `null` and `status` is `"pending"` for any
 * checkpoint whose `endDate` is strictly after `today` — plan §10.4: "the
 * NEXT checkpoint is in the future, so it can't have a recorded amount yet."
 * Past/current checkpoints reuse the exact same `recoveryPaceTolerance` band
 * `computeRecoveryTarget` already uses for its own ahead/on_pace/behind
 * classification — no new tolerance is introduced here.
 */
export function deriveRecoveryCheckpoints(input: DeriveRecoveryCheckpointsInput): RecoveryCheckpoint[] {
  const { today, dailyNeededTarget, operatingDays, exactCalendar, salesByDay } = input;
  const monthStart = utcStartOfMonth(today);
  const totalDaysInMonth = utcDaysInMonth(today);
  const todayKey = utcDateKey(today);
  const tolerance = recoveryPaceTolerance(dailyNeededTarget);

  const checkpointDaysOfMonth: number[] = [];
  for (let d = 7; d <= totalDaysInMonth; d += 7) checkpointDaysOfMonth.push(d);
  if (checkpointDaysOfMonth[checkpointDaysOfMonth.length - 1] !== totalDaysInMonth) {
    checkpointDaysOfMonth.push(totalDaysInMonth);
  }

  return checkpointDaysOfMonth.map((dayOfMonth): RecoveryCheckpoint => {
    const endDate = new Date(monthStart);
    endDate.setUTCDate(endDate.getUTCDate() + dayOfMonth - 1);
    const endDateKey = utcDateKey(endDate);

    const elapsedOpenDays = exactCalendar
      ? deriveOperatingCounts(exactCalendar, endDateKey).elapsedOperatingDays
      : Math.round(operatingDays * (dayOfMonth / totalDaysInMonth));
    const cumulativeTarget = dailyNeededTarget * elapsedOpenDays;

    if (endDateKey > todayKey) {
      return { endDate: endDateKey, cumulativeTarget, recordedAmount: null, variance: null, status: "pending" };
    }

    let recordedAmount = 0;
    for (const [key, amount] of salesByDay) {
      if (key <= endDateKey) recordedAmount += amount;
    }
    const variance = recordedAmount - cumulativeTarget;
    const status: RecoveryCheckpointStatus =
      variance > tolerance ? "ahead" : variance < -tolerance ? "behind" : "on_pace";
    return { endDate: endDateKey, cumulativeTarget, recordedAmount, variance, status };
  });
}

// ============================================================
// Recovery Target — deterministic month-end projection (plan §9.8/§11 Phase
// 5, §16.2 "Gate forecasts behind backtesting thresholds", §19 open question
// #9 "What forecast error threshold is acceptable before enabling
// projections?")
// ============================================================
//
// SCOPE NOTE: this is the deterministic calculation and its backtesting
// harness only (backend/scripts/backtest-recovery-projection.ts). Per §16.2
// and §20 ("no default-enabled forecast until its release gate passes"),
// nothing here is wired into `getRecoveryInsight`'s response, any
// controller/route, or any client. Enabling it for real owners is a
// stakeholder decision (an approved backtesting error threshold) that this
// task deliberately does not make — see the module doc comment in
// insights.service.ts's `computeRecoveryProjection` for where the capability
// currently stops.
//
// Pure math only — no AI involvement anywhere in this calculation, matching
// every other figure in this engine.

/**
 * INTERPRETED DEFAULT, not adviser-confirmed (plan §9.8: "a bounded recent
 * window, initially seven open days"). This is also the MINIMUM number of
 * completed open days required before a projection is attempted at all —
 * see `deriveRecoveryProjection`'s `insufficient_data` branch. The window
 * itself is NOT a fixed trailing 7 days; it is every completed open day so
 * far this month (never crossing into a previous month), which happens to
 * equal exactly `PROJECTION_LOOKBACK_OPEN_DAYS` on the earliest day a
 * projection becomes available and grows from there as the month
 * progresses. This reading was chosen over a fixed trailing-7-day window so
 * the plan's own confidence-tiering guidance ("'limited' if
 * lookbackOperatingDays is exactly at the minimum, 'moderate'/'strong' for a
 * longer window") is actually reachable — a fixed 7-day window would make
 * every available projection read "limited" forever. A stakeholder wanting
 * a genuinely fixed trailing-N-day recent-only average instead of a growing
 * month-to-date-so-far average is a legitimate alternative call; see the
 * report this was built against.
 */
export const PROJECTION_LOOKBACK_OPEN_DAYS = 7;

/**
 * INTERPRETED DEFAULT, not adviser-confirmed (plan §9.8: "stale/incomplete"
 * data disqualifies a projection; the exact staleness window is left open).
 * "Stale" is defined here as: not one sale of any review/duplicate status was
 * recorded in the most recent `PROJECTION_STALENESS_CALENDAR_DAYS` CALENDAR
 * days strictly before today (today itself is excluded — it hasn't finished
 * yet, so its absence of sales so far says nothing about staleness).
 */
export const PROJECTION_STALENESS_CALENDAR_DAYS = 3;

/**
 * INTERPRETED DEFAULT, not adviser-confirmed (plan §9.8's "data_incomplete-
 * style conditions"). If more than this fraction of the lookback window's
 * total sales AMOUNT is provisional (pending review or flagged as a possible
 * duplicate), the projection is withheld — a rate built on unreliable data
 * compounds the unreliability. There is no dedicated `data_incomplete`
 * member on `RecoveryProjectionStatus` (the plan's §8.2 contract only lists
 * "available" | "insufficient_data" | "stale_data"), so this condition is
 * folded into `insufficient_data`: the lookback window technically has
 * enough DAYS, but not enough TRUSTWORTHY data within them, which is the
 * same practical outcome for a client ("we don't have enough to go on yet").
 */
export const PROJECTION_PROVISIONAL_FRACTION_CUTOFF = 0.5;

/**
 * Bump this string manually whenever the projection FORMULA changes (not for
 * threshold-only tuning within the same formula), so an old cached client
 * response can be told apart from a new one, per plan §8.2.
 */
export const PROJECTION_METHOD_VERSION = "v1";

export type RecoveryProjectionStatus = "available" | "insufficient_data" | "stale_data";

/** Plan §8.2's `projection` sub-object. */
export interface RecoveryProjection {
  status: RecoveryProjectionStatus;
  methodVersion: string;
  /** The ACTUAL number of completed open days used this month, even when `status !== "available"` (0 or partial for insufficient_data). */
  lookbackOperatingDays: number;
  /** `null` unless `status === "available"`. */
  projectedMonthEndSales: number | null;
  /** `projectedMonthEndSales - expectedMonthlyExpenses`; `null` unless `status === "available"`. No safety-buffer concept exists yet (§9.3), so this is not netted against `totalCoverageGoal`. */
  projectedVarianceAmount: number | null;
  /** `"unavailable"` whenever `status !== "available"`. */
  confidence: RecoveryConfidence;
}

export interface DeriveRecoveryProjectionInput {
  /** Completed open days so far this month (excludes today), capped implicitly by the caller never looking past month start. */
  lookbackOperatingDaysAvailable: number;
  /** Sum of CONFIRMED-only sales (reviewStatus "Reviewed" + duplicateStatus "Not a Duplicate") over those completed open days. */
  lookbackConfirmedSalesSum: number;
  /** Sum of everything else (pending-review or flagged-duplicate) over the same days — used only for the provisional-fraction guard, never in the rate itself. */
  lookbackProvisionalSalesSum: number;
  /** Whether any sale, of any review/duplicate status, was recorded in the most recent `PROJECTION_STALENESS_CALENDAR_DAYS` calendar days before today. */
  hasRecentSales: boolean;
  /** Same `confirmedSalesThisMonth` the parent `RecoveryTargets` already exposes — the projection is additive on top of it, not a re-derivation. */
  confirmedSalesThisMonth: number;
  /** Same `remainingOperatingDays` the parent `RecoveryTargets` already exposes (exact when a schedule is configured, approximated otherwise). */
  remainingOperatingDays: number;
  expectedMonthlyExpenses: number;
}

/**
 * Pure implementation of plan §9.8's deterministic month-end projection.
 * Never guesses: any of the three guard conditions below returns an explicit
 * unavailable status instead of a fabricated number.
 *
 * Formula (§9.8, unchanged from the plan):
 *   recentAverageSalesPerOpenDay = lookbackConfirmedSalesSum / lookbackOperatingDaysAvailable
 *   projectedMonthEndSales = confirmedSalesThisMonth + recentAverageSalesPerOpenDay × remainingOperatingDays
 *
 * See `insights.service.ts`'s `computeRecoveryProjection` for how the inputs
 * here are assembled from the database — this function itself does no I/O
 * and is unit-testable without one.
 */
export function deriveRecoveryProjection(input: DeriveRecoveryProjectionInput): RecoveryProjection {
  const {
    lookbackOperatingDaysAvailable,
    lookbackConfirmedSalesSum,
    lookbackProvisionalSalesSum,
    hasRecentSales,
    confirmedSalesThisMonth,
    remainingOperatingDays,
    expectedMonthlyExpenses,
  } = input;

  const unavailable = (status: "insufficient_data" | "stale_data"): RecoveryProjection => ({
    status,
    methodVersion: PROJECTION_METHOD_VERSION,
    lookbackOperatingDays: lookbackOperatingDaysAvailable,
    projectedMonthEndSales: null,
    projectedVarianceAmount: null,
    confidence: "unavailable",
  });

  // Guard 1: not enough completed open days yet — can't happen until at
  // least PROJECTION_LOOKBACK_OPEN_DAYS open days have elapsed this month.
  if (lookbackOperatingDaysAvailable < PROJECTION_LOOKBACK_OPEN_DAYS) {
    return unavailable("insufficient_data");
  }

  // Guard 2: stale — no sales recorded at all recently, regardless of how
  // much history exists further back.
  if (!hasRecentSales) {
    return unavailable("stale_data");
  }

  // Guard 3: too much of the recent window is provisional to trust its rate.
  // `lookbackTotal === 0` (a window of confirmed open days with literally
  // zero amount recorded, confirmed or otherwise) cannot be "over" the
  // fraction cutoff — that case is left to fall through and simply projects
  // a zero rate, which is arithmetically honest rather than a guard case.
  const lookbackTotal = lookbackConfirmedSalesSum + lookbackProvisionalSalesSum;
  if (lookbackTotal > 0 && lookbackProvisionalSalesSum / lookbackTotal > PROJECTION_PROVISIONAL_FRACTION_CUTOFF) {
    return unavailable("insufficient_data");
  }

  const recentAverageSalesPerOpenDay = lookbackConfirmedSalesSum / lookbackOperatingDaysAvailable;
  const projectedMonthEndSales = confirmedSalesThisMonth + recentAverageSalesPerOpenDay * remainingOperatingDays;
  const projectedVarianceAmount = projectedMonthEndSales - expectedMonthlyExpenses;

  // INTERPRETED CUTOFFS, not adviser-confirmed (plan §9.8 leaves the exact
  // boundaries open). "limited" at exactly the minimum lookback, "strong"
  // once at least double the minimum has accumulated, "moderate" in between —
  // the same doubling convention this file already uses elsewhere for a
  // round-number confidence step (see MIN_HISTORY_FOR_DETECTION's history).
  let confidence: RecoveryConfidence;
  if (lookbackOperatingDaysAvailable <= PROJECTION_LOOKBACK_OPEN_DAYS) confidence = "limited";
  else if (lookbackOperatingDaysAvailable < PROJECTION_LOOKBACK_OPEN_DAYS * 2) confidence = "moderate";
  else confidence = "strong";

  return {
    status: "available",
    methodVersion: PROJECTION_METHOD_VERSION,
    lookbackOperatingDays: lookbackOperatingDaysAvailable,
    projectedMonthEndSales,
    projectedVarianceAmount,
    confidence,
  };
}

/**
 * Open days from the 1st of the month through `asOf`, inclusive, under the
 * SAME proportional
 * approximation `computeRecoveryTarget` already uses for `elapsedOperatingDays`
 * when no exact `BusinessOperatingDay` schedule is configured (see that
 * function's approximation branch above). Duplicated here rather than
 * exported/shared from there, deliberately: this is a small, stable,
 * already-tested formula, and importing it as a shared helper would mean the
 * one behavioral change to computeRecoveryTarget's approximation also has to
 * reason about this brand-new caller. If that formula's shape ever changes,
 * this one must change identically — see the cross-reference above.
 *
 * `computeRecoveryProjection` calls this with `asOf = yesterday` (business-
 * local), which is what makes it "elapsed as of yesterday" rather than
 * "elapsed as of today" — the completed-open-days convention plan §9.8
 * requires for the projection's lookback window.
 */
export function approximateElapsedOperatingDaysAsOf(operatingDays: number, asOf: Date): number {
  const totalDays = utcDaysInMonth(asOf);
  const calendarDaysLeft = totalDays - utcDayOfMonth(asOf) + 1;
  const remaining = Math.max(1, Math.round(operatingDays * (calendarDaysLeft / totalDays)));
  return Math.max(0, operatingDays - remaining);
}

// ============================================================
// Recovery Target — notification trigger evaluation (plan §10.8/§11 Phase 6)
// ============================================================
//
// Pure decision logic only — no DB reads, no `Notification` writes, no
// business-timezone resolution (callers pass already-resolved local
// minute-of-day/month-key strings/numbers). The orchestration — loading
// `RecoveryNotificationPreference`/`RecoveryNotificationTriggerState`,
// resolving quiet hours and "now" in the business's own timezone, and
// calling `createNotification` — lives in `recoveryNotification.service.ts`,
// which `getRecoveryInsight` (insights.service.ts) calls as a side effect on
// every load, matching this codebase's existing convention of generating
// notifications durably inside the request that detects the condition
// (see notification.service.ts's callers and recurring.service.ts's
// `notifyScheduleFinding`) rather than via an in-memory scheduler.

/** Inputs for the shared cooldown gate every trigger is checked against. */
export interface RecoveryNotificationCooldownInput {
  lastFiredAt: Date | null;
  now: Date;
  minHoursBetweenNotifications: number;
}

/** True when the trigger last fired too recently to fire again (plan §10.8 "cooldown"). */
export function isWithinNotificationCooldown(input: RecoveryNotificationCooldownInput): boolean {
  const { lastFiredAt, now, minHoursBetweenNotifications } = input;
  if (!lastFiredAt) return false;
  const elapsedMs = now.getTime() - lastFiredAt.getTime();
  return elapsedMs < minHoursBetweenNotifications * 60 * 60 * 1000;
}

export interface RecoveryQuietHoursInput {
  /** Minutes since local midnight (0-1439) in the business's own timezone. */
  localMinuteOfDay: number;
  /** Minutes since local midnight, or `null` when quiet hours are disabled. */
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
}

/**
 * True when `localMinuteOfDay` falls inside the configured quiet-hours
 * window. Handles the overnight-wraparound case (e.g. 22:00-06:00), which a
 * plain `start <= x < end` comparison gets backwards.
 */
export function isWithinQuietHours(input: RecoveryQuietHoursInput): boolean {
  const { localMinuteOfDay, quietHoursStartMinute, quietHoursEndMinute } = input;
  if (quietHoursStartMinute == null || quietHoursEndMinute == null) return false;
  if (quietHoursStartMinute === quietHoursEndMinute) return false; // zero-width window = disabled
  if (quietHoursStartMinute < quietHoursEndMinute) {
    return localMinuteOfDay >= quietHoursStartMinute && localMinuteOfDay < quietHoursEndMinute;
  }
  return localMinuteOfDay >= quietHoursStartMinute || localMinuteOfDay < quietHoursEndMinute;
}

export interface RecoveryTargetIncreaseDecision {
  /** True when the adjusted daily target increased beyond the configured percentage since the last firing. */
  fire: boolean;
  /** The baseline `RecoveryNotificationTriggerState.lastFiredValue` should carry forward. */
  nextLastFiredValue: number;
}

/**
 * §10.8 trigger 1: "Adjusted daily target increased beyond a configured
 * percentage." Compared against `lastFiredValue` — the adjusted daily target
 * recorded the LAST time this trigger actually fired, never the previous
 * evaluation's value — so the baseline only moves on a real firing and a
 * slow multi-day creep still eventually clears the threshold instead of
 * resetting on every check.
 *
 * On the very first-ever evaluation (`lastFiredValue == null`) there is no
 * prior value to compare against: this records the current value as the
 * starting baseline and does NOT fire, per the task's explicit instruction
 * not to fire on the first-ever evaluation. The same "record, don't fire"
 * behavior applies when the previous baseline was `<= 0` (only reachable if
 * a fully-covered month, `adjustedDailyTarget === 0`, was once recorded as
 * the baseline) since a percentage increase off a non-positive base is
 * undefined.
 */
export function decideTargetIncreaseTrigger(input: {
  adjustedDailyTarget: number;
  lastFiredValue: number | null;
  thresholdPercent: number;
}): RecoveryTargetIncreaseDecision {
  const { adjustedDailyTarget, lastFiredValue, thresholdPercent } = input;
  if (lastFiredValue == null || lastFiredValue <= 0) {
    return { fire: false, nextLastFiredValue: adjustedDailyTarget };
  }
  const percentIncrease = ((adjustedDailyTarget - lastFiredValue) / lastFiredValue) * 100;
  if (percentIncrease > thresholdPercent) {
    return { fire: true, nextLastFiredValue: adjustedDailyTarget };
  }
  return { fire: false, nextLastFiredValue: lastFiredValue };
}

/**
 * §10.8 trigger 2: "Business stayed behind for three completed open days."
 * Reuses the day-level status `getRecoveryInsight`'s `dailyCoverage` table
 * already computes via `dayStatus` (plan §8.3) instead of re-deriving it —
 * see that function's caller for how the last three COMPLETED (i.e. strictly
 * before business-local today) operating days' statuses are extracted from
 * it.
 *
 * Requires both the day-level signal (three straight "below" days) AND the
 * CURRENT month-level `status === "behind"` — a business that dug out of a
 * three-day hole and is back on pace should not keep hearing it's behind.
 *
 * Returns `false` (does not fire, and does not claim the condition is
 * unmet-forever) whenever fewer than three completed operating days are
 * available to inspect — e.g. early in a month, or a profile whose caller
 * only loaded a short coverage window. This is a known, accepted limitation
 * documented at the call site, not a bug: the trigger becomes evaluable
 * again once enough operating-day history is in view.
 */
export function decideBehindThreeDaysTrigger(input: {
  monthStatus: RecoveryStatus;
  lastThreeCompletedOperatingDayStatuses: DayStatus[];
}): boolean {
  const { monthStatus, lastThreeCompletedOperatingDayStatuses } = input;
  if (monthStatus !== "behind") return false;
  if (lastThreeCompletedOperatingDayStatuses.length < 3) return false;
  return lastThreeCompletedOperatingDayStatuses.every((status) => status === "below");
}

/**
 * §10.8 trigger 3: "An open day is nearing completion with no sales record,
 * ONLY IF operating hours exist." This codebase has no operating-HOURS
 * concept — `BusinessOperatingDay`/`BusinessOperatingDayOverride` (plan
 * §7.2/§7.3) record which CALENDAR DATES are open, never a time-of-day
 * opening/closing hour — so "nearing completion" of an open day cannot be
 * determined for any profile today.
 *
 * Per the plan's own explicit precondition, this must therefore never fire
 * rather than substitute a fake heuristic (e.g. "assume closed at 9pm
 * local"), which would misrepresent any business with different real hours.
 * Wired the same way `"data_incomplete"` is wired into `RecoveryStatus` but
 * never emitted (see that type's doc comment above) — implemented and ready,
 * permanently inert until a real operating-hours capability exists. DO NOT
 * make this heuristically fire without that capability landing first.
 */
export function decideOpenDayNoSalesTrigger(): boolean {
  return false;
}

/**
 * §10.8 trigger 4: "Projection crosses from on-track to shortfall." The only
 * projection this codebase has, `deriveRecoveryProjection` above, is
 * explicitly gated behind an unapproved backtesting error threshold and NOT
 * wired into any client-facing response yet (see that function's SCOPE NOTE
 * and plan §16.2/§20 — "no default-enabled forecast until its release gate
 * passes"). Generating real owner-facing notifications off an unapproved,
 * unvalidated projection would defeat the entire point of that gate, so this
 * must never fire until the projection itself is approved for display.
 */
export function decideProjectionShortfallTrigger(): boolean {
  return false;
}

/**
 * §10.8 trigger 5: "Coverage target is reached." Fires once per business-
 * local calendar month: `lastFiredMonthKey` (the "YYYY-MM" the last firing
 * happened in, business-local) is compared against `currentMonthKey`, so
 * reloading the Recovery Target screen while still covered does not re-fire
 * on every page view, but a business that becomes covered again in a LATER
 * month is notified again.
 */
export function decideCoverageReachedTrigger(input: {
  monthStatus: RecoveryStatus;
  lastFiredAt: Date | null;
  /** "YYYY-MM", business-local, for the moment being evaluated. */
  currentMonthKey: string;
  /** "YYYY-MM" the last firing happened in, business-local, or `null` if it has never fired. */
  lastFiredMonthKey: string | null;
}): boolean {
  const { monthStatus, lastFiredAt, currentMonthKey, lastFiredMonthKey } = input;
  if (monthStatus !== "covered") return false;
  if (!lastFiredAt) return true;
  return lastFiredMonthKey !== currentMonthKey;
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

// ============================================================
// Recovery Target — month-end review (plan §10.9/§11 Phase 7)
// ============================================================
//
// Pure materiality/selection/templating logic only, unit-tested without a
// database — see insights.service.ts's `computeMonthEndReview` for the
// read-only database orchestration (which month's calendar/sales to load,
// the "has this month actually ended" guard, etc.), matching this file's
// existing split with insights.service.ts everywhere else.
//
// OUT OF SCOPE here and in `computeMonthEndReview`: season-aware,
// weekday-weighted target allocation (plan §11 Phase 7, §15's closing
// paragraph). That requires multi-month historical open-day data this
// schema does not persist (no month-over-month history table exists, and
// plan §7.5 forbids new persistence beyond what earlier phases already
// approved) and stakeholder validation this project does not have. Nothing
// below compares across months.

/**
 * INTERPRETED THRESHOLD, not stakeholder-confirmed — same posture as the
 * large-expense threshold and `PACE_TOLERANCE_FRACTION` elsewhere in this
 * file. How far `coveragePercent` must land from 100% before the month-end
 * summary treats the configured `expectedMonthlyExpenses` baseline as
 * possibly not matching the month's recorded pattern. Deliberately much
 * wider than `PACE_TOLERANCE_FRACTION` (5%) — that is a DAILY pace-variance
 * tolerance where a single day's noise matters; this is a whole-MONTH
 * materiality check, where 20 percentage points of aggregate drift is a
 * conservative bar meant to avoid flagging routine month-to-month variance
 * as a baseline problem.
 */
export const MONTH_END_BASELINE_MATERIALITY_FRACTION = 0.2;

/**
 * §10.9: "whether the configured expense baseline appeared materially
 * different from the recorded pattern." A pure, honest SIGNAL only — never a
 * suggested replacement number, and never written anywhere.
 *
 * `expectedMonthlyExpenses <= 0` (no baseline configured at all) always
 * returns false — "no baseline" is a setup problem this summary's caller
 * already has other, dedicated fields for (mirroring
 * `RecoveryTargets.needsSetup`/`setupIssues`), not a "this number looks off"
 * pattern signal, and flagging it here would just restate "you have no
 * baseline" as a misleading, pattern-focused sentence.
 */
export function deriveBaselineAppearsOffFromPattern(coveragePercent: number, expectedMonthlyExpenses: number): boolean {
  if (expectedMonthlyExpenses <= 0) return false;
  return Math.abs(coveragePercent - 100) > MONTH_END_BASELINE_MATERIALITY_FRACTION * 100;
}

export interface MonthEndOpenDaySales {
  date: string;
  sales: number;
}

/**
 * §10.9's "strongest and weakest confirmed open days" — pure selection over
 * an already-resolved per-open-day CONFIRMED sales list, expected in
 * chronological order (insights.service.ts builds this from the real
 * confirmed/provisional split, plan §9.6).
 *
 * Ties resolve to the EARLIEST date — this scans forward and only replaces
 * the current strongest/weakest on a STRICT improvement, so the first day
 * seen for a tied amount wins. An arbitrary but stable, documented choice.
 *
 * Zero-open-days edge case: both null when `openDays` is empty (e.g. a
 * fully-closed, schedule-configured month — nothing to report). A month
 * WITH open days but literally zero sales on every one of them still
 * returns a real day for both — the earliest such zero-sales open day —
 * per this task's documented choice: "no sales at all" is itself the
 * finding (surfaced separately via `missingOrProvisionalDayCount`), not a
 * reason to suppress which day was the (tied) best/worst.
 */
export function selectStrongestAndWeakestOpenDay(
  openDays: MonthEndOpenDaySales[],
): { strongest: MonthEndOpenDaySales | null; weakest: MonthEndOpenDaySales | null } {
  if (openDays.length === 0) return { strongest: null, weakest: null };
  let strongest = openDays[0]!;
  let weakest = openDays[0]!;
  for (const day of openDays.slice(1)) {
    if (day.sales > strongest.sales) strongest = day;
    if (day.sales < weakest.sales) weakest = day;
  }
  return { strongest, weakest };
}

/** PHP currency formatting matching `aiContext.service.ts`'s existing convention. */
function formatPhp(n: number): string {
  return `₱${Math.round(n).toLocaleString("en-PH")}`;
}

/**
 * INTERPRETED THRESHOLD: the fraction of a month's open days that must be
 * missing-or-provisional before the templated question below calls it out.
 * Below this fraction, a handful of unreviewed/missed days is treated as
 * routine noise, not something worth a dedicated next-month question.
 */
export const MONTH_END_MISSING_DAY_QUESTION_FRACTION = 0.2;

export interface MonthEndReviewQuestionInputs {
  baselineAppearsOffFromPattern: boolean;
  expectedMonthlyExpenses: number;
  coveragePercent: number;
  missingOrProvisionalDayCount: number;
  openDayCount: number;
  strongestOpenDay: MonthEndOpenDaySales | null;
  weakestOpenDay: MonthEndOpenDaySales | null;
  originalDailyTarget: number;
  finalAdjustedDailyTarget: number | null;
}

/**
 * §10.9's "suggested questions for next month" — PLAIN, DETERMINISTIC STRING
 * TEMPLATES built from already-computed numbers. Never AI-generated, never
 * prescriptive, never an instruction to change a setting (plan §10.9's
 * closing line: "suggestions must not automatically update the next month's
 * settings"; plan §7's Phase 7 entry: "require explicit approval for any
 * next-month baseline update").
 *
 * Always returns between 2 and 4 questions: each condition below is
 * independent and additive, and the two lowest-priority filler questions
 * exist only to top the list up to a minimum of 2 when fewer than two
 * conditions actually fired.
 */
export function deriveSuggestedQuestionsForNextMonth(input: MonthEndReviewQuestionInputs): string[] {
  const questions: string[] = [];

  if (input.baselineAppearsOffFromPattern) {
    questions.push(
      `Does ${formatPhp(input.expectedMonthlyExpenses)}/month still reflect your typical expenses? Recorded sales covered ${Math.round(input.coveragePercent)}% of that this month.`,
    );
  }

  if (input.openDayCount > 0 && input.missingOrProvisionalDayCount / input.openDayCount >= MONTH_END_MISSING_DAY_QUESTION_FRACTION) {
    questions.push(
      `${input.missingOrProvisionalDayCount} of ${input.openDayCount} open days this month have no sales recorded or still need review — were any missed, or were those days actually closed?`,
    );
  }

  if (
    input.finalAdjustedDailyTarget != null
    && input.originalDailyTarget > 0
    && input.finalAdjustedDailyTarget > input.originalDailyTarget * (1 + PACE_TOLERANCE_FRACTION)
  ) {
    questions.push(
      `Your daily target drifted from ${formatPhp(input.originalDailyTarget)} to ${formatPhp(input.finalAdjustedDailyTarget)} by month-end — did something change partway through the month?`,
    );
  }

  if (input.strongestOpenDay && input.weakestOpenDay && input.strongestOpenDay.date !== input.weakestOpenDay.date) {
    questions.push(
      `${input.strongestOpenDay.date} was your strongest open day (${formatPhp(input.strongestOpenDay.sales)}) and ${input.weakestOpenDay.date} was your weakest (${formatPhp(input.weakestOpenDay.sales)}) — anything worth planning around for next month?`,
    );
  }

  if (questions.length === 0) {
    questions.push("Nothing unusual stood out this month — anything you'd like to flag before next month starts?");
  }
  if (questions.length < 2) {
    questions.push("Any one-off events (holidays, closures, promos) this month you'd want factored into next month's expectations?");
  }

  return questions.slice(0, 4);
}
