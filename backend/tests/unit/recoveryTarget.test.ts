import { describe, expect, it } from "vitest";
import {
  applyMonthDataStatus,
  classifyRecoveryChangeReason,
  computeChangeSincePreviousDay,
  computeRecoveryTarget,
  dayStatus,
  daysInMonth,
  deriveRecoveryCheckpoints,
  recoveryPaceTolerance,
} from "../../src/services/analysis.service";
import { utcIsoWeekday } from "../../src/lib/dates";

// All dates here are built with Date.UTC deliberately. computeRecoveryTarget
// reads its input with UTC getters because record dates are date-only values
// stored at UTC midnight; constructing test dates in local time would make
// these assertions pass or fail depending on the machine's timezone.
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

const base = {
  expectedMonthlyExpenses: 125000,
  operatingDays: 25,
  salesThisMonth: 45000,
  salesToday: 4500,
};

describe("computeRecoveryTarget — the approved mockup's worked example", () => {
  // The UI mockup states: EME 125,000 over 25 operating days -> 5,000/day;
  // 45,000 recorded -> 80,000 remaining; 15 remaining operating days ->
  // 5,333/day adjusted. For remainingOperatingDays to land on 15 with 25
  // operating days in a 30-day month, 18 calendar days must remain, i.e. the
  // 13th of April.
  const result = computeRecoveryTarget({ ...base, today: utc(2026, 4, 13) });

  it("derives the daily needed target as EME / operating days", () => {
    expect(result.dailyNeededTarget).toBe(5000);
  });

  it("derives the remaining target as EME - sales so far", () => {
    expect(result.remainingTarget).toBe(80000);
  });

  it("reproduces the mockup's 15 remaining operating days", () => {
    expect(result.daysInMonth).toBe(30);
    expect(result.calendarDaysLeftInMonth).toBe(18);
    expect(result.remainingOperatingDays).toBe(15);
  });

  it("reproduces the mockup's 5,333 adjusted daily target", () => {
    expect(Math.round(result.adjustedDailyTarget)).toBe(5333);
  });

  it("reports today as 500 below the flat daily target", () => {
    expect(result.todaysTarget).toBe(5000);
    expect(result.todaysGap).toBe(-500);
    expect(result.todaysStatus).toBe("below");
  });

  it("is behind for the month, because the adjusted target now exceeds the flat one", () => {
    expect(result.onTrack).toBe(false);
    expect(result.monthCoveragePercent).toBe(36);
  });
});

describe("computeRecoveryTarget — month boundaries", () => {
  it("on the 1st, every day of the month is still ahead", () => {
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 0, salesToday: 0, today: utc(2026, 7, 1) });
    expect(r.daysInMonth).toBe(31);
    expect(r.calendarDaysLeftInMonth).toBe(31);
    // The whole month remains, so the full operating-day count remains.
    expect(r.remainingOperatingDays).toBe(25);
    expect(r.adjustedDailyTarget).toBe(125000 / 25);
    // Nothing recorded yet but nothing missed yet either: the adjusted target
    // still equals the flat target, so this is on track rather than behind.
    expect(r.onTrack).toBe(true);
  });

  it("on the last day, exactly one day remains and there is no divide-by-zero", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 7, 31) });
    expect(r.calendarDaysLeftInMonth).toBe(1);
    expect(r.remainingOperatingDays).toBe(1);
    expect(r.adjustedDailyTarget).toBe(80000);
    expect(Number.isFinite(r.adjustedDailyTarget)).toBe(true);
  });

  it("clamps remaining operating days to at least 1 when rounding would give 0", () => {
    // 8 operating days scaled by 1/31 of the month rounds to 0. Left unclamped
    // that divides the remaining target by zero and yields Infinity.
    const r = computeRecoveryTarget({
      ...base,
      operatingDays: 8,
      salesThisMonth: 10000,
      today: utc(2026, 7, 31),
    });
    expect(r.remainingOperatingDays).toBe(1);
    expect(Number.isFinite(r.adjustedDailyTarget)).toBe(true);
    expect(r.adjustedDailyTarget).toBe(115000);
  });

  it("handles February in a leap year", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2028, 2, 29) });
    expect(r.daysInMonth).toBe(29);
    expect(r.calendarDaysLeftInMonth).toBe(1);
  });

  it("handles February in a non-leap year", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2027, 2, 28) });
    expect(r.daysInMonth).toBe(28);
    expect(r.calendarDaysLeftInMonth).toBe(1);
  });

  it("reads the day in UTC, not local time", () => {
    // A record date is stored as this exact instant. On a UTC+8 machine local
    // getters would read the previous day and shift every derived figure.
    const r = computeRecoveryTarget({ ...base, today: new Date("2026-07-25T00:00:00.000Z") });
    expect(r.calendarDaysLeftInMonth).toBe(31 - 25 + 1);
  });
});

