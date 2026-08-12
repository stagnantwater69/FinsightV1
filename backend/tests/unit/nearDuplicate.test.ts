import { describe, expect, it } from "vitest";
import {
  normalizeComparisonText,
  scoreNearDuplicate,
  textSimilarity,
} from "../../src/services/anomalyDetection/nearDuplicate.service";

function record(overrides: Partial<Parameters<typeof scoreNearDuplicate>[0]> = {}) {
  return {
    id: 1,
    businessProfileId: 1,
    categoryId: 10,
    date: new Date("2026-08-01T00:00:00.000Z"),
    amount: 5_000,
    description: "Bulk rice delivery",
    vendor: "Pure Gold Market",
    ...overrides,
  };
}

describe("near-duplicate text normalization", () => {
  it("normalizes case, accents, punctuation, and whitespace", () => {
    expect(normalizeComparisonText("  CAFÉ  &  Market, Inc. ")).toBe("cafe and market inc");
  });

  it("does not treat two missing vendors as a positive match", () => {
    expect(textSimilarity(null, null)).toBe(0);
  });

  it("recognizes compact spelling variations", () => {
    expect(textSimilarity("Pure Gold", "PureGold")).toBe(1);
  });
});

describe("near-duplicate scoring", () => {
  it("scores an explainably similar transaction above the review threshold", () => {
    const result = scoreNearDuplicate(
      record(),
      record({
        id: 2,
        date: new Date("2026-08-02T00:00:00.000Z"),
        amount: 5_050,
        description: "Bulk rice purchase",
        vendor: "PureGold Market",
      }),
    );

    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.amountSimilarity).toBeGreaterThan(0.98);
    expect(result.vendorSimilarity).toBeGreaterThan(0.9);
    expect(result.dateDistanceDays).toBe(1);
  });

  it("does not over-score a matching amount with unrelated context", () => {
    const result = scoreNearDuplicate(
      record(),
      record({
        id: 2,
        categoryId: 99,
        date: new Date("2026-08-08T00:00:00.000Z"),
        description: "Electricity bill",
        vendor: "Power Company",
      }),
    );

    expect(result.score).toBeLessThan(0.75);
  });
});
