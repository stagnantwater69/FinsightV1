import { describe, expect, it } from "vitest";
import {
  BAND_SENTENCE,
  BAND_TONE,
  DEFAULT_PERIOD_DAYS,
  IMPACT_STALE_COPY,
  MAX_AMOUNT,
  MAX_ITEM_LENGTH,
  PERIOD_OPTIONS,
  QUICK_AMOUNTS,
  amountValidationError,
  canRequestReview,
  canSuggestCategory,
  gaugeAccessibilityText,
  gaugeGeometry,
  impactStaleReason,
  isCategorySuggestionStale,
  isImpactStale,
  isQuickAmountSelected,
  isReviewStale,
  parseAmount,
  percentOfFundsText,
  periodEvidence,
  periodEvidenceNote,
  periodPhrase,
  quickAmountValue,
  resetScenario,
  scenarioQuestion,
} from "../src/lib/spendingImpactForm";
import { FIELD_LIMITS } from "../src/lib/fieldLimits";

/**
 * The Spending Impact form's input rules.
 *
 * These pin the hardening that replaced the old behaviour, where a bad amount
 * silently cleared whatever result was on screen and said nothing about why.
 * The request-sequencing (latest-request-wins) guard is NOT covered here — it
 * lives inside the screen around a ref and this repo has no mobile render
 * harness, so it needs manual verification rather than a vacuous unit test.
 */

describe("parseAmount", () => {
  it("reads plain numbers", () => {
    expect(parseAmount("11000")).toBe(11000);
    expect(parseAmount("250.5")).toBe(250.5);
  });

  it("accepts the commas people actually type", () => {
    expect(parseAmount("11,000")).toBe(11000);
    expect(parseAmount("1,234,567.89")).toBe(1234567.89);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseAmount("  500 ")).toBe(500);
  });

  it("returns null for emptiness and for things that are not numbers", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("12abc")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
  });

  it("parses negatives as numbers — rejecting them is validation's job", () => {
    expect(parseAmount("-500")).toBe(-500);
  });

  /*
   * `Number()` on its own reads these as 16 and 100000. A decimal pad cannot
   * type either, but a paste or a hardware keyboard can, and a currency field
   * that silently reinterprets its own input is how a wrong figure reaches a
   * total with nothing on screen to show it happened.
   */
  it("refuses number formats JavaScript would happily reinterpret", () => {
    expect(parseAmount("0x10")).toBeNull();
    expect(parseAmount("1e5")).toBeNull();
    expect(parseAmount("0b101")).toBeNull();
    expect(parseAmount("Infinity")).toBeNull();
    expect(parseAmount("1_000")).toBeNull();
  });

  it("still refuses partial input that is not yet a number", () => {
    expect(parseAmount(".")).toBeNull();
    expect(parseAmount("-")).toBeNull();
  });
});

describe("amountValidationError", () => {
  it("says nothing about a valid positive amount", () => {
    expect(amountValidationError("11000")).toBeNull();
    expect(amountValidationError("11,000.50")).toBeNull();
    expect(amountValidationError("0.01")).toBeNull();
  });

  it("distinguishes an empty field from a malformed one", () => {
    // Two different mistakes get two different sentences — "valid amount"
    // for both would tell someone who typed nothing the same thing as
    // someone who typed garbage.
    expect(amountValidationError("")).toBe("Enter an amount to check.");
    expect(amountValidationError("   ")).toBe("Enter an amount to check.");
    expect(amountValidationError("fridge")).toBe("Enter a valid number.");
  });

  it("rejects zero and negative amounts by name", () => {
    expect(amountValidationError("0")).toBe("Enter an amount greater than zero.");
    expect(amountValidationError("-500")).toBe("Enter an amount greater than zero.");
  });

  /*
   * The server's own ceiling. Above it, /insights/spending-impact still
   * answers (its schema is only nonnegative) so the impact card would render,
   * and then /ai/purchase-review 400s — one request accepted and one rejected
   * for the same number, with a raw Zod message in place of FinSight's words.
   */
  it("mirrors the server's upper bound", () => {
    expect(MAX_AMOUNT).toBe(999_999_999);
    expect(amountValidationError(String(MAX_AMOUNT))).toBeNull();
    expect(amountValidationError("999,999,999")).toBeNull();
    expect(amountValidationError(String(MAX_AMOUNT + 1))).toBe(
      "That's larger than FinSight can check. Enter ₱999,999,999 or less.",
    );
    expect(amountValidationError("1000000000")).not.toBeNull();
  });
});

