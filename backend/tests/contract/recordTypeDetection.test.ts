import { describe, expect, it } from "vitest";
// The REAL constants, imported across the project boundary — not copies of copies.
import * as server from "../../src/lib/recordTypeDetection";
import * as web from "../../../web/src/lib/recordTypeDetection";
import * as mobile from "../../../mobile/src/lib/recordTypeDetection";

/**
 * The three copies of the sale/expense reader must agree, exactly.
 *
 * WHY THIS TEST EXISTS. The clients mirror `classifyTypeValue` so the mapping
 * preview can badge each row with what it will become before the import runs —
 * they cannot ask the server what fifty rows would become without re-uploading
 * the file. That mirroring buys a preview that is worth looking at, and costs
 * the risk that the two drift.
 *
 * A drift here is the worst failure this feature has available. The preview
 * would show an owner "42 sales, 8 expenses", the server would file some of
 * those rows the other way, and nothing anywhere would report a problem — the
 * import succeeds, the numbers are wrong, and the screen that was supposed to
 * be the safeguard is the thing that lied. So one word added to the server's
 * list and not to the clients' fails here rather than in someone's books.
 */
describe("sale/expense word lists are identical across server, web and mobile", () => {
  const sorted = (s: Set<string>) => [...s].sort();

  it("agree on which words mean a sale", () => {
    expect(sorted(web.SALES_WORDS)).toEqual(sorted(server.SALES_WORDS));
    expect(sorted(mobile.SALES_WORDS)).toEqual(sorted(server.SALES_WORDS));
  });

  it("agree on which words mean an expense", () => {
    expect(sorted(web.EXPENSE_WORDS)).toEqual(sorted(server.EXPENSE_WORDS));
    expect(sorted(mobile.EXPENSE_WORDS)).toEqual(sorted(server.EXPENSE_WORDS));
  });

  /** No word may mean both — the classifier checks sales first and would hide the clash. */
  it("never assign the same word to both directions", () => {
    const overlap = [...server.SALES_WORDS].filter((w) => server.EXPENSE_WORDS.has(w));
    expect(overlap).toEqual([]);
  });

  /**
   * Behaviour, not just data: the same inputs must classify the same way in all
   * three, including the ones that must refuse to classify at all.
   */
  it("classify the same values the same way", () => {
    const cases = [
      "Sale",
      "sales",
      "INCOME",
      "benta",
      "Expense",
      "gastos",
      "purchase",
      "debit",
      "credit",
      "  sAlE  ",
      "misc",
      "transfer",
      "",
      "load",
    ];
    for (const value of cases) {
      const expected = server.classifyTypeValue(value);
      expect(web.classifyTypeValue(value), `web disagreed on "${value}"`).toBe(expected);
      expect(mobile.classifyTypeValue(value), `mobile disagreed on "${value}"`).toBe(expected);
    }
  });

  it("read the same amounts the same way", () => {
    const cases = ["1200", "1,200.50", "-1,200", "(1,200.00)", "PHP 350", "+900", "", "n/a"];
    for (const value of cases) {
      const expected = server.parseSignedAmount(value);
      expect(web.parseSignedAmount(value), `web disagreed on "${value}"`).toBe(expected);
      expect(mobile.parseSignedAmount(value), `mobile disagreed on "${value}"`).toBe(expected);
    }
  });
});
