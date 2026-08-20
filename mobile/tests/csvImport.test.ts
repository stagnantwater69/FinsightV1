import { describe, expect, it } from "vitest";
import {
  EMPTY_MAPPING,
  analyseRows,
  checkMapping,
  columnMappingPayload,
  correctionsPayload,
  defaultImportTitle,
  guessColumn,
  guessMapping,
  importProgress,
  newCategoryNames,
  newIdempotencyKey,
  problemsFirst,
  rowProblem,
  type ColumnMapping,
  type RowRules,
  type RowValues,
} from "../src/lib/csvImport";
import { parseCsvDate } from "../src/lib/csvDates";
import { FIELD_LIMITS } from "../src/lib/fieldLimits";

/**
 * The import screen's rules, tested where they can be tested.
 *
 * Mobile has no render harness, so everything worth checking about this
 * feature lives in src/lib and is exercised here: the mapping guess, the row
 * rules mirrored from csvImport.service's validateRows, the two payload
 * shapes the server parses, and the replay token that makes a retry safe.
 * What is NOT covered is the screen itself — that is stated in the report
 * rather than implied by a green suite.
 */

const RULES: RowRules = { recordType: "expense", mixedStrategy: "column", dateFormat: "iso" };

function values(overrides: Partial<RowValues> = {}): RowValues {
  return {
    date: "2026-01-05",
    description: "Rice sack",
    amount: "1200.50",
    category: "Inventory",
    vendor: "Aling Nena",
    recordType: "",
    ...overrides,
  };
}

describe("column guessing", () => {
  it("matches an exact heading before a partial one", () => {
    expect(guessColumn(["Txn Date (PHP)", "Date"], "date")).toBe("Date");
  });

  it("still finds a heading that carries extra words", () => {
    expect(guessColumn(["Txn Date (PHP)"], "date")).toBe("Txn Date (PHP)");
    expect(guessColumn(["Supplier name"], "vendor")).toBe("Supplier name");
  });

  it("normalises separators and case the way a spreadsheet export writes them", () => {
    expect(guessColumn(["TRANS_DATE"], "date")).toBe("TRANS_DATE");
  });

  it("guesses a vendor column, which mobile previously could not map at all", () => {
    const { mapping } = guessMapping(["Date", "Item", "Store", "Amount", "Category"], {});
    expect(mapping.vendor).toBe("Store");
  });

  /*
   * The specific silent failure this prevents: "type" is a category synonym,
   * so a Sale/Expense column auto-mapped as categories would have the import
   * create two permanent categories called "Sale" and "Expense".
   */
  it("lets a detected sale/expense column take itself back from category", () => {
    const { mapping, recordType, mixedStrategy } = guessMapping(
      ["Date", "Description", "Amount", "Type"],
      { detectedTypeColumn: "Type" },
    );
    expect(mapping.recordType).toBe("Type");
    expect(mapping.category).toBe("");
    expect(recordType).toBe("mixed");
    expect(mixedStrategy).toBe("column");
  });

  it("offers the sign convention when the amount column carries negatives", () => {
    const { recordType, mixedStrategy } = guessMapping(["Date", "Description", "Amount"], {
      columnsWithNegatives: ["Amount"],
    });
    expect(recordType).toBe("mixed");
    expect(mixedStrategy).toBe("sign");
  });
});

describe("mapping validity", () => {
  it("requires a category for a pure expense import but not for a mixed one", () => {
    const mapping: ColumnMapping = { ...EMPTY_MAPPING, date: "D", description: "N", amount: "A" };
    expect(checkMapping(mapping, "expense", "column").missing).toEqual(["category"]);
    expect(checkMapping(mapping, "mixed", "sign").missing).toEqual([]);
    expect(checkMapping(mapping, "sales", "column").missing).toEqual([]);
  });

  it("refuses one column pointed at two fields", () => {
    const mapping: ColumnMapping = { ...EMPTY_MAPPING, date: "D", description: "A", amount: "A", category: "C" };
    const check = checkMapping(mapping, "expense", "column");
    expect(check.duplicated).toEqual(["A"]);
    expect(check.ready).toBe(false);
  });

  it("ignores a collision on a field this record type never sends", () => {
    // Category is not offered for a sales import, so a leftover value in it
    // must not block a mapping the server would accept.
    const mapping: ColumnMapping = { ...EMPTY_MAPPING, date: "D", description: "N", amount: "A", category: "A" };
    expect(checkMapping(mapping, "sales", "column").ready).toBe(true);
  });
});

