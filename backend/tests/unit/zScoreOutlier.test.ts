import { describe, expect, it } from "vitest";
import {
  computeCategoryStats,
  computeQuartiles,
  deviationFraction,
  detectionMethod,
  isOutsideIqrFence,
  isUnusualExpense,
  zScore,
  MIN_DEVIATION_FRACTION,
  MIN_HISTORY_FOR_DETECTION,
  Z_SCORE_THRESHOLD,
} from "../../src/services/analysis.service";

/** The full rule, against a baseline array — the shape every call site uses. */
function reportsUnusual(candidate: number, baseline: number[]) {
  return isUnusualExpense(candidate, computeCategoryStats(baseline), computeQuartiles(baseline));
}

// The planted-outlier fixture. These are the exact Inventory amounts used when
// Expense Behaviour was built and verified by hand: four ordinary supplier
// restocks plus one bulk delivery an order of magnitude larger.
const ORDINARY_INVENTORY = [6000, 5800, 6200, 5500, 5900, 6100, 5700];
const PLANTED_OUTLIER = 30000;

/**
 * Leave-one-out scoring, matching insights.service: a candidate is scored
 * against the other records in its category, never against a baseline that
 * includes itself. Including it drags the mean toward the outlier and shrinks
 * its own z-score, which is how outliers hide from naive implementations.
 */
function leaveOneOutZ(amounts: number[], index: number) {
  const candidate = amounts[index]!;
  const baseline = amounts.filter((_, i) => i !== index);
  return zScore(candidate, computeCategoryStats(baseline));
}

describe("computeCategoryStats", () => {
  it("computes the mean", () => {
    expect(computeCategoryStats([6000, 5800, 6200, 5500]).mean).toBe(5875);
  });

  it("uses the sample standard deviation (n-1), not the population one", () => {
    const stats = computeCategoryStats([6000, 5800, 6200, 5500]);
    // Deviations from 5875: 125, -75, 325, -375.
    // Sum of squares = 15625 + 5625 + 105625 + 140625 = 267500.
    // Sample variance divides by n-1 = 3 -> 89166.67, sd ~= 298.61.
    // Population variance would divide by 4 -> 66875, sd ~= 258.60, which
    // understates the spread and would over-flag borderline records.
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(267500 / 3), 6);
    expect(stats.stdDev).not.toBeCloseTo(Math.sqrt(267500 / 4), 6);
    expect(stats.count).toBe(4);
  });

  it("reports a standard deviation of 0 for a single record", () => {
    const stats = computeCategoryStats([5000]);
    expect(stats.count).toBe(1);
    expect(stats.stdDev).toBe(0);
    expect(stats.mean).toBe(5000);
  });

  it("reports a standard deviation of 0 when every record is identical", () => {
    expect(computeCategoryStats([100, 100, 100, 100]).stdDev).toBe(0);
  });
});

describe("zScore", () => {
  it("returns 0 rather than Infinity when the baseline has no spread", () => {
    // Every historical record identical: any deviation divided by sd=0 would
    // be Infinity, which would flag every new record as unusual.
    const stats = computeCategoryStats([100, 100, 100]);
    expect(zScore(999999, stats)).toBe(0);
    expect(Number.isFinite(zScore(999999, stats))).toBe(true);
  });

  it("is signed — below-average records score negative", () => {
    const stats = computeCategoryStats(ORDINARY_INVENTORY);
    expect(zScore(9000, stats)).toBeGreaterThan(0);
    expect(zScore(1000, stats)).toBeLessThan(0);
  });
});

