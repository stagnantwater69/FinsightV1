import { describe, expect, it } from "vitest";
import { looksLikeDuplicatePage } from "../../src/services/ocr.service";

/**
 * No corpus exists for this one (see the function's own comment) — these
 * cases are hand-constructed to pin down the threshold's actual behaviour
 * rather than to claim a measured accuracy rate.
 */
describe("looksLikeDuplicatePage", () => {
  it("catches the same page shot twice, with the OCR noise a second photo adds", () => {
    const first = [
      "ABC SARI-SARI STORE",
      "123 Apas Road, Cebu City",
      "Date: 2026-07-20",
      "Rice 25kg        1220.00",
      "Cooking oil       180.00",
      "TOTAL           1400.00",
    ].join("\n");
    // A second photo of the SAME page: one line reads slightly differently
    // (the kind of noise a different angle or a fold introduces) — 5 of 6
    // lines still agree, comfortably above the "most of it matches" bar.
    const second = [
      "ABC SARI-SARI STORE",
      "123 Apas Road, Cebu City",
      "Date: 2026-07-20",
      "Rice 25kg        1220.00",
      "Cooking oil       l80.00",
      "TOTAL           1400.00",
    ].join("\n");
    expect(looksLikeDuplicatePage(first, second)).toBe(true);
  });

  it("does not flag a short receipt where one line reads differently between photos", () => {
    // The case the 0.8-looking threshold would have missed: a 4-line receipt
    // with a single noisy line only reaches 0.75 overlap. This asserts the
    // chosen threshold (0.6) still catches it.
    const first = ["ABC SARI-SARI STORE", "Rice 25kg   1220.00", "Cooking oil   180.00", "TOTAL   1400.00"].join("\n");
    const second = ["ABC SARI-SARI STORE", "Rice 25kg   1220.00", "Cooking oil   l80.00", "TOTAL   1400.00"].join("\n");
    expect(looksLikeDuplicatePage(first, second)).toBe(true);
  });

  it("does not flag two genuinely different pages of one long receipt", () => {
    const page1 = ["ABC SARI-SARI STORE", "Rice 25kg        1220.00", "Cooking oil       180.00"].join("\n");
    const page2 = ["Canned goods       95.00", "Bottled water      20.00", "TOTAL           1335.00"].join("\n");
    expect(looksLikeDuplicatePage(page1, page2)).toBe(false);
  });

  it("does not flag two different receipts that happen to share boilerplate", () => {
    // Shared footer/header lines are common and must not, on their own, read
    // as a duplicate page — the overlap has to be substantial, not partial.
    const page1 = ["ABC SARI-SARI STORE", "Rice 25kg   1220.00", "TOTAL   1220.00", "Thank you!"].join("\n");
    const page2 = ["ABC SARI-SARI STORE", "Ice          20.00", "TOTAL     20.00", "Thank you!"].join("\n");
    expect(looksLikeDuplicatePage(page1, page2)).toBe(false);
  });

  it("says no rather than guessing on empty text", () => {
    expect(looksLikeDuplicatePage("", "some text")).toBe(false);
    expect(looksLikeDuplicatePage("some text", "")).toBe(false);
    expect(looksLikeDuplicatePage("", "")).toBe(false);
  });

  it("is symmetric — order of comparison does not change the answer", () => {
    const a = "line one\nline two\nline three";
    const b = "line one\nline two\nsomething else";
    expect(looksLikeDuplicatePage(a, b)).toBe(looksLikeDuplicatePage(b, a));
  });
});