describe("computeRecoveryTarget — degenerate inputs", () => {
  it("floors the remaining target at 0 once the month is over-covered", () => {
    const r = computeRecoveryTarget({
      ...base,
      salesThisMonth: 200000, // more than the 125,000 needed
      today: utc(2026, 7, 15),
    });
    expect(r.remainingTarget).toBe(0);
    expect(r.adjustedDailyTarget).toBe(0);
    expect(r.onTrack).toBe(true);
    expect(r.monthCoveragePercent).toBeCloseTo(160, 6);
  });

  it("returns 0 rather than NaN/Infinity when operatingDays is 0", () => {
    // The API rejects operatingDays < 1, so this is defence in depth for data
    // arriving another way (a migration, a manual DB edit) rather than a state
    // the UI can reach.
    const r = computeRecoveryTarget({
      ...base,
      operatingDays: 0,
      salesThisMonth: 0,
      salesToday: 0,
      today: utc(2026, 7, 15),
    });
    expect(r.dailyNeededTarget).toBe(0);
    expect(Number.isNaN(r.dailyNeededTarget)).toBe(false);
    expect(r.todaysTarget).toBe(0);
    // No target to miss, so today is neither above nor below it.
    expect(r.todaysStatus).toBe("at");
  });

  it("returns 0% coverage rather than NaN when expected monthly expenses is 0", () => {
    const r = computeRecoveryTarget({
      ...base,
      expectedMonthlyExpenses: 0,
      salesThisMonth: 0,
      salesToday: 0,
      today: utc(2026, 7, 15),
    });
    expect(r.monthCoveragePercent).toBe(0);
    expect(Number.isNaN(r.monthCoveragePercent)).toBe(false);
  });

  it("always flags the remaining-operating-days figure as approximated", () => {
    // The profile stores a monthly operating-day count, not a weekly schedule,
    // so this number can never be exact. The UI relies on this flag to say so.
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 7, 15) });
    expect(r.remainingOperatingDaysIsApproximated).toBe(true);
  });
});

describe("dayStatus", () => {
  it("reports above / at / below against the target", () => {
    expect(dayStatus(6000, 5000)).toBe("above");
    expect(dayStatus(5000, 5000)).toBe("at");
    expect(dayStatus(4000, 5000)).toBe("below");
  });

  it("treats sub-centavo differences as 'at', so float noise can't hide a hit target", () => {
    expect(dayStatus(5000.001, 5000)).toBe("at");
    expect(dayStatus(4999.999, 5000)).toBe("at");
  });

  it("still distinguishes a real one-centavo miss", () => {
    expect(dayStatus(4999.99, 5000)).toBe("below");
  });

  it("reports 'at' when there is no target at all", () => {
    expect(dayStatus(0, 0)).toBe("at");
  });
});

describe("daysInMonth", () => {
  it("returns the correct length for each month length, read in UTC", () => {
    expect(daysInMonth(utc(2026, 1, 15))).toBe(31);
    expect(daysInMonth(utc(2026, 4, 15))).toBe(30);
    expect(daysInMonth(utc(2026, 2, 15))).toBe(28);
    expect(daysInMonth(utc(2028, 2, 15))).toBe(29);
  });
});

// ============================================================
// Phase 1 — RecoveryStatus precedence and pace variance
// (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.4/§9.7)
// ============================================================

describe("computeRecoveryTarget — expected pace to date and pace variance (§9.4)", () => {
  it("reproduces the mockup worked example's -5,000 pace variance (behind)", () => {
    // dailyNeededTarget 5,000, remainingOperatingDays 15 (see the mockup test
    // above) => elapsedOperatingDays = 25 - 15 = 10 => expected-to-date 50,000.
    // Recorded 45,000 => variance -5,000, well past the tolerance band.
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 4, 13) });
    expect(r.expectedSalesToDate).toBe(50000);
    expect(r.paceVarianceAmount).toBe(-5000);
    expect(r.status).toBe("behind");
  });

  it("on the 1st of the month, zero elapsed days means zero expected-to-date and on_pace", () => {
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 0, salesToday: 0, today: utc(2026, 7, 1) });
    expect(r.expectedSalesToDate).toBe(0);
    expect(r.paceVarianceAmount).toBe(0);
    expect(r.status).toBe("on_pace");
  });
});

describe("computeRecoveryTarget — status precedence (§9.7, Phase 1 subset)", () => {
  // Fixed calendar point for all cases below: 2026-07-15, so
  // remainingOperatingDays = round(25 * 17/31) = 14, elapsedOperatingDays = 11,
  // expectedSalesToDate = 5,000 x 11 = 55,000, tolerance = max(0.005, 250) = 250.
  const today = utc(2026, 7, 15);

  it("needs_setup takes precedence over everything else, even an ostensibly covered month", () => {
    const r = computeRecoveryTarget({ ...base, expectedMonthlyExpenses: 0, salesThisMonth: 999999, today });
    expect(r.status).toBe("needs_setup");
    expect(r.confidence).toBe("unavailable");
  });

  it("covered when remainingTarget has reached zero", () => {
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 200000, today });
    expect(r.remainingTarget).toBe(0);
    expect(r.status).toBe("covered");
    expect(r.confidence).toBe("moderate");
  });

  it("ahead when pace variance clears the tolerance on the positive side", () => {
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 80000, today });
    expect(r.expectedSalesToDate).toBe(55000);
    expect(r.paceVarianceAmount).toBe(25000);
    expect(r.status).toBe("ahead");
  });

  it("behind when pace variance clears the tolerance on the negative side", () => {
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 30000, today });
    expect(r.paceVarianceAmount).toBe(-25000);
    expect(r.status).toBe("behind");
  });

  it("on_pace when pace variance sits inside the tolerance band", () => {
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 55100, today }); // variance = +100, tolerance = 250
    expect(r.paceVarianceAmount).toBe(100);
    expect(r.status).toBe("on_pace");
  });

  it("on_pace exactly at the tolerance boundary counts as within it, not ahead/behind", () => {
    const tolerance = recoveryPaceTolerance(5000);
    const r = computeRecoveryTarget({ ...base, salesThisMonth: 55000 + tolerance, today });
    expect(r.status).toBe("on_pace");
  });
});

