import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalQualityReport, localCorpusEntrySchema, localQualityThresholdsSchema, type LocalSampleObservation } from "./local-quality-gate";
import { runLocalQualityGate } from "./run-local-quality-gate";
import { COHORT_TAGS } from "./policy-v1-contract";

const extraction = vi.hoisted(() => ({ extractText: vi.fn(async (): Promise<string> => { throw new Error("Controlled extraction failure"); }) }));
vi.mock("../../src/services/ocr.service", () => ({
  extractText: extraction.extractText, shutdownOcr: vi.fn(), parseReceiptFields: vi.fn(), parseLineItems: vi.fn(),
}));
const temporaryDirectories: string[] = [];
function privateFixture() {
  const root = mkdtempSync(join(tmpdir(), "finsight-capture-contract-"));
  temporaryDirectories.push(root);
  const bytes = Buffer.from("Generated test bytes, not a receipt photograph");
  writeFileSync(join(root, "contract.png"), bytes);
  const entry = {
    id: "generated_contract_sample", file: "contract.png", kind: "real", conditions: "Synthetic metadata contract only",
    provenance: { label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED", consentRecorded: true, anonymizationReviewed: true, groundTruthReviewerCount: 2 },
    developmentCohort: {
      receiptGroupId: "contract_receipt", vendorTemplateId: "contract_template", sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      partition: "HOLDOUT", reviewerIds: ["reviewer_one", "reviewer_two"], cohortTags: [...COHORT_TAGS], languageTags: ["MIXED"],
      captureConditions: { jurisdiction: "PH", lighting: "LOW_LIGHT", perspective: "SKEWED", pageCount: 2, handwriting: "HANDWRITTEN_OR_ANNOTATED", printQuality: "FADED_OR_STRESSED" },
    },
    expected: { vendor: "Test", date: "2026-10-13", amount: 100, items: [{ name: "Test item", quantity: 1, amount: 100 }] },
  };
  const manifest = join(root, "manifest.json");
  const thresholds = join(root, "thresholds.json");
  const output = join(root, "output.json");
  writeFileSync(manifest, JSON.stringify([entry]));
  writeFileSync(thresholds, JSON.stringify({
    schemaVersion: "finsight-local-ocr-thresholds-v1",
    profile: { includedProvenance: [entry.provenance.label], minimumSamples: 1, maximumFailureRate: 0,
      minimumAccuracy: { vendor: 1, date: 1, total: 1, items: 1 }, maximumItemFalsePositiveRate: 0, maximumLatencyMs: { p50: 1000, p95: 1000 } },
  }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { root, manifest, thresholds, output };
}
afterEach(() => {
  vi.restoreAllMocks();
  extraction.extractText.mockClear();
  for (const path of temporaryDirectories.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("finsight-capture-contract-")) throw new Error("Unsafe test cleanup target");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("capture-condition extraction metrics", () => {
  it("retains failed eligible observations in the condition failure and field denominators", () => {
    const entry = localCorpusEntrySchema.parse({
      id: "generated_contract_sample", file: "contract.png", kind: "real", conditions: "Synthetic metadata fixture only",
      provenance: { label: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED", consentRecorded: true, anonymizationReviewed: true, groundTruthReviewerCount: 2 },
      developmentCohort: {
        receiptGroupId: "contract_receipt", vendorTemplateId: "contract_template", sourceSha256: "a".repeat(64), partition: "HOLDOUT",
        reviewerIds: ["reviewer_one", "reviewer_two"], cohortTags: ["DAMAGED_OR_LOW_LIGHT"], languageTags: ["MIXED"],
        captureConditions: { jurisdiction: "PH", lighting: "LOW_LIGHT", perspective: "SKEWED", pageCount: 2, handwriting: "PRINTED", printQuality: "CLEAR" },
      },
      expected: { vendor: "Test", date: "2026-10-13", amount: 100, items: [] },
    });
    const observation: LocalSampleObservation = {
      id: entry.id, provenance: "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED", outcome: "FAILED", latencyMs: 500,
      fields: { vendor: "wrong", date: "wrong", total: "wrong", items: "wrong" }, itemScore: null, failureKind: "OCR_ERROR",
    };
    const thresholds = localQualityThresholdsSchema.parse({
      schemaVersion: "finsight-local-ocr-thresholds-v1",
      profile: { includedProvenance: [observation.provenance], minimumSamples: 1, maximumFailureRate: 0,
        minimumAccuracy: { vendor: 1, date: 1, total: 1, items: 1 }, maximumItemFalsePositiveRate: 0, maximumLatencyMs: { p50: 1000, p95: 1000 } },
    });
    const report = buildLocalQualityReport({ allEntries: [entry], attemptedEntries: [entry], observations: [observation], thresholds, requestedScope: "anonymized-real" });
    for (const condition of ["LOW_LIGHT", "SKEWED_PERSPECTIVE", "MULTI_PAGE"] as const) {
      expect(report.metricsByCaptureCondition[condition]).toMatchObject({ samples: 1, failures: 1, failureRate: 1 });
      expect(report.metricsByCaptureCondition[condition]!.accuracy.total).toEqual({ correct: 0, denominator: 1, value: 0 });
    }
    expect(report.metricsByCaptureCondition.HANDWRITTEN_OR_ANNOTATED).toBeUndefined();
    expect(report.gate.status).toBe("FAIL");
  });

  it("scores a future explicit PH holdout failure and reports condition denominators", async () => {
    const fixture = privateFixture();
    expect(await runLocalQualityGate(["--representative-ph-holdout", "--manifest", fixture.manifest, "--images", fixture.root, "--thresholds", fixture.thresholds, "--output", fixture.output])).toBe(1);
    expect(extraction.extractText).toHaveBeenCalledTimes(1);
    const report = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(report.representativeReadiness.counts.eligibleSamples).toBe(1);
    expect(report.metrics).toMatchObject({ samples: 1, failures: 1, failureRate: 1, itemLineRecall: 0 });
    expect(report.metricsByCaptureCondition.LOW_LIGHT).toMatchObject({ failures: 1, failureRate: 1 });
    expect(report.metricsByCaptureCondition.MULTI_PAGE.accuracy.total.denominator).toBe(1);
    expect(report.gate.status).toBe("FAIL");
  });

  it("writes blocked representative results with no extractor call when the frame is empty", async () => {
    const fixture = privateFixture();
    writeFileSync(fixture.manifest, "[]");
    expect(await runLocalQualityGate(["--representative-ph-holdout", "--manifest", fixture.manifest, "--images", fixture.root, "--output", fixture.output])).toBe(3);
    expect(extraction.extractText).not.toHaveBeenCalled();
    const report = JSON.parse(readFileSync(fixture.output, "utf8"));
    expect(report.representativeReadiness.status).toBe("BLOCKED_NO_ELIGIBLE_SAMPLES");
    expect(report.metrics.failureRate).toBeNull();
    expect(report.metrics.accuracy.total.value).toBeNull();
  });

  it("rejects the synthetic default budget before scoring a representative holdout", async () => {
    const fixture = privateFixture();
    expect(await runLocalQualityGate(["--representative-ph-holdout", "--manifest", fixture.manifest, "--images", fixture.root, "--output", fixture.output])).toBe(2);
    expect(extraction.extractText).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("REPRESENTATIVE_THRESHOLD_PROFILE_INVALID"));
  });
});
