import { describe, expect, it } from "vitest";
import { locateRecordRows } from "../../src/services/csvImport.service";

/** Records keep no row number, so the origin panel finds the row by what the import copied from it. */
describe("locateRecordRows", () => {
  const rows = [
    { date: "2026-10-01", description: "Monthly burger stall rent", amount: "4500.00" },
    { date: "2026-10-13", description: "Paper takeaway bags x200;  purchase E0064394", amount: "PHP 240.00" },
    { date: "2026-10-14", description: "Paper takeaway bags x200; purchase E0064394", amount: "(240)" },
    { date: "2026-10-15", description: "Paper takeaway bags x200; purchase E0064394", amount: "250" },
  ];

  it("matches on description and amount, ignoring spacing, case and money formatting", () => {
    expect(locateRecordRows(rows, { date: "2026-12-01", description: "paper takeaway bags x200; purchase e0064394", amount: 240 })).toEqual([2, 3]);
  });

  it("narrows repeated rows by the record's date when one carries it", () => {
    expect(locateRecordRows(rows, { date: "2026-10-14", description: "Paper takeaway bags x200; purchase E0064394", amount: 240 })).toEqual([3]);
  });

  it("finds nothing rather than guessing when the amount differs", () => {
    expect(locateRecordRows(rows, { date: "2026-10-01", description: "Monthly burger stall rent", amount: 4600 })).toEqual([]);
  });
});