describe("recoveryPaceTolerance", () => {
  it("is 5% of the daily target when that exceeds the centavo floor", () => {
    expect(recoveryPaceTolerance(5000)).toBe(250);
  });

  it("floors at the centavo epsilon for a near-zero daily target", () => {
    expect(recoveryPaceTolerance(0)).toBe(0.005);
    expect(recoveryPaceTolerance(0.05)).toBe(0.005);
  });
});

describe("applyMonthDataStatus (§9.7 step 2, folded on top of the pure snapshot)", () => {
  it("overrides an otherwise-computed status to no_current_month_data when the month has zero sales records", () => {
    const targets = computeRecoveryTarget({ ...base, salesThisMonth: 0, salesToday: 0, today: utc(2026, 7, 15) });
    const result = applyMonthDataStatus(targets, true);
    expect(result.status).toBe("no_current_month_data");
    expect(result.confidence).toBe("limited");
  });

  it("does not override needs_setup, even when the month also has no records", () => {
    const targets = computeRecoveryTarget({ ...base, expectedMonthlyExpenses: 0, today: utc(2026, 7, 15) });
    const result = applyMonthDataStatus(targets, true);
    expect(result.status).toBe("needs_setup");
    expect(result.confidence).toBe("unavailable");
  });

  it("leaves the status untouched when the month does have records", () => {
    const targets = computeRecoveryTarget({ ...base, today: utc(2026, 7, 15) });
    const result = applyMonthDataStatus(targets, false);
    expect(result.status).toBe(targets.status);
    expect(result.confidence).toBe(targets.confidence);
  });
});

