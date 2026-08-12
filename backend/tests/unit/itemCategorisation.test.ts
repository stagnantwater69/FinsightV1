import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categoriseReceiptItems, UNCATEGORISED } from "../../src/services/ai.service";

/**
 * The categorisation grounding test.
 *
 * The question here is not "does the model classify well" — that varies by
 * model and by day, and is not something a test can pin. It is the narrower
 * and more important one: **can anything the model says put a category into
 * the owner's books that they never created?** Every case below is a way of
 * answering no.
 *
 * `fetch` is stubbed rather than called, so these assertions don't depend on
 * a network, an API key, or today's model behaviour.
 */

/** A realistic small-business category list — a Cebu burger stall. */
const CATEGORIES = ["Ingredients", "Packaging", "Utilities", "Equipment"];

/** Real item names off a food-business receipt. */
const ITEMS = ["Buns", "Ground beef patty", "Eggs tray", "Rice cooker"];

function geminiSaying(text: string) {
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
}
function openRouterSaying(text: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: text } }] }) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grounding against the business's own categories", () => {
  it("accepts matches that are on the list", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(
        JSON.stringify([
          { index: 0, match: "Ingredients" },
          { index: 1, match: "Ingredients" },
          { index: 2, match: "Ingredients" },
          { index: 3, match: "Equipment" },
        ]),
      ),
    );

    const out = await categoriseReceiptItems(ITEMS, CATEGORIES);
    expect(out.map((s) => s.match)).toEqual(["Ingredients", "Ingredients", "Ingredients", "Equipment"]);
    expect(out.every((s) => s.suggestNew === null)).toBe(true);
  });

  /**
   * The central guarantee. A model that answers "Groceries" for a business
   * that has no such category must not create one, must not be silently
   * mapped onto the nearest existing name, and must not fail the scan — the
   * item is simply left uncategorised for the owner to place.
   */
  it("refuses a category the business does not have", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "Groceries" }])),
    );
    const out = await categoriseReceiptItems(["Buns"], CATEGORIES);
    expect(out[0]!.match).toBeNull();
  });

  it("does not map a near-miss onto a real category", async () => {
    // "Ingredient" (singular) and "Food" are both plausible-looking and both
    // wrong — neither is on the list, so neither resolves.
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "Ingredient" }, { index: 1, match: "Food" }])),
    );
    const out = await categoriseReceiptItems(["Buns", "Patty"], CATEGORIES);
    expect(out.map((s) => s.match)).toEqual([null, null]);
  });

  it("matches case-insensitively but returns the business's own spelling", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "  ingredients " }])),
    );
    const out = await categoriseReceiptItems(["Buns"], CATEGORIES);
    expect(out[0]!.match).toBe("Ingredients");
  });
});

/**
 * The differentiation test.
 *
 * The grounding tests above prove the categoriser never invents a category.
 * They do NOT prove it actually reasons per item — a pipeline that read only
 * the first result and stamped it on every row would pass every one of them.
 * That is exactly the failure that was reported from a real Savemore Market
 * receipt: eleven groceries all filed under one category.
 *
 * These pin the property those tests were blind to: distinct item types must
 * come back with distinct categories, and each must land on the right one.
 */
describe("differentiating between items", () => {
  const MIXED = ["Coke Mismo 300ml", "Gardenia white bread", "Tissue 2ply 12s", "Rice cooker"];
  const MIXED_CATEGORIES = ["Ingredients", "Supplies", "Equipment"];

  it("returns more than one category for clearly different item types", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(
        JSON.stringify([
          { index: 0, match: "Ingredients" },
          { index: 1, match: "Ingredients" },
          { index: 2, match: "Supplies" },
          { index: 3, match: "Equipment" },
        ]),
      ),
    );

    const out = await categoriseReceiptItems(MIXED, MIXED_CATEGORIES);
    const distinct = new Set(out.map((s) => s.match));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it("keeps each item on ITS OWN category rather than the first one", async () => {
    // The order is deliberately shuffled relative to the items, because a
    // pipeline that ignored `index` and zipped positionally would still pass
    // an in-order fixture.
    fetchMock.mockResolvedValueOnce(
      geminiSaying(
        JSON.stringify([
          { index: 3, match: "Equipment" },
          { index: 0, match: "Ingredients" },
          { index: 2, match: "Supplies" },
          { index: 1, match: "Ingredients" },
        ]),
      ),
    );

    const out = await categoriseReceiptItems(MIXED, MIXED_CATEGORIES);
    const byIndex = new Map(out.map((s) => [s.index, s.match]));
    expect(byIndex.get(0)).toBe("Ingredients"); // Coke
    expect(byIndex.get(1)).toBe("Ingredients"); // bread
    expect(byIndex.get(2)).toBe("Supplies"); // tissue
    expect(byIndex.get(3)).toBe("Equipment"); // rice cooker
  });

  it("returns one suggestion per item, not one for the whole receipt", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(
        JSON.stringify(MIXED.map((_, i) => ({ index: i, match: i === 3 ? "Equipment" : "Ingredients" }))),
      ),
    );
    const out = await categoriseReceiptItems(MIXED, MIXED_CATEGORIES);
    expect(out).toHaveLength(MIXED.length);
    expect(new Set(out.map((s) => s.index)).size).toBe(MIXED.length);
  });

  /**
   * A uniform answer is not automatically wrong — a receipt of nothing but
   * groceries genuinely is all one category. What must not happen is the
   * pipeline FORCING uniformity, so this checks a mixed answer survives
   * intact while a genuinely uniform one is also passed through untouched.
   */
  it("passes a genuinely uniform answer through unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify(MIXED.map((_, i) => ({ index: i, match: "Ingredients" })))),
    );
    const out = await categoriseReceiptItems(MIXED, MIXED_CATEGORIES);
    expect(out.every((s) => s.match === "Ingredients")).toBe(true);
  });
});

