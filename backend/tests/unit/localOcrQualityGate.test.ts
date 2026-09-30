import { describe, expect, it } from "vitest";
import {
  buildLocalQualityReport,
  classifyProvenance,
  entriesForScope,
  evaluateGate,
  localCorpusEntrySchema,
  localQualityThresholdsSchema,
  opaqueSampleId,
  summarizeObservations,
  type LocalSampleObservation,
} from "../receipt-scanner-evaluation/local-quality-gate";

const entry = (overrides: Record<string, unknown> = {}) => localCorpusEntrySchema.parse({
  id: "syn-01",
  file: "syn-01.png",
  kind: "synthetic",
  conditions: "generated fixture",
  expected: { date: "2026-01-02", vendor: "Example Store", amount: 12.5, items: [] },
  ...overrides,
});

const observation = (overrides: Partial<LocalSampleObservation> = {}): LocalSampleObservation => ({
  id: "sample-1",
  provenance: "SYNTHETIC_GENERATED",
  outcome: "SUCCESS",
  latencyMs: 100,
  fields: { vendor: "correct", date: "correct", total: "correct", items: "correct" },
  itemScore: { expected: 1, matched: 1, nameCorrect: 1, quantityCorrect: 1, quantityScored: 1, falsePositives: 0 },
  failureKind: null,
  ...overrides,
});

const publicProvenance = {
  label: "PUBLIC_LICENSED_REAL_SINGLE_REVIEW",
  sourceAttributionRecorded: true,
  licenseAttributionRecorded: true,
  groundTruthReviewerCount: 1,
} as const;

const unknownProvenance = {
  label: "EXISTING_REAL_UNKNOWN_CONSENT",
  consentRecorded: false,
  sourceAttributionRecorded: false,
} as const;

const thresholds = localQualityThresholdsSchema.parse({
  schemaVersion: "finsight-local-ocr-thresholds-v1",
  profile: {
    includedProvenance: ["SYNTHETIC_GENERATED", "SYNTHETIC_DERIVED"],
    minimumSamples: 2,
    maximumFailureRate: 0,
    minimumAccuracy: { vendor: 1, date: 1, total: 1, items: 1 },
    maximumItemFalsePositiveRate: 0,
    maximumLatencyMs: { p50: 150, p95: 250 },
  },
});