// ============================================================
// Phase 2 — exact operating calendar (RECOVERY-TARGET-IMPROVEMENT-PLAN.md
// §9.2/§9.5, Phase 2)
// ============================================================
//
// These tests exercise `computeRecoveryTarget`'s exact-mode branch directly,
// with hand-computed `exactOperatingCalendar` counts standing in for whatever
// `resolveExactOperatingCounts` would have derived from a real schedule —
// `operatingCalendar.service.ts`'s own DB-backed resolution logic (weekly
// schedule vs. override precedence) is covered separately in
// tests/integration/operatingCalendar.test.ts.
describe("computeRecoveryTarget — exact operating calendar (Phase 2, §9.2/§9.5)", () => {
  it("omitting exactOperatingCalendar leaves approximation mode byte-for-byte unchanged", () => {
    const withoutSchedule = computeRecoveryTarget({ ...base, today: utc(2026, 4, 13) });
    expect(withoutSchedule.operatingScheduleConfigured).toBe(false);
    expect(withoutSchedule.operatingDaysThisMonth).toBe(base.operatingDays);
    expect(withoutSchedule.remainingOperatingDaysIsApproximated).toBe(true);
    // Unchanged from the pre-Phase-2 worked example at the top of this file.
    expect(withoutSchedule.remainingOperatingDays).toBe(15);
    expect(Math.round(withoutSchedule.adjustedDailyTarget)).toBe(5333);
  });

  it("weekdays-only schedule (closed Sat/Sun): exact counts replace the approximation", () => {
    // April 2026: weekdays-only means every Sat/Sun is closed. There are 8
    // weekend dates in April 2026 (4,5,11,12,18,19,25,26), so 22 open days
    // across the month. As of Monday the 13th: 1st-13th inclusive is 13
    // calendar days minus 4 elapsed weekend days (4,5,11,12) = 9 elapsed open
    // days; 13th-30th inclusive is 18 calendar days minus 4 remaining weekend
    // days (18,19,25,26) = 14 remaining open days (today itself is open and
    // counted in both, per operatingCalendar.service.ts's convention).
    const today = utc(2026, 4, 13); // a Monday
    const r = computeRecoveryTarget({
      ...base,
      today,
      exactOperatingCalendar: {
        operatingDaysThisMonth: 22,
        elapsedOperatingDays: 9,
        remainingOperatingDays: 14,
      },
    });
    expect(r.operatingScheduleConfigured).toBe(true);
    expect(r.operatingDaysThisMonth).toBe(22);
    expect(r.remainingOperatingDaysIsApproximated).toBe(false);
    expect(r.dailyNeededTarget).toBeCloseTo(125000 / 22, 6);
    expect(r.expectedSalesToDate).toBeCloseTo((125000 / 22) * 9, 6);
    expect(r.remainingOperatingDays).toBe(14);
    expect(r.adjustedDailyTarget).toBeCloseTo(80000 / 14, 6);
  });

  it("weekend-only schedule: open days this month can exceed what a weekdays approximation would guess", () => {
    const today = utc(2026, 4, 13);
    const r = computeRecoveryTarget({
      ...base,
      operatingDays: 25, // the stored approximation, deliberately wrong for this schedule
      today,
      exactOperatingCalendar: {
        // April 2026 has exactly 8 Sat/Sun dates: 4,5,11,12,18,19,25,26.
        // By Monday the 13th, the 4th/5th/11th/12th have elapsed (4), and
        // the 18th/19th/25th/26th remain (4).
        operatingDaysThisMonth: 8,
        elapsedOperatingDays: 4,
        remainingOperatingDays: 4,
      },
    });
    // operatingDays (the stored profile approximation) is left untouched...
    expect(r.operatingDays).toBe(25);
    // ...but operatingDaysThisMonth and the derived targets use the exact count.
    expect(r.operatingDaysThisMonth).toBe(8);
    expect(r.dailyNeededTarget).toBeCloseTo(125000 / 8, 6);
    expect(r.remainingOperatingDays).toBe(4);
    expect(r.adjustedDailyTarget).toBeCloseTo(80000 / 4, 6);
  });

  it("all-open schedule matching the approximation's guess produces the same figures", () => {
    // Reproduces the mockup worked example exactly, but through exact mode:
    // 25 operating days total, 15 remaining, 10 elapsed as of 2026-04-13.
    const today = utc(2026, 4, 13);
    const r = computeRecoveryTarget({
      ...base,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 25, elapsedOperatingDays: 10, remainingOperatingDays: 15 },
    });
    expect(r.dailyNeededTarget).toBe(5000);
    expect(Math.round(r.adjustedDailyTarget)).toBe(5333);
    expect(r.expectedSalesToDate).toBe(50000);
    expect(r.status).toBe("behind");
  });

  it("all-open schedule NOT matching the approximation's guess diverges from it", () => {
    const today = utc(2026, 4, 13);
    const approx = computeRecoveryTarget({ ...base, today });
    const exact = computeRecoveryTarget({
      ...base,
      today,
      // The true month has 28 open days, not the stored approximation's 25.
      exactOperatingCalendar: { operatingDaysThisMonth: 28, elapsedOperatingDays: 12, remainingOperatingDays: 17 },
    });
    expect(exact.dailyNeededTarget).not.toBe(approx.dailyNeededTarget);
    expect(exact.remainingOperatingDays).not.toBe(approx.remainingOperatingDays);
    expect(exact.dailyNeededTarget).toBeCloseTo(125000 / 28, 6);
  });

  it("a holiday override on what would otherwise be an open weekday reduces the exact count", () => {
    // Modeled as a schedule that would normally have 22 open weekdays in
    // April, with one of them (e.g. a mid-month holiday) overridden closed —
    // resolveOperatingCalendar's own override-precedence logic is exercised
    // in the integration test; here we assert computeRecoveryTarget correctly
    // consumes whatever exact count it's handed.
    const today = utc(2026, 4, 13);
    const withoutHoliday = computeRecoveryTarget({
      ...base,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 22, elapsedOperatingDays: 9, remainingOperatingDays: 14 },
    });
    const withHoliday = computeRecoveryTarget({
      ...base,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 21, elapsedOperatingDays: 9, remainingOperatingDays: 13 },
    });
    expect(withHoliday.operatingDaysThisMonth).toBe(21);
    expect(withHoliday.dailyNeededTarget).toBeGreaterThan(withoutHoliday.dailyNeededTarget);
    expect(withHoliday.remainingOperatingDays).toBe(13);
  });

  it("a special-opening override on a normally-closed day increases the exact count", () => {
    const today = utc(2026, 4, 13);
    const normallyClosedSunday = computeRecoveryTarget({
      ...base,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 22, elapsedOperatingDays: 9, remainingOperatingDays: 14 },
    });
    const specialOpening = computeRecoveryTarget({
      ...base,
      today,
      // One normally-closed Sunday opened specially -> +1 to the month total
      // and to remaining (it falls after the 13th).
      exactOperatingCalendar: { operatingDaysThisMonth: 23, elapsedOperatingDays: 9, remainingOperatingDays: 15 },
    });
    expect(specialOpening.operatingDaysThisMonth).toBe(23);
    expect(specialOpening.remainingOperatingDays).toBe(15);
    expect(specialOpening.dailyNeededTarget).toBeLessThan(normallyClosedSunday.dailyNeededTarget);
  });

  it("zero remaining open days with a positive remaining target does NOT fabricate a fake day (§9.5)", () => {
    // Last day of the month is closed (e.g. Sunday), and it's also the ONLY
    // day left — so the true remaining open-day count is 0, not the
    // approximation's clamped-to-1 floor.
    const today = utc(2026, 4, 30);
    const r = computeRecoveryTarget({
      ...base,
      salesThisMonth: 45000,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 22, elapsedOperatingDays: 22, remainingOperatingDays: 0 },
    });
    expect(r.remainingOperatingDays).toBe(0);
    expect(r.remainingTarget).toBe(80000);
    // adjustedDailyTarget must equal remainingTarget itself, not
    // remainingTarget / 1 (which would coincidentally be the same number
    // here, so this also checks it isn't silently re-clamped to 1 elsewhere).
    expect(r.adjustedDailyTarget).toBe(r.remainingTarget);
    expect(Number.isFinite(r.adjustedDailyTarget)).toBe(true);
    // Now resolves to "behind" via the explicit
    // `remainingOperatingDays === 0 && remainingTarget > 0` branch added for
    // the whole-month-closed case below (it also naturally would have
    // resolved to "behind" here via pace variance, since
    // elapsedOperatingDays is large and non-zero, but the explicit branch
    // takes precedence and produces the same result).
    expect(r.status).toBe("behind");
  });

  it("zero remaining open days with a fully covered target still reports 'covered', not 'behind'", () => {
    const today = utc(2026, 4, 30);
    const r = computeRecoveryTarget({
      ...base,
      salesThisMonth: 200000,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 22, elapsedOperatingDays: 22, remainingOperatingDays: 0 },
    });
    expect(r.remainingTarget).toBe(0);
    expect(r.adjustedDailyTarget).toBe(0);
    expect(r.status).toBe("covered");
  });

  // QA finding (Phase 2 review, RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.5): a
  // business profile whose ENTIRE month is closed (operatingDaysThisMonth: 0,
  // not just remainingOperatingDays: 0 with days already elapsed) used to
  // report "on_pace" instead of the plan's mandated explicit "behind" for a
  // positive remaining target with zero open days. This differs from the test
  // above because there `elapsedOperatingDays` was 22 (all open days already
  // passed) so `expectedSalesToDate` was a large positive figure and
  // `paceVarianceAmount` was naturally very negative. Here elapsedOperatingDays
  // is ALSO 0 (nothing was ever open), so expectedSalesToDate was 0 too, and
  // paceVarianceAmount = salesThisMonth - 0 landed inside tolerance whenever
  // salesThisMonth was small/zero — masking a fully uncovered target as
  // "on_pace". Fixed in analysis.service.ts by adding an explicit
  // `remainingOperatingDays === 0 && remainingTarget > 0` => "behind" branch
  // instead of relying on pace variance alone. This is now a permanent
  // regression test and must stay green.
  it("whole month closed (operatingDaysThisMonth: 0) with an uncovered target reports 'behind', not 'on_pace'", () => {
    const today = utc(2026, 4, 15);
    const r = computeRecoveryTarget({
      ...base,
      salesThisMonth: 0,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 0, elapsedOperatingDays: 0, remainingOperatingDays: 0 },
    });
    expect(r.operatingDaysThisMonth).toBe(0);
    expect(r.remainingOperatingDays).toBe(0);
    expect(r.remainingTarget).toBeGreaterThan(0);
    expect(Number.isFinite(r.dailyNeededTarget)).toBe(true);
    expect(Number.isFinite(r.adjustedDailyTarget)).toBe(true);
    expect(r.status).toBe("behind");
  });

  it("whole month closed (operatingDaysThisMonth: 0) with an already-covered target reports 'covered', not 'behind'", () => {
    // Same whole-month-closed shape as above, but the business already fully
    // met its target before closing for the month — the new explicit
    // `remainingOperatingDays === 0` branch must not override the
    // remainingTarget < AMOUNT_EPSILON => "covered" branch that is checked
    // first.
    const today = utc(2026, 4, 15);
    const r = computeRecoveryTarget({
      ...base,
      salesThisMonth: 200000,
      today,
      exactOperatingCalendar: { operatingDaysThisMonth: 0, elapsedOperatingDays: 0, remainingOperatingDays: 0 },
    });
    expect(r.operatingDaysThisMonth).toBe(0);
    expect(r.remainingOperatingDays).toBe(0);
    expect(r.remainingTarget).toBe(0);
    expect(r.status).toBe("covered");
  });
});

