import { describe, expect, it } from "vitest";
import {
  describeWindow,
  resolveReportingWindow,
  selectionFromQuery,
  windowDateFilter,
} from "../../src/lib/reportingPeriod";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const keys = (window: ReturnType<typeof resolveReportingWindow>) => describeWindow(window);

describe("resolveReportingWindow: this week", () => {
  it("runs Monday to Sunday of the week containing today", () => {
    // 2026-09-30 is a Wednesday.
    const window = keys(resolveReportingWindow({ kind: "week" }, day("2026-09-30")));
    expect(window).toMatchObject({ kind: "week", start: "2026-09-28", end: "2026-10-04", days: 7, elapsedDays: 3 });
  });

  it("compares with the same weekdays of last week, not all seven days", () => {
    const window = keys(resolveReportingWindow({ kind: "week" }, day("2026-09-30")));
    expect(window.previous).toEqual({ start: "2026-09-21", end: "2026-09-23" });
  });

  it("treats Sunday as the last day of the week, not the first", () => {
    const window = keys(resolveReportingWindow({ kind: "week" }, day("2026-10-04")));
    expect(window).toMatchObject({ start: "2026-09-28", end: "2026-10-04", elapsedDays: 7 });
    expect(window.previous).toEqual({ start: "2026-09-21", end: "2026-09-27" });
  });

  it("starts on a Monday when today is Monday", () => {
    const window = keys(resolveReportingWindow({ kind: "week" }, day("2026-09-28")));
    expect(window).toMatchObject({ start: "2026-09-28", elapsedDays: 1 });
    expect(window.previous).toEqual({ start: "2026-09-21", end: "2026-09-21" });
  });
});

describe("resolveReportingWindow: a calendar month", () => {
  it("covers the whole month, first to last day", () => {
    const window = keys(resolveReportingWindow({ kind: "month", month: "2026-08" }, day("2026-09-30")));
    expect(window).toMatchObject({ kind: "month", month: "2026-08", start: "2026-08-01", end: "2026-08-31", days: 31, elapsedDays: 31 });
  });

  it("compares a finished month with all of the month before", () => {
    const window = keys(resolveReportingWindow({ kind: "month", month: "2026-08" }, day("2026-09-30")));
    expect(window.previous).toEqual({ start: "2026-07-01", end: "2026-07-31" });
  });

  it("compares the current month with the same days of last month", () => {
    const window = keys(resolveReportingWindow({ kind: "month", month: "2026-09" }, day("2026-09-24")));
    expect(window).toMatchObject({ start: "2026-09-01", end: "2026-09-30", elapsedDays: 24 });
    expect(window.previous).toEqual({ start: "2026-08-01", end: "2026-08-24" });
  });

  it("clamps the comparison to a shorter previous month", () => {
    // 31 March in progress: February 2026 only has 28 days.
    const window = keys(resolveReportingWindow({ kind: "month", month: "2026-03" }, day("2026-03-30")));
    expect(window.previous).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("handles leap-year February", () => {
    const window = keys(resolveReportingWindow({ kind: "month", month: "2028-02" }, day("2028-06-01")));
    expect(window).toMatchObject({ start: "2028-02-01", end: "2028-02-29", days: 29 });
  });

  it("crosses a year boundary for January's comparison", () => {
    const window = keys(resolveReportingWindow({ kind: "month", month: "2026-01" }, day("2026-09-30")));
    expect(window.previous).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });

  it("reports nothing elapsed for a month still ahead", () => {
    const window = keys(resolveReportingWindow({ kind: "month", month: "2026-11" }, day("2026-09-30")));
    expect(window.elapsedDays).toBe(0);
    expect(window.previous).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("rejects a month key that is not YYYY-MM", () => {
    expect(() => resolveReportingWindow({ kind: "month", month: "2026-13" }, day("2026-09-30"))).toThrow(/YYYY-MM/);
    expect(() => resolveReportingWindow({ kind: "month", month: "0099-01" }, day("2026-09-30"))).toThrow(/YYYY-MM/);
  });
});

describe("resolveReportingWindow: all time and the legacy rolling window", () => {
  it("gives all time no first day and nothing to compare with", () => {
    const window = resolveReportingWindow({ kind: "all" }, day("2026-09-30"));
    expect(window).toMatchObject({ kind: "all", start: null, end: null, days: null, previous: null });
    // No first day, but never past today.
    expect(windowDateFilter(window, day("2026-09-30"))).toEqual({ lte: new Date("2026-09-30T23:59:59.999Z") });
  });

  it("keeps the rolling window exactly as periodDays always meant it", () => {
    const window = keys(resolveReportingWindow({ kind: "rolling", days: 30 }, day("2026-09-30")));
    expect(window).toMatchObject({ start: "2026-09-01", end: "2026-09-30", days: 30 });
    expect(window.previous).toEqual({ start: "2026-08-02", end: "2026-08-31" });
  });

  it("anchors a rolling window on an explicit end date", () => {
    const window = keys(resolveReportingWindow({ kind: "rolling", days: 7, endDate: day("2025-07-31") }, day("2026-09-30")));
    expect(window).toMatchObject({ start: "2025-07-25", end: "2025-07-31" });
  });
});

describe("windowDateFilter", () => {
  it("includes every record dated on the last day", () => {
    const filter = windowDateFilter(resolveReportingWindow({ kind: "month", month: "2026-08" }, day("2026-09-30")), day("2026-09-30"));
    expect(filter.gte?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(filter.lte.toISOString()).toBe("2026-08-31T23:59:59.999Z");
  });

  it("stops a month or week still in progress at today, so future-dated records count nowhere", () => {
    const today = day("2026-09-17");
    const month = windowDateFilter(resolveReportingWindow({ kind: "month", month: "2026-09" }, today), today);
    expect(month).toEqual({ gte: day("2026-09-01"), lte: new Date("2026-09-17T23:59:59.999Z") });
    const week = windowDateFilter(resolveReportingWindow({ kind: "week" }, today), today);
    expect(week.lte.toISOString()).toBe("2026-09-17T23:59:59.999Z");
  });
});

describe("selectionFromQuery", () => {
  it("prefers an explicit period over periodDays", () => {
    expect(selectionFromQuery({ period: "week", periodDays: 30 })).toEqual({ kind: "week" });
    expect(selectionFromQuery({ period: "all", periodDays: 7 })).toEqual({ kind: "all" });
    expect(selectionFromQuery({ period: "month", month: "2026-09" })).toEqual({ kind: "month", month: "2026-09" });
  });

  it("requires the month when the period is a month", () => {
    expect(() => selectionFromQuery({ period: "month" })).toThrow(/month is required/);
  });

  it("keeps the legacy meanings of periodDays, including 0 for all time", () => {
    expect(selectionFromQuery({ periodDays: 0 })).toEqual({ kind: "all" });
    expect(selectionFromQuery({ periodDays: 7 })).toEqual({ kind: "rolling", days: 7 });
    expect(selectionFromQuery({})).toEqual({ kind: "rolling", days: 30 });
  });
});
