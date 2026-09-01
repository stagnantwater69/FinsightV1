import { describe, expect, it } from "vitest";
import {
  deriveBaselineAppearsOffFromPattern,
  deriveSuggestedQuestionsForNextMonth,
  MONTH_END_BASELINE_MATERIALITY_FRACTION,
  MONTH_END_MISSING_DAY_QUESTION_FRACTION,
  selectStrongestAndWeakestOpenDay,
  type MonthEndOpenDaySales,
} from "../../src/services/analysis.service";

// Plan §10.9 (docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md) — the deterministic
// month-end review. These cover only the pure materiality/selection/
// templating logic; the database orchestration
// (insights.service.ts's `computeMonthEndReview`) is covered against real
// seeded data in tests/integration/recoveryMonthEndReview.test.ts.

describe("deriveBaselineAppearsOffFromPattern — materiality boundary", () => {
  it("is the documented 20 percentage points", () => {
    expect(MONTH_END_BASELINE_MATERIALITY_FRACTION).toBe(0.2);
  });

  it("returns false exactly at the boundary (120%)", () => {
    expect(deriveBaselineAppearsOffFromPattern(120, 100000)).toBe(false);
  });

  it("returns true just past the boundary (120.01%)", () => {
    expect(deriveBaselineAppearsOffFromPattern(120.01, 100000)).toBe(true);
  });

  it("returns false exactly at the boundary on the shortfall side (80%)", () => {
    expect(deriveBaselineAppearsOffFromPattern(80, 100000)).toBe(false);
  });

  it("returns true just past the boundary on the shortfall side (79.99%)", () => {
    expect(deriveBaselineAppearsOffFromPattern(79.99, 100000)).toBe(true);
  });

  it("returns false at exactly 100% coverage", () => {
    expect(deriveBaselineAppearsOffFromPattern(100, 100000)).toBe(false);
  });

  it("returns false when no baseline is configured, regardless of coveragePercent", () => {
    expect(deriveBaselineAppearsOffFromPattern(0, 0)).toBe(false);
    expect(deriveBaselineAppearsOffFromPattern(500, -1)).toBe(false);
  });
});

describe("selectStrongestAndWeakestOpenDay", () => {
  it("returns both null for an empty open-day list", () => {
    expect(selectStrongestAndWeakestOpenDay([])).toEqual({ strongest: null, weakest: null });
  });

  it("picks the single day as both strongest and weakest when there's only one", () => {
    const days: MonthEndOpenDaySales[] = [{ date: "2026-06-01", sales: 500 }];
    expect(selectStrongestAndWeakestOpenDay(days)).toEqual({
      strongest: { date: "2026-06-01", sales: 500 },
      weakest: { date: "2026-06-01", sales: 500 },
    });
  });

  it("picks the highest and lowest confirmed-sales days", () => {
    const days: MonthEndOpenDaySales[] = [
      { date: "2026-06-01", sales: 500 },
      { date: "2026-06-02", sales: 1500 },
      { date: "2026-06-03", sales: 100 },
    ];
    const result = selectStrongestAndWeakestOpenDay(days);
    expect(result.strongest).toEqual({ date: "2026-06-02", sales: 1500 });
    expect(result.weakest).toEqual({ date: "2026-06-03", sales: 100 });
  });

  it("breaks ties in favor of the earliest date (chronological input order)", () => {
    const days: MonthEndOpenDaySales[] = [
      { date: "2026-06-01", sales: 1000 },
      { date: "2026-06-02", sales: 1000 },
      { date: "2026-06-03", sales: 1000 },
    ];
    const result = selectStrongestAndWeakestOpenDay(days);
    expect(result.strongest).toEqual({ date: "2026-06-01", sales: 1000 });
    expect(result.weakest).toEqual({ date: "2026-06-01", sales: 1000 });
  });

  it("returns a real zero-sales day for both strongest and weakest when every open day has zero sales", () => {
    const days: MonthEndOpenDaySales[] = [
      { date: "2026-06-01", sales: 0 },
      { date: "2026-06-02", sales: 0 },
    ];
    const result = selectStrongestAndWeakestOpenDay(days);
    expect(result.strongest).toEqual({ date: "2026-06-01", sales: 0 });
    expect(result.weakest).toEqual({ date: "2026-06-01", sales: 0 });
  });
});

