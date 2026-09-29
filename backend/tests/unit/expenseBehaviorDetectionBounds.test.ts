import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DETECTION_CONFIG } from "../../src/services/anomalyDetection/config";
import { MAXIMUM_WINDOW_RECORDS } from "../../src/services/anomalyDetection/trend.service";

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
const groupBy = vi.fn();
const findFirst = vi.fn();
const categoryFindMany = vi.fn();
const loadBoundedCategoryHistory = vi.fn();

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    expenseRecord: {
      findMany: (...args: unknown[]) => findMany(...args),
      groupBy: (...args: unknown[]) => groupBy(...args),
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

interface Row {
  id: number;
  categoryId: number;
  amount: number;
  date: Date;
  description: string;
}

/**
 * `scanned` is what the bounded `findMany` hands the detector; `all` is what
 * Postgres aggregates over. Passing a longer `all` is how a window past the
 * row ceiling is reproduced without the two ever being confused.
 */
function mockWindow(scanned: Row[], all: Row[] = scanned, previous: Row[] = []) {
  findMany.mockResolvedValue(scanned);
  groupBy.mockImplementation(async (args: { by: ["categoryId" | "date"]; _count?: unknown }) => {
    // Only the current-window aggregates ask for counts, which is what tells
    // them apart from the previous-period one here.
    const rows = args._count === undefined ? previous : all;
    const key = args.by[0];
    const groups = new Map<number, { key: number | Date; total: number; count: number }>();
    for (const row of rows) {
      const bucket = key === "date" ? row.date.getTime() : row.categoryId;
      const entry = groups.get(bucket) ?? { key: key === "date" ? row.date : row.categoryId, total: 0, count: 0 };
      entry.total += row.amount;
      entry.count += 1;
      groups.set(bucket, entry);
    }
    return [...groups.values()].map((entry) => ({
      [key]: entry.key,
      _sum: { amount: entry.total },
      _count: entry.count,
    }));
  });
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
    mockWindow(current);

    const result = await getExpenseBehavior(1, 1, 366, END);

    // The oldest record is past the ceiling, so it is no longer a candidate —
    // the same ceiling `loadBoundedCategoryHistory` already applies in SQL,
    // and the reason it is applied newest-first.
    expect(result.unusualExpenses).toHaveLength(0);
  });

  it("still counts every record the owner is shown a total for", async () => {
    const current = oneCategoryOverTheCap();
    mockWindow(current);

    const result = await getExpenseBehavior(1, 1, 366, END);

    // The ceiling is on what the detector scans, never on what the period
    // sums. Truncating the totals would turn a performance fix into a wrong
    // number on the owner's screen.
    expect(result.totals.current).toBe(CAP * 500 + 50_000);
    expect(result.categoryTrends[0]!.recordCount).toBe(CAP + 1);
  });

  it("bounds both window queries on the ceiling the trend detector already uses", async () => {
    mockWindow([]);

    await getExpenseBehavior(1, 1, 366, END);

    // One row-level read, and it is the detector's. Everything shown to the
    // owner comes from the aggregates, which carry no ceiling.
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]![0] as { take?: number; orderBy?: unknown };
    expect(args.take).toBe(MAXIMUM_WINDOW_RECORDS);
    // Newest first, so the ceiling drops the oldest end of the window.
    expect(args.orderBy).toEqual([{ date: "desc" }, { id: "desc" }]);
    for (const call of groupBy.mock.calls) {
      expect(call[0]).not.toHaveProperty("take");
    }
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
    mockWindow(current);

    const result = await getExpenseBehavior(1, 1, 366, END);

    expect(result.unusualExpenses.map((e) => e.id)).toContain(9);
  });
});

/*
 * The row ceiling exists for the detector. A period total computed from the
 * newest N records is a wrong number on the Dashboard, not a slow one, so
 * every figure the owner is shown is summed by Postgres over the whole window.
 */
describe("getExpenseBehavior figures above the row ceiling", () => {
  /** The newest `MAXIMUM_WINDOW_RECORDS` charges, plus three the bounded read never sees. */
  function aWindowPastTheCeiling() {
    const scanned: Row[] = [];
    for (let i = 0; i < MAXIMUM_WINDOW_RECORDS; i++) {
      scanned.push({
        id: i + 1,
        categoryId: 1,
        amount: 500,
        date: new Date(Date.UTC(2026, 8, 17 - (i % 30))),
        description: `Supplier charge ${i + 1}`,
      });
    }
    const beyond: Row[] = [1, 2, 3].map((n) => ({
      id: MAXIMUM_WINDOW_RECORDS + n,
      categoryId: 1,
      amount: 1_000,
      date: new Date(Date.UTC(2026, 5, n)),
      description: `Older than the ceiling ${n}`,
    }));
    return { scanned, all: [...scanned, ...beyond] };
  }

  const EXACT_TOTAL = MAXIMUM_WINDOW_RECORDS * 500 + 3_000;

  it("reports the whole window's total, not the bounded read's", async () => {
    const { scanned, all } = aWindowPastTheCeiling();
    mockWindow(scanned, all);

    const result = await getExpenseBehavior(1, 1, 366, END);

    expect(result.totals.current).toBe(EXACT_TOTAL);
    expect(result.categoryTrends[0]!.current).toBe(EXACT_TOTAL);
    expect(result.categoryTrends[0]!.recordCount).toBe(MAXIMUM_WINDOW_RECORDS + 3);
  });

  it("keeps the daily series exact too, including the days past the ceiling", async () => {
    const { scanned, all } = aWindowPastTheCeiling();
    mockWindow(scanned, all);

    const result = await getExpenseBehavior(1, 1, 366, END);

    expect(result.dailyTotals.reduce((sum, day) => sum + day.total, 0)).toBe(EXACT_TOTAL);
    expect(result.dailyTotals.find((day) => day.date === "2026-06-01")).toEqual({
      date: "2026-06-01",
      total: 1_000,
      count: 1,
    });
  });

  it("compares against the whole previous window as well", async () => {
    const { scanned, all } = aWindowPastTheCeiling();
    mockWindow(scanned, all, [
      { id: 90_001, categoryId: 1, amount: 4_000, date: new Date(Date.UTC(2025, 8, 20)), description: "Last year" },
    ]);

    const result = await getExpenseBehavior(1, 1, 366, END);

    expect(result.totals.previous).toBe(4_000);
    expect(result.categoryTrends[0]!.previous).toBe(4_000);
  });
});