describe("computeRecoveryTarget — timezone/asOfDate passthrough (§9.1/§8.2 Phase 1 fields)", () => {
  it("defaults timezone to Asia/Manila and derives asOfDate from the input `today`", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 7, 15) });
    expect(r.timezone).toBe("Asia/Manila");
    expect(r.asOfDate).toBe("2026-07-15");
    expect(r.contractVersion).toBe(1);
  });

  it("carries through an explicitly supplied timezone unchanged", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 7, 15), timezone: "America/Los_Angeles" });
    expect(r.timezone).toBe("America/Los_Angeles");
  });
});

// ============================================================
// Phase 3 — confirmed/provisional split, dataWarnings, setupIssues
// (RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.6/§8.2, Phase 3)
// ============================================================

describe("computeRecoveryTarget — confirmed/provisional split (§9.6)", () => {
  it("without recordEligibility, treats every sale as confirmed and salesThisMonth is unaffected", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 7, 15) });
    expect(r.confirmedSalesThisMonth).toBe(r.salesThisMonth);
    expect(r.provisionalSalesThisMonth).toBe(0);
    expect(r.dataWarnings).toEqual([]);
    // salesThisMonth/remainingTarget/adjustedDailyTarget are untouched by the
    // split — they still sum confirmed + provisional exactly as before.
    expect(r.remainingTarget).toBe(base.expectedMonthlyExpenses - base.salesThisMonth);
  });

  it("splits confirmedSalesThisMonth/provisionalSalesThisMonth so they sum to salesThisMonth", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      recordEligibility: {
        confirmedSalesThisMonth: 30000,
        pendingReviewSalesThisMonth: 10000,
        possibleDuplicateSalesThisMonth: 5000,
      },
    });
    expect(r.confirmedSalesThisMonth).toBe(30000);
    expect(r.provisionalSalesThisMonth).toBe(base.salesThisMonth - 30000);
    expect(r.confirmedSalesThisMonth + r.provisionalSalesThisMonth).toBe(r.salesThisMonth);
    // remainingTarget/adjustedDailyTarget still use the FULL (confirmed +
    // provisional) salesThisMonth — the split is additive reporting only.
    expect(r.remainingTarget).toBe(base.expectedMonthlyExpenses - base.salesThisMonth);
  });

  it("emits records_pending_review when the provisional amount is attributed to needs-review status", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      recordEligibility: {
        confirmedSalesThisMonth: base.salesThisMonth - 1000,
        pendingReviewSalesThisMonth: 1000,
        possibleDuplicateSalesThisMonth: 0,
      },
    });
    expect(r.dataWarnings).toEqual(["records_pending_review"]);
  });

  it("emits possible_duplicates when the provisional amount is attributed to a flagged duplicate", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      recordEligibility: {
        confirmedSalesThisMonth: base.salesThisMonth - 1000,
        pendingReviewSalesThisMonth: 0,
        possibleDuplicateSalesThisMonth: 1000,
      },
    });
    expect(r.dataWarnings).toEqual(["possible_duplicates"]);
  });

  it("emits both warnings when both causes are present", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      recordEligibility: {
        confirmedSalesThisMonth: base.salesThisMonth - 2000,
        pendingReviewSalesThisMonth: 1000,
        possibleDuplicateSalesThisMonth: 1000,
      },
    });
    expect(r.dataWarnings).toContain("records_pending_review");
    expect(r.dataWarnings).toContain("possible_duplicates");
  });

  it("emits no warnings when provisional is zero", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      recordEligibility: {
        confirmedSalesThisMonth: base.salesThisMonth,
        pendingReviewSalesThisMonth: 0,
        possibleDuplicateSalesThisMonth: 0,
      },
    });
    expect(r.dataWarnings).toEqual([]);
  });
});

