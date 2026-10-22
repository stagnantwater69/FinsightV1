import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { getDashboardSummary } from "../../src/services/dashboard.service";
import { getExpenseBehavior, simulateSpendingImpact } from "../../src/services/insights.service";
import { getReductionOpportunities } from "../../src/services/reductionOpportunity.service";
import { listRecordMonths } from "../../src/services/recordMonths.service";
import { resolveBusinessToday, utcAddDays, utcDateKey, utcIsoWeekday } from "../../src/lib/dates";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

const AUTH = ["Authorization", "Bearer valid-token"] as const;

let ctx: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  ctx = await makeOwnerWithProfile({}, ["Inventory", "Utilities"]);
  authUserId.value = ctx.user.authId;
});

afterAll(disconnectDb);

async function expense(owner: typeof ctx, date: string, amount: number, category = "Inventory") {
  await prisma.expenseRecord.create({
    data: {
      businessProfileId: owner.profile.id,
      categoryId: owner.categories[category]!,
      date: new Date(`${date}T00:00:00.000Z`),
      description: `Expense ${date}`,
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

async function sale(owner: typeof ctx, date: string, amount: number) {
  await prisma.salesReferenceRecord.create({
    data: {
      businessProfileId: owner.profile.id,
      date: new Date(`${date}T00:00:00.000Z`),
      description: `Sale ${date}`,
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

describe("months with records", () => {
  it("lists only months that hold an expense or a sale, newest first, across years", async () => {
    await expense(ctx, "2025-12-15", 100);
    await expense(ctx, "2026-03-02", 200);
    await expense(ctx, "2026-03-28", 50);
    await expense(ctx, "2026-09-10", 300);
    await sale(ctx, "2026-08-01", 900);
    await sale(ctx, "2026-09-11", 400);

    expect(await listRecordMonths(ctx.user.id, ctx.profile.id)).toEqual(["2026-09", "2026-08", "2026-03", "2025-12"]);
  });

  /*
   * The query walks month to month through the date index rather than reading
   * every record. This pins it to the plain grouped query it replaced, over a
   * ledger with multi-month gaps, sales-only and expense-only months, the
   * first and last day of months, records dated after today, and a
   * neighbouring business's records in months this one does not have.
   */
  it("finds exactly the months a full grouped pass finds", async () => {
    const today = resolveBusinessToday(ctx.profile.timezone);
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    const dayOffsets = [0, -1, -27, -31, -32, -95, -96, -200, -201, -420, -760, -761, -1100, 3, 45];
    for (const [i, offset] of dayOffsets.entries()) {
      const date = utcDateKey(utcAddDays(today, offset));
      if (i % 3 === 0) await sale(ctx, date, 100 + i);
      else await expense(ctx, date, 100 + i);
    }
    // Dated after today on both sides, so neither table may put a future month in.
    await sale(ctx, utcDateKey(utcAddDays(today, 70)), 10);
    // Month boundaries in a year with no other records.
    await expense(ctx, utcDateKey(utcAddDays(today, -1500)).slice(0, 8) + "01", 10);
    await sale(ctx, utcDateKey(utcAddDays(today, -1600)).slice(0, 8) + "28", 10);
    for (const offset of [-60, -300, -900]) await expense(other, utcDateKey(utcAddDays(today, offset)), 10);

    const todayKey = utcDateKey(today);
    const reference = await prisma.$queryRaw<{ month: string }[]>`
      SELECT to_char("ExpenseRecord_Date", 'YYYY-MM') AS month FROM "ExpenseRecord"
      WHERE "BusinessProfile_ID" = ${ctx.profile.id} AND "ExpenseRecord_Date" <= ${todayKey}::date
      UNION
      SELECT to_char("SalesReferenceRecord_Date", 'YYYY-MM') AS month FROM "SalesReferenceRecord"
      WHERE "BusinessProfile_ID" = ${ctx.profile.id} AND "SalesReferenceRecord_Date" <= ${todayKey}::date
      ORDER BY month DESC`;

    const months = await listRecordMonths(ctx.user.id, ctx.profile.id);
    expect(months.length).toBeGreaterThan(8);
    expect(months).toEqual(reference.map((row) => row.month));
  });

  it("is empty for a business with no records", async () => {
    expect(await listRecordMonths(ctx.user.id, ctx.profile.id)).toEqual([]);
  });

  it("never includes another owner's months, and refuses another owner's business", async () => {
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    await expense(other, "2024-01-05", 100);
    await sale(other, "2024-02-05", 100);
    await expense(ctx, "2026-09-10", 300);

    expect(await listRecordMonths(ctx.user.id, ctx.profile.id)).toEqual(["2026-09"]);
    await expect(listRecordMonths(ctx.user.id, other.profile.id)).rejects.toMatchObject({ status: 404 });
  });

  it("serves the list over HTTP and answers 404 for a business the caller does not own", async () => {
    const other = await makeOwnerWithProfile({}, ["Inventory"]);
    await expense(ctx, "2026-07-04", 120);

    const mine = await request(app).get("/api/v1/records/months").set(...AUTH).query({ businessProfileId: ctx.profile.id });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ months: ["2026-07"] });

    const theirs = await request(app).get("/api/v1/records/months").set(...AUTH).query({ businessProfileId: other.profile.id });
    expect(theirs.status).toBe(404);

    const unauthenticated = await request(app).get("/api/v1/records/months").query({ businessProfileId: ctx.profile.id });
    expect(unauthenticated.status).toBe(401);
  });
});

describe("period-scoped figures", () => {
  beforeEach(async () => {
    await expense(ctx, "2026-07-31", 1_000);
    await expense(ctx, "2026-08-01", 200);
    await expense(ctx, "2026-08-31", 300, "Utilities");
    await expense(ctx, "2026-09-01", 4_000);
    await sale(ctx, "2026-08-15", 5_000);
    await sale(ctx, "2025-08-15", 7_000);
  });

  it("totals a calendar month from its first day to its last, and nothing either side", async () => {
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "month", month: "2026-08" });
    expect(summary.overview.totalExpenses).toBe(500);
    expect(summary.overview.totalSalesReference).toBe(5_000);
    expect(summary.period).toMatchObject({ kind: "month", month: "2026-08", start: "2026-08-01", end: "2026-08-31" });
    expect(summary.expenseCategoryBreakdown.map((row) => row.categoryName).sort()).toEqual(["Inventory", "Utilities"]);
  });

  it("keeps the same month of different years apart", async () => {
    const lastYear = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "month", month: "2025-08" });
    expect(lastYear.overview.totalSalesReference).toBe(7_000);
    expect(lastYear.overview.totalExpenses).toBe(0);
  });

  it("reads everything for all time", async () => {
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "all" });
    expect(summary.overview.totalExpenses).toBe(5_500);
    expect(summary.overview.totalSalesReference).toBe(12_000);
    expect(summary.period.kind).toBe("all");
  });

  it("returns zero, not an error, for a month with no records", async () => {
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "month", month: "2026-05" });
    expect(summary.overview.totalExpenses).toBe(0);
    expect(summary.lifetime.recordCount).toBe(6);
  });

  it("compares a month in Expense Insights with the calendar month before it", async () => {
    const behavior = await getExpenseBehavior(ctx.user.id, ctx.profile.id, { kind: "month", month: "2026-08" });
    expect(behavior.totals).toEqual({ current: 500, previous: 1_000 });
    expect(behavior.dailyBucket).toBe("day");
    expect(behavior.dailyTotals).toHaveLength(31);
    expect(behavior.dailyTotals[0]).toMatchObject({ date: "2026-08-01", total: 200 });
  });

  it("buckets all time by month and has nothing to compare against", async () => {
    const behavior = await getExpenseBehavior(ctx.user.id, ctx.profile.id, { kind: "all" });
    expect(behavior.totals).toEqual({ current: 5_500, previous: 0 });
    expect(behavior.dailyBucket).toBe("month");
    expect(behavior.dailyTotals.map((point) => point.date)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(behavior.previousPeriodStart).toBeNull();
  });

  it("uses the selected month as Spending Impact's recent spending", async () => {
    const impact = await simulateSpendingImpact(ctx.user.id, ctx.profile.id, 100, { kind: "month", month: "2026-08" });
    expect(impact.periodExpenses).toEqual({ before: 500, after: 600 });
  });

  it("offers no reduction opportunities for all time, and says why", async () => {
    const response = await getReductionOpportunities(ctx.user.id, ctx.profile.id, { kind: "all" });
    expect(response.opportunities).toEqual([]);
    expect(response.dataQuality.message).toMatch(/week or a month/);
  });
});

