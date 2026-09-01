import { describe, expect, it } from "vitest";
import { parseLineItems } from "../../src/services/ocr.service";

/**
 * The item-line parser, against the layouts real registers actually print.
 *
 * The bias under test throughout is conservatism: a missed item costs the
 * owner one manual row, a fabricated one puts a number in their books that
 * was never on the receipt. Every "does NOT read" case below is protecting
 * against the second.
 */

describe("shapes that are items", () => {
  it("reads a plain name-and-price line", () => {
    const items = parseLineItems(["ALING NENA STORE", "Rice 25kg        1050.00", "TOTAL      1050.00"].join("\n"));
    expect(items).toEqual([{ name: "Rice 25kg", quantity: null, unitPrice: null, amount: 1050 }]);
  });

  it("reads several items in printed order", () => {
    const items = parseLineItems(
      ["Buns              50.00", "Patty            120.00", "Eggs              65.00", "TOTAL   235.00"].join("\n"),
    );
    expect(items.map((i) => i.name)).toEqual(["Buns", "Patty", "Eggs"]);
    expect(items.map((i) => i.amount)).toEqual([50, 120, 65]);
  });

  it("reads a thousands separator", () => {
    const items = parseLineItems("Bulk inventory     12,450.00\nTOTAL   12,450.00");
    expect(items[0]!.amount).toBe(12450);
  });

  it('reads a "2 x Name" quantity prefix and derives the unit price', () => {
    const items = parseLineItems("2 x Softdrinks      90.00\nTOTAL  90.00");
    expect(items[0]).toEqual({ name: "Softdrinks", quantity: 2, unitPrice: 45, amount: 90 });
  });

  it('reads a "3 @ Name" prefix too', () => {
    const items = parseLineItems("3 @ Bread       75.00\nTOTAL 75.00");
    expect(items[0]!.quantity).toBe(3);
    expect(items[0]!.unitPrice).toBe(25);
  });

  it("reads a quantity / unit price / amount column layout", () => {
    const items = parseLineItems("Chicken          2    150.00    300.00\nTOTAL  300.00");
    expect(items[0]).toEqual({ name: "Chicken", quantity: 2, unitPrice: 150, amount: 300 });
  });

  /**
   * Three numbers in a row are only a qty/unit/amount triple if they
   * multiply out. When they don't, they are unrelated figures — a product
   * code and a price, say — and the line is read as a plain name-and-price.
   */
  it("does not treat three numbers as columns when they don't multiply out", () => {
    const items = parseLineItems("Item code 7 99.00 250.00\nTOTAL 250.00");
    expect(items[0]!.amount).toBe(250);
    expect(items[0]!.quantity).toBeNull();
  });

  it("strips a peso sign", () => {
    const items = parseLineItems("Frozen goods    ₱980.25\nTOTAL ₱980.25");
    expect(items[0]!.amount).toBe(980.25);
    expect(items[0]!.name).toBe("Frozen goods");
  });

  it("strips leading bullets and collapses OCR's ragged spacing", () => {
    const items = parseLineItems("* Cooking   oil  1L        170.00\nTOTAL 170.00");
    expect(items[0]!.name).toBe("Cooking oil 1L");
  });
});

describe("layouts taken from the real receipts in the corpus", () => {
  /**
   * real-01-ph-pos-photo. BIR-accredited registers print a VAT class flag
   * hard against the amount — V (VATable), Z (zero-rated), E (exempt),
   * X (non-taxable). Without handling it, every item line on a compliant
   * Philippine receipt is missed.
   */
  it("reads an amount carrying a PH VAT class flag", () => {
    const items = parseLineItems(
      ["Spareribs Meal        129.00V", "Iced Latte 16oz        59.00V", "TOTAL      188.00"].join("\n"),
    );
    expect(items).toEqual([
      { name: "Spareribs Meal", quantity: null, unitPrice: null, amount: 129 },
      { name: "Iced Latte 16oz", quantity: null, unitPrice: null, amount: 59 },
    ]);
  });

  it.each(["V", "Z", "E", "X"])("accepts a trailing %s flag", (flag) => {
    expect(parseLineItems(`Some item      50.00${flag}`)[0]!.amount).toBe(50);
  });

  /** real-02-clean-digital: a QTY / DESC / AMT column layout. */
  it("reads a leading bare quantity column", () => {
    const items = parseLineItems(
      [
        "QTY DESC AMT",
        "1 Americano $3.19",
        "1 Almond Scone $1.99",
        "1 16oz Bottle Water $2.99",
        "AMT $8.70",
        "SUBTOTAL $8.17",
        "TAX $0.53",
        "BALANCE $8.70",
      ].join("\n"),
    );
    expect(items).toEqual([
      { name: "Americano", quantity: 1, unitPrice: 3.19, amount: 3.19 },
      { name: "Almond Scone", quantity: 1, unitPrice: 1.99, amount: 1.99 },
      { name: "16oz Bottle Water", quantity: 1, unitPrice: 2.99, amount: 2.99 },
    ]);
  });

  it('does not mistake a leading year for a quantity', () => {
    const items = parseLineItems("2026 Calendar      50.00");
    expect(items[0]!.name).toBe("2026 Calendar");
    expect(items[0]!.quantity).toBeNull();
  });

  it('does not read the "AMT" summary line as an item', () => {
    expect(parseLineItems("AMT $8.70")).toEqual([]);
  });
});

