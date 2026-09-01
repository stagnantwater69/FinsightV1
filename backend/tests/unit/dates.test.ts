import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBusinessToday,
  utcAddDays,
  utcDateKey,
  utcDayOfMonth,
  utcDaysInMonth,
  utcEndOfDay,
  utcStartOfDay,
  utcStartOfMonth,
  utcToday,
} from "../../src/lib/dates";

// Regression tests for a real bug: record dates are date-only values stored at
// UTC midnight, but day boundaries were being computed with local-time getters.
// On this project's target timezone (UTC+8) local midnight on the 25th is
// 16:00Z on the 24th, which sorts BEFORE the 25th's stored value — so every
// record dated today silently vanished from the dashboard and from
// expense-behaviour trends. These tests pin the UTC semantics.

const AT_UTC_MIDNIGHT = new Date("2026-07-25T00:00:00.000Z");
// Late enough in the UTC day that a UTC+8 machine has already rolled over to
// the 26th locally — the case that used to break.
const LATE_IN_UTC_DAY = new Date("2026-07-25T23:30:00.000Z");
// Early enough that a UTC-5 machine is still on the 24th locally.
const EARLY_IN_UTC_DAY = new Date("2026-07-25T02:00:00.000Z");

describe("utcStartOfDay", () => {
  it("is a no-op on a value already at UTC midnight", () => {
    expect(utcStartOfDay(AT_UTC_MIDNIGHT).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("floors to the same UTC day regardless of time of day", () => {
    expect(utcStartOfDay(LATE_IN_UTC_DAY).toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(utcStartOfDay(EARLY_IN_UTC_DAY).toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });
});

describe("utcEndOfDay", () => {
  it("is the last representable instant of the UTC day", () => {
    expect(utcEndOfDay(AT_UTC_MIDNIGHT).toISOString()).toBe("2026-07-25T23:59:59.999Z");
  });

  it("includes a record stored at that day's UTC midnight", () => {
    // This is the actual assertion the bug violated: an `lte` bound built from
    // the day must not exclude a record dated that day.
    const recordDate = new Date("2026-07-25T00:00:00.000Z");
    const upperBound = utcEndOfDay(utcStartOfDay(LATE_IN_UTC_DAY));
    expect(recordDate.getTime()).toBeLessThanOrEqual(upperBound.getTime());
  });

  it("excludes a record dated the following day", () => {
    const tomorrow = new Date("2026-07-26T00:00:00.000Z");
    expect(tomorrow.getTime()).toBeGreaterThan(utcEndOfDay(AT_UTC_MIDNIGHT).getTime());
  });
});

describe("a range built from these helpers spans exactly the intended days", () => {
  it("a single-day range contains that day's record and neither neighbour", () => {
    const day = utcStartOfDay(AT_UTC_MIDNIGHT);
    const from = day;
    const to = utcEndOfDay(day);

    const yesterday = new Date("2026-07-24T00:00:00.000Z");
    const today = new Date("2026-07-25T00:00:00.000Z");
    const tomorrow = new Date("2026-07-26T00:00:00.000Z");

    const inRange = (d: Date) => d >= from && d <= to;
    expect(inRange(yesterday)).toBe(false);
    expect(inRange(today)).toBe(true);
    expect(inRange(tomorrow)).toBe(false);
  });

  it("a 30-day window includes both endpoints", () => {
    const today = utcStartOfDay(AT_UTC_MIDNIGHT);
    const from = utcAddDays(today, -29);
    const to = utcEndOfDay(today);
    expect(utcDateKey(from)).toBe("2026-06-26");
    expect(from >= from && from <= to).toBe(true);
    expect(today <= to).toBe(true);
  });
});

describe("utcAddDays", () => {
  it("moves forward and backward", () => {
    expect(utcDateKey(utcAddDays(AT_UTC_MIDNIGHT, 1))).toBe("2026-07-26");
    expect(utcDateKey(utcAddDays(AT_UTC_MIDNIGHT, -1))).toBe("2026-07-24");
  });

  it("crosses month boundaries", () => {
    expect(utcDateKey(utcAddDays(new Date("2026-07-31T00:00:00.000Z"), 1))).toBe("2026-08-01");
    expect(utcDateKey(utcAddDays(new Date("2026-07-01T00:00:00.000Z"), -1))).toBe("2026-06-30");
  });

  it("crosses year boundaries", () => {
    expect(utcDateKey(utcAddDays(new Date("2026-12-31T00:00:00.000Z"), 1))).toBe("2027-01-01");
  });

  it("does not mutate its input", () => {
    const original = new Date("2026-07-25T00:00:00.000Z");
    utcAddDays(original, 10);
    expect(original.toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("is unaffected by daylight-saving transitions", () => {
    // Local-time date arithmetic can yield a 23- or 25-hour "day" across a DST
    // boundary. UTC has no DST, so adding a day always adds exactly 24 hours.
    const before = new Date("2026-03-07T00:00:00.000Z");
    const after = utcAddDays(before, 1);
    expect(after.getTime() - before.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("utcStartOfMonth / utcDaysInMonth / utcDayOfMonth", () => {
  it("finds the 1st of the month at UTC midnight", () => {
    expect(utcStartOfMonth(LATE_IN_UTC_DAY).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("reads the day of month in UTC", () => {
    expect(utcDayOfMonth(LATE_IN_UTC_DAY)).toBe(25);
    expect(utcDayOfMonth(EARLY_IN_UTC_DAY)).toBe(25);
  });

  it("returns correct month lengths including leap years", () => {
    expect(utcDaysInMonth(new Date("2026-01-15T00:00:00.000Z"))).toBe(31);
    expect(utcDaysInMonth(new Date("2026-04-15T00:00:00.000Z"))).toBe(30);
    expect(utcDaysInMonth(new Date("2026-02-15T00:00:00.000Z"))).toBe(28);
    expect(utcDaysInMonth(new Date("2028-02-15T00:00:00.000Z"))).toBe(29);
  });
});

describe("utcDateKey", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(utcDateKey(AT_UTC_MIDNIGHT)).toBe("2026-07-25");
  });

  it("uses the UTC day even late in the UTC day", () => {
    expect(utcDateKey(LATE_IN_UTC_DAY)).toBe("2026-07-25");
  });
});

describe("utcToday", () => {
  it("returns midnight UTC", () => {
    const t = utcToday();
    expect(t.getUTCHours()).toBe(0);
    expect(t.getUTCMinutes()).toBe(0);
    expect(t.getUTCSeconds()).toBe(0);
    expect(t.getUTCMilliseconds()).toBe(0);
  });

  it("matches the current UTC calendar day", () => {
    expect(utcDateKey(utcToday())).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("resolveBusinessToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is already the next local day in Asia/Manila (UTC+8) while UTC is still on the previous day", () => {
    // 20:00 UTC on the 25th is 04:00 the next morning in Manila.
    vi.setSystemTime(new Date("2026-07-25T20:00:00.000Z"));
    expect(utcDateKey(utcToday())).toBe("2026-07-25");
    expect(utcDateKey(resolveBusinessToday("Asia/Manila"))).toBe("2026-07-26");
  });

  it("is still on the previous local day in America/Los_Angeles while UTC has already rolled over — not a hardcoded +8", () => {
    // 02:00 UTC on the 26th is 19:00 the previous evening in Los Angeles (PDT, UTC-7).
    vi.setSystemTime(new Date("2026-07-26T02:00:00.000Z"));
    expect(utcDateKey(utcToday())).toBe("2026-07-26");
    expect(utcDateKey(resolveBusinessToday("America/Los_Angeles"))).toBe("2026-07-25");
  });

  it("returns a UTC-midnight-encoded Date, matching the date-only construction convention used elsewhere", () => {
    vi.setSystemTime(new Date("2026-07-25T20:00:00.000Z"));
    const result = resolveBusinessToday("Asia/Manila");
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });

  it("agrees with utcToday() when the local zone and UTC are on the same calendar day", () => {
    vi.setSystemTime(new Date("2026-07-25T05:00:00.000Z"));
    expect(utcDateKey(resolveBusinessToday("Asia/Manila"))).toBe(utcDateKey(utcToday()));
  });
});
