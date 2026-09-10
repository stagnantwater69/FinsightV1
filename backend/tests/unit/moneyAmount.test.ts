import { describe, expect, it } from "vitest";
import { MAX_MONEY_AMOUNT, moneyAmountSchema } from "../../src/lib/money";

/**
 * API-004. `z.number().positive()` accepted 0.001, Prisma rounded it into a
 * Decimal(12,2) column as 0.00, and the API answered 201 — a zero-value record
 * the owner cannot see but duplicate detection, the dashboard sums and the
 * anomaly detectors all count. These cases pin the scale and the bound to the
 * column's own precision.
 */
describe("moneyAmountSchema", () => {
  it("rejects a sub-centavo amount rather than letting it round to zero", () => {
    const result = moneyAmountSchema.safeParse(0.001);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/2 decimal places/i);
  });

  it.each([0.005, 1.234, 99.999, 1234.5678, 1e-7])("rejects %p", (value) => {
    expect(moneyAmountSchema.safeParse(value).success).toBe(false);
  });

  it.each([0.01, 1, 12.5, 1234.56, 99999.99, MAX_MONEY_AMOUNT])("accepts %p", (value) => {
    expect(moneyAmountSchema.safeParse(value).success).toBe(true);
  });

  it("rejects zero and negatives with a message about being greater than zero", () => {
    for (const value of [0, -1, -0.01]) {
      const result = moneyAmountSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.message).toMatch(/greater than zero/i);
    }
  });

  it("rejects anything wider than the Decimal(12, 2) column can hold", () => {
    expect(moneyAmountSchema.safeParse(MAX_MONEY_AMOUNT + 1).success).toBe(false);
    expect(MAX_MONEY_AMOUNT).toBe(9_999_999_999.99);
  });

  it("rejects NaN and Infinity instead of handing them to Prisma.Decimal", () => {
    expect(moneyAmountSchema.safeParse(Number.NaN).success).toBe(false);
    expect(moneyAmountSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});
