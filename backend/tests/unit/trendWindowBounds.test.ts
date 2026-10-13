import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectionConfig } from "../../src/services/anomalyDetection/config";

/*
 * Every sibling detector caps the history it loads — behavioural novelty at
 * 1,000, velocity at 5,000, recurring at 10,000. The trend detector's 60-day
 * window was the one that did not, and it then re-scanned the whole result
 * once per category and twice more per window.
 */

const expenseFindMany = vi.fn();
const categoryFindMany = vi.fn();
const saveFinding = vi.fn(async (finding: Record<string, unknown>) => finding);

vi.mock("../../src/config/prisma", () => ({
  prisma: {
    expenseRecord: { findMany: (...args: unknown[]) => expenseFindMany(...args) },
    expenseCategory: { findMany: (...args: unknown[]) => categoryFindMany(...args) },
  },
}));

vi.mock("../../src/lib/ownership", () => ({
  requireOwnedBusinessProfile: vi.fn(async () => ({ id: 1, expectedMonthlyExpenses: 50_000 })),
}));

vi.mock("../../src/services/anomalyDetection/finding.service", () => ({
  saveFinding: (...args: [Record<string, unknown>]) => saveFinding(...args),
}));

const { refreshTrendFindings } = await import("../../src/services/anomalyDetection/trend.service");

const TODAY = new Date(Date.UTC(2026, 8, 17));
const CONFIG = detectionConfig({
  featureFlags: { ...detectionConfig().featureFlags, trends: true },
});

/** Day offset back from `TODAY`, as the `@db.Date` midnight the rows carry. */
function daysAgo(n: number) {
  return new Date(Date.UTC(2026, 8, 17 - n));
}

beforeEach(() => {
  vi.clearAllMocks();
  categoryFindMany.mockResolvedValue([{ id: 1, name: "Inventory" }]);
  expenseFindMany.mockResolvedValue([]);
});

describe("trend detector window load", () => {
  it("bounds the 60-day load and takes the newest records first", async () => {
    await refreshTrendFindings(1, 1, TODAY, CONFIG);

    const args = expenseFindMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.take).toBeTypeOf("number");
    expect(args.take as number).toBeGreaterThan(0);
    expect(args.take as number).toBeLessThanOrEqual(10_000);
    expect(args.orderBy).toEqual([{ date: "desc" }, { id: "desc" }]);
  });

  it("loads the window once, not once per category", async () => {
    categoryFindMany.mockResolvedValue([
      { id: 1, name: "Inventory" },
      { id: 2, name: "Utilities" },
      { id: 3, name: "Transport" },
    ]);

    await refreshTrendFindings(1, 1, TODAY, CONFIG);

    expect(expenseFindMany).toHaveBeenCalledTimes(1);
  });

  it("still reports a category whose spending jumped, with the same figures", async () => {
    // 7-day window: PHP 4,000 this week against PHP 1,000 the week before.
    expenseFindMany.mockResolvedValue([
      { categoryId: 1, amount: 4_000, date: daysAgo(2) },
      { categoryId: 1, amount: 1_000, date: daysAgo(9) },
    ]);

    const findings = await refreshTrendFindings(1, 1, TODAY, CONFIG);

    const sevenDay = findings.find((f) => (f.metadata as { windowDays: number }).windowDays === 7);
    expect(sevenDay).toBeDefined();
    expect(sevenDay!.metadata).toMatchObject({ categoryId: 1, current: 4_000, previous: 1_000, change: 3_000 });
  });

  it("ignores a category with nothing in the window", async () => {
    categoryFindMany.mockResolvedValue([
      { id: 1, name: "Inventory" },
      { id: 2, name: "Utilities" },
    ]);
    expenseFindMany.mockResolvedValue([
      { categoryId: 1, amount: 4_000, date: daysAgo(2) },
      { categoryId: 1, amount: 1_000, date: daysAgo(9) },
    ]);

    const findings = await refreshTrendFindings(1, 1, TODAY, CONFIG);

    expect(findings.every((f) => (f.metadata as { categoryId: number }).categoryId === 1)).toBe(true);
  });
});
