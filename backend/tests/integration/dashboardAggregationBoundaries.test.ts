import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/config/prisma";
import { getDashboardCashflow, getDashboardSummary } from "../../src/services/dashboard.service";
import { listNotifications } from "../../src/services/notification.service";
import { disconnectDb, makeOwnerWithProfile, resetDb } from "../setup/testDb";

let owner: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let other: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  owner = await makeOwnerWithProfile({ timezone: "Asia/Manila" }, ["Inventory"]);
  other = await makeOwnerWithProfile({ timezone: "Asia/Manila" }, ["Inventory"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T16:30:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(disconnectDb);

async function seed(rows: Array<{ date: string; sales?: number; expense?: number }>, context = owner) {
  const sales = rows.filter((row) => row.sales !== undefined).map((row) => ({
    businessProfileId: context.profile.id, date: new Date(`${row.date}T00:00:00Z`),
    description: "Synthetic cashflow sales", amount: row.sales!, source: "MANUAL_ENTRY" as const,
  }));
  const expenses = rows.filter((row) => row.expense !== undefined).map((row) => ({
    businessProfileId: context.profile.id, categoryId: context.categories.Inventory!,
    date: new Date(`${row.date}T00:00:00Z`), description: "Synthetic cashflow expense",
    amount: row.expense!, source: "MANUAL_ENTRY" as const,
  }));
  if (sales.length) await prisma.salesReferenceRecord.createMany({ data: sales });
  if (expenses.length) await prisma.expenseRecord.createMany({ data: expenses });
}

describe("database cashflow aggregation boundaries", () => {
  it("returns seven daily buckets with exact cents, zero fills and Manila date boundaries", async () => {
    await seed([
      { date: "2026-10-07", sales: 1.11, expense: 0.1 }, { date: "2026-10-07", expense: 0.2 },
      { date: "2026-10-13", sales: 2.22, expense: 7.01 }, { date: "2026-10-13", sales: 3.33 },
      { date: "2026-10-06", sales: 99, expense: 99 }, { date: "2026-10-14", sales: 99, expense: 99 },
    ]);
    await seed([{ date: "2026-10-13", sales: 999, expense: 999 }], other);
    expect(await getDashboardCashflow(owner.user.id, owner.profile.id, "daily")).toEqual({
      granularity: "daily", points: [
        { date: "2026-10-07", sales: 1.11, expenses: 0.3 },
        ...["08", "09", "10", "11", "12"].map((day) => ({ date: `2026-10-${day}`, sales: 0, expenses: 0 })),
        { date: "2026-10-13", sales: 5.55, expenses: 7.01 },
      ],
    });
  });

  it("returns six monthly buckets and excludes the prior boundary and tomorrow in the current month", async () => {
    await seed([
      { date: "2026-05-01", sales: 0.1, expense: 1.11 }, { date: "2026-05-31", sales: 0.2 },
      { date: "2026-10-13", sales: 7.77, expense: 2.22 },
      { date: "2026-04-30", sales: 900, expense: 900 }, { date: "2026-10-14", sales: 900, expense: 900 },
    ]);
    await seed([{ date: "2026-05-01", sales: 900, expense: 900 }], other);
    expect(await getDashboardCashflow(owner.user.id, owner.profile.id, "monthly")).toEqual({
      granularity: "monthly", points: [
        { date: "2026-05", sales: 0.3, expenses: 1.11 },
        ...["06", "07", "08", "09"].map((month) => ({ date: `2026-${month}`, sales: 0, expenses: 0 })),
        { date: "2026-10", sales: 7.77, expenses: 2.22 },
      ],
    });
  });

  it.each(["daily", "monthly"] as const)("rejects another owner's %s cashflow without leaking its existence", async (granularity) => {
    await expect(getDashboardCashflow(other.user.id, owner.profile.id, granularity)).rejects.toMatchObject({ status: 404 });
  });
});

describe("bounded dashboard notification reads", () => {
  async function notes() {
    await prisma.notification.createMany({ data: Array.from({ length: 502 }, (_, index) => ({
      userId: owner.user.id, businessProfileId: owner.profile.id, type: "Import complete", message: `Synthetic notice ${index}`,
    })) });
    await prisma.notification.create({ data: {
      userId: other.user.id, businessProfileId: other.profile.id, type: "Import complete", message: "Other business private notice",
    } });
  }

  it("keeps the list's 500 default and allows a smaller owner-scoped limit", async () => {
    await notes();
    const full = await listNotifications(owner.user.id, owner.profile.id);
    expect(full).toHaveLength(500);
    const smaller = await listNotifications(owner.user.id, owner.profile.id, 10);
    expect(smaller).toHaveLength(10);
    expect(smaller).toEqual(full.slice(0, 10));
    expect(smaller.every((notice) => notice.businessProfileId === owner.profile.id)).toBe(true);
    await expect(listNotifications(other.user.id, owner.profile.id, 10)).rejects.toMatchObject({ status: 404 });
  });

  it("asks PostgreSQL for only ten dashboard alerts", async () => {
    await notes();
    const query = vi.spyOn(prisma.notification, "findMany");
    const summary = await getDashboardSummary(owner.user.id, owner.profile.id, { kind: "month", month: "2026-10" });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: owner.user.id, businessProfileId: owner.profile.id }, take: 10,
    }));
    expect(summary.alerts).toHaveLength(10);
    expect(summary.alerts.some((notice) => notice.message === "Other business private notice")).toBe(false);
  });

  it.each([0, -1, 501, 1.5])("rejects an invalid notification fetch limit %s", async (take) => {
    await expect(listNotifications(owner.user.id, owner.profile.id, take)).rejects.toMatchObject({ status: 400 });
  });
});
