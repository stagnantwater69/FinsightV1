import { describe, expect, it } from "vitest";
import {
  RECEIPT_WARNING_CODES,
  fieldsNeedingAttention,
  warningHeadline,
  warningPageSuffix,
  warningTone,
} from "./receiptWarnings";

describe("receipt warning presentation", () => {
  it("has a short plain headline for every code the server can send", () => {
    for (const code of RECEIPT_WARNING_CODES) {
      const headline = warningHeadline(code);
      expect(headline).not.toBe(warningHeadline("SOMETHING_NEW"));
      expect(headline).not.toContain("—");
      expect(headline.length).toBeLessThanOrEqual(60);
    }
  });

  it("names unverified provider items without repeating the server's guidance", () => {
    expect(RECEIPT_WARNING_CODES).toContain("UNVERIFIED_ITEMS");
    expect(warningHeadline("UNVERIFIED_ITEMS")).toBe("The AI-read items still need checking");
    expect(warningHeadline("UNVERIFIED_ITEMS")).not.toBe(warningHeadline("UNEXPLAINED_GAP"));
    expect(warningTone("UNVERIFIED_ITEMS")).toBe("warn");
  });

  it("falls back to a generic headline for a code this build does not know", () => {
    expect(warningHeadline("SOMETHING_NEW")).toBe("FinSight flagged something on this receipt");
  });

  it("keeps only the capture-overlap note informational", () => {
    expect(warningTone("OVERLAPPING_PAGES")).toBe("info");
    expect(warningTone("BLURRY_PAGE")).toBe("warn");
  });

  it("formats the page suffix only when a page is named", () => {
    expect(warningPageSuffix({ code: "BLURRY_PAGE", guidance: null, pageNumber: 2 })).toBe(" (page 2)");
    expect(warningPageSuffix({ code: "BLURRY_PAGE", guidance: null })).toBe("");
  });

  it("lists attention fields in form order with aliases normalised", () => {
    expect(fieldsNeedingAttention([
      { code: "UNREADABLE_FIELD", guidance: null, field: "total" },
      { code: "AMBIGUOUS_DATE", guidance: null, field: "extractedDate" },
      { code: "UNVERIFIED_ITEMS", guidance: null },
    ])).toEqual(["date", "amount"]);
  });
});
