import { describe, expect, it } from "vitest";
import {
  comparePrice,
  describesSameItem,
  looksLikeBasket,
  searchTerm,
  significantWords,
} from "../../src/services/insights.service";

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

/**
 * WHAT THIS GUARDS, AND WHY IT IS NOT A STYLE POINT.
 *
 * An owner pricing a house was shown a snack receipt as "last time you bought
 * something like this", at PHP 5,313. The SQL behind that card uses `contains`
 * — a substring match — and one line of the receipt read "Piattos Roadhouse
 * BBQ". "Roadhouse" contains "house".
 *
 * Of everything on that screen, this is the half labelled as counted from the
 * owner's own records rather than written by AI. A wrong number under that
 * label costs more than a clumsy sentence from the model does.
 */
describe("deciding whether a record is really the same purchase", () => {
  const snackReceipt =
    "Piattos Roadhouse BBQ (40g) - Bag, Mr. Chips Nacho Cheese (24g) - Bag, " +
    "Presto Creams Peanut Butter (30g) - Pack of 10, Jack 'n Jill Mini-Chocolate Pretzels (25g) - Pack";

  it("does not call a snack receipt a house", () => {
    expect(describesSameItem(snackReceipt, significantWords("house"))).toBe(false);
  });

  it("rejects every other substring trap an ordinary ledger contains", () => {
    expect(describesSameItem("proven supplier deposit", ["oven"])).toBe(false);
    expect(describesSameItem("price list printing", ["rice"])).toBe(false);
    expect(describesSameItem("shopping cartons", ["cart"])).toBe(false);
    expect(describesSameItem("backpack for deliveries", ["pack"])).toBe(false);
  });

  it("still finds the thing the owner actually means", () => {
    expect(describesSameItem("Display fridge for drinks", significantWords("display fridge"))).toBe(true);
    expect(describesSameItem("House repair - roofing", significantWords("house"))).toBe(true);
  });

  /*
   * Every word has to be there, which is the rule the AND in the query was
   * written for: "display fridge" must not match a record that only says
   * "display".
   */
  it("requires every search word, not just one of them", () => {
    expect(describesSameItem("Display rack for the counter", significantWords("display fridge"))).toBe(false);
  });

  it("treats a plural and its singular as the same thing", () => {
    expect(describesSameItem("Plastic chairs x6", significantWords("chair"))).toBe(true);
    expect(describesSameItem("Plastic chair", significantWords("chairs"))).toBe(true);
    expect(describesSameItem("Storage boxes", significantWords("boxes"))).toBe(true);
  });

  /* The prefilter has to return the record before the check above can judge it. */
  it("searches on a stem so the plural and the singular arrive together", () => {
    expect(searchTerm("chairs")).toBe("chair");
    expect(searchTerm("rice")).toBe("rice");
    expect(searchTerm("gas")).toBe("gas");
  });
});

/**
 * A confirmed receipt scan writes every line it read into ONE record, so the
 * amount is the whole shop. Quoting that as the price of one item overstates
 * it by however much else was in the basket — true even when the word match
 * is genuine, which is why it is a separate check.
 */
describe("telling one purchase from a whole basket", () => {
  it("recognises a scanned receipt's item list", () => {
    expect(
      looksLikeBasket("Piattos BBQ (40g) - Bag, Mr. Chips (24g) - Bag, Presto Creams - Pack of 10, Cupp Keso - Pack"),
    ).toBe(true);
  });

  it("leaves the ordinary way of writing one thing down alone", () => {
    expect(looksLikeBasket("Rice, 25kg sack, premium")).toBe(false);
    expect(looksLikeBasket("Display fridge for drinks")).toBe(false);
  });
});
