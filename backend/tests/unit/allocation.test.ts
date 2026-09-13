import { describe, expect, it } from "vitest";
import { allocateProportionally } from "../../src/lib/allocation";

/**
 * The one property that must never break: the parts sum to the whole.
 *
 * Everything downstream depends on it. confirmReceipt refuses to write a
 * receipt whose splits don't equal the confirmed total, so a single centavo
 * lost in this function is not a rounding curiosity — it is an owner staring
 * at "PHP 0.01 of the receipt total is not assigned to a category yet" with
 * no way to fix it.
 */
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocateProportionally", () => {
  it("splits a clean multiple exactly in proportion", () => {
    // PHP 180.00 of VAT over PHP 1,000 inventory + PHP 500 equipment.
    expect(allocateProportionally(18000, [100000, 50000])).toEqual([12000, 6000]);
  });

  it("never loses a centavo to rounding", () => {
    // 100 centavos over three equal buckets is 33.33... each. Rounding each
    // independently gives 33+33+33 = 99 and drops one centavo; the
    // largest-remainder method must hand it out instead.
    const shares = allocateProportionally(100, [1, 1, 1]);
    expect(sum(shares)).toBe(100);
    expect(shares).toEqual([34, 33, 33]);
  });

  it("never gains a centavo either", () => {
    const shares = allocateProportionally(200, [1, 1, 1]);
    expect(sum(shares)).toBe(200);
  });

  it("handles a negative total, for a discount", () => {
    const shares = allocateProportionally(-5000, [30000, 20000]);
    expect(sum(shares)).toBe(-5000);
    expect(shares).toEqual([-3000, -2000]);
  });

  it("keeps a negative total exact when it does not divide evenly", () => {
    const shares = allocateProportionally(-100, [1, 1, 1]);
    expect(sum(shares)).toBe(-100);
  });

  it("is deterministic when remainders tie", () => {
    // The same receipt confirmed twice must split the same way, so ties break
    // on the earlier bucket rather than on iteration order.
    const first = allocateProportionally(100, [1, 1, 1]);
    const second = allocateProportionally(100, [1, 1, 1]);
    expect(first).toEqual(second);
    expect(first[0]).toBeGreaterThanOrEqual(first[1]!);
  });

  it("gives everything to the only bucket", () => {
    expect(allocateProportionally(12345, [999])).toEqual([12345]);
  });

  it("falls back to an equal split when every weight is zero", () => {
    const shares = allocateProportionally(10, [0, 0, 0]);
    expect(sum(shares)).toBe(10);
  });

  it("returns nothing for no buckets", () => {
    expect(allocateProportionally(500, [])).toEqual([]);
  });

  it("stays exact across many awkward splits", () => {
    // A property check over the shapes a real receipt actually produces.
    for (let gap = -999; gap <= 999; gap += 7) {
      for (const weights of [[1, 2, 3], [7, 11, 13, 17], [1, 1], [999, 1], [50, 50, 50, 50, 50]]) {
        expect(sum(allocateProportionally(gap, weights))).toBe(gap);
      }
    }
  });

  it("rejects a non-integer total, which would mean pesos leaked in", () => {
    expect(() => allocateProportionally(12.5, [1, 1])).toThrow();
  });

  it("rejects negative weights", () => {
    expect(() => allocateProportionally(100, [1, -1])).toThrow();
  });

  it("rejects non-integer weights, which the exact arithmetic cannot represent", () => {
    expect(() => allocateProportionally(100, [1.5, 1])).toThrow();
  });

  /*
   * QA-FIN-02. The contract says ties break on the earlier bucket. The
   * floating-point implementation compared discarded fractions as doubles,
   * and two mathematically equal remainders at different magnitudes came out
   * an ulp apart — so the numeric comparison decided and the index tiebreak
   * never ran. These pin the rule to an independent rational oracle.
   */
  describe("exact largest-remainder tie rule", () => {
    /** Signed-floor BigInt oracle: the definition, not the implementation. */
    function oracle(total: number, weights: number[]): number[] {
      const W = weights.reduce((a, b) => a + b, 0);
      const effective = W === 0 ? weights.map(() => 1) : weights;
      const T = BigInt(W === 0 ? weights.length : W);
      const rows = effective.map((w, index) => {
        const n = BigInt(total) * BigInt(w);
        let q = n / T;
        let r = n - q * T;
        if (r < 0n) {
          q -= 1n;
          r += T;
        }
        return { index, q, r };
      });
      let leftover = BigInt(total) - rows.reduce((s, x) => s + x.q, 0n);
      const byRemainder = [...rows].sort((a, b) => (a.r === b.r ? a.index - b.index : b.r > a.r ? 1 : -1));
      const out = rows.map((x) => x.q);
      for (const { index } of byRemainder) {
        if (leftover <= 0n) break;
        out[index] = out[index]! + 1n;
        leftover -= 1n;
      }
      return out.map(Number);
    }

    it("hands the tied centavo to the earlier bucket on the audit's fixture", () => {
      // Exact remainders are [10, 2, 10]/22: buckets 0 and 2 tie, and the
      // contract says bucket 0 gets the leftover centavo. The floating-point
      // version gave it to bucket 2.
      expect(allocateProportionally(-19500592, [1, 9, 12])).toEqual([-886390, -7977515, -10636687]);
    });

    it("breaks positive unequal-weight ties on the earlier bucket", () => {
      // 1 centavo over weights 2:4 — exact shares 1/3 and 2/3, so bucket 1 has
      // the larger remainder and wins outright.
      expect(allocateProportionally(1, [2, 4])).toEqual([0, 1]);
      // 5 over 3:6:9 — shares 5/6, 10/6, 15/6 -> floors 0,1,2 with remainders
      // 5,4,3 (of 6); leftover 2 goes to buckets 0 then 1.
      expect(allocateProportionally(5, [3, 6, 9])).toEqual([1, 2, 2]);
      // 1 over 1:1 — a dead tie, earlier bucket.
      expect(allocateProportionally(1, [1, 1])).toEqual([1, 0]);
    });

    it("matches the rational oracle exactly, not just in total, across the sweep", () => {
      for (let gap = -999; gap <= 999; gap += 7) {
        for (const weights of [[1, 2, 3], [7, 11, 13, 17], [1, 1], [999, 1], [50, 50, 50, 50, 50], [1, 9, 12], [3, 6, 9]]) {
          expect(allocateProportionally(gap, weights)).toEqual(oracle(gap, weights));
        }
      }
    });

    it("stays exact at magnitudes where the float product would lose precision", () => {
      // total * weight here exceeds 2^53, so a double could not even hold the
      // numerator — the split has to come out of integer arithmetic.
      const total = 987_654_321;
      const weights = [123_456_789, 987_654_321, 555_555_555];
      const shares = allocateProportionally(total, weights);
      expect(sum(shares)).toBe(total);
      expect(shares).toEqual(oracle(total, weights));
    });
  });
});
