import { describe, expect, it } from "vitest";
import { evaluateVelocity } from "../../src/services/anomalyDetection/velocity.service";

const day = (offset: number) => new Date(Date.UTC(2026, 7, 31 + offset));
const record = (id: number, offset: number, vendor = "Supplier A", categoryId = 1) => ({
  id,
  categoryId,
  vendor,
  amount: 100,
  date: day(offset),
});

describe("velocity evaluation", () => {
  it("detects a same-day burst against quiet comparable periods", () => {
    const candidate = record(3, 0);
    const signals = evaluateVelocity(candidate, [record(1, 0), record(2, 0), candidate]);

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ windowDays: 1, scope: "vendor", currentCount: 3, baselineMedianCount: 0 }),
    ]));
  });

  it("does not flag normal repeated activity", () => {
    const rows = Array.from({ length: 21 }, (_, index) => record(index + 1, -140 + index * 7));
    expect(evaluateVelocity(rows[20]!, rows)).toEqual([]);
  });

  it("does not count another vendor in the vendor signal", () => {
    const candidate = record(3, 0);
    const signals = evaluateVelocity(candidate, [record(1, 0, "Other"), record(2, 0, "Other"), candidate]);
    expect(signals.some((signal) => signal.scope === "vendor")).toBe(false);
  });

  it("counts the first day of every 1-day baseline window", () => {
    // Three rows a day for five days: the candidate's day is normal, not a burst.
    const rows = [0, -1, -2, -3, -4].flatMap((offset, d) =>
      [1, 2, 3].map((n) => record(d * 3 + n, offset)));
    const signals = evaluateVelocity(rows[0]!, rows);
    expect(signals.filter((signal) => signal.windowDays === 1)).toEqual([]);
  });

  it("counts the first day of every 7-day baseline window", () => {
    // Three rows per week in the current window, and three on the opening day of each prior week.
    const offsets = [0, -2, -4, ...[-13, -20, -27, -34].flatMap((offset) => [offset, offset, offset])];
    const rows = offsets.map((offset, index) => record(index + 1, offset));
    const signals = evaluateVelocity(rows[0]!, rows);
    expect(signals.filter((signal) => signal.windowDays === 7)).toEqual([]);
  });

  it("puts a non-midnight timestamp in exactly one window", () => {
    // Late-evening rows on each of the four prior days must land in that day's 1-day baseline window.
    const late = (id: number, offset: number) => ({ ...record(id, offset), date: new Date(day(offset).getTime() + 23 * 3_600_000) });
    const rows = [record(1, 0), record(2, 0), record(3, 0),
      ...[-1, -2, -3, -4].flatMap((offset, d) => [1, 2, 3].map((n) => late(3 + d * 3 + n, offset)))];
    const signals = evaluateVelocity(rows[0]!, rows);
    expect(signals.filter((signal) => signal.windowDays === 1)).toEqual([]);
  });
});
