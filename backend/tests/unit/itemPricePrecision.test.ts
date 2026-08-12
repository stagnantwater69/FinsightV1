import { describe, expect, it } from "vitest";
import { parseLineItems } from "../../src/services/ocr.service";

/**
 * Cent values must survive the whole pipeline.
 *
 * Reported from the review screen: three items priced 3.19, 1.99 and 2.99
 * displayed as "PHP 3", "PHP 2" and "PHP 3", and the subtotal looked wrong.
 * That turned out to be display formatting only — Money defaults to whole
 * pesos — but the distinction matters enough to pin the DATA side here so a
 * future rounding call at parse time can't quietly turn a display bug into a
 * financial one.
 *
 * The display side is fixed by passing `decimals` in ScanReceipt.tsx.
 */

/** The exact receipt from the report (real-02-clean-digital in the corpus). */
const AROMA_CAFE = [
  "AROMA CAFE",
  "1211 Green Street",
  "12/27/2019 08:26 PM",
  "QTY DESC AMT",
  "1 Americano $3.19",
  "1 Almond Scone $1.99",
  "1 16oz Bottle Water $2.99",
  "AMT $8.70",
  "SUBTOTAL $8.17",
  "TAX $0.53",
  "BALANCE $8.70",
].join("\n");

describe("cent precision through parsing", () => {
  it("keeps every centavo of each item price", () => {
    const items = parseLineItems(AROMA_CAFE);
    expect(items.map((i) => i.amount)).toEqual([3.19, 1.99, 2.99]);
  });

  it("never rounds or floors a price to whole pesos", () => {
    for (const item of parseLineItems(AROMA_CAFE)) {
      expect(Number.isInteger(item.amount)).toBe(false);
      expect(item.amount).not.toBe(Math.floor(item.amount));
    }
  });

  /**
   * The subtotal the review screen shows. Summed in centavos, as the screen
   * does — 3.19 + 1.99 + 2.99 is 8.169999999999998 in float, and a screen
   * that printed that, or compared it with ===, would report a mismatch on
   * three correct prices.
   */
  it("sums to exactly 8.17 in centavos", () => {
    const centavos = parseLineItems(AROMA_CAFE).reduce((n, i) => n + Math.round(i.amount * 100), 0);
    expect(centavos).toBe(817);
    expect(centavos / 100).toBe(8.17);
  });

  it("does not read the tax or balance summary lines as items", () => {
    const names = parseLineItems(AROMA_CAFE).map((i) => i.name.toUpperCase());
    expect(names).toEqual(["AMERICANO", "ALMOND SCONE", "16OZ BOTTLE WATER"]);
  });

  /**
   * PHP only — see the scope note. A "$" on a fixture image is incidental;
   * the numeric value is all that is read, and it is always interpreted as
   * pesos. No currency detection, no conversion.
   */
  it("reads the number regardless of the symbol printed beside it", () => {
    const dollars = parseLineItems("Americano $3.19");
    const pesos = parseLineItems("Americano PHP 3.19");
    const bare = parseLineItems("Americano 3.19");
    expect(dollars[0]!.amount).toBe(3.19);
    expect(pesos[0]!.amount).toBe(3.19);
    expect(bare[0]!.amount).toBe(3.19);
  });

  it("keeps centavos on a quantity line's derived unit price", () => {
    const items = parseLineItems("3 x Softdrinks   38.97");
    expect(items[0]!.amount).toBe(38.97);
    expect(items[0]!.unitPrice).toBe(12.99);
  });
});
