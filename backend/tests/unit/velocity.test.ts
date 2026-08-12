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
});
