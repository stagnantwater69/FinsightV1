import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { getDashboardSummary } from "../../src/services/dashboard.service";
import { disconnectDb, makeOwnerWithProfile, makeProfile, resetDb } from "../setup/testDb";

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  owner = await makeOwnerWithProfile({ timezone: "Asia/Manila" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T16:30:00.000Z"));
});

afterEach(() => vi.useRealTimers());
afterAll(disconnectDb);

async function addSale(date: string, amount: number, businessProfileId = owner.profile.id) {
  await prisma.salesReferenceRecord.create({
    data: { businessProfileId, date: new Date(`${date}T00:00:00.000Z`), description: "Daily sales", amount, source: "MANUAL_ENTRY" },
  });
}

async function addExpense(date: string, amount: number) {
  await prisma.expenseRecord.create({
    data: {
      businessProfileId: owner.profile.id,
      categoryId: owner.categories.Inventory!,
      date: new Date(`${date}T00:00:00.000Z`),
      description: "Inventory purchase",
      amount,
      source: "MANUAL_ENTRY",
    },
  });
}

describe("dashboard period comparisons", () => {
  it("compares month-to-date through the business's day and excludes later dates from both windows", async () => {
    await addSale("2026-08-01", 200);
    await addSale("2026-08-17", 800);
    await addSale("2026-08-18", 50_000);
    await addSale("2026-09-17", 1_500);
    await addSale("2026-09-18", 90_000);
    await addExpense("2026-08-17", 500);
    await addExpense("2026-08-18", 30_000);
    await addExpense("2026-09-17", 300);
    await addExpense("2026-09-18", 20_000);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "month", month: "2026-09" });

    expect(summary.overview).toMatchObject({ totalSalesReference: 1_500, totalExpenses: 300 });
    expect(summary.periodComparison).toEqual({
      previousStart: "2026-08-01",
      previousEnd: "2026-08-17",
      sales: { previous: 1_000, changeAmount: 500, changePercent: 50 },
      expenses: { previous: 500, changeAmount: -200, changePercent: -40 },
      net: { previous: 500, changeAmount: 700, changePercent: 140 },
    });
  });

  it("compares a Thursday week-to-date with Monday through Thursday of the previous week", async () => {
    await addSale("2026-09-06", 30_000);
    await addSale("2026-09-07", 300);
    await addSale("2026-09-10", 500);
    await addSale("2026-09-11", 50_000);
    await addSale("2026-09-14", 400);
    await addSale("2026-09-17", 800);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "week" });

    expect(summary.overview.totalSalesReference).toBe(1_200);
    expect(summary.periodComparison).toMatchObject({
      previousStart: "2026-09-07",
      previousEnd: "2026-09-10",
      sales: { previous: 800, changeAmount: 400, changePercent: 50 },
    });
  });

  it("compares a finished month with the entire previous calendar month", async () => {
    await addSale("2026-07-01", 500);
    await addSale("2026-07-31", 500);
    await addSale("2026-08-31", 1_200);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "month", month: "2026-08" });

    expect(summary.periodComparison).toMatchObject({
      previousStart: "2026-07-01",
      previousEnd: "2026-07-31",
      sales: { previous: 1_000, changeAmount: 200, changePercent: 20 },
    });
  });

  it.each([
    { kind: "all" as const },
    { kind: "month" as const, month: "2026-10" },
  ])("has no comparison for $kind without an elapsed comparable period", async (selection) => {
    await addSale("2026-09-01", 1_000);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, selection);

    expect(summary.periodComparison).toBeNull();
  });

  it("uses amount changes without a percentage when the previous period has zero sales or expenses", async () => {
    await addSale("2026-09-17", 1_000);
    await addExpense("2026-09-17", 400);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "month", month: "2026-09" });

    expect(summary.periodComparison).toMatchObject({
      sales: { previous: 0, changeAmount: 1_000, changePercent: null },
      expenses: { previous: 0, changeAmount: 400, changePercent: null },
      net: { previous: 0, changeAmount: 600, changePercent: null },
    });
  });

  it("keeps a negative previous net as an amount comparison instead of reversing its percentage", async () => {
    await addSale("2026-08-17", 500);
    await addExpense("2026-08-17", 1_000);
    await addSale("2026-09-17", 700);
    await addExpense("2026-09-17", 900);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "month", month: "2026-09" });

    expect(summary.periodComparison?.net).toEqual({ previous: -500, changeAmount: 300, changePercent: null });
  });

  it("scopes comparisons to the selected owned business and refuses another owner's business", async () => {
    const sibling = await makeProfile(owner.user.id, { name: "Other branch" });
    const otherOwner = await makeOwnerWithProfile();
    await addSale("2026-08-17", 500);
    await addSale("2026-09-17", 1_000);
    await addSale("2026-08-17", 70_000, sibling.id);
    await addSale("2026-08-17", 90_000, otherOwner.profile.id);

    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "month", month: "2026-09" });

    expect(summary.periodComparison?.sales).toEqual({ previous: 500, changeAmount: 500, changePercent: 100 });
    await expect(getDashboardSummary(owner.user.id, otherOwner.profile.id, { kind: "week" })).rejects.toMatchObject({ status: 404 });
  });
});
