import { describe, expect, it } from "vitest";
import {
  expenseSummaryFigures,
  expenseSummaryPoints,
  expenseSummaryQuestions,
  type SummaryContext,
} from "../src/lib/expenseSummary";
import type { CategoryTrend } from "../src/lib/types";

function trend(categoryName: string, current: number, previous: number, recordCount = 1): CategoryTrend {
  return {
    categoryId: categoryName.length,
    categoryName,
    current,
    previous,
    direction: current > previous ? "up" : current < previous ? "down" : "flat",
    percentChange: previous > 0 ? ((current - previous) / previous) * 100 : null,
    recordCount,
    change: current - previous,
  };
}

const week = {
  totals: { current: 1000, previous: 800 },
  categoryTrends: [trend("Rent", 600, 600, 1), trend("Supplies", 300, 100, 4), trend("Food", 100, 100, 2)],
  dailyTotals: [],
  dailyBucket: "day" as const,
};

const ctx: SummaryContext = {
  periodText: "this week",
  comparedWith: "Last week",
  allTime: false,
  flaggedCount: 0,
  unusualCount: 0,
};

const text = (segments: { text: string }[]) => segments.map((s) => s.text).join("");

describe("expense summary figures", () => {
  it("reads the largest category, its share and the biggest peso increase", () => {
    const s = expenseSummaryFigures(week, 4000);
    expect(s.top?.categoryName).toBe("Rent");
    expect(s.topShare).toBe(60);
    expect(s.biggestIncrease?.categoryName).toBe("Supplies");
    expect(s.periodPercent).toBe(25);
    expect(s.recordCount).toBe(7);
    expect(s.categoryCount).toBe(3);
    expect(s.fundsShare).toBe(25);
  });

  it("has no funds share without a positive balance, and none for All time", () => {
    expect(expenseSummaryFigures(week, null).fundsShare).toBeNull();
    expect(expenseSummaryFigures(week, 0).fundsShare).toBeNull();
    const allTime = { ...week, dailyBucket: "month" as const, dailyTotals: [{}, {}] as never };
    const s = expenseSummaryFigures(allTime, 4000);
    expect(s.fundsShare).toBeNull();
    expect(s.monthlyAverage).toBe(500);
  });

  it("falls back to current minus previous when an older response has no change field", () => {
    const older = { ...week, categoryTrends: week.categoryTrends.map(({ change: _c, ...t }) => t) };
    expect(expenseSummaryFigures(older as unknown as Parameters<typeof expenseSummaryFigures>[0], null).biggestIncrease?.change).toBe(200);
  });
});

describe("expense summary points", () => {
  it("states each point in the owner's words", () => {
    const points = expenseSummaryPoints(expenseSummaryFigures(week, null), { ...ctx, flaggedCount: 2, unusualCount: 1 });
    expect(points.map((p) => text(p.segments))).toEqual([
      "Rent is your highest expense category this week: 60.0% of expenses.",
      "Supplies rose the most: up PHP 200 vs Last week.",
      "Total spending is 25% higher than Last week.",
      "2 expenses to review, 1 unusual for its category.",
    ]);
  });

  it("drops comparison points for All time", () => {
    const points = expenseSummaryPoints(expenseSummaryFigures(week, null), { ...ctx, allTime: true, comparedWith: null });
    expect(points.map((p) => p.kind)).toEqual(["top"]);
  });

  it("offers questions that name the figures on screen", () => {
    const questions = expenseSummaryQuestions(expenseSummaryFigures(week, null), { ...ctx, unusualCount: 1 });
    expect(questions.map((q) => q.label)).toEqual([
      "Why did Supplies rise?",
      "How can I spend less on Rent?",
      "What should I check first?",
    ]);
    expect(questions[0].question).toBe("Why did Supplies increase by PHP 200 compared with Last week?");
  });
});
