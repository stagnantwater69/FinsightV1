import { describe, expect, it } from "vitest";
import {
  ambiguousDateExample,
  detectDateFormat,
  looksLikeDate,
  parseCsvDate,
} from "../../src/lib/csvDates";
import { utcAddDays, utcToday } from "../../src/lib/dates";

/**
 * The bug this module exists to prevent: `new Date("01/05/2026")` parses in
 * SERVER-LOCAL time, so on a UTC+8 host the subsequent
 * `.toISOString().slice(0, 10)` lands the record on the PREVIOUS day. Every
 * assertion below is on the ISO string, which is the value actually stored.
 */
describe("parseCsvDate", () => {
  it("reads ISO dates under every convention, with no timezone drift", () => {
    for (const format of ["iso", "dmy", "mdy", "month-name"] as const) {
      expect(parseCsvDate("2026-01-05", format)).toBe("2026-01-05");
    }
    // Midnight-adjacent dates are where a local-time parse shows up first.
    expect(parseCsvDate("2026-01-01", "iso")).toBe("2026-01-01");
    expect(parseCsvDate("2026-12-31", "iso")).toBe("2026-12-31");
  });

  it("distinguishes day-first from month-first for the same cell", () => {
    expect(parseCsvDate("05/01/2026", "dmy")).toBe("2026-01-05");
    expect(parseCsvDate("05/01/2026", "mdy")).toBe("2026-05-01");
  });

  it("accepts the separators spreadsheets actually emit", () => {
    expect(parseCsvDate("05-01-2026", "dmy")).toBe("2026-01-05");
    expect(parseCsvDate("05.01.2026", "dmy")).toBe("2026-01-05");
    expect(parseCsvDate("5/1/2026", "dmy")).toBe("2026-01-05");
  });

  it("refuses a numeric date when the file was declared ISO", () => {
    expect(parseCsvDate("05/01/2026", "iso")).toBeNull();
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    // new Date(Date.UTC(2026, 1, 31)) silently returns March 3rd.
    expect(parseCsvDate("31/02/2026", "dmy")).toBeNull();
    expect(parseCsvDate("2026-02-30", "iso")).toBeNull();
    expect(parseCsvDate("32/01/2026", "dmy")).toBeNull();
    expect(parseCsvDate("13/13/2026", "dmy")).toBeNull();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(parseCsvDate("29/02/2024", "dmy")).toBe("2024-02-29");
    expect(parseCsvDate("29/02/2025", "dmy")).toBeNull();
  });

  it("bounds implausible years on both sides", () => {
    expect(parseCsvDate("1989-12-31", "iso")).toBeNull();
    expect(parseCsvDate("1990-01-01", "iso")).toBe("1990-01-01");
    const wellBeyond = utcAddDays(utcToday(), 400).toISOString().slice(0, 10);
    expect(parseCsvDate(wellBeyond, "iso")).toBeNull();
    const nextMonth = utcAddDays(utcToday(), 30).toISOString().slice(0, 10);
    expect(parseCsvDate(nextMonth, "iso")).toBe(nextMonth);
  });

  it("rejects two-digit years rather than guessing a century", () => {
    expect(parseCsvDate("05/01/26", "dmy")).toBeNull();
  });

  it("reads spelled-out months in both orders", () => {
    expect(parseCsvDate("5 Jan 2026", "month-name")).toBe("2026-01-05");
    expect(parseCsvDate("Jan 5, 2026", "month-name")).toBe("2026-01-05");
    expect(parseCsvDate("05-January-2026", "month-name")).toBe("2026-01-05");
    expect(parseCsvDate("September 30 2025", "month-name")).toBe("2025-09-30");
    expect(parseCsvDate("Smarch 5, 2026", "month-name")).toBeNull();
  });

  it("returns null for blank and junk cells", () => {
    for (const junk of ["", "   ", "N/A", "-", "date", "2026", "not a date"]) {
      expect(parseCsvDate(junk, "dmy")).toBeNull();
    }
  });
});

describe("looksLikeDate", () => {
  it("recognises date shapes without judging validity of the whole column", () => {
    expect(looksLikeDate("2026-01-05")).toBe(true);
    expect(looksLikeDate("05/01/2026")).toBe(true);
    expect(looksLikeDate("5 Jan 2026")).toBe(true);
    expect(looksLikeDate("Groceries")).toBe(false);
    expect(looksLikeDate("1200.50")).toBe(false);
    expect(looksLikeDate("")).toBe(false);
  });
});

describe("detectDateFormat", () => {
  it("reads ISO files as ISO and unambiguous", () => {
    expect(detectDateFormat(["2026-01-05", "2026-02-11"])).toEqual({ format: "iso", ambiguous: false });
  });

  it("resolves day-first when a value can only be day-first", () => {
    // 25 cannot be a month, so the file must be dmy.
    expect(detectDateFormat(["05/01/2026", "25/01/2026"])).toEqual({ format: "dmy", ambiguous: false });
  });

  it("resolves month-first when a value can only be month-first", () => {
    expect(detectDateFormat(["01/25/2026", "01/05/2026"])).toEqual({ format: "mdy", ambiguous: false });
  });

  it("flags a file whose numeric dates all fit both readings", () => {
    expect(detectDateFormat(["05/01/2026", "03/02/2026"])).toEqual({ format: "dmy", ambiguous: true });
  });

  it("flags a self-contradictory file rather than importing half of it wrong", () => {
    // 25/01 is only dmy; 01/25 is only mdy. No single convention fits.
    expect(detectDateFormat(["25/01/2026", "01/25/2026"]).ambiguous).toBe(true);
  });

  it("ignores junk cells instead of letting one flip the answer", () => {
    expect(detectDateFormat(["25/01/2026", "N/A", "", "05/01/2026"])).toEqual({
      format: "dmy",
      ambiguous: false,
    });
  });

  it("detects spelled-out month files", () => {
    expect(detectDateFormat(["5 Jan 2026", "11 Feb 2026"])).toEqual({ format: "month-name", ambiguous: false });
  });
});

describe("ambiguousDateExample", () => {
  it("spells out both readings of the first genuinely ambiguous cell", () => {
    expect(ambiguousDateExample(["Groceries", "05/01/2026", "25/01/2026"])).toEqual({
      raw: "05/01/2026",
      dmyIso: "2026-01-05",
      mdyIso: "2026-05-01",
    });
  });

  it("returns null when nothing is ambiguous", () => {
    // Same value both ways — a genuinely identical reading is not ambiguous.
    expect(ambiguousDateExample(["05/05/2026"])).toBeNull();
    expect(ambiguousDateExample(["2026-01-05", "25/01/2026"])).toBeNull();
  });
});
