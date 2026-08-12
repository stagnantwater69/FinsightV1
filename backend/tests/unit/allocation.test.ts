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
});
