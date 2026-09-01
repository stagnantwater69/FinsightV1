import { describe, expect, it } from "vitest";
import {
  decideBehindThreeDaysTrigger,
  decideCoverageReachedTrigger,
  decideOpenDayNoSalesTrigger,
  decideProjectionShortfallTrigger,
  decideTargetIncreaseTrigger,
  isWithinNotificationCooldown,
  isWithinQuietHours,
} from "../../src/services/analysis.service";

// Plan §10.8 / §11 Phase 6 — pure decision logic only. Orchestration
// (loading preferences/state, resolving quiet hours/"now" in the business's
// timezone, and writing durable state + notifications) is covered against a
// real database in tests/integration/recoveryNotifications.test.ts.

describe("isWithinNotificationCooldown", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  it("is false when the trigger has never fired", () => {
    expect(isWithinNotificationCooldown({ lastFiredAt: null, now, minHoursBetweenNotifications: 24 })).toBe(false);
  });

  it("is true within the cooldown window", () => {
    const lastFiredAt = new Date("2026-08-30T00:00:00Z"); // 12 hours ago
    expect(isWithinNotificationCooldown({ lastFiredAt, now, minHoursBetweenNotifications: 24 })).toBe(true);
  });

  it("is false once the cooldown window has elapsed", () => {
    const lastFiredAt = new Date("2026-08-29T11:59:59Z"); // just over 24 hours ago
    expect(isWithinNotificationCooldown({ lastFiredAt, now, minHoursBetweenNotifications: 24 })).toBe(false);
  });
});

describe("isWithinQuietHours", () => {
  it("is false when quiet hours are unset", () => {
    expect(isWithinQuietHours({ localMinuteOfDay: 60, quietHoursStartMinute: null, quietHoursEndMinute: null })).toBe(false);
  });

  it("handles a same-day window (e.g. 13:00-15:00)", () => {
    const start = 13 * 60;
    const end = 15 * 60;
    expect(isWithinQuietHours({ localMinuteOfDay: 14 * 60, quietHoursStartMinute: start, quietHoursEndMinute: end })).toBe(true);
    expect(isWithinQuietHours({ localMinuteOfDay: 12 * 60, quietHoursStartMinute: start, quietHoursEndMinute: end })).toBe(false);
    expect(isWithinQuietHours({ localMinuteOfDay: 15 * 60, quietHoursStartMinute: start, quietHoursEndMinute: end })).toBe(false);
  });

  it("handles an overnight window (e.g. 22:00-06:00)", () => {
    const start = 22 * 60;
    const end = 6 * 60;
    expect(isWithinQuietHours({ localMinuteOfDay: 23 * 60, quietHoursStartMinute: start, quietHoursEndMinute: end })).toBe(true);
    expect(isWithinQuietHours({ localMinuteOfDay: 1 * 60, quietHoursStartMinute: start, quietHoursEndMinute: end })).toBe(true);
    expect(isWithinQuietHours({ localMinuteOfDay: 12 * 60, quietHoursStartMinute: start, quietHoursEndMinute: end })).toBe(false);
  });

  it("treats a zero-width window as disabled", () => {
    expect(isWithinQuietHours({ localMinuteOfDay: 500, quietHoursStartMinute: 480, quietHoursEndMinute: 480 })).toBe(false);
  });
});