describe("computeRecoveryTarget — setupIssues (§8.2 Phase 3)", () => {
  it("flags expected_expenses_missing when needsSetup is true", () => {
    const r = computeRecoveryTarget({ ...base, expectedMonthlyExpenses: 0, today: utc(2026, 7, 15) });
    expect(r.setupIssues).toContain("expected_expenses_missing");
  });

  it("flags operating_schedule_missing in approximation mode (informational, not blocking)", () => {
    const r = computeRecoveryTarget({ ...base, today: utc(2026, 7, 15) });
    expect(r.operatingScheduleConfigured).toBe(false);
    expect(r.setupIssues).toContain("operating_schedule_missing");
  });

  it("does not flag operating_schedule_missing when a schedule is configured", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      exactOperatingCalendar: { operatingDaysThisMonth: 22, elapsedOperatingDays: 9, remainingOperatingDays: 14 },
    });
    expect(r.setupIssues).not.toContain("operating_schedule_missing");
  });

  it("can hold both issues at once, independently", () => {
    const r = computeRecoveryTarget({ ...base, expectedMonthlyExpenses: 0, today: utc(2026, 7, 15) });
    expect(r.setupIssues).toEqual(
      expect.arrayContaining(["expected_expenses_missing", "operating_schedule_missing"]),
    );
    expect(r.setupIssues).toHaveLength(2);
  });

  it("is empty when both setup conditions are satisfied", () => {
    const r = computeRecoveryTarget({
      ...base,
      today: utc(2026, 7, 15),
      exactOperatingCalendar: { operatingDaysThisMonth: 22, elapsedOperatingDays: 9, remainingOperatingDays: 14 },
    });
    expect(r.setupIssues).toEqual([]);
  });
});

