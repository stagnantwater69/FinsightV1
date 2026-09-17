import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DETECTION_CONFIG } from "../../src/services/anomalyDetection/config";

/*
 * `getExpenseBehavior` feeds the leave-one-out scan from two places: the
 * bounded rolling baseline, which SQL caps per category, and the selected
 * period, which it merged on top without any cap at all. So the bound only
 * held for accounts that were never going to strain it — a category with
 * 20,000 records in the window handed all 20,000 to a synchronous scan on a
 * path the Dashboard calls on mount.
 *
 * The queries are stubbed here rather than run against Postgres: what is
 * under test is the merge, and building 1,001 rows in memory is the whole
 * point of the case.
 */

const findMany = vi.fn();
const findFirst = vi.fn();
const categoryFindMany = vi.fn();
const loadBoundedCategoryHistory = vi.fn();

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    expenseRecord: {
      findMany: (...args: unknown[]) => findMany(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
    expenseCategory: { findMany: (...args: unknown[]) => categoryFindMany(...args) },
  },
}));

vi.mock("../../src/lib/ownership", () => ({
  requireOwnedBusinessProfile: vi.fn(async () => ({ id: 1, userId: 1 })),
}));

vi.mock("../../src/services/anomalyDetection/categoryStatistics.service", () => ({
  loadBoundedCategoryHistory: (...args: unknown[]) => loadBoundedCategoryHistory(...args),
}));

const { getExpenseBehavior } = await import("../../src/services/insights.service");

const CAP = DEFAULT_DETECTION_CONFIG.maximumCategoryRecords;
const END = new Date(Date.UTC(2026, 8, 17));

/** `CAP` identical recent charges, plus one much older outlier in the same category. */
function oneCategoryOverTheCap() {
  const rows = [];
  for (let i = 0; i < CAP; i++) {
    rows.push({
      id: i + 1,
      categoryId: 1,
      amount: 500,
      date: new Date(Date.UTC(2026, 8, 17 - (i % 30))),
      description: `Supplier charge ${i + 1}`,
    });
  }
  rows.push({
    id: CAP + 1,
    categoryId: 1,
    amount: 50_000,
    date: new Date(Date.UTC(2026, 5, 1)),
    description: "Oldest record in the window",
  });
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  categoryFindMany.mockResolvedValue([{ id: 1, name: "Inventory", costBehavior: "VARIABLE" }]);
  loadBoundedCategoryHistory.mockResolvedValue([]);
  findFirst.mockResolvedValue({ date: END });
});

describe("getExpenseBehavior detection input bounds", () => {
  it("stops merging a category's period records once the per-category ceiling is reached", async () => {
    const current = oneCategoryOverTheCap();
    findMany.mockResolvedValueOnce(current).mockResolvedValueOnce([]);

    const result = await getExpenseBehavior(1, 1, 366, END);

    // The oldest record is past the ceiling, so it is no longer a candidate —
    // the same ceiling `loadBoundedCategoryHistory` already applies in SQL,
    // and the reason it is applied newest-first.
    expect(result.unusualExpenses).toHaveLength(0);
  });

  it("still counts every record the owner is shown a total for", async () => {
    const current = oneCategoryOverTheCap();
    findMany.mockResolvedValueOnce(current).mockResolvedValueOnce([]);

    const result = await getExpenseBehavior(1, 1, 366, END);

    // The ceiling is on what the detector scans, never on what the period
    // sums. Truncating the totals would turn a performance fix into a wrong
    // number on the owner's screen.
    expect(result.totals.current).toBe(CAP * 500 + 50_000);
    expect(result.categoryTrends[0]!.recordCount).toBe(CAP + 1);
  });

  it("leaves a category under the ceiling reporting its outlier as before", async () => {
    const current = [
      ...[480, 500, 512, 495, 505, 488, 502, 499].map((amount, i) => ({
        id: i + 1,
        categoryId: 1,
        amount,
        date: new Date(Date.UTC(2026, 8, 10 + i)),
        description: `Charge ${i + 1}`,
      })),
      { id: 9, categoryId: 1, amount: 4_800, date: new Date(Date.UTC(2026, 8, 1)), description: "Outlier" },
    ];
    findMany.mockResolvedValueOnce(current).mockResolvedValueOnce([]);

    const result = await getExpenseBehavior(1, 1, 366, END);

    expect(result.unusualExpenses.map((e) => e.id)).toContain(9);
  });
});
