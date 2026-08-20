import { describe, expect, it } from "vitest";
import { comparePrice, significantWords } from "../../src/services/insights.service";

/**
 * The half of "is this the right price?" that FinSight can actually answer.
 *
 * Not what a display fridge costs in Cebu today — nothing in this system knows
 * that, and a model asked to guess would produce a confident range with
 * nothing behind it. What it knows is what THIS owner has paid before, so the
 * question becomes "is this normal for me", which is arithmetic.
 *
 * The two pure pieces of that arithmetic are pinned here; the queries around
 * them are exercised by the integration suite.
 */

describe("choosing what to search their records for", () => {
  it("keeps the words that identify the item", () => {
    expect(significantWords("Display fridge for the drinks")).toEqual(["display", "fridge", "drinks"]);
  });

  /*
   * Short words and filler match half a ledger while looking specific — a
   * search for "the" and "new" returns the owner's entire year and calls it a
   * similar purchase.
   */
  it("drops filler and anything too short to identify anything", () => {
    expect(significantWords("a new set of 2 pcs")).toEqual([]);
    expect(significantWords("buy some more rice")).toEqual(["rice"]);
  });

  it("survives punctuation, casing and a very long description", () => {
    expect(significantWords("RICE — 25kg sack, premium (Jasmine)")).toEqual(["rice", "25kg", "sack"]);
  });

  it("takes at most three words, because the fourth narrows nothing", () => {
    expect(significantWords("commercial display chiller freezer cabinet").length).toBe(3);
  });
});

describe("placing the amount against what they usually pay", () => {
  it("says so plainly when there is nothing to compare against", () => {
    expect(comparePrice(11000, null)).toBe("no-history");
    expect(comparePrice(11000, 0)).toBe("no-history");
  });

  it("says so when no amount has been entered yet", () => {
    expect(comparePrice(null, 4200)).toBe("no-amount");
  });

  /**
   * THE BANDS ARE WIDE ON PURPOSE. Prices move, sizes differ, and a 15%
   * difference from a median of four records is noise. Calling that "above
   * what you usually pay" teaches the owner to ignore the line.
   */
  it("treats a modest difference as normal rather than as a signal", () => {
    expect(comparePrice(4500, 4200)).toBe("in-line");
    expect(comparePrice(3200, 4200)).toBe("in-line");
    expect(comparePrice(5800, 4200)).toBe("in-line");
  });

  it("marks a real step up, and a step up that is in another league", () => {
    expect(comparePrice(8000, 4200)).toBe("above");
    expect(comparePrice(40000, 4200)).toBe("far-above");
  });

  it("marks a purchase well under their usual", () => {
    expect(comparePrice(2000, 4200)).toBe("below");
  });
});