describe("row rules mirror the server's validateRows", () => {
  it("accepts a good row", () => {
    expect(rowProblem(values(), RULES)).toBeNull();
  });

  /*
   * The ORDER is the assertion. Only the first problem is shown, so a row
   * reported as a bad date that the server skips for a missing description
   * would send the owner to fix the wrong cell.
   */
  it("reports the missing description before anything else that is also wrong", () => {
    expect(rowProblem(values({ description: "  ", date: "nonsense", amount: "-5" }), RULES)).toEqual({
      field: "description",
      reason: "Missing description",
    });
  });

  it("uses the server's own sentences", () => {
    expect(rowProblem(values({ date: "31/02/2026" }), RULES)).toEqual({
      field: "date",
      reason: 'Invalid date: "31/02/2026"',
    });
    expect(rowProblem(values({ amount: "abc" }), RULES)).toEqual({
      field: "amount",
      reason: 'Invalid amount: "abc"',
    });
    expect(rowProblem(values({ amount: "12000000000" }), RULES)).toEqual({
      field: "amount",
      reason: 'Amount too large: "12000000000"',
    });
    expect(rowProblem(values({ amount: "10.005" }), RULES)).toEqual({
      field: "amount",
      reason: 'Invalid amount: "10.005" has more than two decimal places',
    });
    expect(rowProblem(values({ category: "" }), RULES)).toEqual({
      field: "category",
      reason: "Missing category",
    });
  });

  it("enforces the same cell limits the columns behind them have", () => {
    expect(rowProblem(values({ description: "x".repeat(FIELD_LIMITS.recordDescription + 1) }), RULES)?.field).toBe(
      "description",
    );
    expect(rowProblem(values({ category: "x".repeat(FIELD_LIMITS.categoryName + 1) }), RULES)?.field).toBe("category");
    expect(rowProblem(values({ vendor: "x".repeat(FIELD_LIMITS.vendor + 1) }), RULES)?.field).toBe("vendor");
    // An EMPTY vendor is simply no vendor, never a rejection.
    expect(rowProblem(values({ vendor: "" }), RULES)).toBeNull();
  });

  /*
   * A negative amount is only meaningful under the sign convention. In a file
   * that is not using it, a negative stays the invalid amount it has always
   * been rather than quietly becoming a positive one.
   */
  it("only reads a minus sign as a record type when the file says it means one", () => {
    expect(rowProblem(values({ amount: "-120" }), RULES)?.field).toBe("amount");
    const signRules: RowRules = { recordType: "mixed", mixedStrategy: "sign", dateFormat: "iso" };
    expect(rowProblem(values({ amount: "-120", category: "" }), signRules)).toBeNull();
  });

  it("refuses to guess a row the type column does not classify", () => {
    const columnRules: RowRules = { recordType: "mixed", mixedStrategy: "column", dateFormat: "iso" };
    expect(rowProblem(values({ recordType: "wala" }), columnRules)).toEqual({
      field: "recordType",
      reason: 'Could not tell if "wala" means a sale or an expense',
    });
    expect(rowProblem(values({ recordType: "" }), columnRules)).toEqual({
      field: "recordType",
      reason: "Missing sale/expense value",
    });
    expect(rowProblem(values({ recordType: "benta", category: "" }), columnRules)).toBeNull();
  });

  it("lets a mixed file's expense row through without a category", () => {
    const mixedRules: RowRules = { recordType: "mixed", mixedStrategy: "column", dateFormat: "iso" };
    expect(rowProblem(values({ recordType: "expense", category: "" }), mixedRules)).toBeNull();
  });
});

