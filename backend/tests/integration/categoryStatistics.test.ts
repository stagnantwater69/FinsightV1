import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/prisma";
import * as expenses from "../../src/services/expenseRecord.service";
import { detectAmountOutlierForExpense } from "../../src/services/anomalyDetection/amountOutlier.service";
import {
  loadBoundedCategoryHistory,
  loadBoundedCategoryHistoryForCategories,
  refreshOwnedCategoryStatistics,
} from "../../src/services/anomalyDetection/categoryStatistics.service";
import { detectionConfig } from "../../src/services/anomalyDetection/config";
import { disconnectDb, makeOwnerWithProfile, resetDb, utcDay, utcDayString } from "../setup/testDb";

let alice: Awaited<ReturnType<typeof makeOwnerWithProfile>>;
let bob: Awaited<ReturnType<typeof makeOwnerWithProfile>>;

beforeEach(async () => {
  await resetDb();
  alice = await makeOwnerWithProfile({ name: "Alice's Store" });
  bob = await makeOwnerWithProfile({ name: "Bob's Store" });
});

afterAll(disconnectDb);

async function addInventory(amount: number, dayOffset: number) {
  return expenses.createExpenseRecord(alice.user.id, {
    businessProfileId: alice.profile.id,
    categoryId: alice.categories.Inventory!,
    date: utcDayString(dayOffset),
    description: `Inventory ${dayOffset}`,
    amount,
  });
}

