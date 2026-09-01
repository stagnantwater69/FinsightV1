import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sales from "../../src/services/salesRecord.service";
import * as insights from "../../src/services/insights.service";
import { prisma } from "../../src/config/prisma";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";
import { NOTIFICATION_TYPES } from "../../src/services/notification.service";

/**
 * End-to-end coverage for Recovery Target notifications
 * (docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §10.8 / §11 Phase 6), wired into
 * `getRecoveryInsight` — every call exercised here goes through the real
 * insight read path, exactly as the Recovery Target screen and Dashboard do.
 *
 * Pure trigger-decision-function coverage (fire/no-fire given inputs, in
 * isolation) lives in tests/unit/recoveryNotificationTriggers.test.ts. This
 * file proves the DURABLE wiring: a real `Notification` row and a real
 * `RecoveryNotificationTriggerState` row are written, cooldown/quiet-hours/
 * opt-out actually suppress firing end to end, and the two permanently-inert
 * triggers never produce a notification no matter what state is seeded.
 */

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

afterEach(() => {
  vi.useRealTimers();
});
afterAll(disconnectDb);

async function addSaleOn(dateKey: string, amount: number, description = "Sale") {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date: dateKey,
    description,
    amount,
  });
}

function notificationsFor(businessProfileId: number, type: string) {
  return prisma.notification.findMany({ where: { businessProfileId, type } });
}

function triggerState(businessProfileId: number, trigger: string) {
  return prisma.recoveryNotificationTriggerState.findUnique({
    where: { businessProfileId_trigger: { businessProfileId, trigger: trigger as never } },
  });
}

describe("TARGET_INCREASE", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 100000, operatingDays: 25, timezone: "Asia/Manila" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T02:00:00.000Z")); // ~10am Manila
  });

  it("does not fire on the very first evaluation, and records a baseline", async () => {
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(0);

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    expect(state).not.toBeNull();
    expect(state!.lastFiredAt).toBeNull();
    expect(state!.lastEvaluatedAt).not.toBeNull();
    expect(Number(state!.lastFiredValue)).toBeGreaterThan(0);
  });

  it("fires once the adjusted daily target increases beyond the default 15% threshold, and updates durable state", async () => {
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // sets baseline

    // Raise the baseline (~100000/25=4000/day) well past a 15% increase.
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } });

    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1);
    // §14: no peso amount in the message.
    expect(notifications[0]!.message).not.toMatch(/PHP|₱|\d/);

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    expect(state!.lastFiredAt).not.toBeNull();
  });

  it("does not re-fire within the cooldown window even if the condition is met again", async () => {
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // baseline
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } });
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // fires (1st)

    // Push it up again a couple hours later — well within the default 24h cooldown.
    vi.setSystemTime(new Date("2026-08-05T04:00:00.000Z"));
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 400000 } });
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1); // still just the one from before

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    // Baseline was left unchanged by the suppressed firing (see the doc
    // comment on evaluateTargetIncrease) — advancing the cooldown clock is
    // still proven by lastEvaluatedAt moving forward below.
    expect(state!.lastEvaluatedAt!.getTime()).toBeGreaterThan(state!.lastFiredAt!.getTime());
  });

  it("does not fire when quiet hours cover the current business-local time, but still advances lastEvaluatedAt", async () => {
    // Preference quiet-hours columns are stored as plain LOCAL wall-clock
    // values (see recoveryNotificationPreference.service.ts's
    // timeStringToDate) — 08:00-12:00 local, no further UTC conversion.
    await prisma.recoveryNotificationPreference.create({
      data: {
        businessProfileId: ctx.profile.id,
        quietHoursStart: new Date("1970-01-01T08:00:00.000Z"),
        quietHoursEnd: new Date("1970-01-01T12:00:00.000Z"),
      },
    });

    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // baseline, still inside quiet hours (10am Manila)
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } });
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // would fire, but quiet hours suppress it

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(0);

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    expect(state!.lastFiredAt).toBeNull();
    expect(state!.lastEvaluatedAt).not.toBeNull();
  });

  it("does not fire when the owner has opted the trigger out", async () => {
    await prisma.recoveryNotificationPreference.create({
      data: { businessProfileId: ctx.profile.id, targetIncreaseAlertEnabled: false },
    });

    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // baseline
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } });
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(0);
  });

  // Regression test for a QA-found race condition: `evaluateRecoveryNotifications`
  // has no queue/scheduler serializing it — it runs inline on every
  // `getRecoveryInsight` call, and the Dashboard and the Recovery Target
  // screen can both call it for the same profile at effectively the same
  // moment. Before the fix (a Postgres advisory lock held for the
  // read-decide-write sequence per trigger — see
  // `withTriggerLock`/`evaluateTargetIncrease` in
  // recoveryNotification.service.ts), N concurrent calls that all observed
  // the same fire-worthy condition each independently read the
  // pre-fire `RecoveryNotificationTriggerState` row, decided "fire", and
  // wrote their own `Notification` row — producing N duplicates instead of 1.
  it("produces exactly one notification when many concurrent evaluations observe the same fire-worthy increase (race condition regression)", async () => {
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14); // establishes the baseline
    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } }); // well past the 15% threshold

    // Simulate many screens/tabs loading at the same instant, all racing to
    // be the one that reports the increase.
    await Promise.all(
      Array.from({ length: 20 }, () => insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14))
    );

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1);

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    expect(state!.lastFiredAt).not.toBeNull();
  });
});

