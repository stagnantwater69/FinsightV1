import { describe, expect, it } from "vitest";
import {
  formatDayRange,
  monthLabel,
  periodKey,
  periodLabel,
  periodParams,
  periodPhrase,
  previousLabel,
  samePeriod,
  windowKey,
  type PeriodWindow,
} from "./reportingPeriod";

const AUGUST = { kind: "month", month: "2026-08" } as const;

describe("reportingPeriod", () => {
  it("asks the server for each choice by name", () => {
    expect(periodParams({ kind: "week" })).toEqual({ period: "week" });
    expect(periodParams(AUGUST)).toEqual({ period: "month", month: "2026-08" });
    expect(periodParams({ kind: "all" })).toEqual({ period: "all" });
  });

  it("names a month by its calendar name, never shifted a month by the time zone", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });

  it("captions and phrases each choice", () => {
    expect(periodLabel({ kind: "week" })).toBe("This week");
    expect(periodLabel(AUGUST)).toBe("August 2026");
    expect(periodLabel({ kind: "all" })).toBe("All time");
    expect(periodPhrase({ kind: "week" })).toBe("this week");
    expect(periodPhrase(AUGUST)).toBe("in August 2026");
    expect(periodPhrase({ kind: "all" })).toBe("across all records");
  });

  it("writes a short day range without dashes", () => {
    expect(formatDayRange("2026-08-01", "2026-08-24")).toBe("Aug 1-24");
    expect(formatDayRange("2026-09-28", "2026-10-04")).toBe("Sep 28 to Oct 4");
    expect(formatDayRange("2026-08-05", "2026-08-05")).toBe("Aug 5");
  });

  it("names a finished month's comparison, and the same days of an in-progress one", () => {
    const finished: PeriodWindow = {
      kind: "month", month: "2026-08", start: "2026-08-01", end: "2026-08-31", days: 31, elapsedDays: 31,
      previous: { start: "2026-07-01", end: "2026-07-31" },
    };
    const inProgress: PeriodWindow = {
      ...finished, month: "2026-09", start: "2026-09-01", end: "2026-09-30", days: 30, elapsedDays: 24,
      previous: { start: "2026-08-01", end: "2026-08-24" },
    };
    expect(previousLabel(finished)).toBe("July 2026");
    expect(previousLabel(inProgress)).toBe("Aug 1-24");
    expect(previousLabel({ ...finished, kind: "all", previous: null })).toBeNull();
    expect(previousLabel(undefined)).toBeNull();
  });

  it("keys a selection and the window a response was computed for the same way", () => {
    expect(periodKey(AUGUST)).toBe("month:2026-08");
    expect(windowKey({ kind: "month", month: "2026-08", start: null, end: null, days: 31, elapsedDays: 31, previous: null })).toBe("month:2026-08");
    expect(windowKey(undefined)).toBeNull();
    expect(samePeriod(AUGUST, { kind: "month", month: "2026-08" })).toBe(true);
    expect(samePeriod(AUGUST, { kind: "week" })).toBe(false);
  });
});
