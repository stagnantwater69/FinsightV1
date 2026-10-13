import { describe, expect, it } from "vitest";
import { verifiedReceiptScan } from "../src/screens/records/scanReceipt/verifiedScan";

/**
 * The review screen maps over `items` inside a setState, so an items list the
 * server never sent used to surface as an uncaught TypeError mid-render while
 * every other malformed field produced a sentence the owner could read.
 */
const UNVERIFIED = "FinSight returned a receipt result that could not be verified.";

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    businessProfileId: 1,
    receiptBatchId: null,
    receiptOrdinal: null,
    scanRevision: 0,
    confirmationStatus: "Pending",
    items: [
      { id: 11, lineNumber: 1, name: "Rice 5kg", quantity: 1, unitPrice: 320, amount: 320, categoryId: 3 },
      { id: 12, lineNumber: 2, name: "Cooking oil", quantity: null, unitPrice: null, amount: 180, categoryId: null },
    ],
    ...overrides,
  };
}

describe("verifiedReceiptScan accepts a well-formed response", () => {
  it("returns the scan unchanged, items included", () => {
    const result = verifiedReceiptScan(response(), 7, 1, null);
    expect(result.items).toHaveLength(2);
  });

  it("accepts a receipt the server read no lines from", () => {
    expect(verifiedReceiptScan(response({ items: [] }), 7, 1, null).items).toEqual([]);
  });
});

describe("verifiedReceiptScan rejects a malformed item list", () => {
  it.each([
    ["items missing entirely", (() => { const body = response(); delete (body as Record<string, unknown>).items; return body; })()],
    ["items sent as null", response({ items: null })],
    ["items sent as an object", response({ items: { 0: { id: 1 } } })],
    ["an item that is not an object", response({ items: ["Rice 5kg"] })],
    ["an item with no id", response({ items: [{ lineNumber: 1, name: "Rice", quantity: null, unitPrice: null, amount: 320, categoryId: null }] })],
    ["an item with a fractional id", response({ items: [{ id: 1.5, lineNumber: 1, name: "Rice", quantity: null, unitPrice: null, amount: 320, categoryId: null }] })],
    ["two items sharing one id", response({ items: [
      { id: 11, lineNumber: 1, name: "Rice", quantity: null, unitPrice: null, amount: 320, categoryId: null },
      { id: 11, lineNumber: 2, name: "Oil", quantity: null, unitPrice: null, amount: 180, categoryId: 2 },
    ] })],
    ["an item whose name is not text", response({ items: [{ id: 11, lineNumber: 1, name: 42, quantity: null, unitPrice: null, amount: 320, categoryId: null }] })],
    ["an item whose amount is a string", response({ items: [{ id: 11, lineNumber: 1, name: "Rice", quantity: null, unitPrice: null, amount: "320.00", categoryId: null }] })],
    ["an item whose amount is NaN", response({ items: [{ id: 11, lineNumber: 1, name: "Rice", quantity: null, unitPrice: null, amount: Number.NaN, categoryId: null }] })],
    ["an item with a nonsense category id", response({ items: [{ id: 11, lineNumber: 1, name: "Rice", quantity: null, unitPrice: null, amount: 320, categoryId: 0 }] })],
  ])("refuses %s", (_case, body) => {
    expect(() => verifiedReceiptScan(body, 7, 1, null)).toThrow(UNVERIFIED);
  });

  it("refuses items before any of them can reach the review screen", () => {
    // The same sentence every other malformed field produces, not a TypeError.
    const failure = (() => {
      try { verifiedReceiptScan(response({ items: undefined }), 7, 1, null); return null; }
      catch (err) { return err; }
    })();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(UNVERIFIED);
    expect((failure as Error)).not.toBeInstanceOf(TypeError);
  });
});

describe("verifiedReceiptScan keeps its existing guards", () => {
  it("refuses a scan whose id is not the one that was asked for", () => {
    expect(() => verifiedReceiptScan(response(), 8, 1, null)).toThrow(UNVERIFIED);
  });

  it("refuses a scan bound to another business profile", () => {
    expect(() => verifiedReceiptScan(response(), 7, 2, null)).toThrow(UNVERIFIED);
  });

  it("refuses a batch child whose ordinal does not match", () => {
    const body = response({ receiptBatchId: 4, receiptOrdinal: 2 });
    expect(() => verifiedReceiptScan(body, 7, 1, { batchId: 4, ordinal: 1 })).toThrow(UNVERIFIED);
  });
});
