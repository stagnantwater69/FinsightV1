import { describe, expect, it } from "vitest";
import { validateVisionReceipt } from "../../src/services/visionOcr.service";

/**
 * The boundary between a model's answer and the owner's books.
 *
 * Using a vision model for extraction reverses a rule this codebase stated
 * deliberately — that a language model must not produce the numbers, because
 * it can invent one. The measured false-positive rate was zero across three
 * corpus runs, but zero measured is not the same as zero possible, so this
 * layer treats every response as hostile input and drops whatever does not
 * survive checking.
 *
 * These are pure-function tests: no network, no key, no model behaviour.
 */

const good = JSON.stringify({
  date: "2026-07-11",
  vendor: "ABC SARI-SARI STORE",
  total: 188,
  items: [
    { name: "Spareribs Meal", quantity: null, amount: 129 },
    { name: "Iced Latte 16oz", quantity: 1, amount: 59 },
  ],
});

describe("reading a well-formed answer", () => {
  it("accepts it", () => {
    const out = validateVisionReceipt(good)!;
    expect(out.date).toBe("2026-07-11");
    expect(out.vendor).toBe("ABC SARI-SARI STORE");
    expect(out.amount).toBe(188);
    expect(out.items).toHaveLength(2);
  });

  it("survives a ```json fence", () => {
    expect(validateVisionReceipt("```json\n" + good + "\n```")!.amount).toBe(188);
  });

  /**
   * MEASURED, not hypothetical. At temperature 0 the identical prompt and
   * image returned a bare object on one corpus run and that same object
   * wrapped in an array on the next. The receipt was read correctly both
   * times — the unhandled envelope was what scored it as unreadable.
   */
  it("unwraps a single-element array, which the model really does emit", () => {
    const out = validateVisionReceipt(`[${good}]`)!;
    expect(out.amount).toBe(188);
    expect(out.items).toHaveLength(2);
  });
});

describe("refusing what cannot be trusted", () => {
  it("returns null for prose", () => {
    expect(validateVisionReceipt("This looks like a receipt for 188 pesos!")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(validateVisionReceipt("{ntotally broken")).toBeNull();
  });

  it("returns null for a bare array of several objects", () => {
    // Ambiguous — which receipt is it? Refusing beats picking one.
    expect(validateVisionReceipt('[{"total":1},{"total":2}]')).toBeNull();
  });

  it("returns null for a JSON scalar", () => {
    expect(validateVisionReceipt('"188.00"')).toBeNull();
  });
});

describe("items — where an invented line would do the damage", () => {
  const withItems = (items: unknown) => validateVisionReceipt(JSON.stringify({ total: 100, items }))!;

  it("drops a line with no readable price", () => {
    expect(withItems([{ name: "Mystery", quantity: null, amount: null }]).items).toEqual([]);
  });

  it("drops a line with no name", () => {
    expect(withItems([{ name: "   ", quantity: null, amount: 50 }]).items).toEqual([]);
  });

  it("drops a zero or negative amount", () => {
    expect(withItems([
      { name: "Free sample", amount: 0 },
      { name: "Refund", amount: -50 },
    ]).items).toEqual([]);
  });

  it("drops a non-numeric amount rather than coercing it to zero", () => {
    expect(withItems([{ name: "Rice", amount: "not a number" }]).items).toEqual([]);
  });

  it("keeps the good lines from a partly bad list", () => {
    const out = withItems([
      { name: "Rice 25kg", amount: 1220 },
      { name: "Broken", amount: null },
      { name: "Cooking oil", amount: 180 },
    ]);
    expect(out.items.map((i) => i.name)).toEqual(["Rice 25kg", "Cooking oil"]);
  });

  it("caps a runaway list", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `Item ${i}`, amount: 10 }));
    expect(withItems(many).items.length).toBeLessThanOrEqual(100);
  });

  it("tolerates items not being an array at all", () => {
    expect(withItems("lots of things").items).toEqual([]);
  });

  it("treats a zero or negative quantity as not stated", () => {
    expect(withItems([{ name: "Rice", quantity: 0, amount: 50 }]).items[0]!.quantity).toBeNull();
  });

  it("truncates an over-long name to what the column holds", () => {
    const out = withItems([{ name: "x".repeat(400), amount: 50 }]);
    expect(out.items[0]!.name.length).toBeLessThanOrEqual(255);
  });
});

describe("dates — an impossible one fails the whole upload at Prisma", () => {
  const withDate = (date: unknown) => validateVisionReceipt(JSON.stringify({ date, total: 1 }))!;

  it("rejects a non-calendar date", () => {
    expect(withDate("2026-13-45").date).toBeNull();
  });

  it("rejects a date in the wrong shape", () => {
    expect(withDate("11/07/2026").date).toBeNull();
    expect(withDate("July 11 2026").date).toBeNull();
  });

  it("rejects a non-string date", () => {
    expect(withDate(20260711).date).toBeNull();
  });

  it("accepts a real one", () => {
    expect(withDate("2026-07-11").date).toBe("2026-07-11");
  });
});

describe("vendor and total", () => {
  it("ignores a blank vendor", () => {
    expect(validateVisionReceipt('{"vendor":"   ","total":1}')!.vendor).toBeNull();
  });

  it("truncates an over-long vendor to what the column holds", () => {
    const out = validateVisionReceipt(JSON.stringify({ vendor: "y".repeat(400), total: 1 }))!;
    expect(out.vendor!.length).toBeLessThanOrEqual(150);
  });

  it("ignores a zero or negative total", () => {
    expect(validateVisionReceipt('{"total":0}')!.amount).toBeNull();
    expect(validateVisionReceipt('{"total":-5}')!.amount).toBeNull();
  });

  it("returns an empty reading rather than null when the model found nothing", () => {
    // Distinct from a malformed answer: the model replied properly and said
    // it could not read anything, which the caller treats as "no rescue".
    const out = validateVisionReceipt('{"date":null,"vendor":null,"total":null,"items":[]}')!;
    expect(out).not.toBeNull();
    expect(out.amount).toBeNull();
    expect(out.items).toEqual([]);
  });
});
