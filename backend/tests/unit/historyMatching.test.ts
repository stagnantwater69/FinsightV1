import { describe, expect, it } from "vitest";
import {
  bestMatch,
  findKnownVendorInText,
  MATCH_THRESHOLD,
  normaliseForMatch,
  similarity,
} from "../../src/lib/historyMatching";

/**
 * The cases that must NOT match matter more than the ones that must.
 *
 * A missed correction leaves the owner exactly where they are today: a mangled
 * name they can see is mangled and fix. A WRONG correction files a receipt
 * under a shop they never visited, presented confidently, with nothing on
 * screen suggesting it was altered. The threshold is set by the second risk,
 * not the first.
 */
describe("similarity", () => {
  it("treats OCR glyph swaps as the same name", () => {
    // The substitutions tesseract actually makes on thermal print.
    expect(similarity("SAVEM0RE MARKET", "SAVEMORE MARKET")).toBe(1);
    expect(similarity("5AVEMORE MARKET", "SAVEMORE MARKET")).toBe(1);
    expect(similarity("PUREG0LD PRICE CLUB", "PUREGOLD PRICE CLUB")).toBe(1);
  });

  it("ignores case, punctuation and spacing", () => {
    expect(similarity("Savemore Market, Inc.", "SAVEMORE MARKET INC")).toBe(1);
    expect(similarity("  ALFAMART   ", "Alfamart")).toBe(1);
  });

  it("scores unrelated names near zero", () => {
    expect(similarity("ALFAMART", "PUREGOLD")).toBeLessThan(0.3);
  });
});

describe("bestMatch", () => {
  const known = ["SAVEMORE MARKET", "PUREGOLD PRICE CLUB", "ALFAMART"];

  it("corrects a noisy reading to the confirmed spelling", () => {
    expect(bestMatch("SAVEM0RE MARKET", known)?.value).toBe("SAVEMORE MARKET");
  });

  it("leaves a genuinely new vendor alone", () => {
    expect(bestMatch("MERCURY DRUG", known)).toBeNull();
  });

  /**
   * Two real Philippine chains two characters apart. Merging them would file a
   * receipt under a shop the owner never visited — the failure this threshold
   * exists to prevent.
   */
  it("does not merge two different shops with similar names", () => {
    expect(similarity("SM SUPERMARKET", "SM HYPERMARKET")).toBeLessThan(MATCH_THRESHOLD);
    expect(bestMatch("SM HYPERMARKET", ["SM SUPERMARKET"])).toBeNull();
  });

  it("does not match on short names, where one character is too much of the whole", () => {
    // "TAN" vs "TAM" is one edit on three characters. No threshold can tell a
    // misreading from a different business at that length.
    expect(bestMatch("TAN", ["TAM"])).toBeNull();
  });

  it("returns nothing when the business has no history", () => {
    expect(bestMatch("SAVEMORE MARKET", [])).toBeNull();
  });

  it("prefers the closest of several known vendors", () => {
    const match = bestMatch("PUREG0LD PRICE CLUB", known);
    expect(match?.value).toBe("PUREGOLD PRICE CLUB");
  });

  it("ignores null and empty candidates", () => {
    expect(bestMatch(null, known)).toBeNull();
    expect(bestMatch("", known)).toBeNull();
  });
});

describe("findKnownVendorInText", () => {
  /**
   * The failure that motivated this: OCR mangles a stylised logo into a short
   * scrap, that scrap wins the vendor scoring, and the real registered name
   * sits two lines below being ignored. Searching every line finds it.
   */
  it("finds a known vendor the parser passed over", () => {
    const text = ["Dore", "SANFORD MARKETING CORPORATION", "123 Main St", "TOTAL 689.75"].join("\n");
    const match = findKnownVendorInText(text, ["SANFORD MARKETING CORPORATION"]);
    expect(match?.value).toBe("SANFORD MARKETING CORPORATION");
  });

  it("finds a vendor printed in the footer", () => {
    const text = ["OFFICIAL RECEIPT", "Rice 25kg 1050.00", "TOTAL 1050.00", "SAVEM0RE MARKET"].join("\n");
    expect(findKnownVendorInText(text, ["SAVEMORE MARKET"])?.value).toBe("SAVEMORE MARKET");
  });

  it("finds nothing on a receipt from a new shop", () => {
    const text = ["MERCURY DRUG", "Paracetamol 50.00", "TOTAL 50.00"].join("\n");
    expect(findKnownVendorInText(text, ["SAVEMORE MARKET", "ALFAMART"])).toBeNull();
  });

  /** An item line must never be mistaken for the shop's name. */
  it("does not match a product line against a known vendor", () => {
    const text = ["Rice 25kg 1050.00", "Cooking oil 1L 180.00", "TOTAL 1230.00"].join("\n");
    expect(findKnownVendorInText(text, ["SAVEMORE MARKET", "ALFAMART"])).toBeNull();
  });
});

describe("normaliseForMatch", () => {
  it("folds confusable digits so a comparison is not defeated by them", () => {
    expect(normaliseForMatch("SAVEM0RE")).toBe(normaliseForMatch("SAVEMORE"));
  });
});