describe("bounded category history", () => {
  it("excludes records older than the rolling window", async () => {
    await addInventory(100, -364);
    await addInventory(200, -365);

    const history = await loadBoundedCategoryHistory(alice.profile.id, utcDay(), 365, 1_000);

    expect(history.map((record) => Number(record.amount))).toEqual([100]);
  });

  it("applies the record cap independently to every category", async () => {
    for (let i = 0; i < 4; i++) await addInventory(100 + i, -i);
    for (let i = 0; i < 4; i++) {
      await expenses.createExpenseRecord(alice.user.id, {
        businessProfileId: alice.profile.id,
        categoryId: alice.categories.Utilities!,
        date: utcDayString(-i),
        description: `Utility ${i}`,
        amount: 200 + i,
      });
    }

    const history = await loadBoundedCategoryHistory(alice.profile.id, utcDay(), 365, 3);
    const inventory = history.filter((record) => record.categoryId === alice.categories.Inventory);
    const utilities = history.filter((record) => record.categoryId === alice.categories.Utilities);

    expect(inventory).toHaveLength(3);
    expect(utilities).toHaveLength(3);
  });

  /*
   * The per-category read replaced a ROW_NUMBER() ranking of the whole window.
   * This keeps that ranking as the reference and checks the two agree, row for
   * row and in order, on a ledger built to catch a difference: many records on
   * the same day (the id tiebreak), uneven categories, records either side of
   * the window, another business's records, and one of Alice's records filed
   * under Bob's category, which the schema does not forbid.
   */
  it("returns exactly what ranking the whole window returned", async () => {
    const aliceCategories = Object.values(alice.categories).filter((id): id is number => id !== undefined);
    const bobCategory = Object.values(bob.categories).find((id): id is number => id !== undefined)!;
    let seed = 20261023;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const rows = [];
    for (let i = 0; i < 600; i++) {
      // Skewed toward the first category so the categories are uneven.
      const categoryId = aliceCategories[Math.floor(random() ** 2 * aliceCategories.length)]!;
      rows.push({
        businessProfileId: alice.profile.id,
        categoryId,
        // Few distinct days, so many records tie on date.
        date: new Date(`${utcDayString(-Math.floor(random() * 30) * 15)}T00:00:00Z`),
        description: `Ledger ${i}`,
        source: "MANUAL_ENTRY" as const,
        amount: 10 + Math.floor(random() * 500),
      });
    }
    rows.push({ businessProfileId: alice.profile.id, categoryId: bobCategory, date: new Date(`${utcDayString(-2)}T00:00:00Z`), description: "Filed under Bob's category", amount: 77, source: "MANUAL_ENTRY" as const });
    for (let i = 0; i < 40; i++) {
      rows.push({ businessProfileId: bob.profile.id, categoryId: bobCategory, date: new Date(`${utcDayString(-i)}T00:00:00Z`), description: `Bob ${i}`, amount: 5 + i, source: "MANUAL_ENTRY" as const });
    }
    await prisma.expenseRecord.createMany({ data: rows });

    const windowEnd = utcDay();
    const reference = (days: number, cap: number, maximumCategories?: number, selected?: number[]) => {
      const start = new Date(windowEnd.getTime() - (days - 1) * 86_400_000);
      const end = new Date(windowEnd.getTime() + 86_400_000 - 1);
      return prisma.$queryRawUnsafe<{ id: number; categoryId: number }[]>(`
        WITH ${maximumCategories === undefined ? "" : `selected_categories AS (
          SELECT er."Category_ID" FROM "ExpenseRecord" er
          WHERE er."BusinessProfile_ID" = $1 AND er."ExpenseRecord_Date" >= $2 AND er."ExpenseRecord_Date" <= $3
          GROUP BY er."Category_ID" ORDER BY SUM(er."ExpenseRecord_Amount") DESC, er."Category_ID" ASC
          LIMIT ${maximumCategories}),`}
        ranked AS (
          SELECT er."ExpenseRecord_ID" AS id, er."Category_ID" AS "categoryId", er."ExpenseRecord_Date" AS date,
            ROW_NUMBER() OVER (PARTITION BY er."Category_ID" ORDER BY er."ExpenseRecord_Date" DESC, er."ExpenseRecord_ID" DESC) AS row_number
          FROM "ExpenseRecord" er
          WHERE er."BusinessProfile_ID" = $1 AND er."ExpenseRecord_Date" >= $2 AND er."ExpenseRecord_Date" <= $3
          ${selected ? `AND er."Category_ID" IN (${selected.join(",")})` : ""}
          ${maximumCategories === undefined ? "" : `AND er."Category_ID" IN (SELECT "Category_ID" FROM selected_categories)`}
        )
        SELECT id, "categoryId" FROM ranked WHERE row_number <= ${cap}
        ORDER BY "categoryId", date DESC, id DESC`, alice.profile.id, start, end);
    };
    const ids = (records: { id: number; categoryId: number }[]) => records.map((record) => `${record.categoryId}:${record.id}`);

    let compared = 0;
    for (const [days, cap] of [[365, 1_000], [365, 1], [200, 3], [90, 7], [1, 50]] as const) {
      const expected = ids(await reference(days, cap));
      expect(ids(await loadBoundedCategoryHistory(alice.profile.id, windowEnd, days, cap))).toEqual(expected);
      expect(ids(await loadBoundedCategoryHistory(alice.profile.id, windowEnd, days, cap, 2))).toEqual(ids(await reference(days, cap, 2)));
      const selected = [aliceCategories[1]!, aliceCategories[0]!, aliceCategories[1]!, bobCategory];
      expect(ids(await loadBoundedCategoryHistoryForCategories(alice.profile.id, windowEnd, selected, days, cap)))
        .toEqual(ids(await reference(days, cap, undefined, selected)));
      compared += expected.length;
    }
    // The comparison covered real rows, including the record under Bob's category.
    expect(compared).toBeGreaterThan(400);
    expect(ids(await reference(365, 1_000))).toContain(`${bobCategory}:${(await prisma.expenseRecord.findFirstOrThrow({ where: { description: "Filed under Bob's category" } })).id}`);
  });
});

