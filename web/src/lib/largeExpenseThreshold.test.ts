import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD_PERCENT,
  thresholdPercentToPesos,
  thresholdPesosToPercent,
} from "./largeExpenseThreshold";
import {
  EMPTY_DRAFT,
  applyFieldUpdate,
  draftFromProfile,
  matchBusinessType,
  thresholdDisplayValue,
  toBusinessProfileInput,
} from "./businessProfileDraft";

/**
 * The threshold is the one figure the owner sees in different units from the
 * ones it is stored in, so these tests pin the seam. A conversion that drifts
 * would change which expenses get flagged for review — silently, and only for
 * businesses whose numbers happen to expose the error.
 */
describe("threshold conversion", () => {
  it("turns a percent into the peso amount it represents", () => {
    expect(thresholdPercentToPesos(500_000, 20)).toBe(100_000);
    expect(thresholdPercentToPesos(60_000, 25)).toBe(15_000);
  });

  it("round-trips a typed amount back to a percent", () => {
    expect(thresholdPesosToPercent(500_000, 100_000)).toBe(20);
    expect(thresholdPercentToPesos(500_000, thresholdPesosToPercent(500_000, 75_000))).toBe(75_000);
  });

  /*
   * The case that would otherwise reach the API as a rejected `0` or `NaN`:
   * a percentage of nothing is undefined, and an owner who has not filled in
   * their monthly expenses must not be blocked by a field they never saw.
   */
  it("falls back to the default when no percentage can be derived", () => {
    expect(thresholdPesosToPercent(0, 5_000)).toBe(DEFAULT_THRESHOLD_PERCENT);
    expect(thresholdPesosToPercent(500_000, 0)).toBe(DEFAULT_THRESHOLD_PERCENT);
    expect(thresholdPesosToPercent(Number.NaN, 5_000)).toBe(DEFAULT_THRESHOLD_PERCENT);
  });

  /** The API's ceiling is 999.99; a strange choice must not become a failed save. */
  it("clamps rather than rejecting an out-of-range amount", () => {
    expect(thresholdPesosToPercent(1_000, 1_000_000)).toBe(999.99);
  });
});

describe("threshold in the setup draft", () => {
  it("tracks expected monthly expenses while untouched", () => {
    const draft = { ...EMPTY_DRAFT, expectedMonthlyExpenses: "500000" };
    expect(thresholdDisplayValue(draft)).toBe("100000");
  });

  it("stops tracking once the owner types their own amount", () => {
    const draft = applyFieldUpdate(
      { ...EMPTY_DRAFT, expectedMonthlyExpenses: "500000" },
      "largeExpenseThresholdPesos",
      "250000",
    );
    expect(thresholdDisplayValue(draft)).toBe("250000");
    expect(toBusinessProfileInput(draft).largeExpenseThresholdPercent).toBe(50);
  });

  /*
   * The regression this flag exists for: with an empty box meaning "untouched",
   * clearing the field re-showed the suggestion under the cursor and the amount
   * could not be deleted to retype it.
   */
  it("stays empty when the owner clears it, rather than snapping back", () => {
    const cleared = applyFieldUpdate(
      { ...EMPTY_DRAFT, expectedMonthlyExpenses: "500000" },
      "largeExpenseThresholdPesos",
      "",
    );
    expect(thresholdDisplayValue(cleared)).toBe("");
    // Still saves as the default — cleared means "use the suggestion", not "no threshold".
    expect(toBusinessProfileInput(cleared).largeExpenseThresholdPercent).toBe(DEFAULT_THRESHOLD_PERCENT);
  });

  it("sends the default percent when the box was never filled in", () => {
    const draft = { ...EMPTY_DRAFT, expectedMonthlyExpenses: "500000" };
    expect(toBusinessProfileInput(draft).largeExpenseThresholdPercent).toBe(DEFAULT_THRESHOLD_PERCENT);
  });

  /*
   * A saved profile carries a chosen threshold, so editing the monthly expenses
   * must not quietly rewrite it back to the default share.
   */
  it("does not re-track an existing profile's threshold when expenses are edited", () => {
    const reopened = draftFromProfile({
      name: "Aling Nena",
      type: "Sari-sari store",
      availableFunds: 50_000,
      expectedMonthlyExpenses: 500_000,
      operatingDays: 26,
      largeExpenseThresholdPercent: 40,
    });
    expect(thresholdDisplayValue(reopened)).toBe("200000");

    const edited = { ...reopened, expectedMonthlyExpenses: "900000" };
    expect(thresholdDisplayValue(edited)).toBe("200000");
  });
});

/**
 * The business-type picker has to recognise what is already stored.
 *
 * Every profile created before the picker existed holds free text, so exact
 * matching pushed perfectly ordinary types into "Other…": a real profile typed
 * as "Food Business" met a list containing "Food business" and was told its
 * type was something FinSight had no word for.
 */
describe("business type matching", () => {
  it("recognises a listed type regardless of casing or padding", () => {
    expect(matchBusinessType("Food Business")).toBe("Food business");
    expect(matchBusinessType("  SARI-SARI STORE ")).toBe("Sari-sari store");
    expect(matchBusinessType("services")).toBe("Services");
  });

  it("leaves a genuinely custom type as custom", () => {
    expect(matchBusinessType("Tire shop")).toBeNull();
    expect(matchBusinessType("")).toBeNull();
  });

  /** Reopening a profile must not rewrite what is stored — only how it is shown. */
  it("does not alter the stored value", () => {
    const draft = draftFromProfile({
      name: "Curriculogic",
      type: "Food Business",
      availableFunds: 100_000,
      expectedMonthlyExpenses: 500_000,
      operatingDays: 26,
      largeExpenseThresholdPercent: 20,
    });
    expect(draft.type).toBe("Food Business");
    expect(toBusinessProfileInput(draft).type).toBe("Food Business");
  });
});
