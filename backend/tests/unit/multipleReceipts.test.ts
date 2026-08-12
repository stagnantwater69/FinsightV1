import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeMultipleReceipts } from "../../src/services/ocr.service";

/**
 * The claim this check rests on is a measurement, not an intuition: on the
 * accuracy corpus no single receipt carries two date labels, so counting them
 * never cries wolf. That measurement is only true of the corpus as it stands,
 * and the corpus grows (see ingest-images.ts) — so it is asserted here rather
 * than written down in a comment and quietly outgrown.
 */
const results = JSON.parse(
  readFileSync(join(__dirname, "../ocr-accuracy/results.json"), "utf8"),
) as { id: string; rawText: string | null }[];

const withText = results.filter((r) => r.rawText);

describe("looksLikeMultipleReceipts", () => {
  it("has a corpus to measure against", () => {
    expect(withText.length).toBeGreaterThan(20);
  });

  it("never fires on a single receipt in the corpus", () => {
    const flagged = withText.filter((r) => looksLikeMultipleReceipts(r.rawText)).map((r) => r.id);
    // A false positive here is worse than no check at all: it would tell an
    // owner their ordinary receipt is two receipts, on most receipts.
    expect(flagged).toEqual([]);
  });

  it("fires on two corpus receipts photographed together", () => {
    // Every pair whose halves BOTH carry a date label must be caught. Pairs
    // where one half prints no date are a known blind spot and are excluded
    // rather than silently lowering the bar for the rest.
    const dated = withText.filter((r) => /\bdate\s*[:.]/i.test(r.rawText!));
    expect(dated.length).toBeGreaterThan(20);

    const missed: string[] = [];
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length; j++) {
        const together = `${dated[i]!.rawText}\n${dated[j]!.rawText}`;
        if (!looksLikeMultipleReceipts(together)) missed.push(`${dated[i]!.id}+${dated[j]!.id}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("treats a receipt with many total-ish lines as one receipt", () => {
    // The real Palawan sales invoice prints three: "Total gross value",
    // "Total QTY" and "AMOUNT DUE". Counting the word TOTAL would call this
    // three receipts, which is exactly the mistake this check must not make.
    const oneReceipt = [
      "SALES INVOICE",
      "DATE: 6/4/2026 TIME: 4:11:36 PM",
      "2 CANISTER STUFF 110.00",
      "Total gross value: 2,185.00",
      "Prod. Discounts: 5.00",
      "Total QTY: 16",
      "AMOUNT DUE: 2,180.00",
    ].join("\n");
    expect(looksLikeMultipleReceipts(oneReceipt)).toBe(false);
  });

  it("says no rather than guessing when there is no text", () => {
    expect(looksLikeMultipleReceipts(null)).toBe(false);
    expect(looksLikeMultipleReceipts("")).toBe(false);
  });
});
