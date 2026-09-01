import { describe, expect, it } from "vitest";
import { computeReductionSimulation } from "../../src/services/reductionOpportunity.service";
import { ApiError } from "../../src/middleware/error.middleware";

/**
 * Expense Reduction Opportunities — optional reduction simulation, §12 of
 * docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md.
 *
 * `computeReductionSimulation` is pure (no Prisma) — the baseline figures it
 * receives are exactly what the DB-touching caller (`simulateReductionOpportunity`)
 * would have derived from the owner's own records, per §12.2's rule that the
 * client never supplies an authoritative baseline.
 */

describe("computeReductionSimulation — percent reductions", () => {
  it("computes a straightforward percent reduction", () => {
    const result = computeReductionSimulation(10_000, 40_000, { kind: "percent", value: 25 });
    expect(result.categoryExpenses).toEqual({ before: 10_000, after: 7_500 });
    expect(result.totalExpenses).toEqual({ before: 40_000, after: 37_500 });
    expect(result.hypotheticalReduction).toBe(2_500);
    expect(result.requestedReductionPercent).toBe(25);
  });

  it("accepts the boundary value of exactly 100 percent", () => {
    const result = computeReductionSimulation(5_000, 5_000, { kind: "percent", value: 100 });
    expect(result.categoryExpenses.after).toBe(0);
    expect(result.hypotheticalReduction).toBe(5_000);
  });

  it("rejects zero percent", () => {
    expect(() => computeReductionSimulation(1_000, 1_000, { kind: "percent", value: 0 })).toThrow(ApiError);
  });

  it("rejects a negative percent", () => {
    expect(() => computeReductionSimulation(1_000, 1_000, { kind: "percent", value: -10 })).toThrow(ApiError);
  });

  it("rejects a percent greater than 100", () => {
    expect(() => computeReductionSimulation(1_000, 1_000, { kind: "percent", value: 100.01 })).toThrow(ApiError);
  });

  it("rejects a non-finite percent", () => {
    expect(() => computeReductionSimulation(1_000, 1_000, { kind: "percent", value: Number.NaN })).toThrow(ApiError);
  });
});

describe("computeReductionSimulation — amount reductions", () => {
  it("computes a straightforward amount reduction", () => {
    const result = computeReductionSimulation(8_000, 30_000, { kind: "amount", value: 2_000 });
    expect(result.categoryExpenses).toEqual({ before: 8_000, after: 6_000 });
    expect(result.totalExpenses).toEqual({ before: 30_000, after: 28_000 });
    expect(result.hypotheticalReduction).toBe(2_000);
    expect(result.requestedReductionPercent).toBe(25);
  });

  it("accepts an amount exactly equal to the category baseline", () => {
    const result = computeReductionSimulation(3_000, 3_000, { kind: "amount", value: 3_000 });
    expect(result.categoryExpenses.after).toBe(0);
    expect(result.requestedReductionPercent).toBe(100);
  });

  it("rejects an amount exceeding the category baseline", () => {
    expect(() => computeReductionSimulation(1_000, 5_000, { kind: "amount", value: 1_000.01 })).toThrow(ApiError);
  });

  it("rejects a zero amount", () => {
    expect(() => computeReductionSimulation(1_000, 1_000, { kind: "amount", value: 0 })).toThrow(ApiError);
  });

  it("rejects a negative amount", () => {
    expect(() => computeReductionSimulation(1_000, 1_000, { kind: "amount", value: -50 })).toThrow(ApiError);
  });
});

describe("computeReductionSimulation — zero baseline", () => {
  it("rejects a percent reduction when the category has no spend in the period", () => {
    expect(() => computeReductionSimulation(0, 10_000, { kind: "percent", value: 10 })).toThrow(ApiError);
  });

  it("rejects an amount reduction when the category has no spend in the period", () => {
    expect(() => computeReductionSimulation(0, 10_000, { kind: "amount", value: 1 })).toThrow(ApiError);
  });
});

describe("computeReductionSimulation — invariants", () => {
  it("never asserts a financial-state field: the response has no availableFunds-shaped key", () => {
    const result = computeReductionSimulation(10_000, 40_000, { kind: "percent", value: 10 });
    expect(result).not.toHaveProperty("availableFunds");
    expect(result).not.toHaveProperty("funds");
  });

  it("always returns finite, rounded-to-cents monetary figures", () => {
    const result = computeReductionSimulation(999.99, 12345.678, { kind: "percent", value: 33.33 });
    for (const value of [
      result.categoryExpenses.before,
      result.categoryExpenses.after,
      result.totalExpenses.before,
      result.totalExpenses.after,
      result.hypotheticalReduction,
      result.requestedReductionPercent,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number(value.toFixed(2))).toBe(value);
    }
  });

  it("includes the standard set of caveats and none claim the reduction already happened", () => {
    const result = computeReductionSimulation(10_000, 40_000, { kind: "percent", value: 10 });
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.assumptions.join(" ")).toMatch(/hypothetical/i);
    expect(result.assumptions.join(" ")).toMatch(/available business funds/i);
  });

  it("category-after can never be negative even at the percent boundary", () => {
    const result = computeReductionSimulation(1_234.56, 5_000, { kind: "percent", value: 100 });
    expect(result.categoryExpenses.after).toBe(0);
  });
});
