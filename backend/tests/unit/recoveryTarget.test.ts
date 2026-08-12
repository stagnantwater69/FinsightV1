import { describe, expect, it } from "vitest";
import { computeRecoveryTarget, dayStatus, daysInMonth } from "../../src/services/analysis.service";

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
