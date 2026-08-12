import { describe, expect, it } from "vitest";
import {
  accuracyTrend,
  calibration,
  fieldAccuracy,
  recommendThreshold,
  recurringErrors,
  scanCorrectionRate,
  sweepThresholds,
  weekStart,
  type CorrectionObservation,
} from "../../src/lib/extractionMetrics";

/**
 * These figures are the whole point of recording corrections, so the arithmetic
 * behind them is checked against hand-written observations rather than against
 * whatever a database happens to hold.
 *
 * The cases that matter most here are the ones about what must NOT be
 * measured: a denominator that silently includes rows carrying no confidence
 * score would make calibration look better than it is, and an "accuracy" that
 * quietly blends corrections with confirmations would hide which half of the
 * evidence it rests on.
 */

let nextId = 1;
function obs(over: Partial<CorrectionObservation> = {}): CorrectionObservation {
  return {
    receiptScanId: over.receiptScanId ?? nextId++,
    field: "vendor",
    source: "ocr",
    originalValue: "READ",
    finalValue: "READ",
    itemName: null,
    confidence: null,
    wasEdited: false,
    createdAt: new Date("2026-08-03T00:00:00Z"),
    ...over,
  };
}

describe("fieldAccuracy", () => {
  it("counts every reviewed field, not only the corrected ones", () => {
    const rows = [
      obs({ field: "vendor", wasEdited: true }),
      obs({ field: "vendor", wasEdited: false }),
      obs({ field: "vendor", wasEdited: false }),
      obs({ field: "amount", wasEdited: false }),
    ];

    const [vendor, amount] = fieldAccuracy(rows);
    // 1 of 3 corrected. Without the unedited rows this would read as "vendor
    // was wrong once" with nothing to divide by.
    expect(vendor).toMatchObject({ field: "vendor", reviewed: 3, edited: 1 });
    expect(vendor!.unchangedRate).toBeCloseTo(2 / 3);
    expect(amount).toMatchObject({ field: "amount", reviewed: 1, edited: 0, unchangedRate: 1 });
  });

  it("sorts worst first, so the field to fix is the one at the top", () => {
    const rows = [
      obs({ field: "date", wasEdited: false }),
      obs({ field: "itemCategory", wasEdited: true }),
      obs({ field: "itemCategory", wasEdited: true }),
    ];
    expect(fieldAccuracy(rows).map((f) => f.field)).toEqual(["itemCategory", "date"]);
  });

  it("reports null rather than 0 or 1 when nothing was reviewed", () => {
    expect(fieldAccuracy([])).toEqual([]);
  });
});

describe("scanCorrectionRate", () => {
  /**
   * Per scan, not per field, and the difference is the point: a receipt with
   * one wrong field out of eleven is not "91% good" to the person holding it.
   */
  it("counts a scan once however many of its fields were wrong", () => {
    const rows = [
      obs({ receiptScanId: 1, field: "vendor", wasEdited: true }),
      obs({ receiptScanId: 1, field: "amount", wasEdited: true }),
      obs({ receiptScanId: 1, field: "date", wasEdited: false }),
      obs({ receiptScanId: 2, field: "vendor", wasEdited: false }),
    ];
    expect(scanCorrectionRate(rows)).toEqual({ scans: 2, scansWithAnyEdit: 1, rate: 0.5 });
  });
});

describe("calibration", () => {
  it("excludes rows carrying no confidence score from the calibration denominators", () => {
    const rows = [
      obs({ confidence: 90, wasEdited: false }),
      obs({ confidence: 40, wasEdited: true }),
      // Vision-assisted and derived values record no confidence. Counting
      // them as high-confidence-and-correct would flatter the figures with
      // rows no engine ever scored.
      obs({ confidence: null, wasEdited: false }),
      obs({ confidence: null, wasEdited: true }),
    ];

    const c = calibration(rows, 75);
    expect(c.scored).toBe(2);
    expect(c.highConfidenceRows).toBe(1);
    expect(c.lowConfidenceRows).toBe(1);
    expect(c.meanConfidenceWhenUnchanged).toBe(90);
    expect(c.meanConfidenceWhenEdited).toBe(40);
  });

  it("names the two failure modes separately", () => {
    const rows = [
      // Confident and wrong: nothing warned the owner to look harder.
      obs({ confidence: 95, wasEdited: true }),
      // Doubted and right: a warning shown for nothing.
      obs({ confidence: 30, wasEdited: false }),
      obs({ confidence: 30, wasEdited: false }),
    ];
    const c = calibration(rows, 75);
    expect(c.falseHighConfidence).toBe(1);
    expect(c.falseLowConfidence).toBe(2);
  });
});

describe("sweepThresholds", () => {
  it("reports what each threshold catches and what it wastes", () => {
    const rows = [
      obs({ confidence: 30, wasEdited: true }),
      obs({ confidence: 60, wasEdited: true }),
      obs({ confidence: 60, wasEdited: false }),
      obs({ confidence: 95, wasEdited: false }),
    ];

    const at70 = sweepThresholds(rows, [70])[0]!;
    expect(at70).toEqual({
      threshold: 70,
      fires: 3, // everything under 70
      catchesEdited: 2,
      wastedOnUnchanged: 1,
      missesEdited: 0,
    });

    const at50 = sweepThresholds(rows, [50])[0]!;
    // Cheaper, but the 60-confidence error now slips through.
    expect(at50).toMatchObject({ fires: 1, catchesEdited: 1, wastedOnUnchanged: 0, missesEdited: 1 });
  });
});

