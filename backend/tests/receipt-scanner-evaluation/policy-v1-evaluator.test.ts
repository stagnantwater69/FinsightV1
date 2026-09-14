import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_NAMES, INTAKE_HEADERS, MetricFamily, PAIR_HEADERS } from "./policy-v1-contract";
import { buildPolicyV1Report, writePolicyV1Report } from "./policy-v1-report";
import { bootstrapClusteredPercentile95, bootstrapRatio95, wilson95 } from "./policy-v1-statistics";
import { EvaluationInputError, EvaluationPaths, loadAndValidateInputs } from "./policy-v1-validation";
import { runPolicyV1Cli } from "./run-policy-v1-evaluation";

const REPOSITORY_ROOT = resolve(__dirname, "../../..");
const temporaryDirectories: string[] = [];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function csv(headers: readonly string[], rows: Array<Record<string, string>>): string {
  const encode = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => encode(row[header] ?? "")).join(",")).join("\n")}\n`;
}

interface FixtureOptions {
  provider?: string;
  sameReviewer?: boolean;
  extraPrimarySourceClass?: "SYNTHETIC" | "PUBLIC_LICENSED";
}

interface FixtureArtifact {
  sample_id: string;
  source_path: string;
  ground_truth_path: string;
  ground_truth_page_count: number;
  applicable_fields: Array<(typeof FIELD_NAMES)[number]>;
  handwritten_fields: Array<(typeof FIELD_NAMES)[number]>;
  metric_families: MetricFamily[];
  metric_denominators: {
    handwriting_text?: { ground_truth_characters: number; ground_truth_words: number };
    line_items?: {
      ground_truth_items: number;
      quantity_applicable: number;
      unit_price_applicable: number;
      line_total_applicable: number;
    };
      long_reconstruction?: { ground_truth_lines: number; known_truncated: boolean; acquisition_frame_count: number };
    manual_corrections?: { reviewed_fields: number; reviewed_items: number };
    processed_composite?: { scored_financial_fields: number };
  };
}

function makeFixture(options: FixtureOptions = {}): EvaluationPaths & { directory: string; firstSourcePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "finsight-policy-v1-"));
  temporaryDirectories.push(directory);
  const provider = options.provider ?? "LOCAL_TESSERACT";
  const cloud = provider === "AZURE_DOCUMENT_INTELLIGENCE";
  const purpose = cloud ? "CLOUD_BENCHMARK" : "CAPSTONE_DEMO";
  const extractorVersionSha256 = createHash("sha256").update("extractor-v1").digest("hex");
  const declaredHardwareSha256 = createHash("sha256").update("declared-test-hardware").digest("hex");
  const manifestPath = join(directory, "intake.csv");
  const pairLabelsPath = join(directory, "pairs.csv");
  const artifactMapPath = join(directory, "artifact-map.json");
  const sealPath = join(directory, "seal.json");
  const groundTruthBundlePath = join(directory, "ground-truth.bundle");
  const resultsPath = join(directory, "scored-results.json");
  const outputPath = join(directory, "aggregate-report.json");
  const intakeRows: Array<Record<string, string>> = [];
  const artifacts: FixtureArtifact[] = [];
  const primarySampleIds: string[] = [];
  const primaryRows = new Map<string, Record<string, string>>();
  let firstSourcePath = "";

  const addArtifact = (sampleId: string, sourceText: string, groundTruthText: string) => {
    const sourcePath = join(directory, `${sampleId}.source`);
    const groundTruthPath = join(directory, `${sampleId}.ground-truth`);
    writeFileSync(sourcePath, sourceText);
    writeFileSync(groundTruthPath, groundTruthText);
    if (!firstSourcePath) firstSourcePath = sourcePath;
    artifacts.push({
      sample_id: sampleId,
      source_path: sourcePath,
      ground_truth_path: groundTruthPath,
      ground_truth_page_count: 0,
      applicable_fields: [],
      handwritten_fields: [],
      metric_families: [],
      metric_denominators: {},
    });
    return { sourcePath, groundTruthPath };
  };

  const baseRow = (
    sampleId: string,
    receiptId: string,
    captureAttemptId: string,
    role: string,
    sourceClass: string,
    sourcePath: string,
    groundTruthPath: string,
  ): Record<string, string> => ({
    sample_id: sampleId,
    receipt_id: receiptId,
    capture_attempt_id: captureAttemptId,
    benchmark_count_role: role,
    source_class: sourceClass,
    consent_record_id: sourceClass === "CONSENTED_OWNER" ? `consent-${receiptId}` : "NOT_APPLICABLE",
    consent_scope_version: sourceClass === "CONSENTED_OWNER" ? "consent-v1" : "NOT_APPLICABLE",
    donor_pseudonym: sourceClass === "CONSENTED_OWNER" ? `donor-${receiptId}` : "NOT_APPLICABLE",
    captured_at_utc: "2026-09-11T00:00:00Z",
    intake_at_utc: "2026-09-11T01:00:00Z",
    capture_device_model: "Declared Android target",
    android_os_api: "Android 14 API 34",
    app_build: "acceptance-build-v1",
    capture_mode: "ANDROID_CUSTOM_STANDARD",
    language_tags: "en-PH",
    receipt_type: "THERMAL",
    condition_tags: "CLEAN",
    cohort_tags: "CLEAN_PRINTED",
    vendor_template_id: "template-1",
    page_group_id: "NOT_APPLICABLE",
    page_number: "1",
    segment_group_id: "NOT_APPLICABLE",
    source_sha256: sha256(sourcePath),
    redaction_state: "NONE_NEEDED",
    ground_truth_version: "gt-v1",
    ground_truth_reference: `ground-truth:${receiptId}`,
    ground_truth_sha256: sha256(groundTruthPath),
    ground_truth_sealed_at_utc: "2026-09-12T00:00:00Z",
    ground_truth_reviewer_1: "custodian-alpha",
    ground_truth_reviewer_2: options.sameReviewer ? "custodian-alpha" : "custodian-beta",
    permitted_uses: purpose,
    allowed_cloud_providers: cloud ? provider : "NONE",
    retention_expires_at_utc: "2027-09-13T00:00:00Z",
    private_storage_reference: `vault:${sampleId}`,
    release_gate_eligible: "true",
    exclusion_reason: "",
  });

  for (let index = 0; index < 30; index += 1) {
    const ordinal = String(index + 1).padStart(3, "0");
    const sampleId = `sample-primary-${ordinal}`;
    const receiptId = `receipt-${ordinal}`;
    const captureAttemptId = `capture-${ordinal}`;
    const artifact = addArtifact(sampleId, `private source bytes ${ordinal}`, `private ground truth values ${ordinal}`);
    const row = baseRow(sampleId, receiptId, captureAttemptId, "PRIMARY_RECEIPT", "CONSENTED_OWNER", artifact.sourcePath, artifact.groundTruthPath);
    row.vendor_template_id = `template-${(index % 5) + 1}`;
    if (index < 5) {
      row.capture_mode = "ANDROID_CUSTOM_LONG";
      row.language_tags = "en-PH|fil-PH";
      row.condition_tags = "CLEAN|LONG";
      row.cohort_tags = "CLEAN_PRINTED|LONG|FILIPINO_OR_MIXED_LANGUAGE";
    } else if (index < 10) {
      row.condition_tags = "FADED|DAMAGED";
      row.cohort_tags = "STRESSED_OR_FADED|DAMAGED_OR_LOW_LIGHT";
    } else if (index < 15) {
      row.receipt_type = "HANDWRITTEN";
      row.condition_tags = "HANDWRITTEN_FINANCIAL_FIELD";
      row.cohort_tags = "HANDWRITTEN_OR_HAND_ANNOTATED";
    } else if (index < 20) {
      row.language_tags = "en-PH|fil-PH";
      row.cohort_tags = "CLEAN_PRINTED|FILIPINO_OR_MIXED_LANGUAGE";
    } else if (index < 25) {
      row.condition_tags = "LOW_LIGHT|DAMAGED";
      row.cohort_tags = "DAMAGED_OR_LOW_LIGHT";
    }
    const artifactEntry = artifacts.at(-1)!;
    const handwritten = index >= 10 && index < 15;
    const long = index < 5;
    artifactEntry.ground_truth_page_count = long ? 2 : 1;
    artifactEntry.applicable_fields = [...FIELD_NAMES];
    artifactEntry.handwritten_fields = handwritten ? ["subtotal", "tax", "discount", "total"] : [];
    artifactEntry.metric_families = [
      "CAPTURE_DETECTION_LATENCY",
      "CAPTURE_LIVE_GUIDANCE_LATENCY",
      "NORMALIZED_CORNER_ERROR",
      "LINE_ITEMS",
      "MANUAL_CORRECTIONS",
      "PROCESSED_COMPOSITE",
      ...(handwritten ? ["HANDWRITING_TEXT" as const] : []),
      ...(long ? ["LONG_RECONSTRUCTION" as const] : ["LOCAL_RESULT_LATENCY" as const]),
    ];
    artifactEntry.metric_denominators = {
      ...(handwritten ? { handwriting_text: { ground_truth_characters: 100, ground_truth_words: 20 } } : {}),
      line_items: {
        ground_truth_items: 5,
        quantity_applicable: 5,
        unit_price_applicable: 5,
        line_total_applicable: 5,
      },
      ...(long ? { long_reconstruction: { ground_truth_lines: 100, known_truncated: true, acquisition_frame_count: 2 } } : {}),
      manual_corrections: { reviewed_fields: 10, reviewed_items: 5 },
      processed_composite: { scored_financial_fields: 7 },
    };
    intakeRows.push(row);
    primaryRows.set(sampleId, row);
    primarySampleIds.push(sampleId);
  }

  if (options.extraPrimarySourceClass) {
    const sampleId = "sample-primary-extra";
    const receiptId = "receipt-extra";
    const artifact = addArtifact(sampleId, "private extra source bytes", "private extra ground truth values");
    const row = baseRow(
      sampleId,
      receiptId,
      "capture-extra",
      "PRIMARY_RECEIPT",
      options.extraPrimarySourceClass,
      artifact.sourcePath,
      artifact.groundTruthPath,
    );
    row.vendor_template_id = "template-extra";
    const artifactEntry = artifacts.at(-1)!;
    artifactEntry.ground_truth_page_count = 1;
    artifactEntry.applicable_fields = [...FIELD_NAMES];
    artifactEntry.metric_families = [
      "CAPTURE_DETECTION_LATENCY",
      "CAPTURE_LIVE_GUIDANCE_LATENCY",
      "NORMALIZED_CORNER_ERROR",
      "LINE_ITEMS",
      "MANUAL_CORRECTIONS",
      "LOCAL_RESULT_LATENCY",
      "PROCESSED_COMPOSITE",
    ];
    artifactEntry.metric_denominators = {
      line_items: {
        ground_truth_items: 5,
        quantity_applicable: 5,
        unit_price_applicable: 5,
        line_total_applicable: 5,
      },
      manual_corrections: { reviewed_fields: 10, reviewed_items: 5 },
      processed_composite: { scored_financial_fields: 7 },
    };
    intakeRows.push(row);
    primaryRows.set(sampleId, row);
    primarySampleIds.push(sampleId);
  }

  const recaptureSampleIds: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const ordinal = String(index + 1).padStart(3, "0");
    const sampleId = `sample-recapture-${ordinal}`;
    const receiptId = `receipt-${ordinal}`;
    const primary = primaryRows.get(`sample-primary-${ordinal}`)!;
    const artifact = addArtifact(sampleId, `private recapture bytes ${ordinal}`, `private ground truth values ${ordinal}`);
    const row = baseRow(sampleId, receiptId, `recapture-${ordinal}`, "RECAPTURE_ROBUSTNESS", "CONSENTED_OWNER", artifact.sourcePath, artifact.groundTruthPath);
    row.vendor_template_id = primary.vendor_template_id!;
    row.ground_truth_reference = primary.ground_truth_reference!;
    row.ground_truth_sha256 = primary.ground_truth_sha256!;
    artifacts[artifacts.length - 1]!.ground_truth_path = artifacts.find((entry) => entry.sample_id === `sample-primary-${ordinal}`)!.ground_truth_path;
    row.condition_tags = "REPHOTOGRAPHED";
    row.cohort_tags = "NOT_APPLICABLE";
    artifacts.at(-1)!.ground_truth_page_count = 1;
    intakeRows.push(row);
    recaptureSampleIds.push(sampleId);
  }

  for (let index = 0; index < 10; index += 1) {
    const ordinal = String(index + 1).padStart(3, "0");
    const sampleId = `sample-nonreceipt-${ordinal}`;
    const artifact = addArtifact(sampleId, `private non-receipt bytes ${ordinal}`, `private non-receipt truth ${ordinal}`);
    const row = baseRow(sampleId, "NOT_APPLICABLE", `capture-nonreceipt-${ordinal}`, "NON_RECEIPT", "SYNTHETIC", artifact.sourcePath, artifact.groundTruthPath);
    row.receipt_type = "NON_RECEIPT";
    row.condition_tags = "OTHER_RECORDED";
    row.cohort_tags = "NOT_APPLICABLE";
    row.vendor_template_id = "NOT_APPLICABLE";
    artifacts.at(-1)!.metric_families = ["CAPTURE_DETECTION_LATENCY", "CAPTURE_LIVE_GUIDANCE_LATENCY"];
    intakeRows.push(row);
  }

  const pairRows: Array<Record<string, string>> = [];
  const pairBase = (pairId: string, left: string, right: string, label: "DUPLICATE" | "NON_DUPLICATE") => {
    const ordered = [left, right].sort();
    return {
      pair_id: pairId,
      left_sample_id: ordered[0]!,
      right_sample_id: ordered[1]!,
      pair_label: label,
      relationship_basis: label === "DUPLICATE" ? "SAME_PURCHASE_RECAPTURE" : "DIFFERENT_PURCHASE",
      ground_truth_reviewer_1: "custodian-alpha",
      ground_truth_reviewer_2: options.sameReviewer ? "custodian-alpha" : "custodian-beta",
      reviewed_at_utc: "2026-09-12T12:00:00Z",
      release_gate_eligible: "true",
      exclusion_reason: "",
    };
  };
  for (let index = 0; index < 10; index += 1) {
    pairRows.push(pairBase(`pair-duplicate-${index + 1}`, primarySampleIds[index]!, recaptureSampleIds[index]!, "DUPLICATE"));
  }
  for (let index = 0; index < 20; index += 1) {
    pairRows.push(pairBase(`pair-nonduplicate-${index + 1}`, primarySampleIds[index]!, primarySampleIds[index + 10]!, "NON_DUPLICATE"));
  }

  const fieldScores = (handwritten: boolean) => FIELD_NAMES.map((field) => ({
    field,
    applicable: true,
    exact_match: true,
    confidence_band: "UNCALIBRATED",
    value_state: "PRESENT",
    routed_to_review: handwritten && new Set(["subtotal", "tax", "discount", "total"]).has(field),
    handwritten: handwritten && new Set(["subtotal", "tax", "discount", "total"]).has(field),
    ...(field === "total" ? { absolute_error_minor: 0 } : {}),
  }));
  const receiptResults = primarySampleIds.map((sampleId, index) => {
    const handwritten = index >= 10 && index < 15;
    const long = index < 5;
    return {
      sample_id: sampleId,
      trial_id: `receipt-trial-${index + 1}`,
      status: "SUCCESS",
      page_count: long ? 2 : 1,
      fields: fieldScores(handwritten),
      ...(handwritten ? { text: { character_errors: 1, ground_truth_characters: 100, word_errors: 1, ground_truth_words: 20 } } : {}),
      items: {
        predicted_items: 5,
        ground_truth_items: 5,
        matched_items: 5,
        quantity_applicable: 5,
        quantity_exact: 5,
        unit_price_applicable: 5,
        unit_price_exact: 5,
        line_total_applicable: 5,
        line_total_exact: 5,
      },
      ...(long ? { reconstruction: { ground_truth_lines: 100, matched_lines: 100, ordered_lines: 100, duplicated_lines: 0, known_truncated: true, marked_complete: false } } : {}),
      corrections: { reviewed_fields: 10, changed_fields: 0, reviewed_items: 5, changed_items: 0 },
      ...(!long ? { local_result_latency_ms: 1_000 } : {}),
      processed_composite: { scored_financial_fields: 7, original_correct_fields: 5, processed_correct_fields: 7, regressed_fields: 0 },
    };
  });
  const captures = [
    ...primarySampleIds.map((sampleId, index) => ({
      capture_attempt_id: primaryRows.get(sampleId)!.capture_attempt_id,
      trial_id: `capture-trial-${index + 1}`,
      actual_document_count: 1,
      likelihood_outcome: "RECEIPT",
      detection_latency_ms: 100,
      live_guidance_latency_ms: 100,
      corner_errors: [{ sample_id: sampleId, normalized_corner_error: 0.01 }],
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      capture_attempt_id: `capture-nonreceipt-${String(index + 1).padStart(3, "0")}`,
      trial_id: `capture-nonreceipt-trial-${index + 1}`,
      actual_document_count: 0,
      likelihood_outcome: "OBVIOUS_NON_RECEIPT",
      detection_latency_ms: 100,
      live_guidance_latency_ms: 100,
    })),
  ];
  const pairPredictions = pairRows.map((row) => ({ pair_id: row.pair_id, predicted_duplicate: row.pair_label === "DUPLICATE" }));

  writeFileSync(manifestPath, csv(INTAKE_HEADERS, intakeRows));
  writeFileSync(pairLabelsPath, csv(PAIR_HEADERS, pairRows));
  writeFileSync(artifactMapPath, `${JSON.stringify({
    schema_version: "finsight-receipt-artifact-map-v1",
    run_plan: {
      purpose,
      provider,
      extractor_version_sha256: extractorVersionSha256,
      planned_review_end_at_utc: "2026-09-20T00:00:00Z",
      declared_hardware_sha256: declaredHardwareSha256,
      cold_or_warm: "COLD",
    },
    independent_trials: {
      captures: captures.map((capture) => ({
        capture_attempt_id: capture.capture_attempt_id,
        trial_id: capture.trial_id,
      })),
      receipts: receiptResults.map((receipt) => ({
        sample_id: receipt.sample_id,
        trial_id: receipt.trial_id,
      })),
    },
    artifacts,
  }, null, 2)}\n`);
  writeFileSync(groundTruthBundlePath, "private sealed ground truth bundle\n");
  writeFileSync(resultsPath, `${JSON.stringify({
    schema_version: "finsight-receipt-scored-results-v1",
    policy_id: "finsight-core-evidence-gates-v1",
    run: {
      purpose,
      provider,
      extractor_version_sha256: extractorVersionSha256,
      results_opened_at_utc: "2026-09-13T01:00:00Z",
      planned_review_end_at_utc: "2026-09-20T00:00:00Z",
      declared_hardware_sha256: declaredHardwareSha256,
      cold_or_warm: "COLD",
    },
    captures,
    receipts: receiptResults,
    pair_predictions: pairPredictions,
  }, null, 2)}\n`);
  writeFileSync(sealPath, `${JSON.stringify({
    schema_version: "finsight-receipt-evaluation-seal-v1",
    policy_id: "finsight-core-evidence-gates-v1",
    policy_sha256: sha256(join(REPOSITORY_ROOT, "docs/phase-0/benchmark-policy-v1.json")),
    manifest_sha256: sha256(manifestPath),
    pair_labels_sha256: sha256(pairLabelsPath),
    artifact_map_sha256: sha256(artifactMapPath),
    ground_truth_bundle_sha256: sha256(groundTruthBundlePath),
    sealed_at_utc: "2026-09-13T00:00:00Z",
  }, null, 2)}\n`);

  return {
    directory,
    firstSourcePath,
    repositoryRoot: REPOSITORY_ROOT,
    manifestPath,
    pairLabelsPath,
    artifactMapPath,
    sealPath,
    groundTruthBundlePath,
    resultsPath,
    outputPath,
  };
}

function expectInputError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected the policy-v1 input validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluationInputError);
    expect((error as EvaluationInputError).code).toBe(code);
  }
}

function updateSeal(paths: EvaluationPaths, updates: Record<string, string> = {}): void {
  const seal = JSON.parse(readFileSync(paths.sealPath, "utf8")) as Record<string, string>;
  Object.assign(seal, updates);
  writeFileSync(paths.sealPath, `${JSON.stringify(seal, null, 2)}\n`);
}

function updateJson(path: string, update: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  update(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function updateArtifactMap(paths: EvaluationPaths, update: (value: Record<string, unknown>) => void): void {
  updateJson(paths.artifactMapPath, update);
  updateSeal(paths, { artifact_map_sha256: sha256(paths.artifactMapPath) });
}

function replaceManifest(paths: EvaluationPaths, before: string, after: string): void {
  const manifest = readFileSync(paths.manifestPath, "utf8");
  expect(manifest).toContain(before);
  writeFileSync(paths.manifestPath, manifest.replace(before, after));
  updateSeal(paths, { manifest_sha256: sha256(paths.manifestPath) });
}

function replacePairs(paths: EvaluationPaths, before: string, after: string): void {
  const pairs = readFileSync(paths.pairLabelsPath, "utf8");
  expect(pairs).toContain(before);
  writeFileSync(paths.pairLabelsPath, pairs.replace(before, after));
  updateSeal(paths, { pair_labels_sha256: sha256(paths.pairLabelsPath) });
}

function setRunPurpose(paths: EvaluationPaths, purpose: "LOCAL_ENGINEERING" | "CAPSTONE_DEMO"): void {
  const manifest = readFileSync(paths.manifestPath, "utf8").replaceAll(",CAPSTONE_DEMO,", `,${purpose},`);
  writeFileSync(paths.manifestPath, manifest);
  updateSeal(paths, { manifest_sha256: sha256(paths.manifestPath) });
  updateArtifactMap(paths, (artifactMap) => {
    (artifactMap.run_plan as Record<string, unknown>).purpose = purpose;
  });
  updateJson(paths.resultsPath, (results) => {
    (results.run as Record<string, unknown>).purpose = purpose;
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("policy-v1 statistics", () => {
  it("computes the frozen Wilson interval", () => {
    const interval = wilson95(5, 10)!;
    expect(interval.method).toBe("TWO_SIDED_WILSON_SCORE_WITHOUT_CONTINUITY_CORRECTION");
    expect(interval.lower).toBeCloseTo(0.2366, 4);
    expect(interval.upper).toBeCloseTo(0.7634, 4);
  });

  it("keeps negative paired deltas in deterministic receipt-level bootstrap samples", () => {
    const clusters = [{ numerator: -2, denominator: 10 }, { numerator: 1, denominator: 10 }];
    const first = bootstrapRatio95(clusters, { seed: 20260913, resamples: 10_000, resamplingUnit: "DISTINCT_RECEIPT_ID" });
    const second = bootstrapRatio95(clusters, { seed: 20260913, resamples: 10_000, resamplingUnit: "DISTINCT_RECEIPT_ID" });
    expect(first).toEqual(second);
    expect(first!.lower).toBeLessThan(0);
  });

  it("excludes zero-applicability clusters from a ratio bootstrap frame", () => {
    const interval = bootstrapRatio95(
      [{ numerator: 100, denominator: 0 }, { numerator: 5, denominator: 10 }],
      { seed: 20260913, resamples: 100, resamplingUnit: "DISTINCT_RECEIPT_ID" },
    );
    expect(interval).toMatchObject({ lower: 0.5, upper: 0.5 });
  });

  it("resamples percentile observations by distinct receipt cluster", () => {
    const interval = bootstrapClusteredPercentile95(
      [[0.01, 0.02], [0.9]],
      0.5,
      { seed: 20260913, resamples: 1_000 },
    );
    expect(interval).toMatchObject({
      method: "TWO_SIDED_PERCENTILE_BOOTSTRAP",
      resamplingUnit: "DISTINCT_RECEIPT_ID",
      seed: 20260913,
    });
  });
});

describe("policy-v1 external evaluator", () => {
  it("validates a sealed external corpus and writes only aggregate evidence", () => {
    const paths = makeFixture();
    const input = loadAndValidateInputs(paths);
    const report = buildPolicyV1Report(input, "2026-09-13T02:00:00.000Z");
    writePolicyV1Report(report, paths.outputPath);

    expect(report.decision.capstoneCorpusStatus).toBe("PASS");
    expect(report.decision.providerPromotionCorpusStatus).toBe("FAIL");
    expect(report.decision.duplicatePromotionCorpusStatus).toBe("FAIL");
    expect(report.decision.providerPromotionStatus).toBe("FAIL");
    expect(report.decision.duplicatePromotionStatus).toBe("FAIL");
    expect(report.corpus.gates.find((gate) => gate.id === "duplicate_promotion_duplicate_pairs")).toMatchObject({
      decision: "DUPLICATE_PROMOTION",
      gateStatus: "FAIL",
    });
    expect(report.corpus.gates.find((gate) => gate.id === "provider_promotion_unique_real_receipts")).toMatchObject({
      decision: "PROVIDER_PROMOTION",
      gateStatus: "FAIL",
    });
    expect(report.metrics.find((metric) => metric.id === "processed_composite_gain")).toMatchObject({
      pointEstimate: 2 / 7,
      gateStatus: "PASS",
    });
    expect(report.metrics.find((metric) => metric.id === "median_normalized_corner_error")?.confidenceInterval).toMatchObject({
      resamplingUnit: "DISTINCT_RECEIPT_ID",
    });
    expect(report.decision.providerPromotionBlockers).toContain("cloud_provider_evidence_contract");
    expect(report.decision.providerPromotionBlockers).toContain("provider_cohort_macro_average");
    expect(report.decision.providerPromotionBlockers).toContain("raw_and_normalized_ocr_scoring");
    expect(report.decision.duplicatePromotionCorpusBlockers).toContain("duplicate_promotion_duplicate_pairs");
    expect(report.decision.phase2AcceptanceStatus).toBe("OPEN");
    expect(report.decision.measuredMetricStatus).toBe("INCOMPLETE");
    expect(report.unavailableEvidence.every((entry) => entry.status === "NOT_MEASURED")).toBe(true);
    expect(report.seals.artifactMapSha256).toBe(input.seal.artifact_map_sha256);

    const output = readFileSync(paths.outputPath, "utf8");
    expect(output).not.toContain("sample-primary-001");
    expect(output).not.toContain(paths.firstSourcePath);
    expect(output).not.toContain("private source bytes");
    expect(output).not.toContain("private ground truth values");
    expect(statSync(paths.outputPath).mode & 0o777).toBe(0o600);
  });

  it("does not turn corpus-floor support into a provider or duplicate promotion approval", () => {
    const paths = makeFixture();
    const input = loadAndValidateInputs(paths);
    while (input.counts.eligibleRealReceiptIds.size < 100) {
      input.counts.eligibleRealReceiptIds.add(`aggregate-provider-${input.counts.eligibleRealReceiptIds.size}`);
    }
    for (const receiptIds of input.counts.realCohortReceiptIds.values()) {
      while (receiptIds.size < 30) receiptIds.add(`aggregate-cohort-${receiptIds.size}`);
    }
    while (input.counts.duplicatePairIds.size < 100) {
      input.counts.duplicatePairIds.add(`aggregate-duplicate-${input.counts.duplicatePairIds.size}`);
    }
    while (input.counts.nonDuplicatePairIds.size < 200) {
      input.counts.nonDuplicatePairIds.add(`aggregate-nonduplicate-${input.counts.nonDuplicatePairIds.size}`);
    }
    const report = buildPolicyV1Report(input);
    expect(report.decision.providerPromotionCorpusStatus).toBe("PASS");
    expect(report.decision.providerPromotionStatus).toBe("INCOMPLETE");
    expect(report.decision.providerPromotionBlockers).toContain("cloud_provider_evidence_contract");
    expect(report.decision.duplicatePromotionCorpusStatus).toBe("PASS");
    expect(report.decision.duplicatePromotionStatus).toBe("INCOMPLETE");
    expect(report.decision.duplicatePromotionBlockers).toContain("duplicate_owner_review");
  });

  it("keeps seeded bootstrap intervals invariant to scored-result array permutations", () => {
    const paths = makeFixture();
    const input = loadAndValidateInputs(paths);
    const first = buildPolicyV1Report(input, "2026-09-13T02:00:00.000Z");
    input.results.captures?.reverse();
    input.results.receipts?.reverse();
    const reordered = buildPolicyV1Report(input, "2026-09-13T02:00:00.000Z");
    expect(reordered.metrics.map((metric) => [metric.id, metric.scope, metric.confidenceInterval])).toEqual(
      first.metrics.map((metric) => [metric.id, metric.scope, metric.confidenceInterval]),
    );
  });

  it("rejects an aggregate report timestamp before results were opened", () => {
    const paths = makeFixture();
    const input = loadAndValidateInputs(paths);
    expect(() => buildPolicyV1Report(input, "2026-09-13T00:30:00.000Z")).toThrow(/cannot precede/);
  });

  it("rejects an aggregate report timestamp after the sealed review window", () => {
    const paths = makeFixture();
    const input = loadAndValidateInputs(paths);
    expect(() => buildPolicyV1Report(input, "2026-09-20T00:00:01.000Z")).toThrow(/cannot exceed/);
  });

  it("rejects a changed source artifact before reporting metrics", () => {
    const paths = makeFixture();
    writeFileSync(paths.firstSourcePath, "changed private bytes");
    expectInputError(() => loadAndValidateInputs(paths), "SOURCE_HASH_MISMATCH");
  });

  it("rejects an altered manifest header even when its new bytes are sealed", () => {
    const paths = makeFixture();
    const manifest = readFileSync(paths.manifestPath, "utf8").replace(/^sample_id,/, "private_sample_id,");
    writeFileSync(paths.manifestPath, manifest);
    updateSeal(paths, { manifest_sha256: sha256(paths.manifestPath) });
    expectInputError(() => loadAndValidateInputs(paths), "MANIFEST_SCHEMA_INVALID");
  });

  it("validates sealed corpus structure before parsing scored-result bytes", () => {
    const paths = makeFixture();
    const manifest = readFileSync(paths.manifestPath, "utf8").replace(/^sample_id,/, "private_sample_id,");
    writeFileSync(paths.manifestPath, manifest);
    updateSeal(paths, { manifest_sha256: sha256(paths.manifestPath) });
    writeFileSync(paths.resultsPath, "not valid JSON");
    expectInputError(() => loadAndValidateInputs(paths), "MANIFEST_SCHEMA_INVALID");
  });

  it("rejects a manifest changed after the corpus seal", () => {
    const paths = makeFixture();
    writeFileSync(paths.manifestPath, `${readFileSync(paths.manifestPath, "utf8")}\n`);
    expectInputError(() => loadAndValidateInputs(paths), "MANIFEST_SEAL_MISMATCH");
  });

  it("rejects result data declared open before the seal", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      (results.run as Record<string, unknown>).results_opened_at_utc = "2026-09-12T23:59:59Z";
    });
    expectInputError(() => loadAndValidateInputs(paths), "RESULTS_OPENED_BEFORE_SEAL");
  });

  it("rejects an output path inside the repository", () => {
    const paths = makeFixture();
    paths.outputPath = join(REPOSITORY_ROOT, "backend/tests/receipt-scanner-evaluation/private-output-do-not-create.json");
    expectInputError(() => loadAndValidateInputs(paths), "OUTPUT_INSIDE_REPOSITORY");
  });

  it("resolves symlinks before enforcing the outside-repository boundary", () => {
    const paths = makeFixture();
    const linkPath = join(paths.directory, "manifest-link.csv");
    symlinkSync(join(REPOSITORY_ROOT, "docs/phase-0/receipt-corpus-intake.example.csv"), linkPath);
    paths.manifestPath = linkPath;
    expectInputError(() => loadAndValidateInputs(paths), "PRIVATE_PATH_INSIDE_REPOSITORY");
  });

  it("rejects an existing output instead of overwriting evidence", () => {
    const paths = makeFixture();
    writeFileSync(paths.outputPath, "existing report");
    expectInputError(() => loadAndValidateInputs(paths), "OUTPUT_EXISTS");
    expect(readFileSync(paths.outputPath, "utf8")).toBe("existing report");
  });

  it("rejects cloud results because v1 cannot prove required provider evidence", () => {
    const paths = makeFixture({ provider: "AZURE_DOCUMENT_INTELLIGENCE" });
    expectInputError(() => loadAndValidateInputs(paths), "PROVIDER_EVIDENCE_CONTRACT_UNSUPPORTED");
  });

  it("rejects a cloud-consent identifier that leaves the Azure tier ambiguous", () => {
    const paths = makeFixture();
    replaceManifest(
      paths,
      ",CAPSTONE_DEMO,NONE,2027-09-13T00:00:00Z,",
      ",CAPSTONE_DEMO,AZURE_DOCUMENT_INTELLIGENCE,2027-09-13T00:00:00Z,",
    );
    expectInputError(() => loadAndValidateInputs(paths), "CLOUD_PROVIDER_INVALID");
  });

  it("accepts the frozen tier-specific Azure consent identifier for a local-only run", () => {
    const paths = makeFixture();
    replaceManifest(
      paths,
      ",CAPSTONE_DEMO,NONE,2027-09-13T00:00:00Z,",
      ",CAPSTONE_DEMO,AZURE_DOCUMENT_INTELLIGENCE_F0,2027-09-13T00:00:00Z,",
    );
    expect(() => loadAndValidateInputs(paths)).not.toThrow();
  });

  it("rejects PaddleOCR until a versioned failure-hypothesis contract exists", () => {
    const paths = makeFixture({ provider: "PADDLEOCR_LOCAL_NONPRODUCTION" });
    expectInputError(() => loadAndValidateInputs(paths), "PROVIDER_EVIDENCE_CONTRACT_UNSUPPORTED");
  });

  it("reports corpus concentration failures without treating promotion floors as capstone failures", () => {
    const paths = makeFixture();
    setRunPurpose(paths, "LOCAL_ENGINEERING");
    writeFileSync(paths.manifestPath, readFileSync(paths.manifestPath, "utf8").replace(/template-[1-5]/g, "template-1"));
    updateSeal(paths, { manifest_sha256: sha256(paths.manifestPath) });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.corpus.gates.find((gate) => gate.id === "maximum_vendor_template_share")).toMatchObject({ gateStatus: "FAIL" });
    expect(report.decision.capstoneCorpusStatus).toBe("FAIL");
    expect(report.decision.blockers).not.toContain("duplicate_promotion_duplicate_pairs");
  });

  it("fails a CAPSTONE_DEMO corpus floor before reading scored-result bytes", () => {
    const paths = makeFixture();
    writeFileSync(paths.manifestPath, readFileSync(paths.manifestPath, "utf8").replace(/template-[1-5]/g, "template-1"));
    updateSeal(paths, { manifest_sha256: sha256(paths.manifestPath) });
    writeFileSync(paths.resultsPath, "not valid JSON");
    expectInputError(() => loadAndValidateInputs(paths), "CAPSTONE_CORPUS_FLOOR_NOT_MET");
  });

  it("rejects a partial result collection instead of scoring a selected subset", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      (results.receipts as unknown[]).pop();
    });
    expectInputError(() => loadAndValidateInputs(paths), "RECEIPT_RESULT_COVERAGE_INVALID");
  });

  it("rejects an explicitly empty outer result collection", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      results.receipts = [];
    });
    expectInputError(() => loadAndValidateInputs(paths), "RECEIPT_RESULT_COVERAGE_INVALID");
  });

  it("keeps omitted outer result collections visible as incomplete evidence", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      delete results.captures;
      delete results.receipts;
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.metrics.find((metric) => metric.id === "provider_result_timeout_rate")).toMatchObject({
      status: "NOT_MEASURED",
      scope: "ELIGIBLE_CONSENTED_OWNER_RECEIPTS",
    });
    expect(report.metrics.find((metric) => metric.id === "field_exact_match.total" && metric.scope === "ELIGIBLE_CONSENTED_OWNER_RECEIPTS;COHORT:LONG")).toMatchObject({
      status: "NOT_MEASURED",
    });
    expect(report.metrics.find((metric) => metric.id === "field_exact_match.total" && metric.scope === "ELIGIBLE_CONSENTED_OWNER_RECEIPTS;CAPTURE_MODE:ANDROID_CUSTOM_STANDARD")).toMatchObject({
      status: "NOT_MEASURED",
    });
    expect(report.metrics.find((metric) => metric.id === "long_receipt_line_recall")).toMatchObject({
      status: "NOT_MEASURED",
      scope: "ELIGIBLE_CONSENTED_OWNER_RECEIPTS;COHORT:LONG",
    });
    expect(report.metrics.find((metric) => metric.id === "document_detection_recall")).toMatchObject({
      status: "NOT_MEASURED",
      scope: "ELIGIBLE_CONSENTED_OWNER_RECEIPTS_CAPTURES_PLUS_ELIGIBLE_NON_RECEIPTS",
    });
    expect(report.decision.measuredMetricStatus).toBe("INCOMPLETE");
  });

  it.each([
    ["long reconstruction", "RECEIPT_METRIC_COVERAGE_INVALID", (results: Record<string, unknown>) => {
      delete (results.receipts as Array<Record<string, unknown>>)[0]!.reconstruction;
    }],
    ["one-page latency", "RECEIPT_METRIC_COVERAGE_INVALID", (results: Record<string, unknown>) => {
      delete (results.receipts as Array<Record<string, unknown>>)[5]!.local_result_latency_ms;
    }],
    ["processed comparison", "RECEIPT_METRIC_COVERAGE_INVALID", (results: Record<string, unknown>) => {
      delete (results.receipts as Array<Record<string, unknown>>)[0]!.processed_composite;
    }],
    ["corner error", "CORNER_RESULT_COVERAGE_INVALID", (results: Record<string, unknown>) => {
      ((results.captures as Array<Record<string, unknown>>)[0]!.corner_errors as unknown[]).pop();
    }],
    ["capture latency", "CAPTURE_METRIC_COVERAGE_INVALID", (results: Record<string, unknown>) => {
      delete (results.captures as Array<Record<string, unknown>>)[0]!.detection_latency_ms;
    }],
  ])("rejects selected-subset %s evidence", (_label, code, mutate) => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, mutate);
    expectInputError(() => loadAndValidateInputs(paths), code);
  });

  it("rejects a resealed metric-family list that selects an easier subset", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[0]!;
      artifact.metric_families = (artifact.metric_families as string[]).filter((family) => family !== "PROCESSED_COMPOSITE");
      delete (artifact.metric_denominators as Record<string, unknown>).processed_composite;
    });
    expectInputError(() => loadAndValidateInputs(paths), "METRIC_FAMILY_APPLICABILITY_INVALID");
  });

  it("rejects ordinary metric families on recapture-only rows", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifacts = artifactMap.artifacts as Array<Record<string, unknown>>;
      const recapture = artifacts.find((artifact) => artifact.sample_id === "sample-recapture-001")!;
      recapture.metric_families = ["CAPTURE_DETECTION_LATENCY"];
    });
    expectInputError(() => loadAndValidateInputs(paths), "METRIC_FAMILY_APPLICABILITY_INVALID");
  });

  it.each([
    ["processed denominator", (results: Record<string, unknown>) => {
      ((results.receipts as Array<Record<string, unknown>>)[0]!.processed_composite as Record<string, unknown>).scored_financial_fields = 11;
    }],
    ["long-receipt denominator", (results: Record<string, unknown>) => {
      ((results.receipts as Array<Record<string, unknown>>)[0]!.reconstruction as Record<string, unknown>).ground_truth_lines = 101;
    }],
    ["known-truncated truth", (results: Record<string, unknown>) => {
      ((results.receipts as Array<Record<string, unknown>>)[0]!.reconstruction as Record<string, unknown>).known_truncated = false;
    }],
  ])("rejects a post-result change to the sealed %s", (_label, mutate) => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, mutate);
    expectInputError(() => loadAndValidateInputs(paths), "SEALED_DENOMINATOR_MISMATCH");
  });

  it("binds the processed-composite denominator to sealed applicable financial fields", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[0]!;
      (artifact.metric_denominators as Record<string, Record<string, unknown>>).processed_composite!.scored_financial_fields = 6;
    });
    expectInputError(() => loadAndValidateInputs(paths), "PROCESSED_FINANCIAL_FRAME_INVALID");
  });

  it("rejects an impossible processed-composite transition table", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      const comparison = (results.receipts as Array<Record<string, unknown>>)[0]!.processed_composite as Record<string, unknown>;
      comparison.original_correct_fields = 0;
      comparison.processed_correct_fields = 1;
      comparison.regressed_fields = 1;
    });
    expectInputError(() => loadAndValidateInputs(paths), "PROCESSED_COMPARISON_INVALID");
  });

  it.each([
    ["applicability beyond ground truth", (items: Record<string, unknown>) => {
      items.quantity_applicable = 6;
    }],
    ["exact attributes beyond matched items", (items: Record<string, unknown>) => {
      items.matched_items = 1;
      items.quantity_exact = 2;
    }],
  ])("rejects impossible line-item %s", (_label, mutate) => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      mutate((results.receipts as Array<Record<string, unknown>>)[0]!.items as Record<string, unknown>);
    });
    expectInputError(() => loadAndValidateInputs(paths), "ITEM_COUNTS_INVALID");
  });

  it("rejects a slow-row page-count change against sealed ground truth", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      (results.receipts as Array<Record<string, unknown>>)[5]!.page_count = 2;
    });
    expectInputError(() => loadAndValidateInputs(paths), "PAGE_COUNT_MISMATCH");
  });

  it.each([
    ["FADED", "STRESSED_OR_FADED|DAMAGED_OR_LOW_LIGHT", "DAMAGED_OR_LOW_LIGHT"],
    ["LONG", "CLEAN_PRINTED|LONG|FILIPINO_OR_MIXED_LANGUAGE", "CLEAN_PRINTED|FILIPINO_OR_MIXED_LANGUAGE"],
    ["fil-PH", "CLEAN_PRINTED|FILIPINO_OR_MIXED_LANGUAGE", "CLEAN_PRINTED"],
  ])("rejects an omitted cohort tag required by %s facts", (_fact, before, after) => {
    const paths = makeFixture();
    replaceManifest(paths, before, after);
    expectInputError(() => loadAndValidateInputs(paths), "COHORT_TAG_MISSING");
  });

  it("derives primary cohort membership from an eligible support row", () => {
    const paths = makeFixture();
    replaceManifest(paths, ",RECAPTURE_ROBUSTNESS,", ",SAME_RECEIPT_SUPPORT,");
    expectInputError(() => loadAndValidateInputs(paths), "COHORT_TAG_MISSING");
  });

  it("requires receipt-type or condition evidence for a sealed handwritten financial field", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[25]!;
      artifact.handwritten_fields = ["vendor"];
    });
    expectInputError(() => loadAndValidateInputs(paths), "COHORT_HANDWRITING_FACT_INVALID");
  });

  it("does not dilute handwriting financial safety rates with nonfinancial fields", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[10]!;
      (artifact.handwritten_fields as string[]).push("invoice_number");
    });
    updateJson(paths.resultsPath, (results) => {
      const fields = (results.receipts as Array<Record<string, unknown>>)[10]!.fields as Array<Record<string, unknown>>;
      fields.find((field) => field.field === "invoice_number")!.handwritten = true;
      const total = fields.find((field) => field.field === "total")!;
      total.confidence_band = "HIGH";
      total.routed_to_review = false;
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.metrics.find((metric) => metric.id === "handwritten_financial_fields_high_confidence_rate")).toMatchObject({
      numerator: 1,
      denominator: 20,
      gateStatus: "FAIL",
    });
    expect(report.metrics.find((metric) => metric.id === "handwritten_financial_fields_omitted_from_review_rate")).toMatchObject({
      numerator: 1,
      denominator: 20,
      gateStatus: "FAIL",
    });
  });

  it("requires a primary receipt to aggregate support-page handwriting applicability", () => {
    const paths = makeFixture();
    replaceManifest(paths, ",RECAPTURE_ROBUSTNESS,", ",SAME_RECEIPT_SUPPORT,");
    updateArtifactMap(paths, (artifactMap) => {
      const support = (artifactMap.artifacts as Array<Record<string, unknown>>)[30]!;
      support.applicable_fields = ["total"];
      support.handwritten_fields = ["total"];
    });
    expectInputError(() => loadAndValidateInputs(paths), "LOGICAL_RECEIPT_HANDWRITING_INVALID");
  });

  it("requires a sealed multi-frame count for a single-artifact LONG receipt", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[0]!;
      const denominator = (artifact.metric_denominators as Record<string, Record<string, unknown>>).long_reconstruction!;
      denominator.acquisition_frame_count = 1;
    });
    expect(() => loadAndValidateInputs(paths)).toThrow();
  });

  it("reports provider failures and timeouts over the complete receipt frame", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      const receipt = (results.receipts as Array<Record<string, unknown>>)[5]!;
      receipt.status = "TIMED_OUT";
      for (const field of receipt.fields as Array<Record<string, unknown>>) {
        field.exact_match = false;
        field.confidence_band = "NOT_ASSIGNED";
        field.value_state = "MISSING";
        field.routed_to_review = true;
        delete field.absolute_error_minor;
      }
      const items = receipt.items as Record<string, unknown>;
      items.predicted_items = 0;
      items.matched_items = 0;
      items.quantity_exact = 0;
      items.unit_price_exact = 0;
      items.line_total_exact = 0;
      (receipt.processed_composite as Record<string, unknown>).processed_correct_fields = 0;
      (receipt.processed_composite as Record<string, unknown>).regressed_fields = 5;
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.metrics.find((metric) => metric.id === "provider_result_timeout_rate")).toMatchObject({
      numerator: 1,
      denominator: 30,
      pointEstimate: 1 / 30,
    });
    expect(report.metrics.find((metric) => metric.id === "provider_result_success_rate")).toMatchObject({
      numerator: 29,
      denominator: 30,
    });
    expect(report.metrics.find((metric) => metric.id === "field_exact_match.total" && metric.scope === "ELIGIBLE_CONSENTED_OWNER_RECEIPTS")).toMatchObject({
      numerator: 29,
      denominator: 30,
    });
  });

  it.each(["SYNTHETIC", "PUBLIC_LICENSED"] as const)("does not let a %s primary dilute consented-owner capstone metrics", (sourceClass) => {
    const paths = makeFixture({ extraPrimarySourceClass: sourceClass });
    updateJson(paths.resultsPath, (results) => {
      const receipt = (results.receipts as Array<Record<string, unknown>>)[30]!;
      const total = (receipt.fields as Array<Record<string, unknown>>).find((field) => field.field === "total")!;
      total.exact_match = false;
      total.absolute_error_minor = 100;
      const capture = (results.captures as Array<Record<string, unknown>>)[30]!;
      capture.actual_document_count = 0;
      capture.detection_latency_ms = 999_999;
      capture.live_guidance_latency_ms = 999_999;
      (capture.corner_errors as Array<Record<string, unknown>>)[0]!.normalized_corner_error = 0.99;
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.metrics.find((metric) => metric.id === "field_exact_match.total" && metric.scope === "ELIGIBLE_CONSENTED_OWNER_RECEIPTS")).toMatchObject({
      numerator: 30,
      denominator: 30,
      pointEstimate: 1,
    });
    expect(report.metrics.find((metric) => metric.id === "provider_result_success_rate")).toMatchObject({ denominator: 30 });
    expect(report.metrics.find((metric) => metric.id === "document_detection_recall")).toMatchObject({
      numerator: 30,
      denominator: 30,
      pointEstimate: 1,
    });
    expect(report.metrics.find((metric) => metric.id === "median_normalized_corner_error")).toMatchObject({
      denominator: 30,
      pointEstimate: 0.01,
    });
    expect(report.metrics.find((metric) => metric.id === "analysis_latency_p95_ms")).toMatchObject({
      denominator: 40,
      pointEstimate: 100,
    });
  });

  it("marks capture-level gates unavailable when a capstone capture mixes receipt source populations", () => {
    const paths = makeFixture({ extraPrimarySourceClass: "PUBLIC_LICENSED" });
    replaceManifest(paths, "sample-primary-extra,receipt-extra,capture-extra", "sample-primary-extra,receipt-extra,capture-025");
    updateArtifactMap(paths, (artifactMap) => {
      const trials = (artifactMap.independent_trials as Record<string, Array<Record<string, unknown>>>).captures!;
      (artifactMap.independent_trials as Record<string, unknown>).captures = trials.filter(
        (trial) => trial.capture_attempt_id !== "capture-extra",
      );
    });
    updateJson(paths.resultsPath, (results) => {
      const captures = results.captures as Array<Record<string, unknown>>;
      const first = captures.find((capture) => capture.capture_attempt_id === "capture-025")!;
      first.actual_document_count = 2;
      (first.corner_errors as unknown[]).push({ sample_id: "sample-primary-extra", normalized_corner_error: 0.99 });
      results.captures = captures.filter((capture) => capture.capture_attempt_id !== "capture-extra");
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    for (const metricId of [
      "document_detection_precision",
      "document_detection_recall",
      "multi_receipt_count_accuracy",
      "handwritten_hard_reject_rate",
      "analysis_latency_p95_ms",
      "live_capture_guidance_latency_p95_ms",
    ]) {
      expect(report.metrics.find((metric) => metric.id === metricId)).toMatchObject({ status: "NOT_MEASURED" });
    }
    expect(report.metrics.find((metric) => metric.id === "median_normalized_corner_error")).toMatchObject({
      denominator: 30,
      pointEstimate: 0.01,
    });
    expect(report.unavailableEvidence).toContainEqual(expect.objectContaining({ id: "mixed_source_capture_analysis" }));
  });

  it("rejects non-success fields that contradict pre-result sealed applicability", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      const receipt = (results.receipts as Array<Record<string, unknown>>)[5]!;
      receipt.status = "MISSING";
      for (const field of receipt.fields as Array<Record<string, unknown>>) {
        field.applicable = false;
        field.exact_match = null;
        field.confidence_band = "NOT_ASSIGNED";
        field.value_state = "NOT_APPLICABLE";
        field.routed_to_review = false;
        delete field.absolute_error_minor;
      }
    });
    expectInputError(() => loadAndValidateInputs(paths), "FIELD_APPLICABILITY_MISMATCH");
  });

  it("allows a sealed non-applicable critical field on a non-success result", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[5]!;
      artifact.applicable_fields = (artifact.applicable_fields as string[]).filter((field) => field !== "date");
      (artifact.metric_denominators as Record<string, Record<string, unknown>>).processed_composite!.scored_financial_fields = 6;
    });
    updateJson(paths.resultsPath, (results) => {
      const receipt = (results.receipts as Array<Record<string, unknown>>)[5]!;
      receipt.status = "MISSING";
      for (const field of receipt.fields as Array<Record<string, unknown>>) {
        const applicable = field.field !== "date";
        field.applicable = applicable;
        field.exact_match = applicable ? false : null;
        field.confidence_band = "NOT_ASSIGNED";
        field.value_state = applicable ? "MISSING" : "NOT_APPLICABLE";
        field.routed_to_review = applicable;
        delete field.absolute_error_minor;
      }
      const items = receipt.items as Record<string, unknown>;
      items.predicted_items = 0;
      items.matched_items = 0;
      items.quantity_exact = 0;
      items.unit_price_exact = 0;
      items.line_total_exact = 0;
      (receipt.processed_composite as Record<string, unknown>).processed_correct_fields = 0;
      (receipt.processed_composite as Record<string, unknown>).regressed_fields = 5;
      (receipt.processed_composite as Record<string, unknown>).scored_financial_fields = 6;
    });
    expect(() => loadAndValidateInputs(paths)).not.toThrow();
  });

  it("keeps per-receipt corner observations distinct in a multi-receipt capture", () => {
    const paths = makeFixture();
    replaceManifest(paths, "capture-002", "capture-001");
    updateArtifactMap(paths, (artifactMap) => {
      const trials = (artifactMap.independent_trials as Record<string, Array<Record<string, unknown>>>).captures!;
      (artifactMap.independent_trials as Record<string, unknown>).captures = trials.filter(
        (trial) => trial.capture_attempt_id !== "capture-002",
      );
    });
    updateJson(paths.resultsPath, (results) => {
      const captures = results.captures as Array<Record<string, unknown>>;
      const first = captures.find((capture) => capture.capture_attempt_id === "capture-001")!;
      first.actual_document_count = 2;
      (first.corner_errors as unknown[]).push({ sample_id: "sample-primary-002", normalized_corner_error: 0.02 });
      results.captures = captures.filter((capture) => capture.capture_attempt_id !== "capture-002");
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.metrics.find((metric) => metric.id === "median_normalized_corner_error")).toMatchObject({
      denominator: 30,
      confidenceInterval: { resamplingUnit: "DISTINCT_RECEIPT_ID" },
    });
  });

  it("rejects duplicate sealed applicability values", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[0]!;
      (artifact.applicable_fields as string[]).push("total");
    });
    expectInputError(() => loadAndValidateInputs(paths), "ARTIFACT_APPLICABILITY_DUPLICATE");
  });

  it("rejects a release-gate eligible EXCLUDED row before it can support a pair", () => {
    const paths = makeFixture();
    replaceManifest(paths, ",RECAPTURE_ROBUSTNESS,", ",EXCLUDED,");
    expectInputError(() => loadAndValidateInputs(paths), "EXCLUDED_ROLE_ELIGIBLE");
  });

  it.each([
    ["same receipt as non-duplicate", "DUPLICATE,SAME_PURCHASE_RECAPTURE", "NON_DUPLICATE,DIFFERENT_PURCHASE"],
    ["different receipts as duplicate", "NON_DUPLICATE,DIFFERENT_PURCHASE", "DUPLICATE,SAME_PURCHASE_RECAPTURE"],
  ])("rejects pair truth that labels %s", (_label, before, after) => {
    const paths = makeFixture();
    replacePairs(paths, before, after);
    expectInputError(() => loadAndValidateInputs(paths), "PAIR_RECEIPT_IDENTITY_INVALID");
  });

  it("rejects a handwritten field outside sealed field applicability", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[10]!;
      artifact.applicable_fields = (artifact.applicable_fields as string[]).filter((field) => field !== "total");
    });
    expectInputError(() => loadAndValidateInputs(paths), "HANDWRITING_APPLICABILITY_INVALID");
  });

  it("accepts a pre-result sealed zero item count without dropping the receipt block", () => {
    const paths = makeFixture();
    updateArtifactMap(paths, (artifactMap) => {
      const artifact = (artifactMap.artifacts as Array<Record<string, unknown>>)[0]!;
      const lineItems = (artifact.metric_denominators as Record<string, Record<string, unknown>>).line_items!;
      lineItems.ground_truth_items = 0;
      lineItems.quantity_applicable = 0;
      lineItems.unit_price_applicable = 0;
      lineItems.line_total_applicable = 0;
    });
    updateJson(paths.resultsPath, (results) => {
      const items = (results.receipts as Array<Record<string, unknown>>)[0]!.items as Record<string, unknown>;
      items.ground_truth_items = 0;
      items.matched_items = 0;
      items.quantity_applicable = 0;
      items.quantity_exact = 0;
      items.unit_price_applicable = 0;
      items.unit_price_exact = 0;
      items.line_total_applicable = 0;
      items.line_total_exact = 0;
    });
    expect(() => loadAndValidateInputs(paths)).not.toThrow();
  });

  it("does not require a CLEAN condition tag for a sealed clean printed receipt", () => {
    const paths = makeFixture();
    replaceManifest(paths, ",CLEAN,CLEAN_PRINTED|FILIPINO_OR_MIXED_LANGUAGE,", ",OTHER_RECORDED,CLEAN_PRINTED|FILIPINO_OR_MIXED_LANGUAGE,");
    expect(() => loadAndValidateInputs(paths)).not.toThrow();
  });

  it("rejects scored-result run metadata that differs from the sealed run plan", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      (results.run as Record<string, unknown>).extractor_version_sha256 = "0".repeat(64);
    });
    expectInputError(() => loadAndValidateInputs(paths), "RUN_PLAN_MISMATCH");
  });

  it("rejects a result relabeled with a trial that was not predeclared", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      (results.receipts as Array<Record<string, unknown>>)[0]!.trial_id = "post-result-trial";
    });
    expectInputError(() => loadAndValidateInputs(paths), "RECEIPT_TRIAL_MISMATCH");
  });

  it("includes mapped source and ground-truth paths in the aggregate privacy guard", () => {
    const paths = makeFixture();
    const input = loadAndValidateInputs(paths);
    for (const privatePath of [paths.firstSourcePath, paths.sealPath]) {
      (input.results.run as Record<string, unknown>).extractor_version_sha256 = privatePath;
      expect(() => buildPolicyV1Report(input)).toThrow(/private identifier or path/);
    }
  });

  it("rejects arbitrary providers without a frozen provider lifecycle", () => {
    const paths = makeFixture({ provider: "VERYFI" });
    expectInputError(() => loadAndValidateInputs(paths), "PROVIDER_EVIDENCE_CONTRACT_UNSUPPORTED");
  });

  it("does not expose a cloud-override CLI flag", () => {
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const exitCode = runPolicyV1Cli(["--allow-cloud-results"]);
    write.mockRestore();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("CLI_ARGUMENT_INVALID");
  });

  it("rejects calendar-normalized invalid UTC dates", () => {
    const paths = makeFixture();
    replaceManifest(paths, "2026-09-11T00:00:00Z", "2026-02-31T00:00:00Z");
    expectInputError(() => loadAndValidateInputs(paths), "UTC_TIMESTAMP_INVALID");
  });

  it("rejects a path-shaped opaque storage reference", () => {
    const paths = makeFixture();
    replaceManifest(paths, "vault:sample-primary-001", "private/sample-primary-001");
    expectInputError(() => loadAndValidateInputs(paths), "PRIVATE_REFERENCE_INVALID");
  });

  it("rejects a wrong total without absolute-error evidence", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      const receipt = (results.receipts as Array<Record<string, unknown>>)[0]!;
      const total = (receipt.fields as Array<Record<string, unknown>>).find((field) => field.field === "total")!;
      total.exact_match = false;
      delete total.absolute_error_minor;
    });
    expectInputError(() => loadAndValidateInputs(paths), "TOTAL_ABSOLUTE_ERROR_MISSING");
  });

  it("does not fabricate absolute error for a successful result with a missing total", () => {
    const paths = makeFixture();
    updateJson(paths.resultsPath, (results) => {
      const receipt = (results.receipts as Array<Record<string, unknown>>)[0]!;
      const total = (receipt.fields as Array<Record<string, unknown>>).find((field) => field.field === "total")!;
      total.exact_match = false;
      total.value_state = "MISSING";
      delete total.absolute_error_minor;
    });
    const report = buildPolicyV1Report(loadAndValidateInputs(paths));
    expect(report.metrics.find((metric) => metric.id === "field_exact_match.total" && metric.scope === "ELIGIBLE_CONSENTED_OWNER_RECEIPTS")).toMatchObject({
      numerator: 29,
      denominator: 30,
    });
  });

  it("pins the repository policy bytes before following policy-owned paths", () => {
    const paths = makeFixture();
    const alteredRoot = join(paths.directory, "altered-repository");
    mkdirSync(join(alteredRoot, "docs/phase-0"), { recursive: true });
    writeFileSync(join(alteredRoot, "docs/phase-0/benchmark-policy-v1.json"), "{}\n");
    expectInputError(() => loadAndValidateInputs({ ...paths, repositoryRoot: alteredRoot }), "POLICY_FILE_HASH_MISMATCH");
  });

  it("prints a sanitized stable failure without a caller path or sample ID", () => {
    const paths = makeFixture();
    writeFileSync(paths.firstSourcePath, "changed private bytes");
    let stderr = "";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const exitCode = runPolicyV1Cli([
      "--manifest", paths.manifestPath,
      "--pairs", paths.pairLabelsPath,
      "--artifact-map", paths.artifactMapPath,
      "--seal", paths.sealPath,
      "--ground-truth-bundle", paths.groundTruthBundlePath,
      "--results", paths.resultsPath,
      "--output", paths.outputPath,
    ]);
    write.mockRestore();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SOURCE_HASH_MISMATCH");
    expect(stderr).not.toContain(paths.firstSourcePath);
    expect(stderr).not.toContain("sample-primary-001");
  });

  it("rejects a reviewer pair that does not declare two distinct custodians", () => {
    const paths = makeFixture({ sameReviewer: true });
    expectInputError(() => loadAndValidateInputs(paths), "REVIEWER_SEPARATION_INVALID");
  });
});
