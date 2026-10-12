import { describe, expect, it } from "vitest";
import { parseLineItems, parseLocatedLineItems, parseReceiptFields, reconcileItems } from "../../src/services/ocr.service";
import {
  asPhotographed,
  GAISANO_FOOTER,
  GAISANO_HEADER,
  GAISANO_ROWS,
  GAISANO_TOTAL,
  NAME_FIRST_SECTION,
  rowLines,
} from "../helpers/longReceiptFixtures";

const cents = (amount: number) => Math.round(amount * 100);
const sum = (items: { amount: number }[]) => items.reduce((total, item) => total + cents(item.amount), 0) / 100;
const WHOLE_RECEIPT = [...GAISANO_HEADER, ...GAISANO_ROWS.flatMap(rowLines), ...GAISANO_FOOTER].join("\n");

describe("the fixture itself", () => {
  it("agrees with the paper: line totals make the printed total, quantities make the item count", () => {
    expect(sum(GAISANO_ROWS.map((row) => ({ amount: Number(row[3]) })))).toBe(GAISANO_TOTAL);
    expect(GAISANO_ROWS.reduce((count, row) => count + row[1], 0)).toBe(239);
    for (const [, quantity, unitPrice, amount] of GAISANO_ROWS) {
      expect(cents(quantity * Number(unitPrice))).toBe(cents(Number(amount)));
    }
  });
});

describe("two-line rows, figures first (Gaisano)", () => {
  /*
   * The defect: every item on this receipt is printed as a figures line
   * ("005705486 1 115.25 115.25T") followed by its description, and the
   * single-line reader found no purchase in either half — the scan came back
   * with no items at all.
   */
  it("reads all 53 purchases, each with its own description, adding up to the printed total", () => {
    const items = parseLineItems(WHOLE_RECEIPT);
    expect(items).toHaveLength(53);
    expect(items).toEqual(GAISANO_ROWS.map(([, quantity, unitPrice, amount, name]) => ({
      name, quantity, unitPrice: Number(unitPrice), amount: Number(amount),
    })));
    expect(sum(items)).toBe(GAISANO_TOTAL);
    expect(reconcileItems(WHOLE_RECEIPT, items, parseReceiptFields(WHOLE_RECEIPT).amount)).toMatchObject({
      reconciled: true,
      reason: "exact",
    });
  });

  it("keeps a product bought twice on consecutive lines as two purchases", () => {
    const matches = parseLineItems(WHOLE_RECEIPT).filter((item) => item.name === "EMI MATCHES STNDRD 10S");
    expect(matches).toHaveLength(2);
  });

  it("reads the same receipt as three photographs joined in page order", () => {
    const text = asPhotographed().join("\n");
    const items = parseLineItems(text);
    expect(items).toHaveLength(53);
    expect(sum(items)).toBe(GAISANO_TOTAL);
    // Page 2 ends on a figures line; its description opens page 3.
    expect(items.find((item) => item.amount === 299.25)).toMatchObject({ name: "HOLIDAY CRNDBEEF160/150GX", quantity: 3 });
  });

  it("reports the line each item's figures were printed on and its product code", () => {
    const text = [...rowLines(GAISANO_ROWS[0]!), ...rowLines(GAISANO_ROWS[1]!)].join("\n");
    expect(parseLocatedLineItems(text)).toEqual([
      { name: "FEMME BT300 2PLY 128+CTTN", quantity: 1, unitPrice: 115.25, amount: 115.25, lineIndex: 0, code: "005705486", twoLineRow: true },
      { name: "CASINO ETHYL ALCO FEMME 5", quantity: 1, unitPrice: 88.5, amount: 88.5, lineIndex: 2, code: "003399130", twoLineRow: true },
    ]);
  });

  it("does not read the header, VAT, tender or count lines as purchases or names", () => {
    const names = parseLineItems(WHOLE_RECEIPT).map((item) => item.name.toUpperCase());
    expect(names.some((name) => /TOTAL|VAT|CASH|CHANGE|CASHIER|ITEMS|ADDRESS|SOLD TO|GAISANO|SERIAL/.test(name))).toBe(false);
  });
});