describe("isImpactStale", () => {
  it("is fresh when the field still holds the amount that was checked", () => {
    expect(isImpactStale(11000, 11000)).toBe(false);
  });

  it("is never stale before anything has been checked", () => {
    expect(isImpactStale(null, 11000)).toBe(false);
    expect(isImpactStale(null, null)).toBe(false);
  });

  /*
   * The bug this exists for: check ₱11,000, then edit the field to ₱200
   * without pressing Check. The card kept saying "High Impact" and "uses X%
   * of your available funds" — figures about 11,000 — beside a field reading
   * 200, with nothing tying the two together.
   */
  it("goes stale as soon as the field moves off the checked amount", () => {
    expect(isImpactStale(11000, 200)).toBe(true);
  });

  it("goes stale when the field is emptied or made invalid", () => {
    expect(isImpactStale(11000, null)).toBe(true);
  });
});

describe("isReviewStale", () => {
  const reviewed = { item: "display fridge", amount: 11000 };

  it("is fresh when nothing has moved on", () => {
    expect(isReviewStale(reviewed, { item: "display fridge", amount: 11000 })).toBe(false);
  });

  it("never marks stale before a review exists", () => {
    expect(isReviewStale({ item: null, amount: null }, { item: "anything", amount: 5 })).toBe(false);
  });

  it("goes stale when the item wording changes", () => {
    expect(isReviewStale(reviewed, { item: "chest freezer", amount: 11000 })).toBe(true);
  });

  it("goes stale when the amount changes — the price check was written against it", () => {
    expect(isReviewStale(reviewed, { item: "display fridge", amount: 15000 })).toBe(true);
    expect(isReviewStale(reviewed, { item: "display fridge", amount: null })).toBe(true);
  });

  it("ignores whitespace around the item, matching what was actually sent", () => {
    expect(isReviewStale(reviewed, { item: "  display fridge  ", amount: 11000 })).toBe(false);
  });

  it("treats an amount-less review as fresh only while the field stays amount-less", () => {
    const withoutAmount = { item: "display fridge", amount: null };
    expect(isReviewStale(withoutAmount, { item: "display fridge", amount: null })).toBe(false);
    expect(isReviewStale(withoutAmount, { item: "display fridge", amount: 9000 })).toBe(true);
  });
});

