import { describe, expect, it } from "vitest";
import { parseReceiptFields, reconcileItems } from "../../src/services/ocr.service";
import { linePageNumbers, readLocalItems } from "../../src/services/receiptScan/localItems";
import { itemNameSimilarity } from "../../src/lib/receiptOverlapItems";
import { GAISANO_SCREENSHOT_OCR } from "../helpers/gaisanoScreenshotOcr";
import {
  asPhotographed,
  GAISANO_ROWS,
  GAISANO_TOTAL,
  photographedSections,
  rowLines,
} from "../helpers/longReceiptFixtures";

/**
 * A long receipt photographed in sections, read as one receipt.
 *
 * The page texts are the hand-transcribed Gaisano receipt (see the fixture's
 * note on what that does and does not prove), cut the way the scanner cuts a
 * receipt. The OCR-noise variants are constructed, not recorded.
 */

const cents = (amount: number) => Math.round(amount * 100);
const sum = (items: { amount: number }[]) => items.reduce((total, item) => total + cents(item.amount), 0) / 100;
const expectedNames = GAISANO_ROWS.map((row) => row[4]);

function read(pages: string[]) {
  const total = parseReceiptFields(pages.join("\n")).amount;
  return { total, ...readLocalItems(pages, total) };
}

describe("every section of a long receipt is read, in page order", () => {
  it.each([
    ["two", [26, 27]],
    ["three", [14, 21, 18]],
    ["four", [13, 13, 13, 14]],
    ["six", [9, 9, 9, 9, 9, 8]],
  ])("reads all 53 purchases from %s photographs", (_label, split) => {
    const reading = read(photographedSections(split));
    expect(reading.total).toBe(GAISANO_TOTAL);
    expect(reading.items.map((item) => item.name)).toEqual(expectedNames);
    expect(sum(reading.items)).toBe(GAISANO_TOTAL);
    expect(reading.overlapResolution).toBe("none");
  });

  it("reads the three sections exactly as photographed", () => {
    const reading = read(asPhotographed());
    expect(reading.items.map((item) => item.name)).toEqual(expectedNames);
    expect(sum(reading.items)).toBe(GAISANO_TOTAL);
  });

  it("attributes each line to the photograph it came from", () => {
    expect(linePageNumbers(["a\nb", "c", "d\ne\nf"])).toEqual([1, 1, 2, 3, 3, 3]);
  });
});

describe("overlap between consecutive photographs", () => {
  it("counts lines repeated verbatim across a seam once", () => {
    const reading = read(photographedSections([14, 21, 18], 2));
    expect(reading.items.map((item) => item.name)).toEqual(expectedNames);
    expect(reading.overlapResolution).toBe("seam-text");
  });

  /*
   * The two photographs read the repeated row differently — here "1" as "l"
   * and "O" as "0" — so no exact line matches. The product code is the same in
   * both, and removing the repeat is what makes the items meet the total.
   */
  it("counts a row read differently in two photographs once, by its product code", () => {
    const [page1, page2, page3] = asPhotographed();
    const noisyRepeat = ["003523216 l 88.00 88.00T", "CLOSEUP RED H0T NEW 10G 1"].join("\n");
    const reading = read([page1, [noisyRepeat, page2.split("\n").slice(1).join("\n")].join("\n"), page3]);
    expect(reading.overlapResolution).toBe("removed-reconciled");
    expect(reading.items.map((item) => item.name)).toEqual(expectedNames);
    expect(reading.seamReport?.removed).toEqual([
      { name: "CLOSEUP RED H0T NEW 10G 1", quantity: 1, amount: 88, pageNumber: 2, originalPageNumber: 1 },
    ]);
  });

  it("keeps the description when the earlier copy of a repeated row was cut off at the photo's edge", () => {
    const [page1, page2, page3] = asPhotographed();
    // Page 1 ends on CLOSEUP's figures; its description fell below the frame.
    const croppedPage1 = page1.split("\n").slice(0, -1).join("\n");
    const noisyRepeat = "003523216 1 88.00 88.O0T";
    const reading = read([croppedPage1, [noisyRepeat, page2].join("\n"), page3]);
    expect(reading.overlapResolution).toBe("removed-reconciled");
    expect(reading.items.map((item) => item.name)).toEqual(expectedNames);
    expect(sum(reading.items)).toBe(GAISANO_TOTAL);
  });

  it("keeps a product genuinely bought twice when the two lines fall either side of a seam", () => {
    const rows = GAISANO_ROWS.length;
    // Split between the two EMI MATCHES lines, with no overlap: both are real.
    const reading = read(photographedSections([14, 21, rows - 36, 1]));
    expect(reading.items.filter((item) => item.name === "EMI MATCHES STNDRD 10S")).toHaveLength(2);
    expect(reading.overlapResolution).toBe("none");
  });

  it("removes only the overlap copy when a genuine repeat purchase sits at the seam", () => {
    const rows = GAISANO_ROWS.length;
    // Same split, but the second photograph repeats the first EMI MATCHES row.
    const reading = read(photographedSections([14, 21, rows - 36, 1], 2));
    expect(reading.items.filter((item) => item.name === "EMI MATCHES STNDRD 10S")).toHaveLength(2);
    expect(sum(reading.items)).toBe(GAISANO_TOTAL);
  });

  it("never removes a repeat the printed total does not confirm", () => {
    // The repeated row AND a missing row elsewhere: neither reading adds up,
    // so the plain reading stands and the owner sees every line.
    const [page1, page2, page3] = asPhotographed();
    const noisyRepeat = ["003523216 l 88.00 88.00T", "CLOSEUP RED H0T NEW 10G 1"].join("\n");
    const page3MissingRow = page3.replace("003897097 3 21.50 64.50T\n", "");
    const reading = read([page1, [noisyRepeat, page2.split("\n").slice(1).join("\n")].join("\n"), page3MissingRow]);
    expect(reading.overlapResolution).toBe("none");
    expect(reading.items.filter((item) => item.amount === 88)).toHaveLength(2);
  });
});

