import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  ALL_TIME_PERIOD_DAYS,
  DEFAULT_SUMMARY_PERIOD_DAYS,
  PERIOD_OPTIONS,
  periodLabel,
  periodPhrase,
} from "../src/lib/dashboardPeriod";

/**
 * Home's figures and Home's caption describe the same window.
 *
 * WHY THIS FILE EXISTS: `/dashboard/summary` returns a ROLLING lookback ending
 * today. Home captioned the 30-day one "This month", so on 20 August the Sales
 * and Expenses cards showed 22 July - 20 August under a heading an owner reads
 * as August. Their own books will never agree with those figures, and nothing
 * on the screen says why.
 *
 * The window is the server's and stays the server's — this is entirely about
 * what the client calls it.
 */

const BACKEND_DASHBOARD = join(__dirname, "..", "..", "backend", "src", "services", "dashboard.service.ts");

describe("dashboard period labels", () => {
  it("names the 30-day window by its length, never as a calendar month", () => {
    expect(periodLabel(30)).toBe("Last 30 days");
    expect(periodLabel(30).toLowerCase()).not.toContain("month");
  });

  it("names the 7-day window by its length, never as a calendar week", () => {
    expect(periodLabel(7)).toBe("Last 7 days");
    expect(periodLabel(7).toLowerCase()).not.toContain("week");
  });

  it("keeps the two windows that ARE honestly named", () => {
    // A one-day lookback ending today IS today, and all-time is all-time.
    expect(periodLabel(1)).toBe("Today");
    expect(periodLabel(ALL_TIME_PERIOD_DAYS)).toBe("Across all records");
  });

  it("reads as a phrase inside the empty-period sentence", () => {
    expect(`No records for ${periodPhrase(30)}`).toBe("No records for the last 30 days");
    expect(`No records for ${periodPhrase(1)}`).toBe("No records for today");
    expect(`No records for ${periodPhrase(ALL_TIME_PERIOD_DAYS)}`).toBe("No records for all time");
  });

  it("offers a way back to the default from every window", () => {
    const days = PERIOD_OPTIONS.map((o) => o.days);
    // Reversibility, as a data property: "All time" is one option among
    // several, and the default it replaces is still in the same list. When
    // the only setter was the empty-period callout's button, it was not.
    expect(days).toContain(ALL_TIME_PERIOD_DAYS);
    expect(days).toContain(DEFAULT_SUMMARY_PERIOD_DAYS);
    expect(new Set(days).size).toBe(days.length);
  });

  it("labels every option it offers", () => {
    for (const option of PERIOD_OPTIONS) {
      expect(option.label.trim().length).toBeGreaterThan(0);
      expect(periodLabel(option.days).toLowerCase()).not.toContain("this month");
    }
  });

  /*
   * The one assertion that could go stale on the SERVER's side. `periodDays`
   * is a rolling lookback there (`startDate = today - (periodDays - 1)`), and
   * these labels are only honest for as long as that is true. If the server
   * ever switched to calendar months, this fails and the labels get revisited
   * — rather than the drift being discovered on a customer's dashboard.
   */
  it("still describes a rolling lookback, which is what the server computes", () => {
    const src = readFileSync(BACKEND_DASHBOARD, "utf8");
    expect(src, "dashboard.service.ts no longer computes a rolling window").toContain(
      "utcAddDays(today, -(periodDays - 1))",
    );
  });
});
