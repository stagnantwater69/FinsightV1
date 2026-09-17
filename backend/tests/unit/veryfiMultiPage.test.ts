import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Veryfi reads one image per HTTP call, so a three-page receipt is three
 * independent requests that can fail independently. The merge rule takes the
 * amount from the LAST page that supplied one, which is the grand total only
 * while every page was read: lose the page carrying it and the last survivor
 * is a running subtotal that looks exactly like a valid total.
 */

vi.mock("../../src/config/env", () => ({
  env: {
    VERYFI_CLIENT_ID: "client",
    VERYFI_USERNAME: "user",
    VERYFI_API_KEY: "key",
  },
}));

vi.mock("../../src/config/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { extractReceiptWithVeryfi } = await import("../../src/services/veryfiOcr.service");

const page = { buffer: Buffer.from("page-bytes"), mimetype: "image/jpeg" };

function ok(body: Record<string, unknown>): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function httpError(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Veryfi multi-page reads", () => {
  it("rejects the whole reading when the page carrying the grand total fails", async () => {
    // Pages 1 and 2 are running subtotals; page 3 has the grand total and its
    // request fails. PHP 620.00 must not be reported as this receipt's total.
    const replies = [
      ok({ total: 260, vendor: { name: "Long Receipt Store" }, date: "2026-09-14 00:00:00", line_items: [] }),
      ok({ total: 620, line_items: [] }),
      httpError(502),
    ];
    let call = 0;
    vi.stubGlobal("fetch", async () => replies[call++]!);

    const result = await extractReceiptWithVeryfi([page, page, page]);

    expect(result).toEqual({ receipt: null, rejectReason: "http" });
  });

  it("still merges when every page was read", async () => {
    const replies = [
      ok({ total: 260, vendor: { name: "Long Receipt Store" }, date: "2026-09-14 00:00:00", line_items: [] }),
      ok({ total: 620, line_items: [] }),
      ok({ total: 940, line_items: [{ description: "Rice 25kg", total: 940, quantity: 1 }] }),
    ];
    let call = 0;
    vi.stubGlobal("fetch", async () => replies[call++]!);

    const result = await extractReceiptWithVeryfi([page, page, page]);

    expect(result?.rejectReason).toBeNull();
    expect(result?.receipt).toMatchObject({
      vendor: "Long Receipt Store",
      date: "2026-09-14",
      amount: 940,
    });
  });

  it("keeps reporting a single failed page as an http rejection, not an unreachable provider", async () => {
    vi.stubGlobal("fetch", async () => httpError(401));

    const result = await extractReceiptWithVeryfi([page]);

    // null is reserved for "never usefully reached"; this page was answered.
    expect(result).toEqual({ receipt: null, rejectReason: "http" });
  });

  it("returns null when a page throws, because nothing completed a round trip", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection reset");
    });

    expect(await extractReceiptWithVeryfi([page, page])).toBeNull();
  });
});