// ============================================================
// Phase 3 — "Why your target changed" (§8.2/§10.3)
// ============================================================
//
// classifyRecoveryChangeReason/computeChangeSincePreviousDay are pure diff
// functions — getRecoveryInsight's null-on-1st-of-month/needsSetup gating and
// its "re-run computeRecoveryTarget for yesterday" plumbing are covered by
// the integration test instead (they need a real DB-backed profile/sales
// fixture to exercise meaningfully).
describe("classifyRecoveryChangeReason (§10.3 — INTERPRETED heuristic, not adviser-confirmed)", () => {
  it("reports no_material_change when the delta is inside the existing pace tolerance", () => {
    const dailyNeededTarget = 5000; // tolerance = 250
    const reason = classifyRecoveryChangeReason({
      adjustedDailyTargetDelta: 100,
      salesAdded: 0,
      remainingOpenDaysDelta: 0,
      dailyNeededTarget,
    });
    expect(reason).toBe("no_material_change");
  });

  it("reports sales_added when a material sales amount drove the target down", () => {
    const reason = classifyRecoveryChangeReason({
      adjustedDailyTargetDelta: -400, // target got easier
      salesAdded: 5000, // material versus tolerance of 250
      remainingOpenDaysDelta: -1, // ordinary day-elapsed movement too
      dailyNeededTarget: 5000,
    });
    expect(reason).toBe("sales_added");
  });

  it("reports open_day_elapsed when a day elapsed and sales weren't the material cause", () => {
    const reason = classifyRecoveryChangeReason({
      adjustedDailyTargetDelta: 400, // target got harder, purely from one fewer remaining day
      salesAdded: 0,
      remainingOpenDaysDelta: -1,
      dailyNeededTarget: 5000,
    });
    expect(reason).toBe("open_day_elapsed");
  });

  it("on_pace-style boundary: delta exactly at tolerance counts as no_material_change (inclusive)", () => {
    const dailyNeededTarget = 5000; // tolerance = 250
    const tolerance = recoveryPaceTolerance(dailyNeededTarget);
    const reason = classifyRecoveryChangeReason({
      adjustedDailyTargetDelta: tolerance,
      salesAdded: 0,
      remainingOpenDaysDelta: 0,
      dailyNeededTarget,
    });
    expect(reason).toBe("no_material_change");
  });

  it("QA regression: reports open_day_elapsed (not data_changed) when material sales were recorded but the day-elapse effect still dominates and the target got harder", () => {
    // Reproduction from QA's Phase 3 review: a business recorded a material
    // amount of sales (300, above the 250 tolerance) but the target still
    // got harder overall (delta +400) because one fewer day remains. The
    // day-elapse effect is the actual dominant, reportable cause here, not
    // "data_changed" (which would wrongly suggest a baseline/schedule edit).
    const reason = classifyRecoveryChangeReason({
      adjustedDailyTargetDelta: 400,
      salesAdded: 300,
      remainingOpenDaysDelta: -1,
      dailyNeededTarget: 5000, // tolerance = 250
    });
    expect(reason).toBe("open_day_elapsed");
  });

  it("falls back to data_changed when neither sales nor the day count cleanly explain a material delta", () => {
    const reason = classifyRecoveryChangeReason({
      adjustedDailyTargetDelta: 1000, // target got much harder
      salesAdded: 0,
      remainingOpenDaysDelta: 0, // no day-count movement to blame either
      dailyNeededTarget: 5000,
    });
    expect(reason).toBe("data_changed");
  });

  it("never emits baseline_changed or schedule_changed — those require history this phase doesn't persist", () => {
    // Exhaustively probing every branch above never returns either value;
    // this documents that as an explicit, intentional constraint rather than
    // an oversight (see the doc comment on classifyRecoveryChangeReason).
    const cases = [
      { adjustedDailyTargetDelta: 100, salesAdded: 0, remainingOpenDaysDelta: 0 },
      { adjustedDailyTargetDelta: -400, salesAdded: 5000, remainingOpenDaysDelta: -1 },
      { adjustedDailyTargetDelta: 400, salesAdded: 0, remainingOpenDaysDelta: -1 },
      { adjustedDailyTargetDelta: 1000, salesAdded: 0, remainingOpenDaysDelta: 0 },
    ];
    for (const c of cases) {
      const reason = classifyRecoveryChangeReason({ ...c, dailyNeededTarget: 5000 });
      expect(reason).not.toBe("baseline_changed");
      expect(reason).not.toBe("schedule_changed");
    }
  });
});

describe("computeChangeSincePreviousDay (§8.2 shape)", () => {
  it("computes deltas and salesAdded from today vs. yesterday snapshots", () => {
    const today = { adjustedDailyTarget: 5333, salesThisMonth: 45000, remainingOperatingDays: 15, dailyNeededTarget: 5000 };
    const yesterday = { adjustedDailyTarget: 5714, salesThisMonth: 40000, remainingOperatingDays: 16 };
    const result = computeChangeSincePreviousDay(today, yesterday);
    expect(result.adjustedDailyTargetDelta).toBeCloseTo(5333 - 5714, 6);
    expect(result.salesAdded).toBe(5000);
    expect(result.remainingOpenDaysDelta).toBe(-1);
    // A material sales amount (5000 > tolerance 250) drove the target down.
    expect(result.primaryReason).toBe("sales_added");
  });

  it("classifies an ordinary day-elapsed transition with no new sales", () => {
    const today = { adjustedDailyTarget: 5333, salesThisMonth: 45000, remainingOperatingDays: 14, dailyNeededTarget: 5000 };
    const yesterday = { adjustedDailyTarget: 5000, salesThisMonth: 45000, remainingOperatingDays: 15 };
    const result = computeChangeSincePreviousDay(today, yesterday);
    expect(result.salesAdded).toBe(0);
    expect(result.remainingOpenDaysDelta).toBe(-1);
    expect(result.primaryReason).toBe("open_day_elapsed");
  });

  it("classifies a negligible change as no_material_change", () => {
    const today = { adjustedDailyTarget: 5001, salesThisMonth: 45000, remainingOperatingDays: 15, dailyNeededTarget: 5000 };
    const yesterday = { adjustedDailyTarget: 5000, salesThisMonth: 45000, remainingOperatingDays: 15 };
    const result = computeChangeSincePreviousDay(today, yesterday);
    expect(result.primaryReason).toBe("no_material_change");
  });
});

