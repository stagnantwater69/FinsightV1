import { describe, expect, it } from "vitest";
import {
  buildCumulativeSeries,
  formatOperatingDays,
  recoveryAskQuestion,
  recoveryHighlights,
  recoveryPeriodStatusLabel,
  recoverySummaryText,
  todayPercent,
} from "../src/lib/recoveryPeriodView";
import type { DailyCoverageRow, RecoveryCheckpoint, RecoveryReportingPeriod } from "../src/lib/types";

function day(date: string, sales: number, neededTarget: number | null): DailyCoverageRow {
  return {
    date,
    sales,
    neededTarget,
    gap: neededTarget === null ? null : sales - neededTarget,
    status: neededTarget === null ? "closed" : sales >= neededTarget ? "above" : "below",
  };
}

const period = {
  start: "2026-10-01",
  end: "2026-10-10",
  target: 1000,
  isComplete: false,
};

describe("buildCumulativeSeries", () => {
  it("keeps running totals for recorded days, skipping closed days' target", () => {
    const points = buildCumulativeSeries(
      [day("2026-10-02", 50, 100), day("2026-10-01", 120, 100), day("2026-10-03", 30, null)],
      { ...period, isComplete: true },
    );
    expect(points.map((p) => [p.date, p.sales, p.target])).toEqual([
      ["2026-10-01", 120, 100],
      ["2026-10-02", 170, 200],
      ["2026-10-03", 200, 200],
    ]);
    expect(points.every((p) => !p.estimated)).toBe(true);
  });

  it("estimates the target line to the period end, with no sales past the as-of date", () => {
    const points = buildCumulativeSeries([day("2026-10-01", 0, 100)], period);
    expect(points).toHaveLength(10);
    const last = points.at(-1)!;
    expect(last).toMatchObject({ date: "2026-10-10", sales: null, target: 1000, estimated: true });
    expect(points[1]).toMatchObject({ date: "2026-10-02", sales: null, target: 200 });
  });

  it("passes through a future checkpoint's exact cumulative target", () => {
    const checkpoint: RecoveryCheckpoint = {
      endDate: "2026-10-05",
      cumulativeTarget: 300,
      recordedAmount: null,
      variance: null,
      status: "pending",
    };
    const points = buildCumulativeSeries([day("2026-10-01", 0, 100)], period, [checkpoint]);
    expect(points.find((p) => p.date === "2026-10-05")?.target).toBe(300);
    expect(points.at(-1)?.target).toBe(1000);
  });

  it("draws the whole target estimate when no day is recorded yet", () => {
    const points = buildCumulativeSeries([], period);
    expect(points[0]).toMatchObject({ date: "2026-10-01", target: 100 });
    expect(points.at(-1)?.target).toBe(1000);
  });
});

const week = {
  kind: "week",
  month: null,
  start: "2026-10-05",
  end: "2026-10-11",
  isComplete: false,
  status: "behind",
  sales: 300,
  target: 1000,
  remainingTarget: 700,
  adjustedDailyTarget: 175,
  paceVarianceAmount: -120,
} as unknown as RecoveryReportingPeriod;

describe("recovery period view", () => {
  it("states the summary the way web does", () => {
    expect(recoverySummaryText(week)).toBe(
      "Recorded sales this week are PHP 300 against a PHP 1,000 target. Behind pace. The remaining target is PHP 700, or about PHP 175 per remaining operating day.",
    );
    expect(recoverySummaryText({ ...week, isComplete: true, status: "on_pace" })).toBe(
      "Recorded sales this week are PHP 300 against a PHP 1,000 target. Finished on target.",
    );
  });

  it("names the pace gap in the ask question", () => {
    expect(recoveryAskQuestion(week)).toBe(
      "Why are my recorded sales PHP 120 behind pace this week, and what should I review?",
    );
  });

  it("names a month with no sales", () => {
    expect(recoveryPeriodStatusLabel({ ...week, kind: "month", month: "2026-08", status: "no_data" })).toBe(
      "No sales recorded in August 2026",
    );
  });

  it("marks estimated operating days", () => {
    expect(formatOperatingDays(21.54, true)).toBe("≈ 21.5");
    expect(formatOperatingDays(22, true)).toBe("≈ 22");
    expect(formatOperatingDays(22.4, false)).toBe("22");
  });

  it("reads highlights straight off the rows", () => {
    const items = recoveryHighlights([day("2026-10-01", 120, 100), day("2026-10-02", 50, 100), day("2026-10-03", 0, null)]);
    expect(items.map((i) => i.title)).toEqual(["Open days on target", "Highest sales day", "Closed days"]);
    expect(items[0].body).toBe("1 of 2 open days so far reached the allocated target.");
    expect(items[2].body).toBe("1 day was closed on your schedule and carries no target.");
  });

  it("measures today against today's target", () => {
    expect(todayPercent({ todaysSales: 50, todaysTarget: 200 })).toBe(25);
    expect(todayPercent({ todaysSales: 10, todaysTarget: 0 })).toBe(100);
    expect(todayPercent({ todaysSales: 0, todaysTarget: 0 })).toBe(0);
  });
});