describe("planted-outlier detection (the Insights fixture)", () => {
  const amounts = [...ORDINARY_INVENTORY, PLANTED_OUTLIER];
  const outlierIndex = amounts.indexOf(PLANTED_OUTLIER);

  it("flags the planted 30,000 bulk delivery", () => {
    const z = leaveOneOutZ(amounts, outlierIndex);
    expect(Math.abs(z)).toBeGreaterThan(Z_SCORE_THRESHOLD);
  });

  it("does not flag any of the four ordinary restocks", () => {
    for (let i = 0; i < amounts.length; i++) {
      if (i === outlierIndex) continue;
      const z = leaveOneOutZ(amounts, i);
      expect(Math.abs(z), `record ${amounts[i]} should not be flagged (z=${z.toFixed(2)})`).toBeLessThanOrEqual(
        Z_SCORE_THRESHOLD
      );
    }
  });

  it("is drastically weakened if the baseline wrongly includes the candidate", () => {
    // Regression guard for the leave-one-out requirement. An outlier included
    // in its own baseline drags the mean toward itself and inflates the
    // standard deviation, burying the very signal being measured: here it
    // scores ~2.5 instead of ~100, a 40x difference on identical data.
    const naive = Math.abs(zScore(PLANTED_OUTLIER, computeCategoryStats(amounts)));
    const leaveOneOut = Math.abs(leaveOneOutZ(amounts, outlierIndex));

    expect(leaveOneOut).toBeGreaterThan(naive * 10);
    expect(naive).toBeLessThan(3); // barely over the threshold — fragile
    expect(leaveOneOut).toBeGreaterThan(Z_SCORE_THRESHOLD);
  });

  it("would MISS the outlier entirely on a smaller sample without leave-one-out", () => {
    // The same dilution at 5 records puts the naive score UNDER the threshold,
    // so the outlier goes completely unreported. This is the failure mode the
    // leave-one-out baseline exists to prevent.
    const small = [6000, 5800, 6200, 5500, PLANTED_OUTLIER];
    expect(Math.abs(zScore(PLANTED_OUTLIER, computeCategoryStats(small)))).toBeLessThan(Z_SCORE_THRESHOLD);
    expect(Math.abs(leaveOneOutZ(small, small.indexOf(PLANTED_OUTLIER)))).toBeGreaterThan(Z_SCORE_THRESHOLD);
  });

  it("keeps the threshold at the documented 2 standard deviations", () => {
    // A placeholder pending adviser confirmation — asserted so a silent change
    // to detection sensitivity shows up as a failing test.
    expect(Z_SCORE_THRESHOLD).toBe(2);
  });

  it("sits exactly at the minimum history size, so it is eligible for scoring", () => {
    expect(amounts.length).toBe(MIN_HISTORY_FOR_DETECTION);
  });

  it("is reported by the full detection rule, not just by z-score", () => {
    expect(reportsUnusual(PLANTED_OUTLIER, ORDINARY_INVENTORY)).toBe(true);
  });
});

/** Indexes the real detection rule would report, using leave-one-out baselines. */
function flaggedIndexes(amounts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const baseline = amounts.filter((_, j) => j !== i);
    if (reportsUnusual(amounts[i]!, baseline)) out.push(i);
  }
  return out;
}

function countFlagged(amounts: number[]) {
  return flaggedIndexes(amounts).length;
}