describe("recommendThreshold", () => {
  it("proposes the middle of the empty band when the two populations separate", () => {
    const rows = [
      obs({ confidence: 30, wasEdited: true }),
      obs({ confidence: 56, wasEdited: true }),
      obs({ confidence: 90, wasEdited: false }),
      obs({ confidence: 95, wasEdited: false }),
    ];

    const r = recommendThreshold(rows);
    expect(r.separates).toBe(true);
    expect(r.worstCorrect).toBe(56);
    expect(r.bestUntouched).toBe(90);
    // The midpoint, deliberately — not the value that catches the most errors,
    // which would sit one point from a correct read.
    expect(r.midpoint).toBe(73);
    expect(r.overlap).toBe(0);
  });

  /**
   * The expected outcome on real data. Reporting the overlap honestly is the
   * point: it means no threshold separates cleanly and confidence should stay
   * the weakest of the vision-fallback triggers.
   */
  it("refuses to recommend a midpoint when the populations overlap", () => {
    const rows = [
      obs({ confidence: 92, wasEdited: true }),
      obs({ confidence: 40, wasEdited: false }),
    ];
    const r = recommendThreshold(rows);
    expect(r.separates).toBe(false);
    expect(r.midpoint).toBeNull();
    expect(r.overlap).toBe(52);
  });

  it("recommends nothing when one side of the comparison is empty", () => {
    const r = recommendThreshold([obs({ confidence: 80, wasEdited: false })]);
    expect(r.midpoint).toBeNull();
    expect(r.separates).toBe(false);
  });
});

describe("recurringErrors", () => {
  /**
   * A one-off misread is noise. The same misread repeatedly is a rule waiting
   * to be written, which is the only kind worth a person's attention.
   */
  it("keeps repeated mistakes and drops the one-offs", () => {
    const rows = [
      obs({ field: "vendor", wasEdited: true, originalValue: "MERCAD0", finalValue: "Mercado" }),
      obs({ field: "vendor", wasEdited: true, originalValue: "MERCAD0", finalValue: "Mercado" }),
      obs({ field: "vendor", wasEdited: true, originalValue: "ODDONE", finalValue: "Odd One" }),
    ];

    const clusters = recurringErrors(rows, "vendor");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ originalValue: "MERCAD0", finalValue: "Mercado", count: 2 });
  });

  it("keys item-level clusters on the item, so the finding is actionable", () => {
    const rows = [
      obs({ field: "itemCategory", wasEdited: true, itemName: "pandesal", originalValue: "Supplies", finalValue: "Ingredients" }),
      obs({ field: "itemCategory", wasEdited: true, itemName: "pandesal", originalValue: "Supplies", finalValue: "Ingredients" }),
      obs({ field: "itemCategory", wasEdited: true, itemName: "bleach", originalValue: "Supplies", finalValue: "Ingredients" }),
    ];

    // Without the item name these would be one bucket of 3 saying
    // "Supplies -> Ingredients", which names no action.
    const clusters = recurringErrors(rows, "itemCategory", 1);
    expect(clusters.map((c) => [c.itemName, c.count])).toEqual([
      ["pandesal", 2],
      ["bleach", 1],
    ]);
  });

  it("ignores fields the owner left alone", () => {
    const rows = [obs({ field: "vendor", wasEdited: false }), obs({ field: "vendor", wasEdited: false })];
    expect(recurringErrors(rows, "vendor", 1)).toEqual([]);
  });
});

describe("weekStart", () => {
  it("puts Sunday in the week that already started, not the one about to", () => {
    // 2026-08-02 is a Sunday; its week began Monday 2026-07-27.
    expect(weekStart(new Date("2026-08-02T23:59:59Z"))).toBe("2026-07-27");
    expect(weekStart(new Date("2026-08-03T00:00:00Z"))).toBe("2026-08-03");
  });
});

describe("accuracyTrend", () => {
  it("buckets by week and sorts oldest first", () => {
    const rows = [
      obs({ createdAt: new Date("2026-08-05T00:00:00Z"), wasEdited: true }),
      obs({ createdAt: new Date("2026-08-06T00:00:00Z"), wasEdited: false }),
      obs({ createdAt: new Date("2026-07-28T00:00:00Z"), wasEdited: false }),
    ];

    expect(accuracyTrend(rows)).toEqual([
      { bucket: "2026-07-27", reviewed: 1, edited: 0, unchangedRate: 1 },
      { bucket: "2026-08-03", reviewed: 2, edited: 1, unchangedRate: 0.5 },
    ]);
  });

  it("can scope to one field", () => {
    const rows = [
      obs({ field: "vendor", wasEdited: true }),
      obs({ field: "amount", wasEdited: false }),
    ];
    expect(accuracyTrend(rows, "vendor")).toEqual([
      { bucket: "2026-08-03", reviewed: 1, edited: 1, unchangedRate: 0 },
    ]);
  });
});