describe("deriveRecoveryCheckpoints (plan §10.4, Phase 4)", () => {
  // April 2026 has 30 days. Checkpoint dates land on day-of-month 7, 14, 21,
  // 28, and (since 30 is not a multiple of 7) 30 as an extra final
  // checkpoint — this is the "partial first week"/"month boundary" case in
  // one: the last checkpoint only covers a 2-day partial "week".
  const today = utc(2026, 4, 20);

  describe("approximation mode (no operating schedule configured)", () => {
    const salesByDay = new Map<string, number>([
      ["2026-04-01", 10000],
      ["2026-04-07", 5000],
      ["2026-04-10", 8000],
      ["2026-04-14", 2000],
      // Deliberately including a sale after `today` to prove it's excluded
      // from every checkpoint (this function must never look into the future
      // for recorded amounts).
      ["2026-04-25", 99999],
    ]);

    const checkpoints = deriveRecoveryCheckpoints({
      today,
      dailyNeededTarget: 5000, // matches the worked-example base above
      operatingDays: 25,
      salesByDay,
    });

    it("produces 5 checkpoints: every 7 days from the 1st, plus the month's final day", () => {
      expect(checkpoints.map((c) => c.endDate)).toEqual([
        "2026-04-07",
        "2026-04-14",
        "2026-04-21",
        "2026-04-28",
        "2026-04-30",
      ]);
    });

    it("scales the cumulative target by the same proportional approximation computeRecoveryTarget uses, not an equal weekly split", () => {
      // elapsedOpenDays ~= round(25 * dayOfMonth / 30); cumulativeTarget = 5000 * that.
      expect(checkpoints[0]!.cumulativeTarget).toBeCloseTo(5000 * Math.round((25 * 7) / 30), 6); // 30,000
      expect(checkpoints[1]!.cumulativeTarget).toBeCloseTo(5000 * Math.round((25 * 14) / 30), 6); // 60,000
      expect(checkpoints[4]!.cumulativeTarget).toBeCloseTo(5000 * 25, 6); // full month total = EME
    });

    it("sums recorded sales cumulatively from the 1st through each past/current checkpoint's end date", () => {
      expect(checkpoints[0]!.recordedAmount).toBe(15000); // 04-01 + 04-07
      expect(checkpoints[1]!.recordedAmount).toBe(25000); // + 04-10 + 04-14
    });

    it("computes variance as recordedAmount - cumulativeTarget and classifies it against the shared pace tolerance", () => {
      const first = checkpoints[0]!;
      expect(first.variance).toBe(first.recordedAmount! - first.cumulativeTarget);
      expect(first.variance).toBeLessThan(-recoveryPaceTolerance(5000));
      expect(first.status).toBe("behind");
    });

    it("marks every checkpoint after today as pending, with null recordedAmount/variance and no future sales leaking in", () => {
      const future = checkpoints.slice(2); // 04-21, 04-28, 04-30 — all after today (04-20)
      for (const c of future) {
        expect(c.recordedAmount).toBeNull();
        expect(c.variance).toBeNull();
        expect(c.status).toBe("pending");
      }
    });
  });

  describe("exact operating-schedule mode", () => {
    /** Builds a full April 2026 open/closed calendar, closed on Sundays. */
    function sundaysClosedCalendar(): Map<string, boolean> {
      const calendar = new Map<string, boolean>();
      for (let day = 1; day <= 30; day++) {
        const date = utc(2026, 4, day);
        const key = date.toISOString().slice(0, 10);
        calendar.set(key, utcIsoWeekday(date) !== 7);
      }
      return calendar;
    }

    it("uses the exact cumulative open-day count from the resolved calendar instead of the proportional approximation", () => {
      const calendar = sundaysClosedCalendar();
      let expectedOpenThroughDay7 = 0;
      for (let day = 1; day <= 7; day++) {
        if (utcIsoWeekday(utc(2026, 4, day)) !== 7) expectedOpenThroughDay7++;
      }

      const checkpoints = deriveRecoveryCheckpoints({
        today,
        dailyNeededTarget: 5000,
        operatingDays: 25, // ignored when exactCalendar is supplied
        exactCalendar: calendar,
        salesByDay: new Map(),
      });

      expect(checkpoints[0]!.cumulativeTarget).toBeCloseTo(5000 * expectedOpenThroughDay7, 6);
      // Coincidentally both land on 6 for this particular week — the
      // meaningful assertion is above (the exact per-date calendar count is
      // what's used), not that it must differ numerically from the
      // approximation in every case.
    });

    it("a closure landing inside a checkpoint's range reduces that checkpoint's cumulative target versus the same calendar without the override", () => {
      const withoutClosure = sundaysClosedCalendar();
      const withClosure = sundaysClosedCalendar();
      // April 9, 2026 is a Thursday (open by the weekly schedule) — close it
      // via what a date override would produce: an entry set to `false`.
      withClosure.set("2026-04-09", false);

      const [checkpointWithout] = deriveRecoveryCheckpoints({
        today,
        dailyNeededTarget: 5000,
        operatingDays: 25,
        exactCalendar: withoutClosure,
        salesByDay: new Map(),
      }).slice(1, 2); // 04-14 checkpoint, which contains 04-09
      const [checkpointWith] = deriveRecoveryCheckpoints({
        today,
        dailyNeededTarget: 5000,
        operatingDays: 25,
        exactCalendar: withClosure,
        salesByDay: new Map(),
      }).slice(1, 2);

      expect(checkpointWith!.cumulativeTarget).toBe(checkpointWithout!.cumulativeTarget - 5000);
    });
  });

  describe("short month (February, non-leap)", () => {
    it("produces exactly 4 checkpoints — 7, 14, 21, 28 — with no extra final-day checkpoint", () => {
      const febToday = utc(2026, 2, 28);
      const checkpoints = deriveRecoveryCheckpoints({
        today: febToday,
        dailyNeededTarget: 5000,
        operatingDays: 25,
        salesByDay: new Map(),
      });
      expect(checkpoints.map((c) => c.endDate)).toEqual(["2026-02-07", "2026-02-14", "2026-02-21", "2026-02-28"]);
    });
  });
});
