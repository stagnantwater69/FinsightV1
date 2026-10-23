import { describe, expect, it } from "vitest";
import { philippineDate, readNumericDate, resolveNumericDate } from "../../src/lib/receiptDates";
import { parseReceiptFields } from "../../src/services/ocr.service";

describe("resolving an open day/month order against the upload date", () => {
  it("reads a Manila month-first date the way the upload date points", () => {
    // Wendy's, printed 07/06/2024, photographed on 6 July.
    expect(resolveNumericDate(7, 6, 2024, "2024-07-06")).toEqual({ iso: "2024-07-06", ambiguous: true });
  });

  it("still reads the Cebu day-first receipt that set the old default correctly", () => {
    // 11/07/2026 is 11 July; 7 November would be after the upload.
    expect(resolveNumericDate(11, 7, 2026, "2026-07-12")).toEqual({ iso: "2026-07-11", ambiguous: false });
  });

  it("drops the flag only when the upload date rules one reading out", () => {
    // 06/08/2024 uploaded on 6 July: 8 June is possible, 6 August is not.
    expect(resolveNumericDate(6, 8, 2024, "2024-07-06")).toEqual({ iso: "2024-06-08", ambiguous: false });
    // Both possible: the later one wins and the owner is still asked to check.
    expect(resolveNumericDate(3, 9, 2026, "2026-10-01")).toEqual({ iso: "2026-09-03", ambiguous: true });
  });

  it("allows one day of clock difference at the upload boundary", () => {
    expect(resolveNumericDate(7, 6, 2024, "2024-07-05")).toEqual({ iso: "2024-07-06", ambiguous: true });
    expect(resolveNumericDate(7, 6, 2024, "2024-07-04")).toEqual({ iso: "2024-06-07", ambiguous: false });
  });

  it("falls back to day-first without an upload date, or when both readings are later", () => {
    expect(resolveNumericDate(7, 6, 2024, null)).toEqual({ iso: "2024-06-07", ambiguous: true });
    expect(resolveNumericDate(7, 6, 2024, "2024-01-01")).toEqual({ iso: "2024-06-07", ambiguous: true });
  });

  it("leaves dates the paper settles alone", () => {
    expect(resolveNumericDate(6, 18, 2024, "2024-07-06")).toEqual({ iso: "2024-06-18", ambiguous: false });
    expect(resolveNumericDate(31, 1, 2024, "2024-07-06")).toEqual({ iso: "2024-01-31", ambiguous: false });
    expect(resolveNumericDate(5, 5, 2024, "2024-07-06")).toEqual({ iso: "2024-05-05", ambiguous: false });
    expect(resolveNumericDate(31, 2, 2024, "2024-07-06")).toBeNull();
  });

  it("finds the printed date in text and keeps what it read", () => {
    expect(readNumericDate("Date: 07/06/24 5:15 PM", "2024-07-06")).toMatchObject({
      iso: "2024-07-06",
      ambiguous: true,
      sourceText: "07/06/24",
    });
  });

  it("takes the upload day in Philippine time", () => {
    // 20:00 UTC on 5 July is 04:00 on 6 July in Manila.
    expect(philippineDate(new Date("2024-07-05T20:00:00Z"))).toBe("2024-07-06");
  });
});

describe("the local parser with an upload date", () => {
  const receipt = "WENDY'S HAMBURGER RESTAURANT\nSI# 065-003-0000038015 07/06/2024\nDINE IN Total 251.00";

  it("settles the day/month order and keeps it flagged", () => {
    const parsed = parseReceiptFields(receipt, { referenceDate: "2024-07-06" });
    expect(parsed.date).toBe("2024-07-06");
    expect(parsed.dateAmbiguous).toBe(true);
    expect(parsed.dateSourceText).toBe("07/06/2024");
  });

  it("reads day-first without one, as before", () => {
    expect(parseReceiptFields(receipt).date).toBe("2024-06-07");
  });
});
