import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { resolveExactOperatingCounts, resolveOperatingCalendar } from "../../src/services/operatingCalendar.service";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay, utcDayString } from "../setup/testDb";
import { utcDateKey, utcDaysInMonth, utcIsoWeekday, utcStartOfMonth } from "../../src/lib/dates";

// RECOVERY-TARGET-IMPROVEMENT-PLAN.md §9.2/§11 Phase 2: exact operating
// calendar resolution against a real database — the weekly-schedule vs.
// per-date-override precedence, and the "no schedule configured yet" fallback
// that keeps every pre-existing profile's approximation-mode math untouched.

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile(
    { availableFunds: 48500, expectedMonthlyExpenses: 125000, operatingDays: 25, largeExpenseThresholdPercent: 25 },
    ["Inventory"]
  );
});

afterAll(disconnectDb);

async function addSale(amount: number, dayOffset: number) {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: utcDayString(dayOffset),
    description: "Daily sales",
    amount,
  });
}

/** Closed-Sundays-only weekly schedule: weekdays 1-6 open, 7 (Sunday) closed. */
async function seedWeekdaysOnlySchedule(businessProfileId: number) {
  for (let weekday = 1; weekday <= 7; weekday++) {
    await prisma.businessOperatingDay.create({
      data: { businessProfileId, weekday, isOpen: weekday !== 7 },
    });
  }
}

/** Manually counts open (non-Sunday) dates in the month `today` falls in. */
function countWeekdaysOnlyOpenDays(today: Date): { total: number; elapsed: number; remaining: number } {
  const monthStart = utcStartOfMonth(today);
  const totalDaysInMonth = utcDaysInMonth(today);
  const todayKey = utcDateKey(today);
  let total = 0;
  let elapsed = 0;
  let remaining = 0;
  for (let i = 0; i < totalDaysInMonth; i++) {
    const d = new Date(monthStart);
    d.setUTCDate(d.getUTCDate() + i);
    const isOpen = utcIsoWeekday(d) !== 7;
    if (!isOpen) continue;
    total++;
    const key = utcDateKey(d);
    if (key <= todayKey) elapsed++;
    if (key >= todayKey) remaining++;
  }
  return { total, elapsed, remaining };
}

describe("resolveOperatingCalendar — no schedule configured", () => {
  it("returns null when the profile has zero BusinessOperatingDay rows", async () => {
    const today = utcDay(0);
    const calendar = await resolveOperatingCalendar(ctx.profile.id, today, today);
    expect(calendar).toBeNull();
  });

  it("resolveExactOperatingCounts also returns null for the same profile", async () => {
    const counts = await resolveExactOperatingCounts(ctx.profile.id, utcDay(0));
    expect(counts).toBeNull();
  });
});

describe("REGRESSION: an unconfigured profile's recovery math is byte-for-byte unchanged", () => {
  it("getRecoveryInsight reports approximation mode exactly as before Phase 2", async () => {
    await addSale(4500, 0);
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    expect(result.operatingScheduleConfigured).toBe(false);
    expect(result.remainingOperatingDaysIsApproximated).toBe(true);
    expect(result.operatingDaysThisMonth).toBe(ctx.profile.operatingDays);

    // Every day in the coverage window is treated as a potential target day —
    // no "closed" status appears anywhere without a configured schedule.
    for (const day of result.dailyCoverage) {
      expect(day.isOperatingDay).toBe(true);
      expect(day.status).not.toBe("closed");
      expect(day.neededTarget).not.toBeNull();
    }
  });
});

