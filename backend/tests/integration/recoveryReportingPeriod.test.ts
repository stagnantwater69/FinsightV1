import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authUserId } = vi.hoisted(() => ({ authUserId: { value: "" } }));
vi.mock("../../src/config/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/supabase")>();
  return {
    ...actual,
    supabaseAdmin: {
      auth: {
        getUser: async (token: string) =>
          token === "valid-token"
            ? { data: { user: { id: authUserId.value } }, error: null }
            : { data: { user: null }, error: new Error("bad token") },
      },
    },
  };
});

import request from "supertest";
import { app } from "../../src/app";
import { prisma } from "../../src/config/prisma";
import * as insights from "../../src/services/insights.service";
import * as sales from "../../src/services/salesRecord.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
const AUTH = ["Authorization", "Bearer valid-token"] as const;
const ENDPOINT = "/api/v1/insights/recovery";

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T04:00:00.000Z")); // 12:00 on 1 Oct in Manila
  ctx = await makeOwnerWithProfile({
    expectedMonthlyExpenses: 31_000,
    operatingDays: 31,
    timezone: "Asia/Manila",
  });
  authUserId.value = ctx.user.authId;
});

afterEach(() => vi.useRealTimers());
afterAll(disconnectDb);

async function addSale(date: string, amount: number) {
  return sales.createSalesRecord(ctx.user.id, {
    businessProfileId: ctx.profile.id,
    date,
    description: `Sales ${date}`,
    amount,
  });
}

describe("GET /insights/recovery reporting period", () => {
  it("uses the current Monday-Sunday window and prorates the monthly daily target across a month boundary", async () => {
    await addSale("2026-09-28", 1_000);
    await addSale("2026-10-01", 2_000);

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, coverageDays: 31, period: "week" });

    expect(response.status).toBe(200);
    expect(response.body.reportingPeriod).toMatchObject({
      kind: "week",
      month: null,
      start: "2026-09-28",
      end: "2026-10-04",
      asOfDate: "2026-10-01",
      isCurrent: true,
      isComplete: false,
      targetBasis: "prorated_monthly_expenses",
      sales: 3_000,
      remainingOperatingDays: 4,
      operatingDaysIsApproximated: true,
      recordCount: 2,
      status: "behind",
    });
    expect(response.body.reportingPeriod.target).toBeCloseTo(7_100);
    expect(response.body.reportingPeriod.expectedSalesToDate).toBeCloseTo(4_100);
    expect(response.body.reportingPeriod.remainingTarget).toBeCloseTo(4_100);
    expect(response.body.reportingPeriod.operatingDays).toBeCloseTo(7.1);
    expect(response.body.reportingPeriod.elapsedOperatingDays).toBeCloseTo(4.1);
    const displayedTargetToDate = response.body.dailyCoverage.reduce(
      (sum: number, row: { neededTarget: number | null }) => sum + (row.neededTarget ?? 0),
      0,
    );
    expect(displayedTargetToDate).toBeCloseTo(response.body.reportingPeriod.expectedSalesToDate);
    for (const value of Object.values(response.body.reportingPeriod)) {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    }
    expect(response.body.dailyCoverage.map((row: { date: string }) => row.date)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    // Compatibility fields stay month-to-date for older clients.
    expect(response.body.salesThisMonth).toBe(2_000);
    expect(response.body.changeSincePreviousDay).toBeNull();
    expect(response.body.weeklyCheckpoints).toEqual([]);
  });

  it("anchors a completed month at month end and returns final, period-named figures", async () => {
    await addSale("2026-08-01", 10_000);
    await addSale("2026-08-31", 8_000);

    const response = await request(app)
      .get(ENDPOINT)
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, coverageDays: 31, period: "month", month: "2026-08" });

    expect(response.status).toBe(200);
    expect(response.body.reportingPeriod).toMatchObject({
      kind: "month",
      month: "2026-08",
      start: "2026-08-01",
      end: "2026-08-31",
      asOfDate: "2026-08-31",
      isCurrent: false,
      isComplete: true,
      targetBasis: "monthly_expenses",
      target: 31_000,
      sales: 18_000,
      remainingTarget: 13_000,
      coveragePercent: (18_000 / 31_000) * 100,
      remainingOperatingDays: 0,
      adjustedDailyTarget: null,
      expectedSalesToDate: 31_000,
      paceVarianceAmount: -13_000,
      status: "behind",
      recordCount: 2,
    });
    expect(response.body.asOfDate).toBe("2026-08-31");
    expect(response.body.salesThisMonth).toBe(18_000);
    expect(response.body.dailyCoverage).toHaveLength(31);
    expect(response.body.changeSincePreviousDay).toBeNull();
    expect(response.body.weeklyCheckpoints.every((checkpoint: { status: string }) => checkpoint.status !== "pending")).toBe(true);
  });

  it("does not evaluate recovery notifications while viewing a week or historical month", async () => {
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 31, { kind: "week" });
    await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 31, { kind: "month", month: "2026-08" });

    expect(await prisma.recoveryNotificationTriggerState.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { businessProfileId: ctx.profile.id } })).toBe(0);
  });

  it("keeps a period in progress throughout its final business-local day", async () => {
    vi.setSystemTime(new Date("2026-10-04T04:00:00.000Z")); // Sunday, the final day of this ISO week
    const week = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 31, { kind: "week" });
    expect(week.reportingPeriod).toMatchObject({
      end: "2026-10-04",
      asOfDate: "2026-10-04",
      isCurrent: true,
      isComplete: false,
    });

    vi.setSystemTime(new Date("2026-10-31T04:00:00.000Z")); // final day of October in Manila
    const month = await insights.getRecoveryInsight(ctx.user.id, ctx.profile.id, 31, {
      kind: "month",
      month: "2026-10",
    });
    expect(month.reportingPeriod).toMatchObject({
      end: "2026-10-31",
      asOfDate: "2026-10-31",
      isCurrent: true,
      isComplete: false,
    });
  });

  it("rejects unsupported, incomplete, invalid, and future selections", async () => {
    const cases = [
      { period: "all" },
      { period: "month" },
      { period: "month", month: "2026-13" },
      { period: "month", month: "2026-11" },
      { period: "week", month: "2026-10" },
    ];

    for (const query of cases) {
      const response = await request(app)
        .get(ENDPOINT)
        .set(...AUTH)
        .query({ businessProfileId: ctx.profile.id, ...query });
      expect(response.status).toBe(400);
    }
  });

  it("checks profile ownership before returning selected-period data", async () => {
    const other = await makeOwnerWithProfile({ expectedMonthlyExpenses: 10_000 });

    await expect(
      insights.getRecoveryInsight(ctx.user.id, other.profile.id, 31, { kind: "week" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      insights.getRecoveryInsight(ctx.user.id, other.profile.id, 31, { kind: "month", month: "2026-08" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