/*
 * The date parser is the reason this pre-check is worth having at all: web
 * still validates with `new Date(rawDate)`, which reads slash-dates
 * month-first in LOCAL time and rolls impossible days over. Mirroring the
 * server's calendar parser instead is what keeps the pre-check from
 * disagreeing with the import that follows it.
 */
describe("calendar dates", () => {
  it("reads the chosen convention rather than guessing one", () => {
    expect(parseCsvDate("05/01/2026", "dmy")).toBe("2026-01-05");
    expect(parseCsvDate("05/01/2026", "mdy")).toBe("2026-05-01");
  });

  it("accepts ISO under every convention, because ISO cannot be misread", () => {
    expect(parseCsvDate("2026-01-05", "dmy")).toBe("2026-01-05");
    expect(parseCsvDate("2026-01-05", "mdy")).toBe("2026-01-05");
    expect(parseCsvDate("2026-01-05", "iso")).toBe("2026-01-05");
  });

  it("rejects a day that does not exist instead of rolling it over", () => {
    expect(parseCsvDate("31/02/2026", "dmy")).toBeNull();
    expect(parseCsvDate("2026-02-31", "iso")).toBeNull();
  });

  it("rejects a two-digit year, which no format choice can rescue", () => {
    expect(parseCsvDate("05/01/26", "dmy")).toBeNull();
  });

  it("rejects a date outside the plausible range for a business record", () => {
    expect(parseCsvDate("1899-01-01", "iso")).toBeNull();
    expect(parseCsvDate("2999-01-01", "iso")).toBeNull();
  });

  it("reads a spelled-out month", () => {
    expect(parseCsvDate("5 Jan 2026", "month-name")).toBe("2026-01-05");
    expect(parseCsvDate("January 5, 2026", "month-name")).toBe("2026-01-05");
  });
});

describe("row review", () => {
  const mapping: ColumnMapping = {
    ...EMPTY_MAPPING,
    date: "Date",
    description: "Item",
    amount: "Amount",
    category: "Category",
  };
  const rows = [
    { Date: "2026-01-05", Item: "Rice", Amount: "1200", Category: "Inventory" },
    { Date: "not a date", Item: "Oil", Amount: "300", Category: "Inventory" },
    { Date: "2026-01-07", Item: "Salt", Amount: "50", Category: "Inventory" },
  ];

  it("numbers rows the way the spreadsheet does, so the number is findable in Excel", () => {
    const analysed = analyseRows(rows, mapping, {}, RULES);
    expect(analysed.map((r) => r.rowNumber)).toEqual([2, 3, 4]);
  });

  it("applies a typed correction over the file's own cell", () => {
    const analysed = analyseRows(rows, mapping, { 3: { date: "2026-01-06" } }, RULES);
    expect(analysed[1]!.problem).toBeNull();
    expect(analysed[1]!.values.date).toBe("2026-01-06");
  });

  it("checks a corrected value by exactly the same rules", () => {
    const analysed = analyseRows(rows, mapping, { 3: { date: "still not a date" } }, RULES);
    expect(analysed[1]!.problem?.field).toBe("date");
  });

  it("puts problem rows first while keeping each group in file order", () => {
    const analysed = problemsFirst(
      analyseRows([...rows, { Date: "", Item: "Sugar", Amount: "80", Category: "Inventory" }], mapping, {}, RULES),
    );
    expect(analysed.map((r) => r.rowNumber)).toEqual([3, 5, 2, 4]);
  });

  it("names the categories this import would create, deduplicated the server's way", () => {
    const analysed = analyseRows(
      [
        { Date: "2026-01-05", Item: "Rice", Amount: "10", Category: "Inventory" },
        { Date: "2026-01-05", Item: "Oil", Amount: "10", Category: "inventory" },
        { Date: "2026-01-05", Item: "Ice", Amount: "10", Category: "Inventroy" },
      ],
      mapping,
      {},
      RULES,
    );
    expect(newCategoryNames(analysed, ["Inventory"])).toEqual(["Inventroy"]);
  });
});