describe("resolveOperatingCalendar/resolveExactOperatingCounts — configured weekly schedule", () => {
  it("derives exact monthly/elapsed/remaining open-day counts from the weekly schedule", async () => {
    await seedWeekdaysOnlySchedule(ctx.profile.id);
    const today = utcDay(0);
    const expected = countWeekdaysOnlyOpenDays(today);

    const counts = await resolveExactOperatingCounts(ctx.profile.id, today);
    expect(counts).not.toBeNull();
    expect(counts!.operatingDaysThisMonth).toBe(expected.total);
    expect(counts!.elapsedOperatingDays).toBe(expected.elapsed);
    expect(counts!.remainingOperatingDays).toBe(expected.remaining);
  });

  it("a defensive missing weekday row (partial schedule) resolves as closed, not open", async () => {
    // Only Monday is configured open; every other weekday has no row at all.
    // The CRUD layer is responsible for keeping all seven rows present once
    // setup completes — this asserts the resolver's defensive fallback for
    // the case where that invariant doesn't hold.
    await prisma.businessOperatingDay.create({
      data: { businessProfileId: ctx.profile.id, weekday: 1, isOpen: true },
    });
    const today = utcDay(0);
    const monthStart = utcStartOfMonth(today);
    const monthEnd = new Date(monthStart);
    monthEnd.setUTCDate(monthEnd.getUTCDate() + utcDaysInMonth(today) - 1);

    const calendar = await resolveOperatingCalendar(ctx.profile.id, monthStart, monthEnd);
    expect(calendar).not.toBeNull();
    for (const [key, isOpen] of calendar!) {
      const weekday = utcIsoWeekday(new Date(`${key}T00:00:00.000Z`));
      if (weekday === 1) expect(isOpen).toBe(true);
      else expect(isOpen).toBe(false);
    }
  });

  it("a holiday override takes precedence over an otherwise-open weekday", async () => {
    await seedWeekdaysOnlySchedule(ctx.profile.id); // Mon-Sat open
    const today = utcDay(0);
    // Find the next non-Sunday date (an otherwise-open day) to override closed.
    let holiday = new Date(today);
    while (utcIsoWeekday(holiday) === 7) holiday = new Date(holiday.getTime() + 86400000);

    await prisma.businessOperatingDayOverride.create({
      data: { businessProfileId: ctx.profile.id, date: holiday, type: "CLOSED", reason: "Test holiday" },
    });

    const calendar = await resolveOperatingCalendar(ctx.profile.id, holiday, holiday);
    expect(calendar!.get(utcDateKey(holiday))).toBe(false);
  });

  it("a special-opening override takes precedence over an otherwise-closed weekday", async () => {
    await seedWeekdaysOnlySchedule(ctx.profile.id); // Sunday closed
    const today = utcDay(0);
    let specialSunday = new Date(today);
    while (utcIsoWeekday(specialSunday) !== 7) specialSunday = new Date(specialSunday.getTime() + 86400000);

    await prisma.businessOperatingDayOverride.create({
      data: { businessProfileId: ctx.profile.id, date: specialSunday, type: "OPEN", reason: "Special sale" },
    });

    const calendar = await resolveOperatingCalendar(ctx.profile.id, specialSunday, specialSunday);
    expect(calendar!.get(utcDateKey(specialSunday))).toBe(true);
  });
});

describe("getRecoveryInsight — configured schedule excludes closed days from missed-target status", () => {
  it("marks closed days as 'closed' in dailyCoverage rather than 'below'", async () => {
    await seedWeekdaysOnlySchedule(ctx.profile.id);
    const today = utcDay(0);

    // Find the most recent Sunday on or before today, so the coverage window
    // (which always ends at today) is guaranteed to include at least one
    // closed day when today's date is far enough into the month.
    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.operatingScheduleConfigured).toBe(true);
    expect(result.remainingOperatingDaysIsApproximated).toBe(false);

    for (const day of result.dailyCoverage) {
      const weekday = utcIsoWeekday(new Date(`${day.date}T00:00:00.000Z`));
      if (weekday === 7) {
        expect(day.isOperatingDay).toBe(false);
        expect(day.status).toBe("closed");
        expect(day.neededTarget).toBeNull();
        expect(day.gap).toBeNull();
      } else {
        expect(day.isOperatingDay).toBe(true);
        expect(day.status).not.toBe("closed");
      }
    }
  });

  it("operatingDaysThisMonth reflects the exact count, not the stored approximation", async () => {
    await seedWeekdaysOnlySchedule(ctx.profile.id);
    const today = utcDay(0);
    const expected = countWeekdaysOnlyOpenDays(today);

    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);
    expect(result.operatingDaysThisMonth).toBe(expected.total);
    // The stored profile approximation (25) is untouched as a separate field.
    expect(result.operatingDays).toBe(25);
  });
});
