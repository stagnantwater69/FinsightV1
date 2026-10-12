import { describe, expect, it } from "vitest";
import { problemWith } from "./csvImportRules";
import type { MappedField } from "./types";

const validValues: Record<MappedField, string> = {
  Date: "2026-09-27",
  Description: "Restock",
  Amount: "100",
  Category: "",
  Vendor: "Supplier",
};

function amountProblem(amount: string, usesSignedAmounts = false) {
  return problemWith({ ...validValues, Amount: amount }, "iso", usesSignedAmounts);
}

describe("CSV review row checks", () => {
  it.each(["1,234.56", "PHP 1,234.56", "₱ 1,234.56"])("accepts the server's positive peso amount format: %s", (amount) => {
    expect(amountProblem(amount)).toBeNull();
  });

  it.each(["-1,234.56", "(1,234.56)", "(PHP 1,234.56)", "(₱ 1,234.56)"])(
    "accepts a signed amount only for a mixed sign import: %s",
    (amount) => {
      expect(amountProblem(amount, true)).toBeNull();
      expect(amountProblem(amount, false)).toEqual({ field: "Amount", reason: "Invalid amount" });
    },
  );

  it("says a missing amount is required rather than invalid", () => {
    expect(amountProblem("")).toEqual({ field: "Amount", reason: "Amount required" });
    expect(amountProblem("   ")).toEqual({ field: "Amount", reason: "Amount required" });
  });

  it.each(["n/a", "PHP", "0", "-0", "(0)"])("rejects a malformed or zero amount: %s", (amount) => {
    expect(amountProblem(amount, true)).toEqual({ field: "Amount", reason: "Invalid amount" });
  });

  it("rejects a third decimal place, as the server's column would", () => {
    expect(amountProblem("10.005")).toEqual({ field: "Amount", reason: "Too many decimals" });
  });

  it("names a missing date and description in a few words", () => {
    expect(problemWith({ ...validValues, Date: "" }, "iso")).toEqual({ field: "Date", reason: "Date required" });
    expect(problemWith({ ...validValues, Date: "31/02/2026" }, "dmy")).toEqual({ field: "Date", reason: "Invalid date" });
    // The server skips a row dated after the business's today; the review says so first.
    expect(problemWith({ ...validValues, Date: "2026-09-18" }, "iso", false, "2026-09-17")).toEqual({ field: "Date", reason: "Date can't be in the future" });
    expect(problemWith({ ...validValues, Date: "2026-09-17" }, "iso", false, "2026-09-17")).toBeNull();
    expect(problemWith({ ...validValues, Date: "16/09/2026" }, "dmy", false, "2026-09-17")).toBeNull();
    expect(problemWith({ ...validValues, Description: " " }, "iso")).toEqual({ field: "Description", reason: "Description required" });
  });

  it("does not require a category: the import assigns one", () => {
    expect(problemWith({ ...validValues, Category: "" }, "iso")).toBeNull();
  });
});
