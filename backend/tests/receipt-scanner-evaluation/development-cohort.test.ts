import { describe, expect, it } from "vitest";
import { developmentCohortReport, developmentCohortSchema, validateDevelopmentCohort } from "./development-cohort";
import { buildLocalQualityReport, localCorpusEntrySchema, localQualityThresholdsSchema, type LocalSampleObservation } from "./local-quality-gate";
import { parseArgs } from "./run-local-quality-gate";

function entry(id: string, overrides: Partial<ReturnType<typeof developmentCohortSchema.parse>> = {}) {
  return {
    id,
    kind: "real" as const,
    provenance: { label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED" },
    developmentCohort: {
      receiptGroupId: `receipt_${id}`,
      vendorTemplateId: `vendor_${id}`,
      sourceSha256: "a".repeat(64),
      partition: "CALIBRATION" as const,
      cohortTags: ["CLEAN_PRINTED" as const],
      languageTags: ["ENGLISH" as const],
      reviewerIds: ["reviewer_one", "reviewer_two"] as [string, string],
      ...overrides,
    },
  };
}

describe("development receipt cohort", () => {
  it("reports absent real evidence without an acceptance claim", () => {
    const report = developmentCohortReport([]);
    expect(report.status).toBe("NOT_AVAILABLE");
    expect(report.acceptanceClaimSupported).toBe(false);
    expect(report.evidenceVerified).toBe(false);
    expect(report.missingCohorts.HOLDOUT).toHaveLength(6);
  });

  it("counts logical receipts rather than related captures", () => {
    const first = entry("one");
    const recapture = { ...first, id: "recapture" };
    const holdout = entry("two", { partition: "HOLDOUT", sourceSha256: "b".repeat(64), cohortTags: ["FILIPINO_OR_MIXED_LANGUAGE"] });
    const report = developmentCohortReport([first, recapture, holdout]);
    expect(report.byPartition.CALIBRATION.samples).toBe(2);
    expect(report.byPartition.CALIBRATION.uniqueReceiptGroups).toBe(1);
    expect(report.byPartition.CALIBRATION.cohortReceiptGroups.CLEAN_PRINTED).toBe(1);
    expect(report.byPartition.HOLDOUT.cohortReceiptGroups.FILIPINO_OR_MIXED_LANGUAGE).toBe(1);
    expect(JSON.stringify(report)).not.toContain("receipt_one");
    expect(JSON.stringify(report)).not.toContain("reviewer_one");
  });

  it.each(["receiptGroupId", "vendorTemplateId", "sourceSha256"] as const)("rejects shared %s across partitions", (key) => {
    const first = entry("one");
    const second = entry("two", { partition: "HOLDOUT", sourceSha256: "b".repeat(64), [key]: first.developmentCohort[key] });
    expect(() => validateDevelopmentCohort([first, second])).toThrow();
  });

  it("rejects conflicting metadata for captures of the same receipt", () => {
    const first = entry("one");
    const second = { ...first, id: "recapture", developmentCohort: { ...first.developmentCohort, cohortTags: ["LONG" as const] } };
    expect(() => validateDevelopmentCohort([first, second])).toThrow(/disagree/);
  });

  it.each(["synthetic", "degraded"] as const)("rejects %s evidence declared real", (kind) => {
    expect(() => validateDevelopmentCohort([{ ...entry("one"), kind }])).toThrow(/provenance/);
  });

  it("rejects unreviewed ground truth", () => {
    expect(() => validateDevelopmentCohort([{ ...entry("one"), needs_review: true }])).toThrow(/reviewed/);
  });

  it("rejects public single-review or unknown consent provenance", () => {
    const sample = entry("one");
    for (const label of ["PUBLIC_LICENSED_REAL_SINGLE_REVIEW", "EXISTING_REAL_UNKNOWN_CONSENT"]) {
      expect(() => validateDevelopmentCohort([{ ...sample, provenance: { label } }])).toThrow(/provenance/);
    }
  });

  it("requires two distinct reviewer identities", () => {
    expect(() => developmentCohortSchema.parse(entry("one", { reviewerIds: ["reviewer_one", "reviewer_one"] }).developmentCohort)).toThrow();
  });

  it("rejects duplicate sample identities", () => {
    expect(() => validateDevelopmentCohort([entry("one"), entry("one")])).toThrow(/sample ID/);
  });

  it("reports attempted cohort failures and never invents other partition metrics", () => {
    const sample = entry("one", { partition: "HOLDOUT" });
    const parsed = localCorpusEntrySchema.parse({
      ...sample,
      file: "opaque.png",
      conditions: "redacted real sample",
      provenance: {
        label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
        consentRecorded: true,
        anonymizationReviewed: true,
        groundTruthReviewerCount: 2,
      },
      expected: { date: "2026-10-01", vendor: "Example", amount: 100, items: [] },
    });
    const observation: LocalSampleObservation = {
      id: parsed.id,
      provenance: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
      outcome: "FAILED",
      latencyMs: 100,
      fields: { vendor: "wrong", date: "wrong", total: "wrong", items: "wrong" },
      itemScore: null,
      failureKind: "OCR_ERROR",
    };
    const thresholds = localQualityThresholdsSchema.parse({
      schemaVersion: "finsight-local-ocr-thresholds-v1",
      profile: {
        includedProvenance: [observation.provenance], minimumSamples: 1, maximumFailureRate: 0,
        minimumAccuracy: { vendor: 1, date: 1, total: 1, items: 1 },
        maximumItemFalsePositiveRate: 0, maximumLatencyMs: { p50: 1000, p95: 1000 },
      },
    });
    const report = buildLocalQualityReport({
      allEntries: [parsed], attemptedEntries: [parsed], observations: [observation], thresholds,
      requestedScope: "anonymized-real", requestedPartition: "HOLDOUT",
    });
    expect(report.corpus.requestedPartition).toBe("HOLDOUT");
    expect(report.metricsByDevelopmentPartition.HOLDOUT!.byCohort.CLEAN_PRINTED!.failures).toBe(1);
    expect(report.metricsByDevelopmentPartition.HOLDOUT!.metrics.accuracy.total.value).toBe(0);
    expect(report.metricsByDevelopmentPartition.CALIBRATION).toBeUndefined();
    expect(report.gate.status).toBe("FAIL");
    expect(report.developmentCohort.acceptanceClaimSupported).toBe(false);
  });

  it("accepts explicit partitions and rejects unknown selections", () => {
    expect(parseArgs(["--partition", "holdout"])).toMatchObject({ partition: "HOLDOUT" });
    expect(parseArgs(["--partition", "calibration"])).toMatchObject({ partition: "CALIBRATION" });
    expect(() => parseArgs(["--partition", "training"])).toThrow(/partition/);
  });
});
