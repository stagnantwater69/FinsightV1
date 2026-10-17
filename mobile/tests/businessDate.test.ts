import { describe, expect, it } from "vitest";
import { businessToday } from "../src/lib/businessDate";
import { resolveBusinessToday } from "../../backend/src/lib/dates";

describe("transaction business dates", () => {
  it.each([
    ["Asia/Manila", "2026-09-30T16:00:00.000Z", "2026-10-01"],
    ["America/Los_Angeles", "2026-10-01T00:30:00.000Z", "2026-09-30"],
    ["America/Los_Angeles", "2026-01-01T07:59:59.000Z", "2025-12-31"],
    ["America/Los_Angeles", "2026-01-01T08:00:00.000Z", "2026-01-01"],
    ["America/Los_Angeles", "2026-07-01T06:59:59.000Z", "2026-06-30"],
    ["America/Los_Angeles", "2026-07-01T07:00:00.000Z", "2026-07-01"],
    ["Pacific/Kiritimati", "2026-12-31T10:00:00.000Z", "2027-01-01"],
  ])("matches the backend calendar for %s at %s", (zone, instant, expected) => {
    const now = new Date(instant);
    expect(businessToday(zone, now)).toBe(expected);
    expect(resolveBusinessToday(zone, now).toISOString().slice(0, 10)).toBe(expected);
  });
  it("uses the default business date if older client data contains an invalid timezone", () => {
    expect(businessToday("invalid/business-zone", new Date("2026-09-30T16:00:00.000Z"))).toBe("2026-10-01");
  });
});