describe("honest fallback rather than a confident guess", () => {
  it("passes UNCATEGORISED through as no match", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "UNCATEGORISED" }])),
    );
    const out = await categoriseReceiptItems(["Mystery item"], CATEGORIES);
    expect(out[0]!.match).toBeNull();
  });

  it("exposes a proposed new category as a suggestion only, never as a match", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "UNCATEGORISED", suggestNew: "Cleaning supplies" }])),
    );
    const out = await categoriseReceiptItems(["Dishwashing liquid"], CATEGORIES);
    expect(out[0]!.match).toBeNull();
    expect(out[0]!.suggestNew).toBe("Cleaning supplies");
  });

  it("drops a 'new' suggestion that is really an existing category", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "Ingredients", suggestNew: "Ingredients" }])),
    );
    const out = await categoriseReceiptItems(["Buns"], CATEGORIES);
    expect(out[0]!.suggestNew).toBeNull();
  });

  it("ignores an index that is not one of the items sent", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "Ingredients" }, { index: 99, match: "Equipment" }])),
    );
    const out = await categoriseReceiptItems(["Buns"], CATEGORIES);
    expect(out).toHaveLength(1);
    expect(out[0]!.index).toBe(0);
  });

  it("ignores a duplicated index rather than letting the last one win", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying(JSON.stringify([{ index: 0, match: "Ingredients" }, { index: 0, match: "Equipment" }])),
    );
    const out = await categoriseReceiptItems(["Buns"], CATEGORIES);
    expect(out).toHaveLength(1);
    expect(out[0]!.match).toBe("Ingredients");
  });
});

describe("malformed answers", () => {
  it("survives a ```json fence", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiSaying('```json\n[{"index":0,"match":"Ingredients"}]\n```'),
    );
    expect((await categoriseReceiptItems(["Buns"], CATEGORIES))[0]!.match).toBe("Ingredients");
  });

  it("returns nothing for prose", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("These look like ingredients to me!"));
    expect(await categoriseReceiptItems(["Buns"], CATEGORIES)).toEqual([]);
  });

  it("returns nothing for a JSON object instead of an array", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying('{"index":0,"match":"Ingredients"}'));
    expect(await categoriseReceiptItems(["Buns"], CATEGORIES)).toEqual([]);
  });
});

