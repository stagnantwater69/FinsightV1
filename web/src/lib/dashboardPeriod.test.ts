import { describe, expect, it } from "vitest";
import {
  ALL_TIME_PERIOD_DAYS,
  DEFAULT_SUMMARY_PERIOD_DAYS,
  PERIOD_OPTIONS,
  periodLabel,
  periodPhrase,
} from "./dashboardPeriod";

/**
 * WHAT THIS FILE GUARDS: the Dashboard names the window the server actually
 * computed, in the same words the mobile app uses.
 *
 * `/dashboard/summary` returns a ROLLING lookback ending today
 * (`startDate = today - (periodDays - 1)`). Captioning that "This month" told
 * an owner on 20 August that 22 July - 20 August was August; reconciling those
 * figures against their own August books cannot work. Nothing about the
 * arithmetic changed — only the caption, and this pins the caption.
 *
 * The exact strings are asserted rather than derived, because the point is
 * agreement with `mobile/src/lib/dashboardPeriod.ts`: if either side is
 * reworded on its own, the two clients start describing the same endpoint
 * differently and this fails.
 */

describe("dashboard period wording", () => {
  it("labels the segmented control by window LENGTH, not by a calendar name", () => {
    expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual(["Today", "7 days", "30 days", "All time"]);
    // No calendar noun anywhere: these are rolling windows.
    for (const option of PERIOD_OPTIONS) {
      expect(option.label).not.toMatch(/this|week|month/i);
    }
  });

  it("keeps the windows the server understands", () => {
    expect(PERIOD_OPTIONS.map((o) => o.days)).toEqual([1, 7, 30, ALL_TIME_PERIOD_DAYS]);
    expect(DEFAULT_SUMMARY_PERIOD_DAYS).toBe(30);
    expect(ALL_TIME_PERIOD_DAYS).toBe(0);
  });

  it("captions a window as a heading", () => {
    expect(periodLabel(1)).toBe("Today");
    expect(periodLabel(7)).toBe("Last 7 days");
    expect(periodLabel(30)).toBe("Last 30 days");
    // The all-time case the page already handled correctly, preserved.
    expect(periodLabel(ALL_TIME_PERIOD_DAYS)).toBe("Across all records");
  });

  it("has a separate mid-sentence form, so the caption is not just lowercased", () => {
    expect(periodPhrase(1)).toBe("today");
    expect(periodPhrase(7)).toBe("the last 7 days");
    expect(periodPhrase(30)).toBe("the last 30 days");
    expect(periodPhrase(ALL_TIME_PERIOD_DAYS)).toBe("all time");
  });
});