describe("lines that carry money but are not purchases", () => {
  it.each([
    ["TOTAL              1220.00"],
    ["SUBTOTAL           1000.00"],
    ["Sub-total          1000.00"],
    ["VAT 12%             120.00"],
    ["Amount Due         3400.00"],
    ["BALANCE             500.00"],
    ["CASH               1500.00"],
    ["CHANGE              280.00"],
    ["Discount            -50.00"],
    ["Less Senior Disc.    20.00"],
    // REGRESSION (real-16-new-china-us-date, real image corpus): a plain
    // "Amount: 24.95" summary label — not "Amount Due", just "Amount" —
    // was read as a purchased item.
    ["Amount: 24.95"],
  ])("does not read %s as an item", (line) => {
    expect(parseLineItems(line)).toEqual([]);
  });

  // REGRESSION (real-38-super-seven-dot-noise-duplicate-lines and
  // real-39-sanyu-stationery-clean, real image corpus): a GST/tax-summary
  // breakdown row — the tax classification code (SR/ZR/IR) plus its rate —
  // printed under a "GST Summary" header, read as a purchased item.
  it.each([["SR @ 6% 8.21 0.49"], ["IR (0%) 4.99 0.20"]])(
    "does not read a GST-summary breakdown row %s as an item",
    (line) => {
      expect(parseLineItems(line)).toEqual([]);
    },
  );

  it("keeps the items but drops the summary block around them", () => {
    const items = parseLineItems(
      [
        "SARI-SARI EXPRESS",
        "Date: 2026-07-14",
        "Goods            1000.00",
        "SUBTOTAL         1000.00",
        "VAT 12%           120.00",
        "TOTAL            1120.00",
        "CASH             1200.00",
        "CHANGE             80.00",
      ].join("\n"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("Goods");
  });

  it("drops the registration block a PH receipt prints above the items", () => {
    const items = parseLineItems(
      [
        "VAT REG TIN: 123-456-789-00000",
        "PERMIT NO: FP102026-080-0473287",
        "POS SN: 1000104650067",
        "Hardware          5600.00",
        "TOTAL             5600.00",
      ].join("\n"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("Hardware");
  });

  it("ignores a line with no money on it", () => {
    expect(parseLineItems("Thank you, come again!")).toEqual([]);
  });

  it("ignores a row of figures with no name", () => {
    expect(parseLineItems("   123456    99.00")).toEqual([]);
  });

  it("ignores a zero or negative amount", () => {
    expect(parseLineItems("Freebie item      0.00")).toEqual([]);
  });
});

/**
 * Regression: a real Savemore Market grocery receipt.
 *
 * Two non-purchase lines were being read as items — "BDO ATM" (the payment
 * method, carrying the receipt's whole total) and the VAT block. Together
 * they accounted for almost all of the subtotal mismatch the owner saw.
 */
describe("the Savemore Market receipt", () => {
  const SAVEMORE = [
    "SAVEMORE MARKET",
    "Banilad, Cebu City",
    "VAT REG TIN: 005-070-943-00000",
    "Date: 2026-07-26",
    "COKE MISMO 300ML      45.00",
    "SKYFLAKES CRACKERS    38.00",
    "TISSUE 2PLY 12S       89.00",
    "GARDENIA WHITE BREAD  72.00",
    "SPRITE 1.5L           85.00",
    "CENTURY TUNA 155G     42.00",
    "VATable Sales        331.25",
    "VAT Amount            39.75",
    "Zero-Rated Sales       0.00",
    "VAT-Exempt Sales       0.00",
    "TOTAL                371.00",
    "BDO ATM              371.00",
    "AuthCode             123456",
    "Order ID          A9921-004",
  ].join("\n");

  it("reads exactly the six purchased items", () => {
    const items = parseLineItems(SAVEMORE);
    expect(items.map((i) => i.name)).toEqual([
      "COKE MISMO 300ML",
      "SKYFLAKES CRACKERS",
      "TISSUE 2PLY 12S",
      "GARDENIA WHITE BREAD",
      "SPRITE 1.5L",
      "CENTURY TUNA 155G",
    ]);
  });

  it("reads no payment-method line as a purchase", () => {
    const names = parseLineItems(SAVEMORE).map((i) => i.name.toUpperCase());
    expect(names.some((n) => n.includes("ATM") || n.includes("BDO"))).toBe(false);
  });

  it("reads no tax-summary line as a purchase", () => {
    const names = parseLineItems(SAVEMORE).map((i) => i.name.toUpperCase());
    expect(names.some((n) => n.includes("VAT") || n.includes("ZERO") || n.includes("EXEMPT"))).toBe(false);
  });

  it("the items add up to the receipt's own total", () => {
    const sum = parseLineItems(SAVEMORE).reduce((n, i) => n + Math.round(i.amount * 100), 0);
    expect(sum).toBe(37100);
  });
});

/**
 * Regression: the SAME Savemore receipt, but this is the verbatim Tesseract
 * output of a phone photo of it (receipt scan #222), not a tidy rendering.
 *
 * It is here because the tidy version above was passing while the real one
 * was still wrong. Tesseract read this photo well — every amount is legible
 * and no payment or tax line survives as an item — so what remained was
 * damage INSIDE the item lines: the @ of an inline unit price read as an 8,
 * lowercase l read as ], and a quantity column misread in a way that put a
 * wrong number of units into the owner's books.
 */
describe("the Savemore receipt as Tesseract actually read the photo", () => {
  const SCANNED = [
    "Dore",
    "E\" SAVEMORE MARKET BASAK #31 JP RII ST",
    "3 VAT REG TIN® 207-61-175-00070",
    "MIN#22052411500208642",
    "SALES INVOICE",
    "SI# 08-00036843",
    "Trans# 1072 0800037004",
    "12/19/2022 19:44 #08 10002023",
    "1 FemmeTsu2P]y250 68.75",
    "1 MYSAN SkyF lakes 60.50",
    "8 fi Eogacre 130 @33.50 100.50",
    "1 JndDubryB1bryCnsCk 85.00",
    "1 BleeGrTeaTosts 50 J 49.75",
    "5 Sey 822,95 114.75",
    "3 Sprite Can 320m] @34.50 103.50",
    "1 GAR WhiteBreadRS 62.00",
    "1 # Turon WithLangka 25.00",
    "BAGGER : B",
    "TOTAL DUE PHP 689.75",
    "BOO ATM prs 689.75",
    "Card No.: 483442XXXXXX3488",
    "AuthCode: 002364",
    "ORDER ID: HOLDOB000OG002",
    "VATable Sales 615.85",
    "YAT Amount 73.90",
    "lero-Rated Sales 0.00",
    "YAT-Exempt Sales 0.00",
  ].join("\n");

  it("reads the nine purchased lines and nothing else", () => {
    expect(parseLineItems(SCANNED)).toHaveLength(9);
  });

  it("admits no payment, tax or register-metadata line", () => {
    const names = parseLineItems(SCANNED).map((i) => i.name.toUpperCase());
    expect(names.some((n) => /ATM|CARD|AUTH|ORDER|VAT|YAT|BAGGER|TOTAL/.test(n))).toBe(false);
  });

  it("takes the inline unit price out of the item's name", () => {
    const names = parseLineItems(SCANNED).map((i) => i.name);
    expect(names.some((n) => n.includes("@"))).toBe(false);
    expect(names).toContain("Sprite Can 320ml");
  });

  /**
   * The defect this suite exists for. The leading 8 is a misread — the
   * printed "@33.50" against the line total of 100.50 proves the quantity
   * is 3, and 8 units at 12.56 was going into the books instead.
   */
  it("corrects a misread quantity against the printed unit price", () => {
    const item = parseLineItems(SCANNED).find((i) => i.name.includes("Eogacre"));
    expect(item).toMatchObject({ quantity: 3, unitPrice: 33.5, amount: 100.5 });
  });

  it("recovers a unit price whose @ was read as an 8", () => {
    const item = parseLineItems(SCANNED).find((i) => i.name.startsWith("Sey"));
    expect(item).toMatchObject({ name: "Sey", quantity: 5, unitPrice: 22.95, amount: 114.75 });
  });

  it("restores the l that OCR read as a bracket", () => {
    const names = parseLineItems(SCANNED).map((i) => i.name);
    expect(names).toContain("FemmeTsu2Ply250");
  });

  it("does not invent a quantity the receipt never printed", () => {
    // "1 GAR WhiteBreadRS 62.00" prints its quantity; a line without one
    // must stay null rather than being defaulted to 1.
    const item = parseLineItems("Assorted pastries      62.00")[0];
    expect(item).toMatchObject({ quantity: null, unitPrice: null });
  });
});

describe("inline unit prices that must NOT be trusted", () => {
  /**
   * The multiply-out check is the whole safety argument for reading an 8 as
   * an @. A product code that happens to end in decimal-looking digits must
   * fail it and leave the quantity column alone.
   */
  it("keeps the quantity column when the figures do not multiply out", () => {
    const item = parseLineItems("2 Cable HDMI 812,34      90.00")[0];
    expect(item).toMatchObject({ quantity: 2, amount: 90 });
    expect(item!.unitPrice).toBe(45);
  });

  it("still strips a literal @ that does not reconcile", () => {
    const item = parseLineItems("2 Sardines @19.00      90.00")[0];
    expect(item!.name).toBe("Sardines");
    expect(item!.quantity).toBe(2);
  });
});

describe("non-purchase lines that survived OCR corruption", () => {
  /**
   * The original receipt's "VAT Amount" came out of Tesseract as "YAT
   * Amount" — V read as Y — which an exact `\bvat\b` denylist let straight
   * through as a PHP 39.75 purchase.
   */
  it.each([
    ["YAT Amount              39.75"],
    ["YATable Sales          331.25"],
    ["VATable Sales          331.25"],
    ["Zero-Rated Sales         0.00"],
    ["VAT-Exempt Sales         0.00"],
    ["Non-Taxable Sales        0.00"],
  ])("does not read %s as an item", (line) => {
    expect(parseLineItems(line)).toEqual([]);
  });

  it.each([
    ["BDO ATM                371.00"],
    ["GCash                  371.00"],
    ["Maya                   371.00"],
    ["VISA CREDIT            371.00"],
    ["AuthCode               123456"],
    ["Approval Code           99213"],
    ["Ref No.              8891234"],
  ])("does not read the payment line %s as an item", (line) => {
    expect(parseLineItems(line)).toEqual([]);
  });

  /**
   * The structural guard: whatever OCR does to a payment line's NAME, it
   * still carries the receipt total, and on a multi-item receipt that is
   * enough to identify it.
   */
  it("drops an unrecognisable line that carries the whole receipt total", () => {
    const items = parseLineItems(
      ["Buns   60.00", "Patty  120.00", "TOTAL  180.00", "Xz9 qrt phs   180.00"].join("\n"),
    );
    expect(items.map((i) => i.name)).toEqual(["Buns", "Patty"]);
  });

  it("KEEPS a single item that legitimately equals the total", () => {
    // A one-line receipt's only item is the total. The guard must not eat it.
    const items = parseLineItems(["Bulk delivery   5600.00", "TOTAL   5600.00"].join("\n"));
    expect(items).toHaveLength(1);
    expect(items[0]!.amount).toBe(5600);
  });
});

describe("receipts with nothing itemisable", () => {
  /**
   * The realistic failure mode named in the brief: a handwritten slip, or a
   * register that prints only a total. Returning nothing is correct — the
   * caller falls back to the single-total flow rather than inventing lines.
   */
  it("returns nothing for a total-only receipt", () => {
    const items = parseLineItems(["MANG JOSE STORE", "Date: 2026-07-18", "TOTAL      845.50"].join("\n"));
    expect(items).toEqual([]);
  });

  it("returns nothing for unreadable OCR output", () => {
    expect(parseLineItems("~~~ %%% ###")).toEqual([]);
  });

  it("returns nothing for empty text", () => {
    expect(parseLineItems("")).toEqual([]);
  });
});

/**
 * REGRESSION, from a real receipt (real-03 in the corpus).
 *
 * The denylist read `\bdiscount\b`, which does not match "Discounts" — the
 * trailing word boundary needs a non-word character and meets the "s". A real
 * PH sales invoice printing "Prod. Discounts: 5.00" therefore had its DISCOUNT
 * recorded as a 5.00 PURCHASE: money coming off the receipt booked as money
 * spent, which is the precise failure the denylist exists to prevent.
 */
describe("plural summary lines are not purchases", () => {
  it("rejects a pluralised discount line", () => {
    const items = parseLineItems(
      ["MY STORE", "Rice 25kg   1050.00", "Prod. Discounts: 5.00", "TOTAL 1045.00"].join("\n"),
    );
    expect(items.map((i) => i.name)).not.toContain("Prod. Discounts:");
    expect(items.map((i) => i.name)).toEqual(["Rice 25kg"]);
  });

  it("still rejects the singular it always did", () => {
    const items = parseLineItems(["MY STORE", "Rice 25kg 1050.00", "Discount 5.00"].join("\n"));
    expect(items).toHaveLength(1);
  });

  it("rejects pluralised refunds, rebates and voids", () => {
    for (const line of ["Refunds 5.00", "Rebates 5.00", "Voids 5.00"]) {
      const items = parseLineItems(["MY STORE", "Rice 25kg 1050.00", line].join("\n"));
      expect(items, line).toHaveLength(1);
    }
  });
});