describe("category statistic snapshots", () => {
  it("persists 90-day and 365-day summaries and updates them in place", async () => {
    await addInventory(100, -10);
    await addInventory(300, -100);
    await addInventory(900, -400);

    const first = await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay());
    expect(first).toHaveLength(4); // two categories x two configured windows

    const short = await prisma.categoryStatistics.findUniqueOrThrow({
      where: { categoryId_windowDays: { categoryId: alice.categories.Inventory!, windowDays: 90 } },
    });
    const annual = await prisma.categoryStatistics.findUniqueOrThrow({
      where: { categoryId_windowDays: { categoryId: alice.categories.Inventory!, windowDays: 365 } },
    });
    expect(short.recordCount).toBe(1);
    expect(Number(short.mean)).toBe(100);
    expect(annual.recordCount).toBe(2);
    expect(Number(annual.mean)).toBe(200);

    await addInventory(500, -1);
    await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay());
    expect(await prisma.categoryStatistics.count({ where: { businessProfileId: alice.profile.id } })).toBe(4);
    const refreshed = await prisma.categoryStatistics.findUniqueOrThrow({
      where: { categoryId_windowDays: { categoryId: alice.categories.Inventory!, windowDays: 365 } },
    });
    expect(refreshed.recordCount).toBe(3);
    expect(Number(refreshed.mean)).toBe(300);
  });

  it("stores empty summaries for categories without records", async () => {
    await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay());
    const empty = await prisma.categoryStatistics.findUniqueOrThrow({
      where: { categoryId_windowDays: { categoryId: alice.categories.Utilities!, windowDays: 365 } },
    });

    expect(empty.recordCount).toBe(0);
    expect(Number(empty.mean)).toBe(0);
    expect(empty.minimum).toBeNull();
    expect(empty.maximum).toBeNull();
  });

  it("honors the configured per-category record cap", async () => {
    for (let i = 0; i < 5; i++) await addInventory(100 + i, -i);
    const config = detectionConfig({ maximumCategoryRecords: 3 });

    await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay(), config);
    const snapshot = await prisma.categoryStatistics.findUniqueOrThrow({
      where: { categoryId_windowDays: { categoryId: alice.categories.Inventory!, windowDays: 365 } },
    });
    expect(snapshot.recordCount).toBe(3);
  });

  it("rejects refreshes for another owner's profile", async () => {
    await expect(
      refreshOwnedCategoryStatistics(bob.user.id, alice.profile.id, utcDay()),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("cached baseline reuse in amount-outlier detection", () => {
  it("detects from the precomputed summary alone, without needing the raw baseline rows", async () => {
    const config = detectionConfig();
    const baselineIds: number[] = [];
    for (let i = 0; i < 8; i++) baselineIds.push((await addInventory(1_000 + i, -10 - i)).id);
    await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay(), config);

    // Prove the cached summary is what gets used: delete the raw rows behind
    // it entirely. A live-recompute fallback would then see zero history and
    // report nothing.
    await prisma.expenseRecord.deleteMany({ where: { id: { in: baselineIds } } });

    const candidate = await addInventory(30_000, 0);
    const finding = await detectAmountOutlierForExpense(candidate.id, config);

    expect(finding).not.toBeNull();
    expect(finding!.type).toBe("AMOUNT_OUTLIER");
    expect((finding!.metadata as Record<string, unknown>).historyCount).toBe(8);
  });

  it("falls back to the live query when the candidate predates the cached summary", async () => {
    const config = detectionConfig();
    for (let i = 0; i < 8; i++) await addInventory(1_000 + i, -10 - i);
    const candidate = await addInventory(30_000, 0);

    // Refresh runs AFTER the candidate already exists, so the cache may have
    // already absorbed it — detection must not trust the cache here.
    await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay(), config);

    const finding = await detectAmountOutlierForExpense(candidate.id, config);

    expect(finding).not.toBeNull();
    expect((finding!.metadata as Record<string, unknown>).historyCount).toBe(8);
  });

  it("ignores a cached summary for a different category", async () => {
    const config = detectionConfig();
    for (let i = 0; i < 8; i++) await addInventory(1_000 + i, -10 - i);
    await refreshOwnedCategoryStatistics(alice.user.id, alice.profile.id, utcDay(), config);

    const utilityCandidate = await expenses.createExpenseRecord(alice.user.id, {
      businessProfileId: alice.profile.id,
      categoryId: alice.categories.Utilities!,
      date: utcDayString(),
      description: "Utility spike",
      amount: 30_000,
    });

    const finding = await detectAmountOutlierForExpense(utilityCandidate.id, config);
    expect(finding).toBeNull();
  });
});