describe("local OCR quality gate", () => {
  it("keeps synthetic, public real, unknown-consent real, and eligible anonymized receipts distinct", () => {
    expect(classifyProvenance(entry())).toBe("SYNTHETIC_GENERATED");
    expect(classifyProvenance(entry({ id: "deg-01", kind: "degraded", derived_from: "syn-01" }))).toBe("SYNTHETIC_DERIVED");
    expect(classifyProvenance(entry({ id: "meaningful-public-name", kind: "real", provenance: publicProvenance }))).toBe("PUBLIC_LICENSED_REAL_SINGLE_REVIEW");
    expect(classifyProvenance(entry({ id: "real-99-misleading-name", kind: "real", provenance: unknownProvenance }))).toBe("EXISTING_REAL_UNKNOWN_CONSENT");
    expect(classifyProvenance(entry({
      id: "receipt-opaque-001",
      kind: "real",
      provenance: {
        label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
        consentRecorded: true,
        anonymizationReviewed: true,
        groundTruthReviewerCount: 2,
      },
    }))).toBe("ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED");
  });

  it("rejects an anonymized-real claim without the required evidence metadata", () => {
    expect(() => entry({
      id: "receipt-opaque-001",
      kind: "real",
      provenance: {
        label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
        consentRecorded: true,
        anonymizationReviewed: false,
        groundTruthReviewerCount: 1,
      },
    })).toThrow();
  });

  it("rejects real fixtures without explicit provenance evidence", () => {
    expect(() => entry({ id: "real-04-public", kind: "real" })).toThrow(/explicit provenance/);
  });

  it("rejects corpus paths that escape the configured image directory", () => {
    expect(() => entry({ file: "../private-receipt.jpg" })).toThrow(/inside the image root/);
    expect(() => entry({ file: "/tmp/private-receipt.jpg" })).toThrow(/inside the image root/);
  });

  it("computes exact field accuracy, item rates, success rate, and nearest-rank latency", () => {
    const metrics = summarizeObservations([
      observation(),
      observation({
        id: "sample-2",
        latencyMs: 220,
        fields: { vendor: "wrong", date: "correct", total: "missed", items: "wrong" },
        itemScore: { expected: 2, matched: 1, nameCorrect: 1, quantityCorrect: 0, quantityScored: 0, falsePositives: 1 },
      }),
      observation({
        id: "sample-3",
        outcome: "FAILED",
        latencyMs: 180,
        fields: { vendor: "missed", date: "missed", total: "missed", items: "wrong" },
        itemScore: { expected: 1, matched: 0, nameCorrect: 0, quantityCorrect: 0, quantityScored: 0, falsePositives: 0 },
        failureKind: "Error",
      }),
    ]);

    expect(metrics.successRate).toBeCloseTo(2 / 3);
    expect(metrics.failureRate).toBeCloseTo(1 / 3);
    expect(metrics.accuracy.vendor.value).toBeCloseTo(1 / 3);
    expect(metrics.accuracy.date.value).toBeCloseTo(2 / 3);
    expect(metrics.accuracy.total.value).toBeCloseTo(1 / 3);
    expect(metrics.accuracy.items.value).toBeCloseTo(1 / 3);
    expect(metrics.itemLineRecall).toBeCloseTo(0.5);
    expect(metrics.itemLinePrecision).toBeCloseTo(2 / 3);
    expect(metrics.itemFalsePositiveRate).toBeCloseTo(1 / 3);
    expect(metrics.latencyMs).toEqual({ p50: 180, p95: 220 });
  });

  it("fails closed when a budget is not measured or a threshold is missed", () => {
    const result = evaluateGate([
      observation(),
      observation({ id: "sample-2", latencyMs: 260 }),
    ], thresholds.profile);
    expect(result.status).toBe("FAIL");
    expect(result.checks.find((check) => check.id === "latency_p95_ms")?.status).toBe("FAIL");

    const empty = evaluateGate([], thresholds.profile);
    expect(empty.status).toBe("FAIL");
    expect(empty.checks.some((check) => check.status === "NOT_MEASURED")).toBe(true);
  });

  it("does not let public or unknown-consent real fixtures satisfy anonymized-real scope", () => {
    const allEntries = [
      entry(),
      entry({ id: "real-01-local", kind: "real", provenance: unknownProvenance }),
      entry({ id: "real-04-public", kind: "real", provenance: publicProvenance }),
    ];
    expect(entriesForScope(allEntries, "anonymized-real")).toEqual([]);

    const report = buildLocalQualityReport({
      allEntries,
      attemptedEntries: [allEntries[0]!],
      observations: [observation()],
      thresholds,
      requestedScope: "synthetic",
      generatedAtUtc: "2026-09-29T00:00:00.000Z",
    });
    expect(report.corpus.anonymizedRealEvidence).toBe("NOT_AVAILABLE");
    expect(report.corpus.productionAccuracyClaimSupported).toBe(false);
    expect(report.engine.externalProviderCalls).toBe(false);
  });

  it("reports scope-specific discovery and hashes sample identifiers", () => {
    const synthetic = entry();
    const publicEntry = entry({ id: "merchant-and-customer-name", kind: "real", provenance: publicProvenance });
    const report = buildLocalQualityReport({
      allEntries: [synthetic, publicEntry],
      attemptedEntries: [synthetic],
      observations: [observation({ id: synthetic.id })],
      thresholds,
      requestedScope: "synthetic",
      generatedAtUtc: "2026-09-29T00:00:00.000Z",
    });

    expect(report.corpus.discoveredSamples).toBe(1);
    expect(report.corpus.totalReviewedManifestSamples).toBe(2);
    expect(report.corpus.provenanceCounts.PUBLIC_LICENSED_REAL_SINGLE_REVIEW).toBe(0);
    expect(report.samples[0]?.id).toBe(opaqueSampleId(synthetic.id));
    expect(JSON.stringify(report)).not.toContain(synthetic.id);
    expect(JSON.stringify(report)).not.toContain(publicEntry.id);
  });

  it("marks anonymized evidence available only when it was attempted in scope", () => {
    const anonymized = entry({
      id: "receipt-opaque-001",
      kind: "real",
      provenance: {
        label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
        consentRecorded: true,
        anonymizationReviewed: true,
        groundTruthReviewerCount: 2,
      },
    });
    const synthetic = entry();
    const outOfScope = buildLocalQualityReport({
      allEntries: [synthetic, anonymized],
      attemptedEntries: [synthetic],
      observations: [observation({ id: synthetic.id })],
      thresholds,
      requestedScope: "synthetic",
    });
    expect(outOfScope.corpus.anonymizedRealEvidence).toBe("NOT_AVAILABLE");

    const attempted = buildLocalQualityReport({
      allEntries: [anonymized],
      attemptedEntries: [anonymized],
      observations: [observation({ id: anonymized.id, provenance: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED" })],
      thresholds,
      requestedScope: "anonymized-real",
    });
    expect(attempted.corpus.anonymizedRealEvidence).toBe("AVAILABLE");
  });
});