describe("BEHIND_THREE_DAYS", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 150000, operatingDays: 30, timezone: "Asia/Manila" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T02:00:00.000Z")); // 10am Manila, Aug 5
  });

  it("fires after three consecutive completed operating days below target while the month is behind", async () => {
    await addSaleOn("2026-08-02", 100);
    await addSaleOn("2026-08-03", 100);
    await addSaleOn("2026-08-04", 100);

    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 10);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1);

    const state = await triggerState(ctx.profile.id, "BEHIND_THREE_DAYS");
    expect(state!.lastFiredAt).not.toBeNull();
  });

  it("does not fire when fewer than three completed operating days are in view", async () => {
    await addSaleOn("2026-08-04", 100);

    // coverageDays=1 means `dailyCoverage` only contains today's row, so
    // there are zero completed prior days for the trigger to inspect —
    // regardless of what the month-level status turns out to be.
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 1);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(0);

    const state = await triggerState(ctx.profile.id, "BEHIND_THREE_DAYS");
    expect(state!.lastFiredAt).toBeNull();
  });
});

describe("COVERAGE_REACHED", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 10000, operatingDays: 30, timezone: "Asia/Manila" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T02:00:00.000Z")); // 10am Manila
  });

  it("fires once coverage is reached, and does not re-fire again within the same month", async () => {
    await addSaleOn("2026-08-01", 20000); // well over the 10,000 monthly baseline

    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 10);
    expect(result.status).toBe("covered");

    let notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1);

    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 10); // reload, still covered
    notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1); // no second notification this month
  });

  it("fires again in a new month once covered again", async () => {
    await addSaleOn("2026-08-01", 20000);
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 10);

    vi.setSystemTime(new Date("2026-09-05T02:00:00.000Z"));
    await addSaleOn("2026-09-01", 20000);
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 10);

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(2);
  });

  // Race condition regression — see the TARGET_INCREASE describe block above
  // for the full explanation. Reaching coverage for the first time is the
  // scenario QA reproduced concretely (two concurrent `getRecoveryInsight`
  // calls both seeing `lastFiredAt: null` and both firing).
  it("produces exactly one notification when many concurrent evaluations all first observe coverage reached (race condition regression)", async () => {
    await addSaleOn("2026-08-01", 20000); // well over the 10,000 monthly baseline

    await Promise.all(
      Array.from({ length: 20 }, () => insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 10))
    );

    const notifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    expect(notifications).toHaveLength(1);
  });
});