describe("two-line rows, name first (Puregold-style)", () => {
  it("pairs each description with the figures printed under it", () => {
    expect(parseLineItems(NAME_FIRST_SECTION)).toEqual([
      { name: "OISHI FISH CRACKERS 24g/100", quantity: 4, unitPrice: 6.8, amount: 27.2 },
      { name: "OISHI CRACKLING S&V 24g/100", quantity: 7, unitPrice: 6.8, amount: 47.6 },
      { name: "CHIPPY BBQ 25g/100", quantity: 3, unitPrice: 7.45, amount: 22.35 },
      { name: "CHIPPY CHILICHS 25g/100", quantity: 3, unitPrice: 7.45, amount: 22.35 },
      { name: "SUPER CRUNCH SWTCORN 6 55g/10s/5", quantity: 2, unitPrice: 10.1, amount: 20.2 },
      { name: "SUPER CRUNCH CHS B 55g/10s/5", quantity: 2, unitPrice: 10.1, amount: 20.2 },
      { name: "CHEEZY CC RH SPCY&CHSY 22g/10S", quantity: 10, unitPrice: 7.95, amount: 79.5 },
    ]);
  });

  it("reads a quantity separated from its unit price by x or @", () => {
    const items = parseLineItems(["CHIPPY BBQ 25g/100", "3 x 7.45 22.35V", "OISHI PRAWN", "2 @ 6.80 13.60V"].join("\n"));
    expect(items.map((item) => [item.name, item.quantity, item.amount])).toEqual([
      ["CHIPPY BBQ 25g/100", 3, 22.35],
      ["OISHI PRAWN", 2, 13.6],
    ]);
  });
});

describe("OCR damage a figures line survives", () => {
  // Confusions recorded on real receipts elsewhere in this suite and corpus:
  // l/I for 1, O for 0, a comma for the decimal point, a table edge read as |.
  it.each([
    ["005705486 l 115.25 115.25T", 1],
    ["O05705486 1 115.25 115.25T", 1],
    ["005705486 1 115,25 115,25T", 1],
    ["| 005705486 1 115.25 115.25T |", 1],
    ["005705486 1 115.25 115.25 T", 1],
    ["005705486 1 115.25 115.257", 1],
    ["005705486 1 115.25 115.25T.", 1],
  ])("still reads %s", (figures, quantity) => {
    const items = parseLineItems([figures, "FEMME BT300 2PLY 128+CTTN"].join("\n"));
    expect(items).toEqual([{ name: "FEMME BT300 2PLY 128+CTTN", quantity, unitPrice: 115.25, amount: 115.25 }]);
  });

  it("takes the quantity from the arithmetic when the printed one was misread", () => {
    // 10 read as 70: 70 x 48.75 is nowhere near 487.50, which is exactly 10 x 48.75.
    const items = parseLineItems(["003399122 70 48.75 487.50T", "CASINO ETHYL ALCO FEMME 2"].join("\n"));
    expect(items[0]).toMatchObject({ quantity: 10, unitPrice: 48.75, amount: 487.5 });
  });

  it("reads a row whose quantity column was lost, from the arithmetic", () => {
    const items = parseLineItems(["005705486 115.25 115.25T", "FEMME BT300 2PLY 128+CTTN"].join("\n"));
    expect(items[0]).toMatchObject({ name: "FEMME BT300 2PLY 128+CTTN", quantity: 1, amount: 115.25 });
  });
});

describe("what a figures line must never become", () => {
  it("is not a purchase when its figures do not multiply out", () => {
    expect(parseLineItems(["005705486 3 115.25 118.40T", "FEMME BT300 2PLY 128+CTTN"].join("\n"))).toEqual([]);
  });

  it("does not turn a VAT breakdown row of bare figures into a purchase", () => {
    expect(parseLineItems(["VATABLE VAT TOTAL", "7113.65 853.60 7967.25"].join("\n"))).toEqual([]);
  });

  it("keeps the printed product code as the name when the description is unreadable", () => {
    const items = parseLineItems(["005705486 1 115.25 115.25T", "~~ .. __", "003399130 1 88.50 88.50T", "CASINO ETHYL ALCO FEMME 5"].join("\n"));
    expect(items.map((item) => item.name)).toEqual(["005705486", "CASINO ETHYL ALCO FEMME 5"]);
  });

  it("drops a figures line with neither a description nor a code rather than invent a name", () => {
    expect(parseLineItems(["        4        6.80      27.20V", "TOTAL 27.20"].join("\n"))).toEqual([]);
  });

  it("gives each description to one row only", () => {
    const text = ["005705486 1 115.25 115.25T", "003399130 1 88.50 88.50T", "CASINO ETHYL ALCO FEMME 5"].join("\n");
    expect(parseLineItems(text).map((item) => item.name)).toEqual(["005705486", "CASINO ETHYL ALCO FEMME 5"]);
  });
});

