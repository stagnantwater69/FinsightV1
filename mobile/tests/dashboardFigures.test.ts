import { describe, expect, it } from "vitest";
import {
  deltaPillText,
  deltaText,
  deltaTone,
  netCaption,
  previousPeriodCaption,
  previousRangeShort,
  summaryDelta,
  upcomingSchedules,
} from "../src/lib/dashboardFigures";
import type { DashboardPeriodComparison, RecurringSchedule } from "../src/lib/types";

const comparison: DashboardPeriodComparison = {
  previousStart: "2026-09-01T00:00:00.000Z",
  previousEnd: "2026-09-07T00:00:00.000Z",
  sales: { previous: 1000, changeAmount: 200, changePercent: 20 },
  expenses: { previous: 500, changeAmount: 50, changePercent: 10 },
  net: { previous: 0, changeAmount: 150, changePercent: null },
};

function schedule(overrides: Partial<RecurringSchedule>): RecurringSchedule {
  return {
    id: 1,
    businessProfileId: 1,
    categoryId: 1,
    categoryName: "Rent",
    label: "Rent",
    vendor: null,
    intervalDays: 30,
    expectedAmount: 100,
    amountTolerance: 0.1,
    nextDueDate: "2026-10-20T00:00:00.000Z",
    lastRecordedDate: null,
    isActive: true,
    dueState: "SCHEDULED",
    ...overrides,
  } as RecurringSchedule;
}

describe("dashboard figures", () => {
  it("names the previous window with its year", () => {
    expect(previousPeriodCaption(comparison)).toBe("Sep 1-7, 2026");
    expect(previousPeriodCaption({ ...comparison, previousStart: "2025-12-29", previousEnd: "2026-01-04" }))
      .toBe("Dec 29, 2025 to Jan 4, 2026");
  });

  it("has no delta without a comparison", () => {
    expect(summaryDelta(null, "sales")).toBeNull();
    expect(summaryDelta(undefined, "net")).toBeNull();
  });

  it("treats a rise in expenses as bad and a rise in sales as good", () => {
    expect(deltaTone(summaryDelta(comparison, "expenses")!)).toBe("bad");
    expect(deltaTone(summaryDelta(comparison, "sales")!)).toBe("good");
    expect(deltaTone({ ...summaryDelta(comparison, "sales")!, amount: -5 })).toBe("bad");
    expect(deltaTone({ ...summaryDelta(comparison, "sales")!, amount: 0 })).toBe("flat");
  });

  it("states the change with an arrow, and says new when the previous period was zero", () => {
    expect(deltaText(summaryDelta(comparison, "sales")!)).toBe("▲ 20% vs Sep 1-7, 2026");
    expect(deltaText(summaryDelta(comparison, "net")!)).toBe("▲ new vs Sep 1-7, 2026");
    expect(deltaText({ ...summaryDelta(comparison, "sales")!, amount: 0 })).toBe("No change vs Sep 1-7, 2026");
  });

  it("explains net in the owner's terms", () => {
    expect(netCaption(-10, 100)).toBe("Expenses exceeded sales");
    expect(netCaption(25, 100)).toBe("25% of sales kept");
    expect(netCaption(0, 0)).toBe("Sales minus expenses");
  });

  it("shows active schedules, overdue first, then by due date", () => {
    const list = upcomingSchedules([
      schedule({ id: 1, nextDueDate: "2026-10-02" }),
      schedule({ id: 2, dueState: "OVERDUE", nextDueDate: "2026-10-05" }),
      schedule({ id: 3, isActive: false, dueState: "OVERDUE" }),
      schedule({ id: 4, dueState: "DUE_SOON", nextDueDate: "2026-10-11" }),
      schedule({ id: 5, nextDueDate: "2026-10-01" }),
    ]);
    expect(list.map((s) => s.id)).toEqual([2, 4, 5]);
  });
});

describe("compact deltas", () => {
  it("says the change in a few characters", () => {
    expect(deltaPillText(summaryDelta(comparison, "sales")!)).toBe("▲ 20%");
    expect(deltaPillText({ ...summaryDelta(comparison, "sales")!, amount: -30, percent: -3 })).toBe("▼ 3%");
    expect(deltaPillText(summaryDelta(comparison, "net")!)).toBe("New");
    expect(deltaPillText({ ...summaryDelta(comparison, "sales")!, amount: 0 })).toBe("0%");
  });

  it("names the previous window without the year", () => {
    expect(previousRangeShort(comparison)).toBe("Sep 1-7");
  });
});
