import { describe, expect, it } from "vitest";
import { alertKindFromType, formatMoney, formatPercent } from "../src/lib/money";

/**
 * The only genuinely reusable pure logic in the mobile app.
 *
 * Everything else here is either a screen (verified by a real device pass) or a
 * thin call to the backend (already covered by the backend's 252-test suite).
 * Formatting is worth pinning because it must match web EXACTLY — the same
 * record has to read identically on both platforms.
 */
describe("formatMoney — must match web/src/components/Money.tsx", () => {
  it("formats whole pesos with a PHP prefix and thousands separators", () => {
    expect(formatMoney(48500)).toBe("PHP 48,500");
    expect(formatMoney(0)).toBe("PHP 0");
    expect(formatMoney(1234567)).toBe("PHP 1,234,567");
  });

  it("rounds to whole pesos by default", () => {
    expect(formatMoney(5000.49)).toBe("PHP 5,000");
    expect(formatMoney(5000.5)).toBe("PHP 5,001");
  });

  it("shows centavos when asked", () => {
    expect(formatMoney(1220.5, { decimals: true })).toBe("PHP 1,220.50");
    expect(formatMoney(8.7, { decimals: true })).toBe("PHP 8.70");
  });

  it("drops the prefix in bare mode, for columns whose header carries it", () => {
    expect(formatMoney(5000, { bare: true })).toBe("5,000");
  });

  it("uses a real minus sign for negatives, not a hyphen", () => {
    // U+2212, which aligns with digits in a tabular face; a hyphen does not.
    expect(formatMoney(-5000)).toBe("−PHP 5,000");
  });

  it("shows an explicit + only when signed is requested", () => {
    expect(formatMoney(500, { signed: true })).toBe("+PHP 500");
    expect(formatMoney(-500, { signed: true })).toBe("−PHP 500");
    expect(formatMoney(500)).toBe("PHP 500");
  });
});

describe("formatPercent", () => {
  it("defaults to one decimal place", () => {
    expect(formatPercent(22.68)).toBe("22.7%");
    expect(formatPercent(100)).toBe("100.0%");
  });
  it("honours a requested precision", () => {
    expect(formatPercent(22.68, 0)).toBe("23%");
  });
});

describe("alertKindFromType — maps backend Notification.type onto the alert family", () => {
  it("maps the three real backend types", () => {
    expect(alertKindFromType("Possible Duplicate")).toBe("duplicate");
    expect(alertKindFromType("Large Expense Flag")).toBe("large-expense");
    expect(alertKindFromType("Needs Review")).toBe("needs-review");
  });

  it("is case-insensitive", () => {
    expect(alertKindFromType("possible duplicate")).toBe("duplicate");
  });

  it("gives NOTIFICATION_TYPES.RECURRING_SCHEDULE its own kind, not the info fallback", () => {
    // Web maps the same string to "recurring" (web/src/components/Alert.tsx).
    // A watched payment going missed is the reason the schedule exists, so it
    // must not read as "For your information" on mobile.
    expect(alertKindFromType("Recurring Schedule")).toBe("recurring");
    expect(alertKindFromType("recurring schedule")).toBe("recurring");
  });

  it("falls back to info for an unrecognised type rather than throwing", () => {
    // The backend column is VARCHAR, not an enum, so an unknown value is
    // possible and must still render.
    expect(alertKindFromType("Something New")).toBe("info");
  });
});
