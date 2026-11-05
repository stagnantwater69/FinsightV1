import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarEntries,
  isClosedDay,
  isoWeekday,
  monthGrid,
  occurrencesInRange,
  shiftMonth,
} from "../src/lib/paymentCalendar";
import type { RecurringPattern, RecurringSchedule } from "../src/lib/types";

function schedule(over: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 1,
    businessProfileId: 1,
    categoryId: 3,
    categoryName: "Rent",
    label: "Shop rent",
    vendor: null,
    intervalDays: 30,
    expectedAmount: 12000,
    amountTolerance: 0.15,
    nextDueDate: "2026-11-05T00:00:00.000Z",
    lastRecordedDate: null,
    isActive: true,
    sourcePatternId: null,
    dueState: "SCHEDULED",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function pattern(over: Partial<RecurringPattern> = {}): RecurringPattern {
  return {
    id: 9,
    description: "LPG refill",
    vendor: null,
    intervalDays: 14,
    expectedAmount: 950,
    confidence: 0.8,
    nextExpectedDate: "2026-11-03T00:00:00.000Z",
    status: "CANDIDATE",
    category: { name: "Equipment" },
    ...over,
  } as RecurringPattern;
}

describe("calendar dates", () => {
  it("builds whole Monday-to-Sunday weeks around a month", () => {
    const days = monthGrid("2026-11");
    expect(days.length % 7).toBe(0);
    expect(isoWeekday(days[0]!)).toBe(1);
    expect(isoWeekday(days[days.length - 1]!)).toBe(7);
    expect(days).toContain("2026-11-01");
    expect(days).toContain("2026-11-30");
    // November 2026 starts on a Sunday, so the grid opens in October.
    expect(days[0]).toBe("2026-10-26");
  });

  it("steps across month and year ends in UTC", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("projects forward from the start date and never before it", () => {
    expect(occurrencesInRange("2026-11-05", 7, "2026-11-01", "2026-11-30")).toEqual([
      "2026-11-05",
      "2026-11-12",
      "2026-11-19",
      "2026-11-26",
    ]);
    // A start far in the past jumps to the first date inside the range.
    expect(occurrencesInRange("2026-09-01", 30, "2026-11-01", "2026-11-30")).toEqual(["2026-11-30"]);
    expect(occurrencesInRange("2026-12-10", 7, "2026-11-01", "2026-11-30")).toEqual([]);
  });
});

describe("calendarEntries", () => {
  it("marks the server's date as due and later dates as expected", () => {
    const byDate = calendarEntries([schedule({ intervalDays: 14 })], [], "2026-11-01", "2026-11-30");
    expect(byDate.get("2026-11-05")?.[0]).toMatchObject({ kind: "due", overdue: false });
    expect(byDate.get("2026-11-19")?.[0]).toMatchObject({ kind: "expected" });
  });

  it("flags only the server's date of an overdue schedule as overdue", () => {
    const byDate = calendarEntries(
      [schedule({ nextDueDate: "2026-11-02T00:00:00.000Z", intervalDays: 7, dueState: "OVERDUE" })],
      [],
      "2026-11-01",
      "2026-11-30",
    );
    expect(byDate.get("2026-11-02")?.[0]?.overdue).toBe(true);
    expect(byDate.get("2026-11-09")?.[0]?.overdue).toBe(false);
  });

  it("leaves paused schedules, answered suggestions and already-watched suggestions off", () => {
    const byDate = calendarEntries(
      [schedule({ isActive: false }), schedule({ id: 2, label: "Salaries", sourcePatternId: 9 })],
      [pattern(), pattern({ id: 10, status: "DISMISSED" })],
      "2026-11-01",
      "2026-11-30",
    );
    const all = [...byDate.values()].flat();
    expect(all.some((e) => e.label === "Shop rent")).toBe(false);
    expect(all.some((e) => e.kind === "suggested")).toBe(false);
    expect(all.some((e) => e.label === "Salaries")).toBe(true);
  });

  it("places an open suggestion as suggested and lists overdue first on a shared day", () => {
    const byDate = calendarEntries(
      [schedule({ nextDueDate: "2026-11-03T00:00:00.000Z", label: "Late bill", dueState: "OVERDUE" })],
      [pattern()],
      "2026-11-01",
      "2026-11-30",
    );
    const day = byDate.get("2026-11-03")!;
    expect(day.map((e) => e.kind)).toEqual(["due", "suggested"]);
    expect(day[0]!.overdue).toBe(true);
    expect(byDate.get("2026-11-17")?.[0]).toMatchObject({ kind: "suggested", patternId: 9 });
  });
});

describe("isClosedDay", () => {
  const weekly = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, isOpen: weekday !== 7 }));

  it("follows the weekly schedule", () => {
    expect(isClosedDay("2026-11-01", weekly, [])).toBe(true); // a Sunday
    expect(isClosedDay("2026-11-02", weekly, [])).toBe(false);
  });

  it("lets a date exception win over the weekly schedule", () => {
    const overrides = [
      { id: 1, businessProfileId: 1, date: "2026-11-01T00:00:00.000Z", type: "OPEN" as const, reason: null },
      { id: 2, businessProfileId: 1, date: "2026-11-02T00:00:00.000Z", type: "CLOSED" as const, reason: "Holiday" },
    ];
    expect(isClosedDay("2026-11-01", weekly, overrides)).toBe(false);
    expect(isClosedDay("2026-11-02", weekly, overrides)).toBe(true);
  });

  it("treats a never-configured schedule as open every day", () => {
    expect(isClosedDay("2026-11-01", [], [])).toBe(false);
  });
});