describe("payloads the server parses", () => {
  it("omits optional columns rather than sending them empty", () => {
    const mapping: ColumnMapping = { ...EMPTY_MAPPING, date: "D", description: "N", amount: "A" };
    expect(columnMappingPayload(mapping, "expense", "column")).toEqual({ date: "D", description: "N", amount: "A" });
  });

  it("sends vendor and category only where the record type can carry them", () => {
    const mapping: ColumnMapping = {
      ...EMPTY_MAPPING,
      date: "D",
      description: "N",
      amount: "A",
      category: "C",
      vendor: "V",
      recordType: "T",
    };
    expect(columnMappingPayload(mapping, "sales", "column")).toEqual({ date: "D", description: "N", amount: "A" });
    expect(columnMappingPayload(mapping, "mixed", "column")).toEqual({
      date: "D",
      description: "N",
      amount: "A",
      category: "C",
      vendor: "V",
      recordType: "T",
    });
    // The sign convention needs no type column, so one must not be sent.
    expect(columnMappingPayload(mapping, "mixed", "sign").recordType).toBeUndefined();
  });

  it("keys corrections by row number and drops rows with nothing in them", () => {
    expect(correctionsPayload({ 3: { date: "2026-01-06" }, 5: {} })).toEqual({ "3": { date: "2026-01-06" } });
  });

  it("keeps a deliberately cleared cell, which is a real correction", () => {
    expect(correctionsPayload({ 4: { category: "" } })).toEqual({ "4": { category: "" } });
  });
});

describe("batch title", () => {
  it("drops the extension, which is a file name and not a name for a month of records", () => {
    expect(defaultImportTitle("January expenses.csv")).toBe("January expenses");
    expect(defaultImportTitle("JANUARY.CSV")).toBe("JANUARY");
  });

  /*
   * THE 400 THIS FIXES: mobile posted file.name raw, and the server caps the
   * title at 150 characters — so a long export name failed the whole import
   * with a validation error naming a field the screen never showed.
   */
  it("truncates to the server's limit", () => {
    const long = `${"a".repeat(400)}.csv`;
    expect(defaultImportTitle(long).length).toBeLessThanOrEqual(FIELD_LIMITS.importTitle);
  });

  it("breaks on a word where that still keeps most of the allowance", () => {
    const title = defaultImportTitle(`${"word ".repeat(60)}.csv`);
    expect(title.length).toBeLessThanOrEqual(FIELD_LIMITS.importTitle);
    expect(title.endsWith("word")).toBe(true);
  });

  it("never returns an empty title, which the server rejects", () => {
    expect(defaultImportTitle(".csv")).toBe("Imported records");
    expect(defaultImportTitle("")).toBe("Imported records");
  });
});

describe("idempotency key", () => {
  it("fits the server's 8..100 character range", () => {
    const key = newIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(100);
  });

  it("does not repeat, including within the same millisecond", () => {
    const keys = new Set(Array.from({ length: 500 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(500);
  });
});

describe("import progress", () => {
  it("reports real counts once the server knows how many rows there are", () => {
    expect(importProgress({ totalRows: 200, processedRows: 50 })).toEqual({ done: 50, total: 200, fraction: 0.25 });
  });

  /*
   * ADR-4: never fake determinate progress. Before the row count is known
   * there is nothing honest to draw, so the screen is given null and says
   * "still working" rather than animating a bar off an invented denominator.
   */
  it("has nothing to draw before the row count exists", () => {
    expect(importProgress({})).toBeNull();
    expect(importProgress({ totalRows: 0, processedRows: 0 })).toBeNull();
    expect(importProgress({ totalRows: null, processedRows: 12 })).toBeNull();
  });

  it("clamps a count that overshoots rather than drawing past the end", () => {
    expect(importProgress({ totalRows: 10, processedRows: 40 })?.fraction).toBe(1);
  });
});