describe("this week", () => {
  it("covers Monday to Sunday of the business's week", async () => {
    const today = resolveBusinessToday(ctx.profile.timezone);
    const monday = utcAddDays(today, -(utcIsoWeekday(today) - 1));
    await expense(ctx, utcDateKey(monday), 250);
    await expense(ctx, utcDateKey(utcAddDays(monday, -1)), 999); // last Sunday
    const summary = await getDashboardSummary(ctx.user.id, ctx.profile.id, { kind: "week" });
    expect(summary.overview.totalExpenses).toBe(250);
    expect(summary.period.start).toBe(utcDateKey(monday));
  });
});

describe("the period query over HTTP", () => {
  it("accepts period=month on the dashboard and rejects a month without a key", async () => {
    await expense(ctx, "2026-08-10", 300);
    const ok = await request(app)
      .get("/api/v1/dashboard/summary")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, period: "month", month: "2026-08" });
    expect(ok.status).toBe(200);
    expect(ok.body.overview.totalExpenses).toBe(300);

    const missing = await request(app)
      .get("/api/v1/dashboard/summary")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, period: "month" });
    expect(missing.status).toBe(400);

    const malformed = await request(app)
      .get("/api/v1/insights/expense-behavior")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, period: "month", month: "2026-13" });
    expect(malformed.status).toBe(400);
  });

  it("still answers the legacy periodDays query the mobile client sends", async () => {
    const response = await request(app)
      .get("/api/v1/dashboard/summary")
      .set(...AUTH)
      .query({ businessProfileId: ctx.profile.id, periodDays: 0 });
    expect(response.status).toBe(200);
    expect(response.body.periodDays).toBe(0);
    expect(response.body.period.kind).toBe("all");
  });
});