describe("a section that read badly", () => {
  /*
   * Page 2 photographed out of focus: some of its figures lines come back
   * garbled. Those purchases are missing and the gap shows against the total;
   * nothing is guessed, and pages 1 and 3 are read in full.
   */
  it("reads the other sections in full and invents nothing for the damaged one", () => {
    const [page1, page2, page3] = asPhotographed();
    const blurred = page2
      .replace("004461333 1 58.00 58.00T", "OO44G1333 i 5B.O0 5B.0OT")
      .replace("005461363 3 114.00 342.00T", "0054G1363 3 1l4.OO 34Z.O0T")
      .replace("SILKA WHTNG LOT ENRG CTRS", "S1LKA WH7NG L0T ~~ ..");
    const pages = [page1, blurred, page3];
    const reading = read(pages);
    const printed = new Set(GAISANO_ROWS.map((row) => cents(Number(row[3]))));
    expect(reading.items.every((item) => printed.has(cents(item.amount)))).toBe(true);
    expect(reading.items).toHaveLength(51);
    expect(reading.items.map((item) => item.name)).toEqual(expectedNames.filter((name) =>
      name !== "SILKA WHTNG LOT ENRG CTRS" && name !== "BEAR BRAND PWD SWAK 33G/1"));
    const gap = reconcileItems(pages.join("\n"), reading.items, reading.total);
    expect(gap).toMatchObject({ reconciled: false, difference: 400 });
  });
});

describe("a receipt whose rows never pair", () => {
  it("reads a single-line receipt exactly as before", () => {
    const pages = ["SARI-SARI EXPRESS\nRice 25kg 1050.00\nEggs 65.00", "Oil 170.00\nTOTAL 1285.00"];
    const reading = read(pages);
    expect(reading.items.map((item) => item.name)).toEqual(["Rice 25kg", "Eggs", "Oil"]);
    expect(reading.overlapResolution).toBe("none");
  });

  it("does not drop a page's most expensive purchase when that page has no total of its own", () => {
    // Page 1 of the Gaisano receipt: its largest row is 890.00 and there is no TOTAL line on it.
    const reading = readLocalItems([asPhotographed()[0]], null);
    expect(reading.items.map((item) => item.amount)).toContain(890);
    expect(reading.items).toHaveLength(14);
  });

  it("still drops a line that only repeats a misread total", () => {
    const items = readLocalItems(["Buns 60.00\nPatty 120.00\nT0TAL 180.00"], null).items;
    expect(items.map((item) => item.name)).toEqual(["Buns", "Patty"]);
  });

  it("names a lone figures row by its printed product code", () => {
    expect(readLocalItems([rowLines(GAISANO_ROWS[0]!)[0]!], null).items).toEqual([
      { name: "005705486", quantity: 1, unitPrice: 115.25, amount: 115.25 },
    ]);
  });
});

describe("tesseract's own reading of the owner's receipt", () => {
  /*
   * Real OCR noise on the real paper (see the fixture's provenance note: read
   * from screenshots at about a third of upload resolution). What must hold
   * whatever the resolution: every item read is a purchase printed on the
   * receipt, with its own quantity and description — none invented, none
   * shifted onto a neighbour — and a pen stroke read as "¥" does not make the
   * receipt foreign.
   */
  const pages = GAISANO_SCREENSHOT_OCR;
  const reading = read(pages);

  it("reads only purchases the receipt printed, with their own quantity", () => {
    expect(reading.total).toBe(GAISANO_TOTAL);
    expect(reading.items.length).toBeGreaterThanOrEqual(16);
    for (const item of reading.items) {
      const printed = GAISANO_ROWS.filter((row) => cents(Number(row[3])) === cents(item.amount) && row[1] === item.quantity);
      expect(printed, `${item.name} ${item.amount}`).not.toHaveLength(0);
    }
  });

  it("gives each purchase its own description, not a neighbour's", () => {
    for (const item of reading.items) {
      const printed = GAISANO_ROWS.filter((row) => cents(Number(row[3])) === cents(item.amount) && row[1] === item.quantity);
      const bestMatch = Math.max(...printed.map((row) => itemNameSimilarity(item.name, row[4])));
      expect(bestMatch, `${item.name} ${item.amount}`).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("does not read the CHANGE line or a garbled figures row as a purchase", () => {
    expect(reading.items.some((item) => cents(item.amount) === 275 || cents(item.amount) === 29951)).toBe(false);
  });

  it("leaves the rows it could not read to the owner, with the gap showing against the total", () => {
    expect(reading.items.length).toBeLessThan(GAISANO_ROWS.length);
    expect(reconcileItems(pages.join("\n"), reading.items, reading.total).reconciled).toBe(false);
  });
});