describe("OPEN_DAY_NO_SALES and PROJECTION_SHORTFALL — permanently inert", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 150000, operatingDays: 30, timezone: "Asia/Manila" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T02:00:00.000Z")); // late in the month, plenty of history
  });

  it("never fire, however far behind or however much recent-sales history exists", async () => {
    for (let day = 1; day <= 19; day += 1) {
      await addSaleOn(`2026-08-${String(day).padStart(2, "0")}`, 100); // well below target every day
    }

    const result = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 20);
    expect(result.status).toBe("behind");

    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 20); // second load, same conditions persist

    const openDayState = await triggerState(ctx.profile.id, "OPEN_DAY_NO_SALES");
    const projectionState = await triggerState(ctx.profile.id, "PROJECTION_SHORTFALL");
    expect(openDayState!.lastFiredAt).toBeNull();
    expect(projectionState!.lastFiredAt).toBeNull();

    const allRecoveryNotifications = await notificationsFor(ctx.profile.id, NOTIFICATION_TYPES.RECOVERY_TARGET);
    // Only BEHIND_THREE_DAYS is expected to have fired from this scenario;
    // neither deferred trigger contributes to the count.
    expect(allRecoveryNotifications.every((n) => !/projection|operating hours|nearing completion/i.test(n.message))).toBe(true);
  });
});

/**
 * QA follow-up (lower priority than the race-condition fix above): quiet
 * hours use the same `Intl.DateTimeFormat` + IANA-timezone mechanism as
 * `resolveBusinessToday` (which already has a DST test — see
 * tests/integration/recoveryTimezone.test.ts's "America/New_York — DST-aware,
 * not a fixed UTC-5 offset" block) but had no DST-specific coverage of its
 * own. Same technique: one UTC instant, two calendar dates six months apart
 * (EDT vs EST), and an assertion that only holds if the real IANA offset for
 * THAT DATE was consulted rather than a fixed offset.
 */
describe("quiet-hours time-of-day resolution — DST-aware, not a fixed UTC offset (America/New_York)", () => {
  beforeEach(async () => {
    await resetDb();
    ctx = await makeOwnerWithProfile({ expectedMonthlyExpenses: 100000, operatingDays: 25, timezone: "America/New_York" });
    // Quiet hours 00:00-05:00 local. `resolveBusinessLocalMinuteOfDay` is
    // private, so this exercises it the same way production code does — end
    // to end, through TARGET_INCREASE's `suppressed()` check.
    await prisma.recoveryNotificationPreference.create({
      data: {
        businessProfileId: ctx.profile.id,
        quietHoursStart: new Date("1970-01-01T00:00:00.000Z"),
        quietHoursEnd: new Date("1970-01-01T05:00:00.000Z"),
      },
    });
  });

  it("in July (EDT, UTC-4): 04:30 UTC is 00:30 local — inside the window — and suppresses an otherwise-firing increase", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z")); // baseline, well outside quiet hours; never fires regardless
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } });
    // A fixed UTC-5 offset would instead compute 23:30 the PREVIOUS day —
    // outside the window — and wrongly let this fire.
    vi.setSystemTime(new Date("2026-07-15T04:30:00.000Z"));
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    expect(state!.lastFiredAt).toBeNull();
  });

  it("in January (EST, UTC-5): the same instant-shape UTC time is 23:30 the PREVIOUS local day — outside the window — and does not suppress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z")); // baseline
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    await prisma.businessProfile.update({ where: { id: ctx.profile.id }, data: { expectedMonthlyExpenses: 200000 } });
    vi.setSystemTime(new Date("2026-01-15T04:30:00.000Z"));
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 14);

    const state = await triggerState(ctx.profile.id, "TARGET_INCREASE");
    expect(state!.lastFiredAt).not.toBeNull();
  });
});
