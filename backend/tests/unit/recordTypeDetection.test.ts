import { describe, expect, it } from "vitest";
import {
  classifyTypeValue,
  columnsWithSignedAmounts,
  detectSignedAmounts,
  detectTypeColumn,
  parseSignedAmount,
} from "../../src/lib/recordTypeDetection";

/**
 * Reading a combined file's own words for which rows are money in and which are
 * money out.
 *
 * The stakes are why these are exhaustive rather than illustrative: a row filed
 * the wrong way corrupts the recovery target, the daily target and every
 * insight built on them, and nothing on screen would say it happened. The rules
 * that matter most here are the ones about REFUSING to decide.
 */
describe("classifyTypeValue", () => {
  it("reads the words a type column actually contains", () => {
    expect(classifyTypeValue("Sale")).toBe("sales");
    expect(classifyTypeValue("INCOME")).toBe("sales");
    expect(classifyTypeValue("benta")).toBe("sales");
    expect(classifyTypeValue("Expense")).toBe("expense");
    expect(classifyTypeValue("gastos")).toBe("expense");
    expect(classifyTypeValue("purchase")).toBe("expense");
  });

  it("ignores casing, padding and separators", () => {
    expect(classifyTypeValue("  sAlE  ")).toBe("sales");
    expect(classifyTypeValue("cash-out")).toBeNull(); // not a word we know
    expect(classifyTypeValue("out")).toBe("expense");
  });

  /** The important half: anything unrecognised must come back null, never a default. */
  it("refuses to decide on anything it does not recognise", () => {
    for (const value of ["", "   ", "misc", "transfer", "adjustment", "???", "load"]) {
      expect(classifyTypeValue(value)).toBeNull();
    }
    expect(classifyTypeValue(undefined)).toBeNull();
    expect(classifyTypeValue(null)).toBeNull();
  });
});

describe("parseSignedAmount", () => {
  it("reads the shapes spreadsheets actually produce", () => {
    expect(parseSignedAmount("1200")).toBe(1200);
    expect(parseSignedAmount("1,200.50")).toBe(1200.5);
    expect(parseSignedAmount("-1,200")).toBe(-1200);
    expect(parseSignedAmount("+900")).toBe(900);
    // Accounting parentheses are how a great many sheets write a negative.
    expect(parseSignedAmount("(1,200.00)")).toBe(-1200);
    expect(parseSignedAmount("PHP 350")).toBe(350);
    expect(parseSignedAmount("₱ 350")).toBe(350);
  });

  it("returns null rather than zero for anything that is not a number", () => {
    expect(parseSignedAmount("")).toBeNull();
    expect(parseSignedAmount("n/a")).toBeNull();
    expect(parseSignedAmount(undefined)).toBeNull();
  });
});

describe("detectTypeColumn", () => {
  it("finds the column by its values, not its heading", () => {
    const rows = [
      { Date: "2026-01-01", Uri: "Benta", Amount: "500" },
      { Date: "2026-01-02", Uri: "Gastos", Amount: "300" },
      { Date: "2026-01-03", Uri: "Benta", Amount: "700" },
    ];
    expect(detectTypeColumn(rows)).toBe("Uri");
  });

  /**
   * The collision this whole values-first approach exists to survive: a column
   * literally named "Type" holding CATEGORY names, which the category mapper's
   * synonym list would otherwise claim — and vice versa.
   */
  it("does not mistake a category column for a type column", () => {
    const rows = [
      { Type: "Stock", Amount: "500" },
      { Type: "Rent", Amount: "300" },
      { Type: "Utilities", Amount: "700" },
      { Type: "Wages", Amount: "700" },
    ];
    expect(detectTypeColumn(rows)).toBeNull();
  });

  it("does not mistake a free-text description for a type column", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      Description: i === 0 ? "payment for rice" : `Item number ${i}`,
      Amount: "100",
    }));
    expect(detectTypeColumn(rows)).toBeNull();
  });

  it("returns null for a file with no such column", () => {
    expect(detectTypeColumn([{ Date: "2026-01-01", Amount: "100" }])).toBeNull();
    expect(detectTypeColumn([])).toBeNull();
  });
});

describe("detectSignedAmounts", () => {
  it("needs both a negative and a positive to mean direction", () => {
    const mixed = [{ A: "100" }, { A: "-50" }];
    const allPositive = [{ A: "100" }, { A: "50" }];
    const allNegative = [{ A: "-100" }, { A: "-50" }];

    expect(detectSignedAmounts(mixed, "A")).toBe(true);
    // All positive carries no direction information at all — reading it as
    // "everything is a sale" is exactly the silent misfiling to avoid.
    expect(detectSignedAmounts(allPositive, "A")).toBe(false);
    // All negative is a formatting choice, not a distinction.
    expect(detectSignedAmounts(allNegative, "A")).toBe(false);
  });

  it("lists every candidate column for the client to match against its amount", () => {
    const rows = [
      { Debit: "-100", Credit: "200", Note: "x" },
      { Debit: "50", Credit: "-30", Note: "y" },
    ];
    expect(columnsWithSignedAmounts(rows).sort()).toEqual(["Credit", "Debit"]);
  });
});