// ===================================================================
// FIXED: false positives on tight clusters.
// ===================================================================
//
// The statistics were always correct; the tuning was not. Two changes fixed it:
//
//   1. MIN_HISTORY_FOR_DETECTION raised 5 -> 8. At 5 records, leave-one-out
//      estimates the baseline sd from only 4 points; removing an extreme
//      tightens that baseline enough that the extreme clears 2 sd. Measured 2
//      false positives in 5 on ordinary categories.
//   2. A minimum-deviation floor (MIN_DEVIATION_FRACTION, 15%). The z-score
//      answers "is this unusual for this category?", which on a tight cluster
//      can be true of a difference far too small to act on — PHP 187.50 on a
//      PHP 5,000 category (3.7%) scored 2.20 and was reported.
//
// Both halves are required, so a flag now means "statistically unusual AND
// materially different in peso terms".
describe("false positives on tight clusters are suppressed", () => {
  const tight = [5000, 5100, 4900, 5050, 5200, 4950, 5150, 5000];

  it("does not flag the ~4% deviation that used to be reported", () => {
    const baseline = tight.filter((_, i) => i !== tight.indexOf(5200));
    // Still statistically unusual by z-score alone...
    expect(deviationFraction(5200, computeCategoryStats(baseline))).toBeLessThan(MIN_DEVIATION_FRACTION);
    // ...but no longer reported, because the peso difference is trivial.
    expect(reportsUnusual(5200, baseline)).toBe(false);
  });

  it("flags nothing in an ordinary tight category", () => {
    expect(countFlagged(tight)).toBe(0);
  });

  it("flags nothing in an ordinary moderately-spread category", () => {
    expect(countFlagged([4700, 5100, 4900, 5300, 5200, 4800, 5150, 5000])).toBe(0);
  });

  it("DOES still flag a genuine extreme, even in a moderately-spread category", () => {
    // Not everything at the edge is a false positive: 4,000 against a ~5,180
    // baseline is 2.6 sd out AND 22.8% below the mean, so it earns a flag.
    // This is the boundary the deviation floor is meant to sit at.
    expect(countFlagged([4000, 5100, 4900, 6050, 5200, 4600, 5400, 5000])).toBeGreaterThan(0);
  });

  it("flags nothing in a genuinely wide, evenly-spread category", () => {
    expect(countFlagged([1000, 3000, 5000, 7000, 9000, 2000, 4000, 8000])).toBe(0);
  });

  it("needs a statistical test AND the peso floor, never either alone", () => {
    // Baseline excludes the candidate, matching leave-one-out scoring.
    const tightBaseline = [5000, 5100, 4900, 5050, 4950, 5150, 5000];

    // Big deviation but neither test calls it unusual is not enough on its own:
    // a category with wide natural spread should tolerate a large value.
    const wideBaseline = [1000, 9000, 2000, 8000, 3000, 7000, 5000];
    const wide = computeCategoryStats(wideBaseline);
    expect(deviationFraction(9500, wide)).toBeGreaterThan(MIN_DEVIATION_FRACTION);
    expect(Math.abs(zScore(9500, wide))).toBeLessThan(Z_SCORE_THRESHOLD);
    expect(isOutsideIqrFence(9500, computeQuartiles(wideBaseline))).toBe(false);
    expect(reportsUnusual(9500, wideBaseline)).toBe(false);

    // Statistically unusual but a trivial peso difference is also not enough.
    const tightStats = computeCategoryStats(tightBaseline);
    expect(Math.abs(zScore(5200, tightStats))).toBeGreaterThan(Z_SCORE_THRESHOLD);
    expect(deviationFraction(5200, tightStats)).toBeLessThan(MIN_DEVIATION_FRACTION);
    expect(reportsUnusual(5200, tightBaseline)).toBe(false);
  });
});

describe("recall: genuine outliers are still caught", () => {
  it("catches the planted 30,000 bulk delivery at the minimum history size", () => {
    const atMinimum = [6000, 5800, 6200, 5500, 5900, 6100, 5700, 30000];
    expect(atMinimum.length).toBe(MIN_HISTORY_FOR_DETECTION);
    expect(countFlagged(atMinimum)).toBe(1);
    expect(atMinimum[flaggedIndexes(atMinimum)[0]!]).toBe(30000);
  });

  it("catches it in a larger sample too", () => {
    const large = [6000, 5800, 6200, 5500, 5900, 6100, 5700, 6300, 5600, 6000, 5950, 30000];
    expect(countFlagged(large)).toBe(1);
    expect(large[flaggedIndexes(large)[0]!]).toBe(30000);
  });

  it("catches an unusually LOW outlier as well as a high one", () => {
    const withLow = [5000, 5100, 4900, 5050, 5200, 4950, 5150, 50];
    expect(countFlagged(withLow)).toBe(1);
    expect(withLow[flaggedIndexes(withLow)[0]!]).toBe(50);
  });

  it("catches an outlier that is large but not enormous", () => {
    // 12,000 against a ~5,900 baseline: about 2x, comfortably over both halves.
    const moderate = [6000, 5800, 6200, 5500, 5900, 6100, 5700, 12000];
    expect(countFlagged(moderate)).toBe(1);
    expect(moderate[flaggedIndexes(moderate)[0]!]).toBe(12000);
  });
});

describe("minimum history", () => {
  it("is 8, so a category with 7 records is not scored at all", () => {
    expect(MIN_HISTORY_FOR_DETECTION).toBe(8);
  });

  it("keeps the deviation floor at the documented 15%", () => {
    expect(MIN_DEVIATION_FRACTION).toBe(0.15);
  });
});

describe("outlier detection on other shapes", () => {
  it("flags a low outlier as well as a high one", () => {
    // Detection is on absolute z-score, so an unusually SMALL expense in a
    // consistent category is surfaced too.
    const amounts = [5000, 5100, 4900, 5050, 50];
    const z = leaveOneOutZ(amounts, 4);
    expect(z).toBeLessThan(0);
    expect(Math.abs(z)).toBeGreaterThan(Z_SCORE_THRESHOLD);
  });
});

