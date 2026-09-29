import { describe, expect, it } from "vitest";
import { problemWith } from "./csvImportRules";
import type { MappedField } from "./types";

const validValues: Record<MappedField, string> = {
  Date: "2026-09-27",
  Description: "Restock",
  Amount: "100",
  Category: "Inventory",
  Vendor: "Supplier",
};

function amountProblem(amount: string, usesSignedAmounts = false, needsCategory = true) {
  return problemWith(
    { ...validValues, Amount: amount },
    needsCategory,
    "iso",
    usesSignedAmounts,
  );
}

describe("CSV preview amount validation", () => {
  it.each([
    "1,234.56",
    "PHP 1,234.56",
    "₱ 1,234.56",
  ])("accepts the server's positive peso amount format: %s", (amount) => {
    expect(amountProblem(amount)).toBeNull();
  });

  it.each([
    "-1,234.56",
    "(1,234.56)",
    "(PHP 1,234.56)",
    "(₱ 1,234.56)",
  ])("accepts signed amount format only for a mixed sign import: %s", (amount) => {
    expect(amountProblem(amount, true, false)).toBeNull();
    expect(amountProblem(amount, false, false)).toEqual({
      field: "Amount",
      reason: `Invalid amount: "${amount}"`,
    });
    expect(amountProblem(amount, false, true)).toEqual({
      field: "Amount",
      reason: `Invalid amount: "${amount}"`,
    });
  });

  it.each(["", "n/a", "PHP", "0", "-0", "(0)"])("rejects a missing, malformed, or zero amount: %s", (amount) => {
    expect(amountProblem(amount, true, false)).toEqual({
      field: "Amount",
      reason: `Invalid amount: "${amount}"`,
    });
  });
});
