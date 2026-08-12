import { describe, expect, it } from "vitest";
import {
  buildExpenseUpdatePayload,
  buildSalesUpdatePayload,
  recordUpdatePath,
} from "../src/lib/recordUpdate";

/**
 * Editing a saved record.
 *
 * The trap here is that expense and sales take DIFFERENT fields server-side —
 * a sales record has no category and no vendor. Those endpoints are not
 * strict, so sending an extra field is silently discarded rather than
 * refused, which is precisely how the receipt-confirm bug stayed invisible.
 * These pin the difference.
 */

const base = { date: "2026-07-31", description: "Rice and oil", amount: 1400 };

describe("expense updates", () => {
  it("sends the fields the expense endpoint defines", () => {
    const out = buildExpenseUpdatePayload({ ...base, categoryId: 7, vendor: "Savemore" });
    expect(out).toEqual({
      categoryId: 7,
      date: "2026-07-31",
      description: "Rice and oil",
      vendor: "Savemore",
      amount: 1400,
    });
  });

  /** null CLEARS the vendor; "" would store a blank one. */
  it("clears a vendor with null rather than an empty string", () => {
    expect(buildExpenseUpdatePayload({ ...base, categoryId: 7, vendor: "   " }).vendor).toBeNull();
    expect(buildExpenseUpdatePayload({ ...base, categoryId: 7 }).vendor).toBeNull();
  });

  it("trims a real vendor and description", () => {
    const out = buildExpenseUpdatePayload({
      ...base,
      description: "  Rice and oil  ",
      categoryId: 7,
      vendor: "  Savemore  ",
    });
    expect(out.vendor).toBe("Savemore");
    expect(out.description).toBe("Rice and oil");
  });

  /**
   * An expense with no category cannot be saved — the column is NOT NULL.
   * Failing here beats sending a payload the server rejects for a reason the
   * owner would have to decode.
   */
  it("refuses to build an expense with no category", () => {
    expect(() => buildExpenseUpdatePayload({ ...base })).toThrow(/category/i);
    expect(() => buildExpenseUpdatePayload({ ...base, categoryId: null })).toThrow(/category/i);
  });
});

describe("sales updates", () => {
  it("sends only the fields the sales endpoint defines", () => {
    const out = buildSalesUpdatePayload({ ...base, categoryId: 7, vendor: "Savemore" });
    expect(out).toEqual({ date: "2026-07-31", description: "Rice and oil", amount: 1400 });
  });

  /**
   * The specific mistake this guards. A sales record has no category and no
   * vendor server-side, so including either would be silently dropped — and a
   * silent drop is what nobody notices.
   */
  it("never sends a category or vendor on a sales record", () => {
    const out = buildSalesUpdatePayload({ ...base, categoryId: 7, vendor: "Savemore" });
    expect(out).not.toHaveProperty("categoryId");
    expect(out).not.toHaveProperty("vendor");
  });

  it("trims the description", () => {
    expect(buildSalesUpdatePayload({ ...base, description: "  Sales  " }).description).toBe("Sales");
  });
});

describe("where the edit is sent", () => {
  it("routes each type to its own endpoint", () => {
    expect(recordUpdatePath("expense", 12)).toBe("/records/expenses/12");
    expect(recordUpdatePath("sales", 12)).toBe("/records/sales/12");
  });
});