describe("which way round, when both ends of the text are descriptions", () => {
  /*
   * A photograph that starts mid-receipt opens on the description of the row
   * that ended the previous photograph, so the counts tie. Code-bearing rows
   * lead with their code, and this register prints them figures first; the
   * other reading would shift every description onto the wrong purchase.
   */
  it("reads code-bearing rows figures first", () => {
    const text = ["HOLIDAY CRNDBEEF160/150GX", ...GAISANO_ROWS.slice(35, 40).flatMap(rowLines)].join("\n");
    expect(parseLineItems(text).map((item) => [item.amount, item.name])).toEqual([
      [160, "HOLIDAY BEEF LOAF 150GX4"],
      [33.75, "LONGKOU VERMICELLI 50G"],
      [74, "GOLDEN TOWER ODONG 20GX12"],
      [64.5, "SWALLOW MISUA 12S"],
      [135.5, "KOPIKO BLANCA TP 20GX2X10"],
    ]);
  });

  it("reads code-less rows name first", () => {
    const text = [...NAME_FIRST_SECTION.split("\n").slice(1, 5), "OISHI RIBBED CRACKERS"].join("\n");
    expect(parseLineItems(text).map((item) => [item.amount, item.name])).toEqual([
      [27.2, "OISHI FISH CRACKERS 24g/100"],
      [47.6, "OISHI CRACKLING S&V 24g/100"],
    ]);
  });
});

describe("the T flag on a single-line item", () => {
  it("reads an amount carrying Gaisano's taxable flag", () => {
    expect(parseLineItems("Sugar 1kg      68.00T\nTOTAL 68.00")).toEqual([
      { name: "Sugar 1kg", quantity: null, unitPrice: null, amount: 68 },
    ]);
  });
});

describe("single lines on a register that prints two-line rows", () => {
  // Lines verbatim from tesseract's reading of the owner's receipt (see
  // tests/helpers/gaisanoScreenshotOcr.ts): a garbled figures row, and the
  // CHANGE line with its label misread.
  const rows = GAISANO_ROWS.slice(0, 4).flatMap(rowLines);

  it("does not read a figures row garbled past reading as a named purchase", () => {
    const items = parseLineItems([...rows, "0F663300 3 0 NB 299.51", "vv 20%87 1 42.5% &@2.91", "Total P7967.25"].join("\n"));
    expect(items.map((item) => item.amount)).toEqual([115.25, 88.5, 487.5, 322.5]);
  });

  it("reads nothing after the total as a purchase", () => {
    const items = parseLineItems([...rows, "Total P1013.75", "OHNGE wwe) 2.75"].join("\n"));
    expect(items.map((item) => item.amount)).toEqual([115.25, 88.5, 487.5, 322.5]);
  });

  it("still reads a single-line purchase with a real name among two-line rows", () => {
    const items = parseLineItems([...rows, "PLASTIC BAG MEDIUM      2.50", "Total P1016.25"].join("\n"));
    expect(items.map((item) => item.name)).toContain("PLASTIC BAG MEDIUM");
  });
});

describe("money coming back", () => {
  // A void or return printed as a figures row must never become a purchase.
  it.each([
    ["003019093 1 19.50 19.50-"],
    ["003019093 1 19.50 (19.50)"],
    ["003019093 -1 19.50 -19.50"],
    ["003019093 1 19.50 19.50 -"],
  ])("does not read %s as a purchase", (figures) => {
    expect(parseLineItems([figures, "EMI MATCHES STNDRD 10S"].join("\n"))).toEqual([]);
  });
});