describe("deriveSuggestedQuestionsForNextMonth", () => {
  const baseInput = {
    baselineAppearsOffFromPattern: false,
    expectedMonthlyExpenses: 100000,
    coveragePercent: 100,
    missingOrProvisionalDayCount: 0,
    openDayCount: 26,
    strongestOpenDay: null,
    weakestOpenDay: null,
    originalDailyTarget: 3846,
    finalAdjustedDailyTarget: null,
  };

  it("always returns between 2 and 4 questions", () => {
    const none = deriveSuggestedQuestionsForNextMonth(baseInput);
    expect(none.length).toBeGreaterThanOrEqual(2);
    expect(none.length).toBeLessThanOrEqual(4);

    const all = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      baselineAppearsOffFromPattern: true,
      coveragePercent: 60,
      missingOrProvisionalDayCount: 10,
      openDayCount: 20,
      strongestOpenDay: { date: "2026-06-05", sales: 5000 },
      weakestOpenDay: { date: "2026-06-10", sales: 0 },
      finalAdjustedDailyTarget: 6000,
    });
    expect(all.length).toBeLessThanOrEqual(4);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("includes a baseline question referencing the exact expense and coverage numbers when baselineAppearsOffFromPattern is true", () => {
    const questions = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      baselineAppearsOffFromPattern: true,
      coveragePercent: 60,
    });
    expect(questions.some((q) => q.includes("₱100,000") && q.includes("60%"))).toBe(true);
  });

  it("does not include the baseline question when baselineAppearsOffFromPattern is false", () => {
    const questions = deriveSuggestedQuestionsForNextMonth(baseInput);
    expect(questions.some((q) => q.toLowerCase().includes("typical expenses"))).toBe(false);
  });

  it("includes a missing/provisional-day question once the fraction crosses the documented cutoff", () => {
    expect(MONTH_END_MISSING_DAY_QUESTION_FRACTION).toBe(0.2);
    const justBelow = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      openDayCount: 10,
      missingOrProvisionalDayCount: 1, // 10%, below cutoff
    });
    expect(justBelow.some((q) => q.includes("open days this month have no sales"))).toBe(false);

    const atCutoff = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      openDayCount: 10,
      missingOrProvisionalDayCount: 2, // exactly 20%
    });
    expect(atCutoff.some((q) => q.includes("2 of 10 open days"))).toBe(true);
  });

  it("does not divide by zero and skips the missing-day question when there were no open days at all", () => {
    const questions = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      openDayCount: 0,
      missingOrProvisionalDayCount: 0,
    });
    expect(questions.some((q) => q.includes("open days"))).toBe(false);
  });

  it("includes a target-drift question when finalAdjustedDailyTarget rose materially above originalDailyTarget", () => {
    const questions = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      originalDailyTarget: 4000,
      finalAdjustedDailyTarget: 6000,
    });
    expect(questions.some((q) => q.includes("₱4,000") && q.includes("₱6,000"))).toBe(true);
  });

  it("omits the target-drift question when finalAdjustedDailyTarget is null", () => {
    const questions = deriveSuggestedQuestionsForNextMonth({ ...baseInput, finalAdjustedDailyTarget: null });
    expect(questions.some((q) => q.includes("daily target drifted"))).toBe(false);
  });

  it("includes a strongest/weakest-day question when the two differ", () => {
    const questions = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      strongestOpenDay: { date: "2026-06-05", sales: 5000 },
      weakestOpenDay: { date: "2026-06-12", sales: 0 },
    });
    expect(questions.some((q) => q.includes("2026-06-05") && q.includes("2026-06-12"))).toBe(true);
  });

  it("omits the strongest/weakest-day question when they're the same day (a fully tied, single-open-day month)", () => {
    const day: MonthEndOpenDaySales = { date: "2026-06-01", sales: 500 };
    const questions = deriveSuggestedQuestionsForNextMonth({
      ...baseInput,
      openDayCount: 1,
      strongestOpenDay: day,
      weakestOpenDay: day,
    });
    expect(questions.some((q) => q.includes("was your strongest open day"))).toBe(false);
  });

  it("falls back to generic filler questions when nothing notable triggered", () => {
    const questions = deriveSuggestedQuestionsForNextMonth(baseInput);
    expect(questions.length).toBe(2);
  });
});
