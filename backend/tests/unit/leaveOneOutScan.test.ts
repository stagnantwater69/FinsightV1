import { describe, expect, it } from "vitest";
import {
  computeCategoryStats,
  computeQuartiles,
  detectionMethod,
  isUnusualExpense,
  scanUnusualExpenses,
  zScore,
  MIN_HISTORY_FOR_DETECTION,
  type LeaveOneOutRecord,
  type UnusualExpenseHit,
} from "../../src/services/analysis.service";

/*
 * The expense-behaviour insight's unusual-expense scan used to rebuild every
 * candidate's baseline with `records.filter(...)`, `computeCategoryStats` and
 * `computeQuartiles` — an array copy, a full statistics pass and a full SORT
 * per candidate. `scanUnusualExpenses` amortises that across the category.
 *
 * This file exists to hold it to the one promise that matters: the NUMBERS DO
 * NOT MOVE. Below is the original expression, kept verbatim as the reference,
 * and every case asserts the new scan against it — the same records flagged,
 * in the same order, with the same z-score, mean, standard deviation and
 * detecting test. The last test then pins that the cost is no longer
 * quadratic, using the reference itself as the yardstick so the assertion
 * calibrates to whatever machine it runs on.
 */

/** The pre-optimisation loop, verbatim, as the correctness oracle. */
function referenceScan(byCategory: Map<number, LeaveOneOutRecord[]>, isCandidate: (id: number) => boolean) {
  const unusual: UnusualExpenseHit[] = [];
  const insufficientHistory: { categoryId: number; historyCount: number }[] = [];
  for (const [categoryId, records] of byCategory) {
    if (records.length < MIN_HISTORY_FOR_DETECTION) {
      insufficientHistory.push({ categoryId, historyCount: records.length });
      continue;
    }
    for (const candidate of records) {
      if (!isCandidate(candidate.id)) continue;
      const baseline = records.filter((r) => r.id !== candidate.id).map((r) => r.amount);
      const stats = computeCategoryStats(baseline);
      const quartiles = computeQuartiles(baseline);
      const z = zScore(candidate.amount, stats);
      if (isUnusualExpense(candidate.amount, stats, quartiles)) {
        unusual.push({
          id: candidate.id,
          categoryId,
          amount: candidate.amount,
          zScore: z,
          categoryMean: stats.mean,
          categoryStdDev: stats.stdDev,
          detectedBy: detectionMethod(candidate.amount, stats, quartiles),
        });
      }
    }
  }
  return { unusual, insufficientHistory };
}

const records = (amounts: number[], startId = 1): LeaveOneOutRecord[] =>
  amounts.map((amount, i) => ({ id: startId + i, amount }));

/**
 * A relative comparison, because the two implementations evaluate the same
 * formula in a different ORDER and floating-point addition is not associative.
 * The tolerance below (1e-9 relative) is many orders of magnitude tighter than
 * the smallest difference that could change a flag, a threshold or a peso
 * figure, and in practice every reported figure here matches exactly — the
 * scan recomputes anything it is about to report the original way.
 */
type Scan = ReturnType<typeof referenceScan>;

function expectSameNumbers(actual: Scan, expected: Scan) {
  expect(actual.insufficientHistory).toEqual(expected.insufficientHistory);
  expect(actual.unusual.map((h) => h.id)).toEqual(expected.unusual.map((h) => h.id));
  expect(actual.unusual.map((h) => h.detectedBy)).toEqual(expected.unusual.map((h) => h.detectedBy));
  actual.unusual.forEach((hit, i) => {
    const want = expected.unusual[i]!;
    expect(hit.categoryId).toBe(want.categoryId);
    expect(hit.amount).toBe(want.amount);
    for (const field of ["zScore", "categoryMean", "categoryStdDev"] as const) {
      const scale = Math.max(1, Math.abs(want[field]));
      expect(Math.abs(hit[field] - want[field]) / scale).toBeLessThan(1e-9);
    }
  });
}

function checkParity(byCategory: Map<number, LeaveOneOutRecord[]>, isCandidate: (id: number) => boolean = () => true) {
  const expected = referenceScan(byCategory, isCandidate);
  expectSameNumbers(scanUnusualExpenses(byCategory, isCandidate), expected);
  return expected;
}