// ============================================================
// IQR — the second detector
// ============================================================
// Added because the z-score measures a record against a mean and standard
// deviation the record itself helps define, which leaves it blind in two
// situations that are ordinary in a small shop's books. Each case below was
// measured against the leave-one-out baselines the real detector uses, and
// each is a record the previous rule could not report at all.

describe("computeQuartiles", () => {
  it("interpolates between order statistics, matching numpy and R defaults", () => {
    // Sorted: 1,2,3,4,5 — Q1 sits at index 1, Q3 at index 3.
    expect(computeQuartiles([3, 1, 4, 5, 2])).toEqual({ q1: 2, q3: 4, iqr: 2 });
  });

  it("reports an IQR of 0 when every record is identical", () => {
    expect(computeQuartiles([500, 500, 500, 500]).iqr).toBe(0);
  });
});

describe("blind spots the z-score cannot cover", () => {
  /**
   * THE CASE THAT MATTERS MOST. Rent paid at exactly the same amount every
   * month gives a baseline standard deviation of 0, so zScore divides by zero
   * and its guard returns 0. A month at ten times the usual rent therefore
   * scores z = 0.00 — not borderline, structurally undetectable. This is
   * exactly the expense an owner would most want to hear about.
   */
  it("catches a spike in a category whose history has no spread at all", () => {
    const baseline = [500, 500, 500, 500, 500, 500, 500];
    const stats = computeCategoryStats(baseline);

    expect(stats.stdDev).toBe(0);
    expect(zScore(5000, stats)).toBe(0); // the z-score is blind here, by construction
    expect(isOutsideIqrFence(5000, computeQuartiles(baseline))).toBe(true);
    expect(reportsUnusual(5000, baseline)).toBe(true);
    expect(detectionMethod(5000, stats, computeQuartiles(baseline))).toBe("iqr");
  });

  /**
   * MASKING. Several unusually large records inflate the standard deviation
   * each of them is measured against, so none of them stands out. Quartiles
   * barely move when a few extremes are present, so the IQR still sees them.
   */
  it("catches outliers that mask each other from the z-score", () => {
    const amounts = [500, 500, 500, 500, 500, 500, 500, 5000, 5000, 5000];
    const baseline = amounts.filter((_, i) => i !== 7); // leave one 5000 out

    expect(Math.abs(zScore(5000, computeCategoryStats(baseline)))).toBeLessThan(Z_SCORE_THRESHOLD);
    expect(reportsUnusual(5000, baseline)).toBe(true);
  });

  /**
   * The floor still applies to IQR findings. With an IQR of 0 every fence
   * collapses onto the quartile, so without it a category of identical PHP 500
   * records would report PHP 501 as unusual.
   */
  it("still suppresses a trivial peso difference against a no-spread baseline", () => {
    const baseline = [500, 500, 500, 500, 500, 500, 500];
    expect(isOutsideIqrFence(501, computeQuartiles(baseline))).toBe(true);
    expect(reportsUnusual(501, baseline)).toBe(false);
  });

  /**
   * The regression that matters: adding a second detector must not start
   * reporting ordinary records. These are the same fixtures the false-positive
   * suite above certifies as clean, re-checked here to pin down that IQR did
   * not quietly widen them.
   */
  it("adds no flags to categories the previous rule reported as clean", () => {
    expect(countFlagged([5000, 5100, 4900, 5050, 5200, 4950, 5150, 5000])).toBe(0);
    expect(countFlagged([4700, 5100, 4900, 5300, 5200, 4800, 5150, 5000])).toBe(0);
    expect(countFlagged([1000, 3000, 5000, 7000, 9000, 2000, 4000, 8000])).toBe(0);
  });

  it("names which test reported a record", () => {
    // The planted 30,000 is extreme enough that both tests catch it.
    expect(
      detectionMethod(
        PLANTED_OUTLIER,
        computeCategoryStats(ORDINARY_INVENTORY),
        computeQuartiles(ORDINARY_INVENTORY),
      ),
    ).toBe("both");
  });
});
