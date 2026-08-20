import { describe, expect, it } from "vitest";
import { parseCsvDate } from "./csvDates";

/**
 * The row preview must agree with the server about which rows are broken.
 *
 * It used to run `new Date(rawDate)`, which said yes to dates the server
 * rejects and resolved others to a different day — so the preview would tell
 * an owner to "fix" a row that was fine, or stay silent about one the import
 * then skipped. Each case below is one of the three ways the string
 * constructor disagreed.
 */
describe("web CSV date parsing mirrors the server", () => {
  it("does not guess a convention the way the string constructor did", () => {
    // new Date("05/01/2026") is always May 1st. The file decides here.
    expect(parseCsvDate("05/01/2026", "dmy")).toBe("2026-01-05");
    expect(parseCsvDate("05/01/2026", "mdy")).toBe("2026-05-01");
  });

  it("does not shift the day into browser-local time", () => {
    // The UTC+8 failure: new Date("2026-01-05").toISOString() lands on the 4th
    // once local midnight is applied.
    expect(parseCsvDate("2026-01-05", "iso")).toBe("2026-01-05");
    expect(parseCsvDate("2026-12-31", "iso")).toBe("2026-12-31");
  });

  it("rejects impossible dates instead of rolling them into the next month", () => {
    // new Date("2026-02-31") silently becomes March 3rd and reads as valid.
    expect(parseCsvDate("2026-02-31", "iso")).toBeNull();
    expect(parseCsvDate("31/02/2026", "dmy")).toBeNull();
    expect(parseCsvDate("29/02/2025", "dmy")).toBeNull();
    expect(parseCsvDate("29/02/2024", "dmy")).toBe("2024-02-29");
  });

  it("refuses junk the preview must flag before the import does", () => {
    for (const junk of ["", "   ", "N/A", "not a date", "2026"]) {
      expect(parseCsvDate(junk, "dmy")).toBeNull();
    }
  });

  it("accepts ISO under any stated convention, as the correction input emits it", () => {
    for (const format of ["iso", "dmy", "mdy", "month-name"] as const) {
      expect(parseCsvDate("2026-03-09", format)).toBe("2026-03-09");
    }
  });

  it("bounds implausible years the same way the server does", () => {
    expect(parseCsvDate("1989-12-31", "iso")).toBeNull();
    expect(parseCsvDate("1990-01-01", "iso")).toBe("1990-01-01");
  });
});
