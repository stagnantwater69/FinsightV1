import { describe, expect, it } from "vitest";
import { behavioralSignals } from "../../src/services/anomalyDetection/behavioralNovelty.service";

const record = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, categoryId: 1, vendor: "Regular Supplier", description: "Weekly stock", amount: 1_000,
  date: new Date(Date.UTC(2026, 6, 1 + id * 7)), ...overrides,
});

describe("behavioral novelty signals", () => {
  const history = Array.from({ length: 20 }, (_, index) => record(index + 1));

  it("requires enough history", () => {
    expect(behavioralSignals(record(100), history.slice(0, 19))).toBeNull();
  });

  it("scores a new vendor, new category, description, and amount as novel", () => {
    const result = behavioralSignals(record(100, {
      categoryId: 99, vendor: "Never Seen Vendor", description: "Emergency machinery", amount: 10_000,
    }), history)!;
    expect(result.score).toBeGreaterThan(0.65);
    expect(result.vendor).toBe(1);
    expect(result.category).toBe(1);
  });

  it("does not score normal behavior as unusual", () => {
    expect(behavioralSignals(record(100), history)!.score).toBeLessThan(0.65);
  });
});
