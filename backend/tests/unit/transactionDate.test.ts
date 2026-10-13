import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/middleware/error.middleware";
import {
  FUTURE_DATE_CODE,
  FUTURE_DATE_MESSAGE,
  assertNotFutureDate,
  businessTodayKey,
  isAfterToday,
} from "../../src/lib/transactionDate";

// 16:30 UTC on Sep 30 is 00:30 on Oct 1 in Manila (UTC+8): the window where the
// server's UTC day and the business's day disagree.
const JUST_AFTER_MANILA_MIDNIGHT = new Date("2026-09-30T16:30:00.000Z");
const JUST_BEFORE_MANILA_MIDNIGHT = new Date("2026-09-30T15:59:59.000Z");

function rejection(fn: () => void): ApiError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as ApiError;
  }
}

describe("businessTodayKey", () => {
  it("reads the business's own calendar day, not the server's UTC day", () => {
    expect(businessTodayKey("Asia/Manila", JUST_AFTER_MANILA_MIDNIGHT)).toBe("2026-10-01");
    expect(businessTodayKey("UTC", JUST_AFTER_MANILA_MIDNIGHT)).toBe("2026-09-30");
    expect(businessTodayKey("America/Los_Angeles", JUST_AFTER_MANILA_MIDNIGHT)).toBe("2026-09-30");
  });

  it("turns over exactly at local midnight", () => {
    expect(businessTodayKey("Asia/Manila", JUST_BEFORE_MANILA_MIDNIGHT)).toBe("2026-09-30");
    expect(businessTodayKey("Asia/Manila", JUST_AFTER_MANILA_MIDNIGHT)).toBe("2026-10-01");
  });

  it("handles zones a full day ahead of others", () => {
    // UTC+14 is already on Oct 1 at 10:00 UTC on Sep 30; UTC-10 is still on Sep 30.
    const now = new Date("2026-09-30T10:00:00.000Z");
    expect(businessTodayKey("Pacific/Kiritimati", now)).toBe("2026-10-01");
    expect(businessTodayKey("Pacific/Honolulu", now)).toBe("2026-09-30");
  });
});

describe("assertNotFutureDate", () => {
  const now = new Date("2026-09-17T04:00:00.000Z"); // noon in Manila

  it("accepts yesterday and today", () => {
    expect(() => assertNotFutureDate("2026-09-16", "Asia/Manila", now)).not.toThrow();
    expect(() => assertNotFutureDate("2026-09-17", "Asia/Manila", now)).not.toThrow();
    expect(() => assertNotFutureDate(new Date("2026-09-17T00:00:00.000Z"), "Asia/Manila", now)).not.toThrow();
  });

  it("rejects tomorrow with the API's error shape and never moves the date", () => {
    const err = rejection(() => assertNotFutureDate("2026-09-18", "Asia/Manila", now));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      message: FUTURE_DATE_MESSAGE,
      code: FUTURE_DATE_CODE,
      responseDetails: { field: "date", latestDate: "2026-09-17" },
    });
  });

  it("lets a Manila owner save today's date between local midnight and 08:00", () => {
    expect(() => assertNotFutureDate("2026-10-01", "Asia/Manila", JUST_AFTER_MANILA_MIDNIGHT)).not.toThrow();
    // The same date is still tomorrow for a business on UTC.
    expect(rejection(() => assertNotFutureDate("2026-10-01", "UTC", JUST_AFTER_MANILA_MIDNIGHT))?.code).toBe(FUTURE_DATE_CODE);
  });

  it("rejects tomorrow one second before local midnight", () => {
    expect(rejection(() => assertNotFutureDate("2026-10-01", "Asia/Manila", JUST_BEFORE_MANILA_MIDNIGHT))?.code).toBe(FUTURE_DATE_CODE);
  });
});

describe("isAfterToday", () => {
  it("compares calendar days, whatever the form of the date", () => {
    expect(isAfterToday("2026-09-18", "2026-09-17")).toBe(true);
    expect(isAfterToday("2026-09-17", "2026-09-17")).toBe(false);
    expect(isAfterToday(new Date("2026-09-18T00:00:00.000Z"), "2026-09-17")).toBe(true);
    expect(isAfterToday("2026-09-17T00:00:00.000Z", "2026-09-17")).toBe(false);
  });
});
