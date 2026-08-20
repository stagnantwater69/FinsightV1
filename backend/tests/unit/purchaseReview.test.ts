import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePurchaseReview, reviewPlannedPurchase } from "../../src/services/ai.service";

/**
 * The purchase review's grounding test.
 *
 * Whether the model classifies a display fridge well is not something a test
 * can pin — that varies by model and by day. The narrower and more important
 * questions are the ones below: **can this card ever tell an owner what to
 * buy**, and **can it ever appear half-built**? FinSight's standing rule is
 * that it explains and asks; it does not decide (see SYSTEM_PROMPT in
 * ai.service.ts). A prompt rule is a request. This is the enforcement.
 *
 * `fetch` is stubbed rather than called, so nothing here depends on a network,
 * an API key, or today's model behaviour.
 */

const GOOD = {
  kind: "asset",
  priceCheck: "Ask whether delivery and installation are included, and whether that price is for a new unit or a second-hand one.",
  kindReason: "A fridge is bought once and kept, and it keeps working for years.",
  businessUse: "A sari-sari store uses one to keep drinks cold so they sell at a higher price than warm stock.",
  ongoingCosts: "Electricity every month, and a repair or two over its life.",
  questions: [
    "How many hours a day would it actually run?",
    "Does it replace ice you are already buying every week?",
    "What happens to the stock inside it if it breaks?",
  ],
};

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

describe("reading a usable review", () => {
  it("keeps a well-formed answer intact", () => {
    const review = parsePurchaseReview(JSON.stringify(GOOD));
    expect(review).not.toBeNull();
    expect(review!.kind).toBe("asset");
    expect(review!.questions).toHaveLength(3);
    expect(review!.ongoingCosts).toContain("Electricity");
  });

  it("survives a model that wraps its JSON in a markdown fence", () => {
    const review = parsePurchaseReview("```json\n" + JSON.stringify(GOOD) + "\n```");
    expect(review?.kind).toBe("asset");
  });

  it("falls back to 'unclear' for a kind it does not recognise", () => {
    const review = parsePurchaseReview(JSON.stringify({ ...GOOD, kind: "capital expenditure" }));
    expect(review?.kind).toBe("unclear");
  });

  it("keeps a null ongoingCosts as null rather than inventing one", () => {
    const review = parsePurchaseReview(JSON.stringify({ ...GOOD, ongoingCosts: null }));
    expect(review?.ongoingCosts).toBeNull();
  });
});

describe("never telling the owner what to decide", () => {
  /*
   * Each of these is a real thing a language model says when asked about a
   * purchase, and each one is FinSight crossing from monitoring into advice.
   */
  it.each([
    "You should buy this — it will pay for itself.",
    "I recommend going ahead with this purchase.",
    "It is definitely worth it for a store this size.",
    "Don't buy this yet.",
  ])("drops the whole review when the reason reads as a verdict: %s", (verdict) => {
    expect(parsePurchaseReview(JSON.stringify({ ...GOOD, kindReason: verdict }))).toBeNull();
  });

  it("drops a verdict that arrives as one of the questions", () => {
    const review = parsePurchaseReview(
      JSON.stringify({
        ...GOOD,
        questions: [...GOOD.questions, "You should buy the second-hand one instead."],
      }),
    );
    // The three real questions survive; the statement does not.
    expect(review!.questions).toHaveLength(3);
    expect(review!.questions.join(" ")).not.toMatch(/should buy/i);
  });

  /**
   * THE EXEMPTION THAT MATTERS. "Is it worth buying now or after the busy
   * season?" is exactly what the owner should be asking themselves — the
   * forbidden thing is FinSight ANSWERING it. The question mark is the line.
   */
  it("keeps a question that asks about worth rather than pronouncing on it", () => {
    const review = parsePurchaseReview(
      JSON.stringify({
        ...GOOD,
        questions: ["Is it worth buying now, or after the busy season?", "What does it replace?"],
      }),
    );
    expect(review!.questions[0]).toMatch(/worth buying now/);
  });
});

