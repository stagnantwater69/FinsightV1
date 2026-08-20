import { describe, expect, it } from "vitest";
import { validateVisionReceipt, type VisionReceipt } from "../../src/services/visionOcr.service";

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
 * The result is now a DISCRIMINATED one rather than a bare null: a scan whose
 * rescue bought nothing needs to record whether the model's answer failed to
 * parse, failed the schema, or never carried text at all — three different
 * problems with three different owners. Every refusal these tests pin was a
 * refusal before the change too; only the spelling of "no" moved.
 *
 * These are pure-function tests: no network, no key, no model behaviour.
 */

/** Unwraps an accepted reading, failing loudly when the input was refused. */
function accept(raw: string): VisionReceipt {
  const result = validateVisionReceipt(raw);
  expect(result.ok, `expected an accepted reading, got ${JSON.stringify(result)}`).toBe(true);
  return (result as Extract<ReturnType<typeof validateVisionReceipt>, { ok: true }>).receipt;
}

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
    const out = accept(good);
    expect(out.date).toBe("2026-07-11");
    expect(out.vendor).toBe("ABC SARI-SARI STORE");
    expect(out.amount).toBe(188);
    expect(out.items).toHaveLength(2);
  });

  it("survives a ```json fence", () => {
    expect(accept("```json\n" + good + "\n```").amount).toBe(188);
  });

  /**
   * MEASURED, not hypothetical. At temperature 0 the identical prompt and
   * image returned a bare object on one corpus run and that same object
   * wrapped in an array on the next. The receipt was read correctly both
   * times — the unhandled envelope was what scored it as unreadable.
   */
  it("unwraps a single-element array, which the model really does emit", () => {
    const out = accept(`[${good}]`);
    expect(out.amount).toBe(188);
    expect(out.items).toHaveLength(2);
  });
});

describe("refusing what cannot be trusted, and saying why", () => {
  it("refuses prose as unparseable", () => {
    expect(validateVisionReceipt("This looks like a receipt for 188 pesos!")).toEqual({ ok: false, reason: "parse" });
  });

  it("refuses invalid JSON as unparseable", () => {
    expect(validateVisionReceipt("{ntotally broken")).toEqual({ ok: false, reason: "parse" });
  });

  it("refuses a bare array of several objects as a schema failure", () => {
    // Ambiguous — which receipt is it? Refusing beats picking one.
    expect(validateVisionReceipt('[{"total":1},{"total":2}]')).toEqual({ ok: false, reason: "schema" });
  });

  it("refuses a JSON scalar as a schema failure", () => {
    expect(validateVisionReceipt('"188.00"')).toEqual({ ok: false, reason: "schema" });
  });

  it("refuses JSON null as a schema failure", () => {
    expect(validateVisionReceipt("null")).toEqual({ ok: false, reason: "schema" });
  });

  it("refuses an empty answer as empty, distinctly from a malformed one", () => {
    expect(validateVisionReceipt("")).toEqual({ ok: false, reason: "empty" });
    expect(validateVisionReceipt("   \n ")).toEqual({ ok: false, reason: "empty" });
    // An empty code fence is an empty answer wearing punctuation.
    expect(validateVisionReceipt("```json\n```")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("items — where an invented line would do the damage", () => {
  const withItems = (items: unknown) => accept(JSON.stringify({ total: 100, items }));

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

describe("per-item evidence — page number and source text", () => {
  const withItems = (items: unknown) => accept(JSON.stringify({ total: 100, items }));

  it("carries the model's reported page and visible text", () => {
    const out = withItems([{ name: "Rice 25kg", amount: 50, pageNumber: 2, sourceText: "Rice 25kg  50.00" }]);
    expect(out.items[0]!.pageNumber).toBe(2);
    expect(out.items[0]!.sourceText).toBe("Rice 25kg  50.00");
  });

  it("treats an implausible page number as not stated, never inventing one", () => {
    expect(withItems([{ name: "Rice", amount: 50, pageNumber: 0 }]).items[0]!.pageNumber).toBeNull();
    expect(withItems([{ name: "Rice", amount: 50, pageNumber: 1.5 }]).items[0]!.pageNumber).toBeNull();
    expect(withItems([{ name: "Rice", amount: 50, pageNumber: "two" }]).items[0]!.pageNumber).toBeNull();
  });

  it("treats missing or blank source text as not stated", () => {
    expect(withItems([{ name: "Rice", amount: 50 }]).items[0]!.sourceText).toBeNull();
    expect(withItems([{ name: "Rice", amount: 50, sourceText: "  " }]).items[0]!.sourceText).toBeNull();
  });
});

describe("warnings — the model's own admissions, validated like everything else", () => {
  it("keeps a warning carrying a known code", () => {
    const out = accept(
      JSON.stringify({ total: 1, warnings: [{ code: "AMBIGUOUS_DATE", field: "date", detail: "05/03/2026" }] }),
    );
    expect(out.warnings).toEqual([{ code: "AMBIGUOUS_DATE", field: "date", detail: "05/03/2026" }]);
  });

  it("drops a model-invented code rather than passing it to the clients", () => {
    const out = accept(JSON.stringify({ total: 1, warnings: [{ code: "SOMETHING_MADE_UP", field: "date" }] }));
    expect(out.warnings).toEqual([]);
  });

  it("tolerates warnings being absent or not an array", () => {
    expect(accept('{"total":1}').warnings).toEqual([]);
    expect(accept('{"total":1,"warnings":"oh no"}').warnings).toEqual([]);
  });
});

describe("dates — an impossible one fails the whole upload at Prisma", () => {
  const withDate = (date: unknown) => accept(JSON.stringify({ date, total: 1 }));

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
    expect(accept('{"vendor":"   ","total":1}').vendor).toBeNull();
  });

  it("truncates an over-long vendor to what the column holds", () => {
    const out = accept(JSON.stringify({ vendor: "y".repeat(400), total: 1 }));
    expect(out.vendor!.length).toBeLessThanOrEqual(150);
  });

  it("ignores a zero or negative total", () => {
    expect(accept('{"total":0}').amount).toBeNull();
    expect(accept('{"total":-5}').amount).toBeNull();
  });

  it("returns an empty reading rather than a refusal when the model found nothing", () => {
    // Distinct from a malformed answer: the model replied properly and said
    // it could not read anything, which the caller treats as "no rescue".
    const out = accept('{"date":null,"vendor":null,"total":null,"items":[]}');
    expect(out.amount).toBeNull();
    expect(out.items).toEqual([]);
  });
});
