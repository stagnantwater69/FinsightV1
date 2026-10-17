import { describe, expect, it } from "vitest";
import { buildCumulativeSeries } from "./recoverySeries";
import type { DailyCoverageRow, RecoveryCheckpoint } from "../../lib/types";

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
