import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/services/businessProfile.service", () => ({}));
vi.mock("../../src/services/financialPosition.service", () => ({}));
import { createSchema } from "../../src/controllers/businessProfile.controller";

const profile = {
  name: "Money boundary store", type: "Store", operatingDays: 20,
  availableFunds: 0, expectedMonthlyExpenses: 0,
};

describe("business profile database-aligned numeric domain", () => {
  it.each(["availableFunds", "expectedMonthlyExpenses"] as const)("rejects nonfinite %s before persistence", (field) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = createSchema.safeParse({ ...profile, [field]: value });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
  });

  it("accepts zero and exact centavo values at the database boundary", () => {
    expect(createSchema.parse({ ...profile, availableFunds: 9_999_999_999.99, expectedMonthlyExpenses: 0.01 }))
      .toMatchObject({ availableFunds: 9_999_999_999.99, expectedMonthlyExpenses: 0.01 });
  });

  it("rejects a third decimal in the stored threshold percentage", () => {
    expect(createSchema.safeParse({ ...profile, largeExpenseThresholdPercent: 25.001 }).success).toBe(false);
    expect(createSchema.parse({ ...profile, largeExpenseThresholdPercent: 999.99 }).largeExpenseThresholdPercent).toBe(999.99);
  });
});
