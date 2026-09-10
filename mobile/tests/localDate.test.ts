import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { toLocalISODate, todayISO } from "../src/lib/localDate";

/**
 * The date a record gets filed under is the device's day, not UTC's.
 *
 * WHY THIS FILE EXISTS: the add-expense, add-sales and scan-receipt screens
 * all defaulted their date field with `new Date().toISOString().slice(0, 10)`.
 * That is the UTC day. The owners this app is for are in the Philippines
 * (UTC+8), so between midnight and 08:00 local every one of those defaults was
 * yesterday — and the owner sees "Today" on the field, because DateField reads
 * the string back in LOCAL time, where the mismatch is invisible.
 *
 * The consequence is not cosmetic: a wrong date moves the dashboard period,
 * the daily-spend chart, recurring-schedule matching and the recovery target,
 * and it is permanent once saved.
 *
 * The clock is stubbed at the exact reported instant, in the exact reported
 * timezone. `process.env.TZ` is honoured by Node's date implementation from
 * the moment it is assigned, which is what lets a UTC CI machine reproduce a
 * Manila morning.
 */

const ORIGINAL_TZ = process.env.TZ;

/**
 * Source with comments removed.
 *
 * The sweep below looks for a UTC `today` default in CODE. Several files
 * discuss `new Date().toISOString()` in prose precisely because it is the
 * mistake being guarded against — including this fix's own explanation — and a
 * naive text search flags the documentation instead of the defect.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every .ts/.tsx file under src/, for the app-wide sweep at the bottom. */
function sourceFiles(dir = join(__dirname, "..", "src"), prefix = ""): { name: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, `${prefix}${entry.name}/`);
    return /\.tsx?$/.test(entry.name)
      ? [{ name: `${prefix}${entry.name}`, text: readFileSync(full, "utf8") }]
      : [];
  });
}

/** 02:30 on 20 August 2026 in Manila — the reported failure, to the hour. */
const MANILA_EARLY_MORNING = new Date("2026-08-19T18:30:00.000Z");

function withTimezone(tz: string, at: Date, run: () => void) {
  process.env.TZ = tz;
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

beforeAll(() => {
  // Proves the harness itself works: if assigning TZ did nothing, this suite
  // would pass vacuously on a UTC machine no matter how the helper behaves.
  process.env.TZ = "Asia/Manila";
  expect(new Date("2026-08-19T18:30:00.000Z").getHours(), "TZ override had no effect").toBe(2);
});

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("local calendar date", () => {
  it("returns the LOCAL day at 02:30 in Manila, not the UTC one", () => {
    withTimezone("Asia/Manila", MANILA_EARLY_MORNING, () => {
      expect(todayISO()).toBe("2026-08-20");
      // The bug, stated as an assertion: this is what the old default returned.
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-19");
    });
  });

  it("is equally correct west of UTC, where local is the EARLIER day", () => {
    // 21:00 on 19 August in Los Angeles (UTC-7) — the mirror image of Manila.
    withTimezone("America/Los_Angeles", new Date("2026-08-20T04:00:00.000Z"), () => {
      expect(todayISO()).toBe("2026-08-19");
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-20");
    });
  });

  it("agrees with UTC when the device is in UTC", () => {
    withTimezone("UTC", MANILA_EARLY_MORNING, () => {
      expect(todayISO()).toBe("2026-08-19");
    });
  });

  it("formats an arbitrary date with zero-padded month and day", () => {
    expect(toLocalISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toLocalISODate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  /*
   * Read as source rather than imported: `screens/records/shared.tsx` pulls in
   * React Native, which the source suite deliberately does not load (see
   * vitest.config.ts). What matters here is only which implementation the
   * three records screens get, and that is answerable from the text.
   */
  it("is what the records screens default their date field with", () => {
    const shared = readFileSync(join(__dirname, "..", "src", "screens", "records", "shared.tsx"), "utf8");
    expect(shared).toMatch(/export \{ todayISO \} from "\.\.\/\.\.\/lib\/localDate";/);
    expect(codeOnly(shared), "a UTC `today` default is back in shared.tsx").not.toContain("toISOString");
  });

  it("leaves no toISOString-derived default date anywhere in the app", () => {
    const offenders = sourceFiles().filter(({ text }) => /new Date\(\)\.toISOString\(\)/.test(codeOnly(text)));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });
});