/**
 * "Is this the right price?" is a question about one local market on one day.
 * The model has no price data and no way to check one — so it may say what to
 * CHECK about the amount, and nothing about what the amount ought to be.
 * FinSight answers the other half from the owner's own records
 * (buildPurchasePriceContext), which is arithmetic rather than opinion.
 */
describe("never pricing the item", () => {
  it("keeps a check that is about what to ask the seller", () => {
    const review = parsePurchaseReview(JSON.stringify(GOOD));
    expect(review!.priceCheck).toMatch(/delivery and installation/);
  });

  it.each([
    "That looks like a fair price for a unit this size.",
    "A fridge like this usually costs around 15,000 pesos.",
    "Expect to pay between 12,000 and 18,000 for this.",
    "That is quite expensive for what you get.",
    "The going rate is lower than this.",
  ])("drops a price judgement or an invented figure: %s", (claim) => {
    const review = parsePurchaseReview(JSON.stringify({ ...GOOD, priceCheck: claim }));
    // The rest of the card still stands — only the unsupported claim goes.
    expect(review).not.toBeNull();
    expect(review!.priceCheck).toBeNull();
  });

  it("accepts a missing price check rather than demanding one", () => {
    const review = parsePurchaseReview(JSON.stringify({ ...GOOD, priceCheck: null }));
    expect(review!.priceCheck).toBeNull();
    expect(review!.kind).toBe("asset");
  });
});

describe("refusing to show half a card", () => {
  it.each([
    ["no reason", { ...GOOD, kindReason: "  " }],
    ["no business use", { ...GOOD, businessUse: null }],
    ["only one question", { ...GOOD, questions: ["How often would you use it?"] }],
    ["statements where questions were promised", { ...GOOD, questions: ["It uses power.", "It needs space."] }],
  ])("returns nothing when the answer has %s", (_label, payload) => {
    expect(parsePurchaseReview(JSON.stringify(payload))).toBeNull();
  });

  it("returns nothing for prose, an array, or broken JSON", () => {
    expect(parsePurchaseReview("A fridge is a good idea.")).toBeNull();
    expect(parsePurchaseReview(JSON.stringify([GOOD]))).toBeNull();
    expect(parsePurchaseReview("{oops")).toBeNull();
  });

  it("caps a model that will not stop talking", () => {
    const review = parsePurchaseReview(
      JSON.stringify({ ...GOOD, businessUse: "x".repeat(2000), questions: [...GOOD.questions, "And another?", "And one more?"] }),
    );
    expect(review!.businessUse.length).toBeLessThanOrEqual(320);
    expect(review!.questions.length).toBeLessThanOrEqual(4);
  });
});

describe("when the providers are unreachable", () => {
  it("falls back to the second provider before giving up", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Gemini down"));
    fetchMock.mockResolvedValueOnce(openRouterSaying(JSON.stringify(GOOD)));

    const review = await reviewPlannedPurchase("display fridge", 11000, "Sari-sari store");
    expect(review?.kind).toBe("asset");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /*
   * Null, not an error: the card simply does not appear and Spending Impact is
   * exactly the page it was without it. Every AI accelerator in this codebase
   * honours the same contract — it speeds a manual flow up, it is never a
   * dependency of one.
   */
  it("returns nothing rather than throwing when both are down", async () => {
    fetchMock.mockRejectedValue(new Error("both down"));
    await expect(reviewPlannedPurchase("display fridge", 11000, "Sari-sari store")).resolves.toBeNull();
  });

  it("sends the business type and the amount, and nothing else about the business", async () => {
    fetchMock.mockResolvedValueOnce(geminiSaying(JSON.stringify(GOOD)));
    await reviewPlannedPurchase("display fridge", 11000, "Sari-sari store");

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const sent = JSON.stringify(body);
    expect(sent).toContain("Sari-sari store");
    expect(sent).toContain("11,000");
    // No balances, no sales, no funds — the page computes all of that itself.
    expect(sent).not.toMatch(/availableFunds|balance|remaining/i);
  });
});
