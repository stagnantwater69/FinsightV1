import { ExpenseRecordSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildFeatureMatrix,
  featuresFor,
  IF_FEATURE_NAMES,
  topFeatureDeviations,
  type IsolationForestRecord,
} from "../../src/services/anomalyDetection/isolationForestFeatures";

function record(overrides: Partial<IsolationForestRecord> = {}): IsolationForestRecord {
  return {
    id: 1,
    categoryId: 10,
    vendor: "San Miguel",
    description: "beverage restock",
    amount: 1_000,
    date: new Date("2026-06-10T00:00:00Z"),
    source: ExpenseRecordSource.MANUAL_ENTRY,
    ...overrides,
  };
}

/** Steady weekly history: same vendor, same category, similar amounts. */
function steadyHistory(count: number): IsolationForestRecord[] {
  return Array.from({ length: count }, (_, index) =>
    record({
      id: 100 + index,
      amount: 1_000 + (index % 5) * 10,
      date: new Date(Date.UTC(2026, 0, 5 + index * 7)),
    }),
  );
}

describe("isolation forest feature contract (if-features-v1)", () => {
  it("produces one value per declared feature name, all finite", () => {
    const features = featuresFor(record(), steadyHistory(30));
    expect(features).toHaveLength(IF_FEATURE_NAMES.length);
    for (const value of features) expect(Number.isFinite(value)).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const history = steadyHistory(30);
    expect(featuresFor(record(), history)).toEqual(featuresFor(record(), history));
  });

  it("caps ratio features so one wild amount cannot dominate", () => {
    const features = featuresFor(record({ amount: 10_000_000 }), steadyHistory(30));
    const at = (name: (typeof IF_FEATURE_NAMES)[number]) => features[IF_FEATURE_NAMES.indexOf(name)]!;
    expect(at("amountToCategoryMedian")).toBe(10);
    expect(at("amountToVendorMedian")).toBe(10);
    expect(at("categoryMadZ")).toBe(10);
  });

  it("marks a never-seen vendor as new and a known vendor as not", () => {
    const history = steadyHistory(30);
    const at = (features: number[], name: (typeof IF_FEATURE_NAMES)[number]) =>
      features[IF_FEATURE_NAMES.indexOf(name)]!;
    expect(at(featuresFor(record({ vendor: "Brand New Trading" }), history), "vendorIsNew")).toBe(1);
    expect(at(featuresFor(record(), history), "vendorIsNew")).toBe(0);
    // A missing vendor is not evidence of anything — mirrors the rule detectors.
    expect(at(featuresFor(record({ vendor: null }), history), "vendorIsNew")).toBe(0);
  });

  it("scores description novelty low for a repeated description and high for a novel one", () => {
    const history = steadyHistory(30);
    const at = (features: number[], name: (typeof IF_FEATURE_NAMES)[number]) =>
      features[IF_FEATURE_NAMES.indexOf(name)]!;
    const repeated = at(featuresFor(record({ description: "beverage restock" }), history), "descriptionNovelty");
    const novel = at(
      featuresFor(record({ description: "emergency generator fuel purchase" }), history),
      "descriptionNovelty",
    );
    expect(repeated).toBeLessThan(0.1);
    expect(novel).toBeGreaterThan(0.7);
  });

  it("one-hot encodes the record source", () => {
    const history = steadyHistory(30);
    const at = (features: number[], name: (typeof IF_FEATURE_NAMES)[number]) =>
      features[IF_FEATURE_NAMES.indexOf(name)]!;
    const csv = featuresFor(record({ source: ExpenseRecordSource.CSV_UPLOAD }), history);
    const receipt = featuresFor(record({ source: ExpenseRecordSource.RECEIPT_SCAN }), history);
    expect([at(csv, "sourceCsv"), at(csv, "sourceReceipt")]).toEqual([1, 0]);
    expect([at(receipt, "sourceCsv"), at(receipt, "sourceReceipt")]).toEqual([0, 1]);
  });

  it("builds a leave-one-out chronological matrix (a record never sees itself)", () => {
    const history = steadyHistory(3);
    const matrix = buildFeatureMatrix(history);
    expect(matrix.map((entry) => entry.id)).toEqual([100, 101, 102]);
    // The first record has no prior history: never-seen vendor, max days-since.
    const first = matrix[0]!.features;
    expect(first[IF_FEATURE_NAMES.indexOf("vendorIsNew")]).toBe(1);
    expect(first[IF_FEATURE_NAMES.indexOf("daysSinceSimilar")]).toBe(90);
    // The third has two priors: known vendor, recent similar activity.
    const third = matrix[2]!.features;
    expect(third[IF_FEATURE_NAMES.indexOf("vendorIsNew")]).toBe(0);
    expect(third[IF_FEATURE_NAMES.indexOf("daysSinceSimilar")]).toBe(7);
  });
});

describe("topFeatureDeviations", () => {
  it("explains an outlier row with owner-readable, deduplicated labels", () => {
    const records = steadyHistory(40);
    const outlier = record({
      id: 999,
      amount: 50_000,
      vendor: "Unknown Imports",
      description: "completely different purchase",
      date: new Date(Date.UTC(2026, 5, 20)),
    });
    const matrix = buildFeatureMatrix([...records, outlier]);
    const rows = matrix.map((entry) => entry.features);
    const deviations = topFeatureDeviations(matrix.at(-1)!.features, rows);
    expect(deviations.length).toBeGreaterThan(0);
    expect(deviations.length).toBeLessThanOrEqual(3);
    for (const entry of deviations) {
      expect(entry.label).toMatch(/^[A-Z]/); // sentences, not feature names
      expect(entry.deviation).toBeGreaterThanOrEqual(2);
    }
    const labels = deviations.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("returns nothing for a perfectly ordinary row", () => {
    const matrix = buildFeatureMatrix(steadyHistory(40));
    const rows = matrix.map((entry) => entry.features);
    // A mid-batch steady row deviates from nothing.
    expect(topFeatureDeviations(matrix[20]!.features, rows)).toEqual([]);
  });
});