describe("canRequestReview", () => {
  it("needs at least three characters of item", () => {
    expect(canRequestReview("")).toBe(false);
    expect(canRequestReview("tv")).toBe(false);
    expect(canRequestReview("   tv   ")).toBe(false);
    expect(canRequestReview("fan")).toBe(true);
    expect(canRequestReview("  display fridge ")).toBe(true);
  });

  it("mirrors the server's 255-character description ceiling", () => {
    expect(MAX_ITEM_LENGTH).toBe(255);
    expect(canRequestReview("a".repeat(MAX_ITEM_LENGTH))).toBe(true);
    expect(canRequestReview("a".repeat(MAX_ITEM_LENGTH + 1))).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The P2 scenario controls: period, presets, category suggestion, the gauge,
 * thin evidence and the prepared question.
 *
 * WHAT THESE CAN AND CANNOT CLAIM. Every one of them is a pure function, so
 * these are honest about the arithmetic and the wording and about nothing
 * else. There is no render harness for mobile: that the gauge's marker is
 * DRAWN where `gaugeGeometry` says, that the segmented control is reachable,
 * that a screen reader actually reads `gaugeAccessibilityText` aloud, and that
 * the category picker's sheet opens are all physical-device questions and are
 * listed as such in the task report rather than implied here.
 * ---------------------------------------------------------------------------
 */

describe("comparison period", () => {
  it("offers exactly the three windows the plan names", () => {
    expect(PERIOD_OPTIONS.map((o) => o.days)).toEqual([1, 7, 30]);
  });

  it("opens on the window the endpoint itself defaults to", () => {
    // /insights/spending-impact defaults periodDays to 30. Opening on anything
    // else would make the app's first answer differ from the same account's
    // first answer on web for no reason an owner could see.
    expect(DEFAULT_PERIOD_DAYS).toBe(30);
    expect(PERIOD_OPTIONS.some((o) => o.days === DEFAULT_PERIOD_DAYS)).toBe(true);
  });

  it("names each window in a sentence, so copy never says 'last 1 days'", () => {
    expect(periodPhrase(1)).toBe("today's records");
    expect(periodPhrase(7)).toBe("this week's records");
    expect(periodPhrase(30)).toBe("this month's records");
  });
});

describe("isImpactStale with a period", () => {
  it("ignores the period when a call site does not track one", () => {
    expect(isImpactStale(11000, 11000)).toBe(false);
  });

  /*
   * The point of the period argument. The server counts a different set of
   * records for each window, so figures computed over seven days are not an
   * answer about thirty — even though the amount in the field never moved,
   * which is exactly why the amount-only check could not see it.
   */
  it("goes stale when only the window has changed", () => {
    expect(isImpactStale(11000, 11000, 7, 30)).toBe(true);
    expect(isImpactStale(11000, 11000, 30, 30)).toBe(false);
  });
});

describe("impactStaleReason", () => {
  const computed = { amount: 11000, periodDays: 30 };

  it("says nothing while the card still describes the screen", () => {
    expect(impactStaleReason(computed, { amount: 11000, periodDays: 30 })).toBeNull();
  });

  it("has nothing to report before anything is checked", () => {
    expect(impactStaleReason({ amount: null, periodDays: null }, { amount: 500, periodDays: 7 })).toBeNull();
  });

  /*
   * WHY THE REASON IS SEPARATE FROM THE FACT. "Amount changed — check again"
   * over a card that went stale because the owner switched from Month to Week
   * is a false statement about their own screen, and this banner is the one
   * place the screen explains itself.
   */
  it("names which half moved", () => {
    expect(impactStaleReason(computed, { amount: 200, periodDays: 30 })).toBe("amount");
    expect(impactStaleReason(computed, { amount: 11000, periodDays: 7 })).toBe("period");
    expect(impactStaleReason(computed, { amount: 200, periodDays: 7 })).toBe("both");
  });

  it("has copy for every reason it can return", () => {
    for (const reason of ["amount", "period", "both"] as const) {
      expect(IMPACT_STALE_COPY[reason]).toMatch(/check again$/);
    }
  });
});

describe("quick amounts", () => {
  it("offers web's presets, so the same three scenarios are one tap away on both", () => {
    expect([...QUICK_AMOUNTS]).toEqual([5000, 10000, 25000]);
  });

  /*
   * The field holds a string, the presets are numbers. This conversion is the
   * one place a preset could arrive carrying a currency symbol or a thousands
   * separator and then fail `parseAmount` on the very next render — so it is
   * driven back through the parser rather than eyeballed.
   */
  it("produces a value the amount parser and validator both accept", () => {
    for (const preset of QUICK_AMOUNTS) {
      const raw = quickAmountValue(preset);
      expect(parseAmount(raw)).toBe(preset);
      expect(amountValidationError(raw)).toBeNull();
    }
  });

  it("reads as selected only while the field still holds that preset", () => {
    expect(isQuickAmountSelected(5000, "5000")).toBe(true);
    // The commas people actually type must not un-select the chip they tapped.
    expect(isQuickAmountSelected(5000, "5,000")).toBe(true);
    expect(isQuickAmountSelected(5000, "5001")).toBe(false);
    expect(isQuickAmountSelected(5000, "")).toBe(false);
    expect(isQuickAmountSelected(5000, "fridge")).toBe(false);
  });
});

describe("scenario reset", () => {
  it("clears the amount, the item and the category", () => {
    const fresh = resetScenario(7);
    expect(fresh.amount).toBe("");
    expect(fresh.itemDescription).toBe("");
    expect(fresh.categoryId).toBeNull();
  });

  /*
   * The period is a way of LOOKING rather than part of the scenario: an owner
   * comparing against this week is still comparing against this week when
   * they price up the next purchase, and resetting it would make them
   * re-choose it every time. Web leaves its period select alone too.
   */
  it("keeps the comparison window", () => {
    expect(resetScenario(1).periodDays).toBe(1);
    expect(resetScenario(30).periodDays).toBe(30);
  });
});

describe("category suggestion", () => {
  it("waits for the same three characters the review does", () => {
    expect(canSuggestCategory("")).toBe(false);
    expect(canSuggestCategory("tv")).toBe(false);
    expect(canSuggestCategory("  tv ")).toBe(false);
    expect(canSuggestCategory("fan")).toBe(true);
  });

  it("is never stale before a suggestion has been made", () => {
    expect(isCategorySuggestionStale(null, "display fridge")).toBe(false);
  });

  it("stops calling itself a suggestion once the item is something else", () => {
    expect(isCategorySuggestionStale("display fridge", "display fridge")).toBe(false);
    expect(isCategorySuggestionStale("display fridge", "  display fridge  ")).toBe(false);
    expect(isCategorySuggestionStale("display fridge", "chest freezer")).toBe(true);
  });
});

describe("isReviewStale with a reference category", () => {
  const reviewed = { item: "display fridge", amount: 11000, categoryId: 4 };

  it("goes stale when the reference category changes", () => {
    // The category chooses which of the owner's own records the price context
    // is counted from, so changing it changes the "Is this normal for you?"
    // badge — a card that kept the old badge would be describing a different
    // slice of history than the picker says it is.
    expect(isReviewStale(reviewed, { item: "display fridge", amount: 11000, categoryId: 4 })).toBe(false);
    expect(isReviewStale(reviewed, { item: "display fridge", amount: 11000, categoryId: 9 })).toBe(true);
    expect(isReviewStale(reviewed, { item: "display fridge", amount: 11000, categoryId: null })).toBe(true);
  });

  it("treats an absent category and no category as the same thing", () => {
    // A call site that does not track a category at all must not read as
    // "changed from undefined to null" on every render.
    expect(isReviewStale({ item: "fan", amount: null }, { item: "fan", amount: null, categoryId: null })).toBe(false);
    expect(isReviewStale({ item: "fan", amount: null, categoryId: null }, { item: "fan", amount: null })).toBe(false);
  });
});

describe("percentOfFundsText", () => {
  it("writes the ordinary case to one decimal, as web does", () => {
    expect(percentOfFundsText(84)).toBe("84.0%");
    expect(percentOfFundsText(12.34)).toBe("12.3%");
  });

  /*
   * The server sends 999999 for "the funds are zero, so any purchase is
   * infinitely large a share of them". Printed literally that is
   * "999999.0% of your available funds", which is not a fact about anybody's
   * business.
   */
  it("refuses to print the sentinel as a percentage", () => {
    expect(percentOfFundsText(999999)).toBe("more than 100%");
    expect(percentOfFundsText(1_000_000)).toBe("more than 100%");
  });
});

describe("impact gauge", () => {
  it("keeps the marker inside the track and off both ends of the scale", () => {
    const g = gaugeGeometry(20, 30);
    expect(g.markerPercent).toBeGreaterThan(0);
    expect(g.markerPercent).toBeLessThan(100);
    // Zones in order: low ends where noticeable begins, which ends at the
    // owner's own threshold. Out of order, the bar would be drawn inside out.
    expect(g.noticeablePercent).toBeLessThan(g.thresholdPercent);
  });

  it("puts the threshold at the same point on the scale regardless of scenario", () => {
    // 1 / 1.35 of the width, because the ceiling is 35% past the threshold.
    expect(gaugeGeometry(10, 30).thresholdPercent).toBeCloseTo(100 / 1.35, 5);
    expect(gaugeGeometry(10, 80).thresholdPercent).toBeCloseTo(100 / 1.35, 5);
  });

  it("stretches the scale rather than pinning the marker when the scenario is huge", () => {
    // Without the moving ceiling, everything past the threshold would sit at
    // 100% and the marker would stop responding exactly where it matters most.
    const big = gaugeGeometry(400, 30);
    expect(big.displayCeiling).toBe(400);
    expect(big.markerPercent).toBe(100);
    expect(big.thresholdPercent).toBeLessThan(10);
  });

  it("survives a zero threshold and a zero scenario without dividing by zero", () => {
    const zero = gaugeGeometry(0, 0);
    expect(Number.isFinite(zero.markerPercent)).toBe(true);
    expect(zero.displayCeiling).toBe(1);
    expect(zero.markerPercent).toBe(0);
  });

  /*
   * SEVERITY MUST NEVER BE COLOUR ALONE (plan §2). A meter announced as "62"
   * is a number with no unit and no verdict; this is the whole statement, and
   * it is the only one a listening owner gets.
   */
  it("announces the share, what it is a share of, and the band in words", () => {
    expect(gaugeAccessibilityText({ percentOfFunds: 84, impactBand: "High Impact" })).toBe(
      "84.0% of your available funds — high impact.",
    );
    expect(gaugeAccessibilityText({ percentOfFunds: 2, impactBand: "Low Impact" })).toBe(
      "2.0% of your available funds — low impact.",
    );
    expect(gaugeAccessibilityText({ percentOfFunds: 999999, impactBand: "High Impact" })).toBe(
      "more than 100% of your available funds — high impact.",
    );
  });

  it("has a tone and a spoken label for every band the server can send", () => {
    for (const band of ["Low Impact", "Noticeable Impact", "High Impact"] as const) {
      expect(BAND_TONE[band]).toBeTruthy();
      expect(BAND_SENTENCE[band]).toBeTruthy();
    }
    expect(BAND_TONE["High Impact"]).toBe("critical");
    expect(BAND_TONE["Low Impact"]).toBe("good");
  });
});

describe("thin period evidence", () => {
  it("calls an empty window empty", () => {
    expect(periodEvidence(0, 50000)).toBe("none");
    expect(periodEvidence(-1, 50000)).toBe("none");
  });

  /*
   * Relative to the owner's own funds rather than an absolute peso figure:
   * ₱200 of recorded expenses is a normal quiet day for a sari-sari store and
   * an obviously empty window for a business holding half a million.
   */
  it("calls a nearly-empty window thin, in proportion to the business", () => {
    expect(periodEvidence(200, 500_000)).toBe("thin");
    expect(periodEvidence(200, 5_000)).toBe("normal");
  });

  it("says nothing when the window has real history in it", () => {
    expect(periodEvidence(12_000, 50_000)).toBe("normal");
    expect(periodEvidenceNote("normal", 30)).toBeNull();
  });

  /*
   * The note has to name which figures are affected AND which are not.
   * "There is not much data" on its own leaves an owner with no way to know
   * which of the numbers in front of them to stop trusting — and the headline
   * comes from the business profile, not from the window.
   */
  it("explains what is missing, names the window, and protects the funds half", () => {
    const none = periodEvidenceNote("none", 1)!;
    expect(none).toContain("today's records");
    expect(none).toContain("No expenses are recorded");
    expect(none).toContain("available funds");

    const thin = periodEvidenceNote("thin", 7)!;
    expect(thin).toContain("this week's records");
    expect(thin).toContain("almost no history");
    expect(thin).toContain("available funds");
  });
});

describe("the prepared Ask FinSight question", () => {
  const scenario = { amount: 11000, item: "display fridge", periodDays: 30, band: "High Impact" as const };

  it("carries the amount, the item, the band and the window", () => {
    const question = scenarioQuestion(scenario);
    expect(question).toContain("PHP 11,000");
    expect(question).toContain("display fridge");
    expect(question).toContain("high impact");
    expect(question).toContain("this month's records");
    expect(question.endsWith("?")).toBe(true);
  });

  it("still asks a whole question when there is no item", () => {
    const question = scenarioQuestion({ ...scenario, item: "   " });
    expect(question).toContain("PHP 11,000");
    expect(question).not.toContain("  on ");
    expect(question.endsWith("?")).toBe(true);
  });

  /*
   * Capped at the composer's own 500, by dropping the item first. A truncated
   * question is one the owner did not write, and the field's maxLength would
   * cut it silently mid-word.
   */
  it("never hands the composer more than it will accept", () => {
    // The longest item the field itself allows still fits, so the everyday
    // case keeps the item — the drop only happens past what can be typed.
    const atFieldLimit = scenarioQuestion({ ...scenario, item: "a".repeat(MAX_ITEM_LENGTH) });
    expect(atFieldLimit.length).toBeLessThanOrEqual(FIELD_LIMITS.aiQuestion);
    expect(atFieldLimit).toContain("aaaa");

    // Past it — a paste that outran the field, or a longer band and window in
    // some future wording — the item is what goes, and what is left is still
    // a whole question rather than a sentence cut mid-word.
    const beyond = scenarioQuestion({ ...scenario, item: "a".repeat(FIELD_LIMITS.aiQuestion) });
    expect(beyond.length).toBeLessThanOrEqual(FIELD_LIMITS.aiQuestion);
    expect(beyond).not.toContain("aaaa");
    expect(beyond).toContain("PHP 11,000");
    expect(beyond.endsWith("?")).toBe(true);
  });
});