describe("cost discipline and availability", () => {
  it("sends ONE request for a whole receipt, not one per item", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(ITEMS, CATEGORIES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends every item, numbered, in one prompt", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(ITEMS, CATEGORIES);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const sent = body.contents[0].parts[0].text as string;
    for (const item of ITEMS) expect(sent).toContain(item);
    for (const category of CATEGORIES) expect(sent).toContain(category);
  });

  it("falls back to OpenRouter when Gemini fails", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" })
      .mockResolvedValueOnce(openRouterSaying(JSON.stringify([{ index: 0, match: "Ingredients" }])));

    expect((await categoriseReceiptItems(["Buns"], CATEGORIES))[0]!.match).toBe("Ingredients");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to no suggestions when both providers fail", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    await expect(categoriseReceiptItems(["Buns"], CATEGORIES)).resolves.toEqual([]);
  });

  it("asks nothing when the business has no categories yet", async () => {
    expect(await categoriseReceiptItems(["Buns"], [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks nothing when the receipt yielded no items", async () => {
    expect(await categoriseReceiptItems([], CATEGORIES)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the standing fallback category", () => {
  it('is named "Uncategorized"', () => {
    expect(UNCATEGORISED).toBe("Uncategorized");
  });
});

/**
 * What the model is told beyond the item names.
 *
 * Item names arrive through OCR off thermal paper and are frequently mangled
 * ("Sprite Can 320m]"). Two things survive that much better: the shop's name
 * at the top of the receipt, and what this owner decided about the same
 * purchase last week. Both are hints only — the grounding tests above still
 * hold, because nothing here changes what an ANSWER is allowed to be.
 */
describe("classification context", () => {
  /** The user-facing half of the request, which is where context lands. */
  function sentPrompt(): string {
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    return body.contents[0].parts[0].text as string;
  }

  it("includes the vendor when there is one", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, { vendorName: "Savemore Market" });
    expect(sentPrompt()).toContain("Savemore Market");
  });

  it("says nothing about a vendor OCR could not read", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, { vendorName: null });
    expect(sentPrompt()).not.toContain("Vendor:");
  });

  it("ignores a vendor that is only whitespace", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, { vendorName: "   " });
    expect(sentPrompt()).not.toContain("Vendor:");
  });

  it("replays what this business decided before", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, {
      priorChoices: [{ item: "Coke Mismo 300ml", category: "Ingredients" }],
    });
    const sent = sentPrompt();
    expect(sent).toContain("Coke Mismo 300ml");
    expect(sent).toContain('"Coke Mismo 300ml" -> Ingredients');
  });

  /**
   * A category the owner has since deleted or renamed must not be taught as
   * a valid answer. The model would copy it and validateItemCategories would
   * then throw that answer away as ungrounded — teaching an answer that is
   * guaranteed to be discarded is worse than teaching nothing.
   */
  it("drops a prior choice naming a category that no longer exists", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, {
      priorChoices: [
        { item: "Old thing", category: "Category They Deleted" },
        { item: "Buns", category: "Ingredients" },
      ],
    });
    const sent = sentPrompt();
    expect(sent).not.toContain("Category They Deleted");
    expect(sent).toContain('"Buns" -> Ingredients');
  });

  /**
   * Callers pass history most-recent-first, so the first occurrence of an
   * item name is the owner's LATEST decision about it. A superseded choice
   * must not be replayed alongside the one that replaced it — the model would
   * be shown the same item filed two different ways.
   */
  it("keeps only the most recent decision about a repeated item", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Coke"], CATEGORIES, {
      priorChoices: [
        { item: "Coke Mismo", category: "Packaging" }, // the correction
        { item: "Coke Mismo", category: "Ingredients" }, // what it replaced
      ],
    });
    const sent = sentPrompt();
    expect(sent).toContain('"Coke Mismo" -> Packaging');
    expect(sent).not.toContain('"Coke Mismo" -> Ingredients');
  });

  it("matches item names case-insensitively when deduplicating", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, {
      priorChoices: [
        { item: "Buns", category: "Ingredients" },
        { item: "BUNS", category: "Packaging" },
      ],
    });
    // Asserted on the replay form specifically — "Packaging" also appears in
    // the Categories line, where it belongs.
    expect(sentPrompt()).not.toContain("-> Packaging");
    expect(sentPrompt()).toContain('"Buns" -> Ingredients');
  });

  /**
   * The prompt is paid for by the token on every scan, forever. History has
   * to be bounded or a long-running business's receipts get steadily more
   * expensive to classify.
   */
  it("caps how much history it replays", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES, {
      priorChoices: Array.from({ length: 200 }, (_, i) => ({
        item: `Item ${i}`,
        category: "Ingredients",
      })),
    });
    const replayed = (sentPrompt().match(/" -> /g) ?? []).length;
    expect(replayed).toBeLessThanOrEqual(20);
    expect(replayed).toBeGreaterThan(0);
  });

  it("asks exactly as before when given no context at all", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying("[]"));
    await categoriseReceiptItems(["Buns"], CATEGORIES);
    const sent = sentPrompt();
    expect(sent).not.toContain("Vendor:");
    expect(sent).not.toContain(" -> ");
    // The parts that were always there are untouched.
    expect(sent).toContain("Categories: Ingredients, Packaging, Utilities, Equipment");
    expect(sent).toContain("0. Buns");
  });

  /**
   * Context is a hint, never a permission. Everything the grounding tests
   * above establish must still hold when the model has been shown a vendor
   * and a pile of history.
   */
  it("still refuses an ungrounded answer when context was supplied", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying(JSON.stringify([{ index: 0, match: "Groceries" }])));
    const out = await categoriseReceiptItems(["Buns"], CATEGORIES, {
      vendorName: "Savemore Market",
      priorChoices: [{ item: "Buns", category: "Ingredients" }],
    });
    expect(out[0]!.match).toBeNull();
  });
});