describe("decideTargetIncreaseTrigger", () => {
  it("does not fire on the very first-ever evaluation, and records the baseline", () => {
    const result = decideTargetIncreaseTrigger({ adjustedDailyTarget: 5000, lastFiredValue: null, thresholdPercent: 15 });
    expect(result.fire).toBe(false);
    expect(result.nextLastFiredValue).toBe(5000);
  });

  it("does not fire below the configured percentage increase", () => {
    // 5,000 -> 5,600 is a 12% increase, under a 15% threshold.
    const result = decideTargetIncreaseTrigger({ adjustedDailyTarget: 5600, lastFiredValue: 5000, thresholdPercent: 15 });
    expect(result.fire).toBe(false);
    expect(result.nextLastFiredValue).toBe(5000); // baseline unchanged
  });

  it("fires once the increase clears the configured percentage, and rebases", () => {
    // 5,000 -> 6,000 is a 20% increase.
    const result = decideTargetIncreaseTrigger({ adjustedDailyTarget: 6000, lastFiredValue: 5000, thresholdPercent: 15 });
    expect(result.fire).toBe(true);
    expect(result.nextLastFiredValue).toBe(6000);
  });

  it("does not fire and re-baselines when the previous baseline was non-positive", () => {
    const result = decideTargetIncreaseTrigger({ adjustedDailyTarget: 4000, lastFiredValue: 0, thresholdPercent: 15 });
    expect(result.fire).toBe(false);
    expect(result.nextLastFiredValue).toBe(4000);
  });

  it("does not fire on a decrease", () => {
    const result = decideTargetIncreaseTrigger({ adjustedDailyTarget: 4000, lastFiredValue: 5000, thresholdPercent: 15 });
    expect(result.fire).toBe(false);
    expect(result.nextLastFiredValue).toBe(5000);
  });
});

describe("decideBehindThreeDaysTrigger", () => {
  it("fires when behind and the last three completed operating days are all below", () => {
    expect(
      decideBehindThreeDaysTrigger({ monthStatus: "behind", lastThreeCompletedOperatingDayStatuses: ["below", "below", "below"] })
    ).toBe(true);
  });

  it("does not fire when the month status is not behind, even with three below days", () => {
    expect(
      decideBehindThreeDaysTrigger({ monthStatus: "on_pace", lastThreeCompletedOperatingDayStatuses: ["below", "below", "below"] })
    ).toBe(false);
  });

  it("does not fire when fewer than three completed operating days are available", () => {
    expect(decideBehindThreeDaysTrigger({ monthStatus: "behind", lastThreeCompletedOperatingDayStatuses: ["below", "below"] })).toBe(false);
  });

  it("does not fire when one of the three days was not below", () => {
    expect(
      decideBehindThreeDaysTrigger({ monthStatus: "behind", lastThreeCompletedOperatingDayStatuses: ["below", "at", "below"] })
    ).toBe(false);
  });
});

describe("decideOpenDayNoSalesTrigger / decideProjectionShortfallTrigger", () => {
  it("OPEN_DAY_NO_SALES never fires — no operating-hours capability exists", () => {
    expect(decideOpenDayNoSalesTrigger()).toBe(false);
  });

  it("PROJECTION_SHORTFALL never fires — the projection is not approved for display", () => {
    expect(decideProjectionShortfallTrigger()).toBe(false);
  });
});

describe("decideCoverageReachedTrigger", () => {
  it("does not fire when not covered", () => {
    expect(
      decideCoverageReachedTrigger({ monthStatus: "on_pace", lastFiredAt: null, currentMonthKey: "2026-08", lastFiredMonthKey: null })
    ).toBe(false);
  });

  it("fires the first time covered is reached", () => {
    expect(
      decideCoverageReachedTrigger({ monthStatus: "covered", lastFiredAt: null, currentMonthKey: "2026-08", lastFiredMonthKey: null })
    ).toBe(true);
  });

  it("does not re-fire again within the same month", () => {
    const lastFiredAt = new Date("2026-08-15T00:00:00Z");
    expect(
      decideCoverageReachedTrigger({ monthStatus: "covered", lastFiredAt, currentMonthKey: "2026-08", lastFiredMonthKey: "2026-08" })
    ).toBe(false);
  });

  it("fires again in a new month", () => {
    const lastFiredAt = new Date("2026-08-15T00:00:00Z");
    expect(
      decideCoverageReachedTrigger({ monthStatus: "covered", lastFiredAt, currentMonthKey: "2026-09", lastFiredMonthKey: "2026-08" })
    ).toBe(true);
  });
});