describe("scanUnusualExpenses parity with the pre-optimisation loop", () => {
  it("reports insufficient history for a thin category, unchanged", () => {
    const byCategory = new Map([[1, records([100, 200, 300, 400, 500, 600, 700])]]);
    const expected = checkParity(byCategory);
    expect(expected.insufficientHistory).toEqual([{ categoryId: 1, historyCount: 7 }]);
    expect(expected.unusual).toHaveLength(0);
  });

  it("flags an ordinary outlier with the same figures", () => {
    const byCategory = new Map([
      [1, records([480, 500, 512, 495, 505, 488, 502, 499, 4800])],
    ]);
    const expected = checkParity(byCategory);
    expect(expected.unusual.map((h) => h.id)).toEqual([1, 9]);
    expect(expected.unusual.map((h) => h.detectedBy)).toEqual(["iqr", "both"]);
  });

  it("handles the no-spread category the z-score is blind to", () => {
    // Rent at exactly the same amount every month, then one month at ten
    // times it: the leave-one-out standard deviation is zero, zScore's guard
    // returns 0, and only the IQR can catch it. This is also the input family
    // an O(1) variance update cannot survive — the removed term IS the whole
    // sum of squares — so it is the case the exact-recompute fallback exists
    // for, and the one most likely to expose it if the fallback is wrong.
    const byCategory = new Map([[1, records([...Array(9).fill(1234.56), 12345.6])]]);
    const expected = checkParity(byCategory);
    const actual = scanUnusualExpenses(byCategory, () => true);
    expect(expected.unusual.map((h) => h.id)).toEqual([10]);
    // The nine identical amounts do not average to a representable value, so
    // the baseline standard deviation is not literally zero — it is the ~1e-13
    // residue of that, which sends the z-score to ~1e16. Exact equality, not a
    // tolerance: this is precisely the figure a cancelling O(1) update gets
    // wrong by eleven orders of magnitude, and the whole reason the scan falls
    // back to the original expression when the removed term dominates.
    expect(expected.unusual[0]!.categoryStdDev).toBeLessThan(1e-9);
    expect(actual.unusual[0]!.categoryStdDev).toBe(expected.unusual[0]!.categoryStdDev);
    expect(actual.unusual[0]!.zScore).toBe(expected.unusual[0]!.zScore);
    expect(actual.unusual[0]!.detectedBy).toBe("both");
  });

  it("handles masking by several outliers at once", () => {
    const byCategory = new Map([
      [1, records([100, 105, 98, 102, 101, 99, 103, 97, 900, 950, 1000])],
    ]);
    const expected = checkParity(byCategory);
    expect(expected.unusual.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps identical amounts, duplicates and ties consistent", () => {
    const byCategory = new Map([
      [1, records(Array(12).fill(500))],
      [2, records([500, 500, 500, 500, 500, 500, 500, 500, 500, 501], 100)],
      [3, records([0, 0, 0, 0, 0, 0, 0, 0, 0, 1000], 200)],
    ]);
    checkParity(byCategory);
  });

  it("only reports records the candidate predicate admits, baselines unchanged", () => {
    const byCategory = new Map([
      [1, records([480, 500, 512, 495, 505, 488, 502, 499, 4800, 5200])],
    ]);
    // Exclude the first of the two outliers from reporting; it must still
    // count towards the other's baseline, which is what makes the second one's
    // z-score lower than it would be on its own.
    const bothReportable = referenceScan(byCategory, () => true);
    const expected = checkParity(byCategory, (id) => id !== 9);
    expect(expected.unusual.map((h) => h.id)).toEqual([10]);
    expect(expected.unusual[0]!.zScore).toBe(bothReportable.unusual.find((h) => h.id === 10)!.zScore);
  });

  it("matches across many randomised categories", () => {
    // Deterministic LCG — a fixed corpus, reproducible on failure, spanning
    // clustered, skewed, heavy-tailed and near-degenerate categories.
    let seed = 20260908;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const byCategory = new Map<number, LeaveOneOutRecord[]>();
    let nextId = 1;
    for (let category = 1; category <= 60; category++) {
      const size = 6 + Math.floor(rnd() * 40);
      const shape = category % 4;
      const amounts = Array.from({ length: size }, () => {
        if (shape === 0) return Math.round((100 + rnd() * 50) * 100) / 100;
        if (shape === 1) return Math.round(rnd() ** 4 * 50_000 * 100) / 100;
        if (shape === 2) return rnd() < 0.9 ? 2500 : Math.round(rnd() * 90_000) / 100;
        return Math.round((5000 + (rnd() - 0.5) * 0.02) * 100) / 100;
      });
      byCategory.set(category, records(amounts, nextId));
      nextId += size;
    }
    const expected = checkParity(byCategory, (id) => id % 3 !== 0);
    // The corpus has to actually exercise the detector, or parity is vacuous.
    expect(expected.unusual.length).toBeGreaterThan(5);
    expect(expected.insufficientHistory.length).toBeGreaterThan(0);
  });
});

describe("scanUnusualExpenses cost", () => {
  /** One category of uniform-random amounts, the shape that made this quadratic. */
  function bigCategory(size: number) {
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    return new Map([[1, records(Array.from({ length: size }, () => Math.round((200 + rnd() * 800) * 100) / 100))]]);
  }

  it("is no longer quadratic in the size of a category", () => {
    // Calibrated against the OLD implementation on this same machine rather
    // than against a wall-clock constant, so a slow or loaded runner moves
    // both sides of the comparison together.
    const small = bigCategory(1_000);
    const large = bigCategory(4_000);

    // Warm both paths so the comparison is not measuring JIT tiering.
    referenceScan(small, () => true);
    scanUnusualExpenses(large, () => true);

    const referenceStart = performance.now();
    referenceScan(small, () => true);
    const referenceMs = performance.now() - referenceStart;

    const scanStart = performance.now();
    scanUnusualExpenses(large, () => true);
    const scanMs = performance.now() - scanStart;

    // Four times the records. Quadratic would be ~16x the reference; linear-ish
    // is a small fraction of it. Asserting merely "faster than the old code on
    // a quarter of the input" is a wide margin around a >100x measured gap, so
    // it fails on a real regression and not on a noisy CI box.
    expect(scanMs).toBeLessThan(referenceMs);
  });

  it("stays correct on the large category, not just fast", () => {
    checkParity(bigCategory(400));
  });
});
