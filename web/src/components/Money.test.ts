import { describe, expect, it } from "vitest";
import { formatMoney } from "./Money";

/**
 * Every peso figure in the app is rendered through this. It is the single
 * place a formatting mistake would be invisible in code review and wrong on
 * every screen at once, which is exactly why it exists as one function — and
 * why it should have been tested before now.
 */
describe("formatMoney", () => {
  it("shows whole pesos by default, because summaries read faster without centavos", () => {
    expect(formatMoney(5000)).toBe("PHP 5,000");
  });

  it("shows centavos on request", () => {
    expect(formatMoney(1234.5, { decimals: true })).toBe("PHP 1,234.50");
  });

  it("groups thousands", () => {
    expect(formatMoney(1234567, { decimals: true })).toBe("PHP 1,234,567.00");
  });

  it("drops the prefix where a column header already carries it", () => {
    expect(formatMoney(250, { bare: true })).toBe("250");
  });

  /**
   * A minus sign (U+2212), not a hyphen. It aligns with digits in the tabular
   * figure face, which a hyphen does not — a column of negative amounts made of
   * hyphens visibly fails to line up.
   */
  it("uses a true minus sign for negatives", () => {
    expect(formatMoney(-500)).toBe("−PHP 500");
    expect(formatMoney(-500)).not.toContain("-");
  });

  it("shows an explicit + only when asked, for deltas", () => {
    expect(formatMoney(500, { signed: true })).toBe("+PHP 500");
    expect(formatMoney(-500, { signed: true })).toBe("−PHP 500");
    // Unsigned is the default: an ordinary amount should not look like a change.
    expect(formatMoney(500)).toBe("PHP 500");
  });

  it("does not sign zero as negative", () => {
    expect(formatMoney(0)).toBe("PHP 0");
    expect(formatMoney(0, { signed: true })).toBe("+PHP 0");
  });

  it("rounds to whole pesos rather than truncating", () => {
    expect(formatMoney(1234.6)).toBe("PHP 1,235");
    expect(formatMoney(1234.4)).toBe("PHP 1,234");
  });

  it("combines options", () => {
    expect(formatMoney(-1234.5, { decimals: true, bare: true, signed: true })).toBe("−1,234.50");
  });
});
