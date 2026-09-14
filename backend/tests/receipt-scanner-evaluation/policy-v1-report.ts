import { writeFileSync } from "node:fs";
import { CohortTag, COHORT_TAGS, FieldName, FIELD_NAMES, ReceiptObservation } from "./policy-v1-contract";
import {
  bootstrapClusteredPercentile95,
  bootstrapPercentile95,
  bootstrapRatio95,
  ConfidenceInterval,
  percentile,
  wilson95,
} from "./policy-v1-statistics";
import { isLocalProvider, ValidatedInputs } from "./policy-v1-validation";

type GateStatus = "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_MEASURED";

interface Threshold {
  operator: ">=" | "<=" | "=";
  value: number;
}

export interface MetricReport {
  id: string;
  scope: string;
  status: "MEASURED" | "NOT_MEASURED";
  numerator: number | null;
  denominator: number | null;
  pointEstimate: number | null;
  confidenceInterval: ConfidenceInterval | null;
  threshold: Threshold | null;
  gateStatus: GateStatus;
  unit: "PROPORTION" | "MILLISECONDS" | "MINOR_CURRENCY_UNITS" | "COUNT";
  reason?: string;
}

interface CorpusGate {
  id: string;
  decision: "CAPSTONE" | "PROVIDER_PROMOTION" | "DUPLICATE_PROMOTION";
  observed: number;
  threshold: Threshold;
  gateStatus: "PASS" | "FAIL";
}

interface ConfidenceBandReport {
  field: FieldName;
  cohort: CohortTag;
  scope: string;
  supportFloor: number;
  applicablePredictions: number;
  uncalibratedPredictions: number;
  bands: Array<{
    band: "HIGH" | "MEDIUM" | "LOW";
    errors: number;
    predictions: number;
    errorRate: number | null;
    confidenceInterval: ConfidenceInterval | null;
    supportStatus: "CALIBRATED" | "UNCALIBRATED" | "NO_PREDICTIONS";
  }>;
  monotonicErrorRate: boolean | null;
  gateStatus: GateStatus;
}

export interface PolicyV1Report {
  schemaVersion: "finsight-receipt-policy-v1-aggregate-report-v1";
  generatedAtUtc: string;
  policy: {
    id: string;
    status: string;
    sha256: string;
    normativeArtifactsVerified: true;
  };
  run: {
    purpose: string;
    provider: string;
    providerKind: "LOCAL" | "CLOUD";
    extractorVersionSha256: string;
    declaredHardwareSha256: string;
    coldOrWarm: "COLD" | "WARM";
    resultsOpenedAtUtc: string;
    plannedReviewEndAtUtc: string;
  };
  seals: {
    sealedAtUtc: string;
    manifestSha256: string;
    pairLabelsSha256: string;
    artifactMapSha256: string;
    groundTruthBundleSha256: string;
    scoredResultsSha256: string;
  };
  corpus: {
    eligibleRows: number;
    consentedRealReceipts: number;
    providerPromotionRealReceipts: number;
    eligibleNonReceipts: number;
    eligibleDuplicatePairs: number;
    eligibleNonDuplicatePairs: number;
    cohortReceiptCounts: Record<string, number>;
    providerPromotionCohortReceiptCounts: Record<string, number>;
    maximumVendorTemplateShare: number | null;
    captureModeCounts: Record<string, number>;
    gates: CorpusGate[];
  };
  metrics: MetricReport[];
  confidenceBands: ConfidenceBandReport[];
  unavailableEvidence: Array<{ id: string; status: "NOT_MEASURED"; reason: string }>;
  decision: {
    capstoneCorpusStatus: "PASS" | "FAIL";
    providerPromotionCorpusStatus: "PASS" | "FAIL";
    duplicatePromotionCorpusStatus: "PASS" | "FAIL";
    providerPromotionStatus: "PASS" | "FAIL" | "INCOMPLETE";
    duplicatePromotionStatus: "PASS" | "FAIL" | "INCOMPLETE";
    capstoneCorpusBlockers: string[];
    providerPromotionCorpusBlockers: string[];
    duplicatePromotionCorpusBlockers: string[];
    providerPromotionBlockers: string[];
    duplicatePromotionBlockers: string[];
    measuredMetricStatus: "PASS" | "FAIL" | "INCOMPLETE";
    phase2AcceptanceStatus: "OPEN";
    productionAccuracyClaimSupported: false;
    blockers: string[];
  };
  privacy: {
    aggregateOnly: true;
    containsSampleIdentifiers: false;
    containsReceiptTextOrFieldValues: false;
    containsPrivatePathsOrStorageReferences: false;
    outputOutsideRepository: true;
  };
}

const CRITICAL_FIELDS = new Set<FieldName>(["vendor", "date", "currency_code", "total"]);
const FINANCIAL_FIELDS = new Set<FieldName>([...CRITICAL_FIELDS, "subtotal", "tax", "discount"]);
const BOOTSTRAP_UNIT = "DISTINCT_RECEIPT_ID" as const;

function compareOpaqueIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function receiptSourceInMetricPopulation(input: ValidatedInputs, sourceClass: string): boolean {
  return input.results.run.purpose === "CAPSTONE_DEMO"
    ? sourceClass === "CONSENTED_OWNER"
    : sourceClass === "CONSENTED_OWNER" || sourceClass === "PUBLIC_LICENSED";
}

function receiptMetricScope(input: ValidatedInputs): string {
  return input.results.run.purpose === "CAPSTONE_DEMO"
    ? "ELIGIBLE_CONSENTED_OWNER_RECEIPTS"
    : "ELIGIBLE_REAL_RECEIPTS";
}

function captureMetricScope(input: ValidatedInputs): string {
  return `${receiptMetricScope(input)}_CAPTURES_PLUS_ELIGIBLE_NON_RECEIPTS`;
}

function scopedReceiptMetric(metric: MetricReport, baseScope: string): MetricReport {
  let detail = "";
  if (metric.id.includes("handwriting") || metric.id.includes("handwritten_")) {
    detail = ";COHORT:HANDWRITTEN_OR_HAND_ANNOTATED";
  } else if (metric.id.startsWith("long_receipt_") || metric.id.startsWith("known_truncated_")) {
    detail = ";COHORT:LONG";
  } else if (metric.id.startsWith("stressed_")) {
    detail = ";COHORT:STRESSED_OR_FADED";
  } else if (metric.id.startsWith("clean_")) {
    detail = ";COHORT:CLEAN_PRINTED";
  }
  return { ...metric, scope: `${baseScope}${detail}` };
}

function passes(value: number, threshold: Threshold): boolean {
  if (threshold.operator === ">=") return value >= threshold.value;
  if (threshold.operator === "<=") return value <= threshold.value;
  return value === threshold.value;
}

function measuredRatio(
  id: string,
  numerator: number,
  denominator: number,
  threshold: Threshold | null,
  scope = "ALL_ELIGIBLE",
): MetricReport {
  if (denominator === 0) {
    return {
      id,
      scope,
      status: "NOT_MEASURED",
      numerator: 0,
      denominator: 0,
      pointEstimate: null,
      confidenceInterval: null,
      threshold,
      gateStatus: "NOT_MEASURED",
      unit: "PROPORTION",
      reason: "No applicable scored observations",
    };
  }
  const pointEstimate = numerator / denominator;
  return {
    id,
    scope,
    status: "MEASURED",
    numerator,
    denominator,
    pointEstimate,
    confidenceInterval: wilson95(numerator, denominator),
    threshold,
    gateStatus: threshold ? (passes(pointEstimate, threshold) ? "PASS" : "FAIL") : "NOT_APPLICABLE",
    unit: "PROPORTION",
  };
}

function notMeasured(
  id: string,
  reason: string,
  threshold: Threshold | null = null,
  unit: MetricReport["unit"] = "PROPORTION",
  scope = "ALL_ELIGIBLE",
): MetricReport {
  return {
    id,
    scope,
    status: "NOT_MEASURED",
    numerator: null,
    denominator: null,
    pointEstimate: null,
    confidenceInterval: null,
    threshold,
    gateStatus: "NOT_MEASURED",
    unit,
    reason,
  };
}

function fieldThreshold(cohort: CohortTag, field: FieldName): Threshold | null {
  if (cohort === "CLEAN_PRINTED") {
    const values: Partial<Record<FieldName, number>> = { total: 0.95, currency_code: 0.95, vendor: 0.9, date: 0.9 };
    return values[field] === undefined ? null : { operator: ">=", value: values[field]! };
  }
  if (cohort === "STRESSED_OR_FADED" && field === "total") return { operator: ">=", value: 0.85 };
  return null;
}

function bootstrapRatioMetric(
  id: string,
  clusters: Array<{ numerator: number; denominator: number }>,
  seed: number,
  resamples: number,
  threshold: Threshold | null = null,
  unit: MetricReport["unit"] = "PROPORTION",
  scope = "ALL_ELIGIBLE",
): MetricReport {
  const usable = clusters.filter((cluster) => cluster.denominator > 0);
  const numerator = usable.reduce((sum, cluster) => sum + cluster.numerator, 0);
  const denominator = usable.reduce((sum, cluster) => sum + cluster.denominator, 0);
  if (usable.length === 0) return notMeasured(id, "No applicable receipt-level observations", threshold, unit);
  const pointEstimate = numerator / denominator;
  return {
    id,
    scope,
    status: "MEASURED",
    numerator,
    denominator,
    pointEstimate,
    confidenceInterval: bootstrapRatio95(usable, { seed, resamples, resamplingUnit: BOOTSTRAP_UNIT }),
    threshold,
    gateStatus: threshold ? (passes(pointEstimate, threshold) ? "PASS" : "FAIL") : "NOT_APPLICABLE",
    unit,
  };
}

function percentileMetric(
  id: string,
  values: number[],
  targetPercentile: number,
  seed: number,
  resamples: number,
  threshold: Threshold,
): MetricReport {
  const pointEstimate = percentile(values, targetPercentile);
  if (pointEstimate === null) return notMeasured(id, "No declared independent trials supplied", threshold, "MILLISECONDS");
  return {
    id,
    scope: "ALL_ELIGIBLE",
    status: "MEASURED",
    numerator: null,
    denominator: values.length,
    pointEstimate,
    confidenceInterval: bootstrapPercentile95(values, targetPercentile, { seed, resamples }),
    threshold,
    gateStatus: passes(pointEstimate, threshold) ? "PASS" : "FAIL",
    unit: "MILLISECONDS",
  };
}

function receiptCohorts(input: ValidatedInputs, receipt: ReceiptObservation): CohortTag[] {
  const row = input.primaryBySampleId.get(receipt.sample_id)!;
  return row.cohort_tags === "NOT_APPLICABLE" ? [] : row.cohort_tags.split("|") as CohortTag[];
}

function fieldMetric(
  receipts: ReceiptObservation[],
  field: FieldName,
  scope: string,
  threshold: Threshold | null = null,
): MetricReport {
  const fields = receipts.flatMap((receipt) => receipt.fields.filter((candidate) => candidate.field === field && candidate.applicable));
  return measuredRatio(
    `field_exact_match.${field}`,
    fields.filter((candidate) => candidate.exact_match === true).length,
    fields.length,
    threshold,
    scope,
  );
}

function buildFieldMetrics(input: ValidatedInputs, receipts: ReceiptObservation[], baseScope: string): MetricReport[] {
  if (receipts.length === 0) {
    const metrics = FIELD_NAMES.map((field) => notMeasured(
      `field_exact_match.${field}`,
      "No complete receipt result collection supplied",
      null,
      "PROPORTION",
      baseScope,
    ));
    for (const cohort of COHORT_TAGS) {
      for (const field of FIELD_NAMES) {
        metrics.push(notMeasured(
          `field_exact_match.${field}`,
          "No complete receipt result collection supplied",
          fieldThreshold(cohort, field),
          "PROPORTION",
          `${baseScope};COHORT:${cohort}`,
        ));
      }
    }
    const captureModes = [...new Set(
      [...input.primaryBySampleId.values()]
        .filter((row) => receiptSourceInMetricPopulation(input, row.source_class))
        .map((row) => row.capture_mode),
    )].sort();
    for (const mode of captureModes) {
      for (const field of FIELD_NAMES) {
        metrics.push(notMeasured(
          `field_exact_match.${field}`,
          "No complete receipt result collection supplied",
          null,
          "PROPORTION",
          `${baseScope};CAPTURE_MODE:${mode}`,
        ));
      }
    }
    return metrics;
  }
  const metrics: MetricReport[] = [];
  for (const field of FIELD_NAMES) metrics.push(fieldMetric(receipts, field, baseScope));
  for (const cohort of COHORT_TAGS) {
    const group = receipts.filter((receipt) => receiptCohorts(input, receipt).includes(cohort));
    for (const field of FIELD_NAMES) {
      metrics.push(fieldMetric(group, field, `${baseScope};COHORT:${cohort}`, fieldThreshold(cohort, field)));
    }
  }
  const captureModes = [...new Set(
    [...input.primaryBySampleId.values()]
      .filter((row) => receiptSourceInMetricPopulation(input, row.source_class))
      .map((row) => row.capture_mode),
  )].sort();
  for (const mode of captureModes) {
    const group = receipts.filter((receipt) => input.primaryBySampleId.get(receipt.sample_id)!.capture_mode === mode);
    for (const field of FIELD_NAMES) metrics.push(fieldMetric(group, field, `${baseScope};CAPTURE_MODE:${mode}`));
  }
  return metrics;
}

function buildCaptureMetrics(input: ValidatedInputs): MetricReport[] {
  const scope = captureMetricScope(input);
  const allCaptures = [...(input.results.captures ?? [])]
    .sort((left, right) => compareOpaqueIds(left.capture_attempt_id, right.capture_attempt_id));
  const populationPrimaryRows = (captureAttemptId: string) => input.eligibleCaptureRows
    .get(captureAttemptId)!
    .filter((row) => row.benchmark_count_role === "PRIMARY_RECEIPT" && receiptSourceInMetricPopulation(input, row.source_class));
  const hasEligibleNonReceipt = (captureAttemptId: string) => input.eligibleCaptureRows
    .get(captureAttemptId)!
    .some((row) => row.benchmark_count_role === "NON_RECEIPT");
  const hasOutOfPopulationPrimary = (captureAttemptId: string) => input.eligibleCaptureRows
    .get(captureAttemptId)!
    .some((row) => row.benchmark_count_role === "PRIMARY_RECEIPT" && !receiptSourceInMetricPopulation(input, row.source_class));
  const captures = allCaptures.filter((capture) =>
    populationPrimaryRows(capture.capture_attempt_id).length > 0 || hasEligibleNonReceipt(capture.capture_attempt_id)
  );
  const missingReason = allCaptures.length === 0
    ? "No complete capture observation collection supplied"
    : "No capture observations belong to the declared receipt metric population or eligible non-receipt frame";
  if (captures.length === 0) {
    return [
      notMeasured("document_detection_precision", missingReason, { operator: ">=", value: input.policy.existingScannerHarnessGates.documentPrecisionMin }),
      notMeasured("document_detection_recall", missingReason, { operator: ">=", value: input.policy.existingScannerHarnessGates.documentRecallMin }),
      notMeasured("obvious_non_receipt_false_trigger_rate", missingReason, { operator: "<=", value: input.policy.existingScannerHarnessGates.obviousNonReceiptFalseTriggerMax }),
      notMeasured("multi_receipt_count_accuracy", missingReason, { operator: ">=", value: input.policy.existingScannerHarnessGates.multiReceiptCountAccuracyMin }),
      notMeasured("median_normalized_corner_error", missingReason, { operator: "<=", value: input.policy.existingScannerHarnessGates.medianNormalizedCornerErrorMax }),
      notMeasured("handwritten_hard_reject_rate", missingReason, { operator: "<=", value: input.policy.existingScannerHarnessGates.handwrittenHardRejectMax }),
      notMeasured("analysis_latency_p95_ms", missingReason, { operator: "<=", value: input.policy.existingScannerHarnessGates.analysisLatencyP95MillisecondsMax }, "MILLISECONDS"),
      notMeasured("live_capture_guidance_latency_p95_ms", missingReason, { operator: "<=", value: input.policy.performanceGates.liveCaptureGuidanceP95MillisecondsMax }, "MILLISECONDS"),
    ].map((metric) => ({ ...metric, scope }));
  }

  const expectedCount = (captureAttemptId: string) => new Set(
    populationPrimaryRows(captureAttemptId).map((row) => row.receipt_id),
  ).size;
  const receiptCaptures = captures.filter((capture) => expectedCount(capture.capture_attempt_id) > 0);
  const nonReceiptCaptures = captures.filter((capture) =>
    expectedCount(capture.capture_attempt_id) === 0 && hasEligibleNonReceipt(capture.capture_attempt_id)
  );
  const mixedSourceCaptures = receiptCaptures.filter((capture) => hasOutOfPopulationPrimary(capture.capture_attempt_id));
  const mixedSourceReason = "A capture mixes in-scope and out-of-scope receipt sources, so its capture-level outcome cannot be attributed safely";
  const trueDetections = receiptCaptures.filter((capture) => capture.actual_document_count > 0).length;
  const falseDetections = nonReceiptCaptures.filter((capture) => capture.actual_document_count > 0).length;
  const handwrittenCaptures = receiptCaptures.filter((capture) =>
    populationPrimaryRows(capture.capture_attempt_id)
      .some((row) => row.cohort_tags.split("|").includes("HANDWRITTEN_OR_HAND_ANNOTATED")),
  );
  const cornerErrorsByReceipt = new Map<string, number[]>();
  for (const capture of receiptCaptures) {
    for (const corner of capture.corner_errors ?? []) {
      const primary = input.primaryBySampleId.get(corner.sample_id)!;
      if (!receiptSourceInMetricPopulation(input, primary.source_class)) continue;
      const receiptId = primary.receipt_id;
      const errors = cornerErrorsByReceipt.get(receiptId) ?? [];
      errors.push(corner.normalized_corner_error);
      cornerErrorsByReceipt.set(receiptId, errors);
    }
  }
  const cornerErrorClusters = [...cornerErrorsByReceipt.entries()]
    .sort(([left], [right]) => compareOpaqueIds(left, right))
    .map(([, errors]) => errors);
  const cornerErrors = cornerErrorClusters.flat();
  const seed = input.policy.reporting.confidenceIntervals.bootstrapSeed;
  const resamples = input.policy.reporting.confidenceIntervals.bootstrapResamples;
  const medianCornerError = percentile(cornerErrors, 0.5);
  const metrics: MetricReport[] = [
    mixedSourceCaptures.length
      ? notMeasured("document_detection_precision", mixedSourceReason, { operator: ">=", value: input.policy.existingScannerHarnessGates.documentPrecisionMin })
      : measuredRatio("document_detection_precision", trueDetections, trueDetections + falseDetections, { operator: ">=", value: input.policy.existingScannerHarnessGates.documentPrecisionMin }),
    mixedSourceCaptures.length
      ? notMeasured("document_detection_recall", mixedSourceReason, { operator: ">=", value: input.policy.existingScannerHarnessGates.documentRecallMin })
      : measuredRatio("document_detection_recall", trueDetections, receiptCaptures.length, { operator: ">=", value: input.policy.existingScannerHarnessGates.documentRecallMin }),
    measuredRatio(
      "obvious_non_receipt_false_trigger_rate",
      nonReceiptCaptures.filter((capture) => capture.likelihood_outcome !== "OBVIOUS_NON_RECEIPT").length,
      nonReceiptCaptures.length,
      { operator: "<=", value: input.policy.existingScannerHarnessGates.obviousNonReceiptFalseTriggerMax },
    ),
    mixedSourceCaptures.length
      ? notMeasured("multi_receipt_count_accuracy", mixedSourceReason, { operator: ">=", value: input.policy.existingScannerHarnessGates.multiReceiptCountAccuracyMin })
      : measuredRatio(
          "multi_receipt_count_accuracy",
          captures.filter((capture) => capture.actual_document_count === expectedCount(capture.capture_attempt_id)).length,
          captures.length,
          { operator: ">=", value: input.policy.existingScannerHarnessGates.multiReceiptCountAccuracyMin },
        ),
    medianCornerError === null
      ? notMeasured("median_normalized_corner_error", "No normalized corner-error observations supplied", { operator: "<=", value: input.policy.existingScannerHarnessGates.medianNormalizedCornerErrorMax })
      : {
          id: "median_normalized_corner_error",
          scope,
          status: "MEASURED",
          numerator: null,
          denominator: cornerErrors.length,
          pointEstimate: medianCornerError,
          confidenceInterval: bootstrapClusteredPercentile95(cornerErrorClusters, 0.5, { seed, resamples }),
          threshold: { operator: "<=", value: input.policy.existingScannerHarnessGates.medianNormalizedCornerErrorMax },
          gateStatus: medianCornerError <= input.policy.existingScannerHarnessGates.medianNormalizedCornerErrorMax ? "PASS" : "FAIL",
          unit: "PROPORTION",
        },
    mixedSourceCaptures.length
      ? notMeasured("handwritten_hard_reject_rate", mixedSourceReason, { operator: "<=", value: input.policy.existingScannerHarnessGates.handwrittenHardRejectMax })
      : measuredRatio(
          "handwritten_hard_reject_rate",
          handwrittenCaptures.filter((capture) => capture.likelihood_outcome === "OBVIOUS_NON_RECEIPT").length,
          handwrittenCaptures.length,
          { operator: "<=", value: input.policy.existingScannerHarnessGates.handwrittenHardRejectMax },
        ),
    mixedSourceCaptures.length
      ? notMeasured("analysis_latency_p95_ms", mixedSourceReason, { operator: "<=", value: input.policy.existingScannerHarnessGates.analysisLatencyP95MillisecondsMax }, "MILLISECONDS")
      : percentileMetric(
          "analysis_latency_p95_ms",
          captures.flatMap((capture) => capture.detection_latency_ms === undefined ? [] : [capture.detection_latency_ms]),
          0.95,
          seed,
          resamples,
          { operator: "<=", value: input.policy.existingScannerHarnessGates.analysisLatencyP95MillisecondsMax },
        ),
    mixedSourceCaptures.length
      ? notMeasured("live_capture_guidance_latency_p95_ms", mixedSourceReason, { operator: "<=", value: input.policy.performanceGates.liveCaptureGuidanceP95MillisecondsMax }, "MILLISECONDS")
      : percentileMetric(
          "live_capture_guidance_latency_p95_ms",
          captures.flatMap((capture) => capture.live_guidance_latency_ms === undefined ? [] : [capture.live_guidance_latency_ms]),
          0.95,
          seed,
          resamples,
          { operator: "<=", value: input.policy.performanceGates.liveCaptureGuidanceP95MillisecondsMax },
        ),
  ];
  return metrics.map((metric) => ({ ...metric, scope }));
}

function buildReceiptMetrics(input: ValidatedInputs, receipts: ReceiptObservation[], baseScope: string): MetricReport[] {
  const seed = input.policy.reporting.confidenceIntervals.bootstrapSeed;
  const resamples = input.policy.reporting.confidenceIntervals.bootstrapResamples;
  if (receipts.length === 0) {
    const metrics = [
      notMeasured("provider_result_success_rate", "No complete receipt result collection supplied"),
      notMeasured("provider_result_failure_rate", "No complete receipt result collection supplied"),
      notMeasured("provider_result_timeout_rate", "No complete receipt result collection supplied"),
      notMeasured("provider_result_missing_rate", "No complete receipt result collection supplied"),
      notMeasured("one_page_local_result_latency_p95_ms", "No complete receipt result collection supplied", { operator: "<=", value: input.policy.performanceGates.onePageLocalResultP95MillisecondsMax }, "MILLISECONDS"),
      notMeasured("character_error_rate.handwriting", "No handwriting text-error counts supplied"),
      notMeasured("word_error_rate.handwriting", "No handwriting text-error counts supplied"),
      notMeasured("line_item_precision", "No line-item counts supplied"),
      notMeasured("line_item_recall", "No line-item counts supplied"),
      notMeasured("item_quantity_exact_match", "No line-item counts supplied"),
      notMeasured("item_unit_price_exact_match", "No line-item counts supplied"),
      notMeasured("item_line_total_exact_match", "No line-item counts supplied"),
      notMeasured("manual_field_correction_rate", "No correction counts supplied"),
      notMeasured("manual_item_correction_rate", "No correction counts supplied"),
      notMeasured("long_receipt_line_recall", "No long-receipt reconstruction counts supplied", { operator: ">=", value: input.policy.receiptGates.longReceipt.lineRecallMin }),
      notMeasured("long_receipt_line_order_accuracy", "No long-receipt reconstruction counts supplied", { operator: ">=", value: input.policy.receiptGates.longReceipt.lineOrderAccuracyMin }),
      notMeasured("long_receipt_duplicated_line_rate", "No long-receipt reconstruction counts supplied", { operator: "<=", value: input.policy.receiptGates.longReceipt.duplicatedLineRateMax }),
      notMeasured("known_truncated_scans_marked_complete_rate", "No long-receipt reconstruction counts supplied", { operator: "<=", value: input.policy.receiptGates.longReceipt.knownTruncatedScansMarkedCompleteMax }),
      notMeasured("handwritten_financial_fields_high_confidence_rate", "No handwriting field scores supplied", { operator: "<=", value: input.policy.receiptGates.handwriting.highConfidenceFinancialFieldsMax as number }),
      notMeasured("handwritten_financial_fields_omitted_from_review_rate", "No handwriting field scores supplied", { operator: "<=", value: input.policy.receiptGates.handwriting.financialFieldsOmittedFromFocusedReviewMax as number }),
      notMeasured("stressed_missing_or_conflicting_critical_values_routed_to_review", "No stressed receipt field scores supplied", { operator: ">=", value: input.policy.receiptGates.stressedPrinted.missingOrConflictingCriticalValuesRoutedToReviewMin }),
      notMeasured("stressed_currency_correct_or_routed_to_review", "No stressed receipt field scores supplied", { operator: ">=", value: input.policy.receiptGates.stressedPrinted.currencyCorrectOrRoutedToFocusedReviewMin }),
      notMeasured("clean_incorrect_currency_high_confidence_rate", "No clean receipt field scores supplied", { operator: "<=", value: input.policy.receiptGates.cleanPrinted.incorrectCurrencyCodeGivenHighConfidenceMax }),
      notMeasured("stressed_incorrect_currency_high_confidence_rate", "No stressed receipt field scores supplied", { operator: "<=", value: input.policy.receiptGates.stressedPrinted.incorrectCurrencyCodeGivenHighConfidenceMax }),
      notMeasured("processed_composite_gain", "No paired processed-composite counts supplied", { operator: ">=", value: input.policy.existingScannerHarnessGates.processedCompositeGainMin }),
      notMeasured("financial_field_regression_rate", "No paired processed-composite counts supplied", { operator: "<=", value: input.policy.existingScannerHarnessGates.financialFieldRegressionMax }),
      notMeasured("absolute_total_error_minor_when_wrong", "No complete receipt result collection supplied", null, "MINOR_CURRENCY_UNITS"),
    ];
    return metrics.map((metric) => scopedReceiptMetric(metric, baseScope));
  }

  const handwriting = receipts.filter((receipt) => receiptCohorts(input, receipt).includes("HANDWRITTEN_OR_HAND_ANNOTATED"));
  const longReceipts = receipts.filter((receipt) => receiptCohorts(input, receipt).includes("LONG"));
  const textClusters = handwriting.flatMap((receipt) => receipt.text ? [receipt.text] : []);
  const itemClusters = receipts.flatMap((receipt) => receipt.items ? [receipt.items] : []);
  const correctionClusters = receipts.flatMap((receipt) => receipt.corrections ? [receipt.corrections] : []);
  const reconstruction = longReceipts.flatMap((receipt) => receipt.reconstruction ? [receipt.reconstruction] : []);
  const processed = receipts.flatMap((receipt) => receipt.processed_composite ? [receipt.processed_composite] : []);
  const handwrittenFields = handwriting.flatMap((receipt) => receipt.fields.filter((field) =>
    field.applicable && field.handwritten && FINANCIAL_FIELDS.has(field.field)
  ));
  const stressed = receipts.filter((receipt) => receiptCohorts(input, receipt).includes("STRESSED_OR_FADED"));
  const stressedCritical = stressed.flatMap((receipt) => receipt.fields.filter((field) => field.applicable && CRITICAL_FIELDS.has(field.field)));
  const stressedMissing = stressedCritical.filter((field) => field.value_state === "MISSING" || field.value_state === "CONFLICTING");
  const stressedCurrency = stressed.flatMap((receipt) => receipt.fields.filter((field) => field.field === "currency_code" && field.applicable));
  const currencyFor = (cohort: CohortTag) => receipts
    .filter((receipt) => receiptCohorts(input, receipt).includes(cohort))
    .flatMap((receipt) => receipt.fields.filter((field) => field.field === "currency_code" && field.applicable));
  const cleanCurrency = currencyFor("CLEAN_PRINTED");

  const metrics = [
    measuredRatio("provider_result_success_rate", receipts.filter((receipt) => receipt.status === "SUCCESS").length, receipts.length, null),
    measuredRatio("provider_result_failure_rate", receipts.filter((receipt) => receipt.status === "FAILED").length, receipts.length, null),
    measuredRatio("provider_result_timeout_rate", receipts.filter((receipt) => receipt.status === "TIMED_OUT").length, receipts.length, null),
    measuredRatio("provider_result_missing_rate", receipts.filter((receipt) => receipt.status === "MISSING").length, receipts.length, null),
    percentileMetric(
      "one_page_local_result_latency_p95_ms",
      isLocalProvider(input.results.run.provider)
        ? receipts.filter((receipt) => receipt.page_count === 1).flatMap((receipt) => receipt.local_result_latency_ms === undefined ? [] : [receipt.local_result_latency_ms])
        : [],
      0.95,
      seed,
      resamples,
      { operator: "<=", value: input.policy.performanceGates.onePageLocalResultP95MillisecondsMax },
    ),
    bootstrapRatioMetric("character_error_rate.handwriting", textClusters.map((text) => ({ numerator: text.character_errors, denominator: text.ground_truth_characters })), seed, resamples),
    bootstrapRatioMetric("word_error_rate.handwriting", textClusters.map((text) => ({ numerator: text.word_errors, denominator: text.ground_truth_words })), seed, resamples),
    bootstrapRatioMetric("line_item_precision", itemClusters.map((items) => ({ numerator: items.matched_items, denominator: items.predicted_items })), seed, resamples),
    bootstrapRatioMetric("line_item_recall", itemClusters.map((items) => ({ numerator: items.matched_items, denominator: items.ground_truth_items })), seed, resamples),
    bootstrapRatioMetric("item_quantity_exact_match", itemClusters.map((items) => ({ numerator: items.quantity_exact, denominator: items.quantity_applicable })), seed, resamples),
    bootstrapRatioMetric("item_unit_price_exact_match", itemClusters.map((items) => ({ numerator: items.unit_price_exact, denominator: items.unit_price_applicable })), seed, resamples),
    bootstrapRatioMetric("item_line_total_exact_match", itemClusters.map((items) => ({ numerator: items.line_total_exact, denominator: items.line_total_applicable })), seed, resamples),
    bootstrapRatioMetric("manual_field_correction_rate", correctionClusters.map((counts) => ({ numerator: counts.changed_fields, denominator: counts.reviewed_fields })), seed, resamples),
    bootstrapRatioMetric("manual_item_correction_rate", correctionClusters.map((counts) => ({ numerator: counts.changed_items, denominator: counts.reviewed_items })), seed, resamples),
    bootstrapRatioMetric("long_receipt_line_recall", reconstruction.map((counts) => ({ numerator: counts.matched_lines, denominator: counts.ground_truth_lines })), seed, resamples, { operator: ">=", value: input.policy.receiptGates.longReceipt.lineRecallMin }),
    bootstrapRatioMetric("long_receipt_line_order_accuracy", reconstruction.map((counts) => ({ numerator: counts.ordered_lines, denominator: counts.ground_truth_lines })), seed, resamples, { operator: ">=", value: input.policy.receiptGates.longReceipt.lineOrderAccuracyMin }),
    bootstrapRatioMetric(
      "long_receipt_duplicated_line_rate",
      reconstruction.map((counts) => ({ numerator: counts.duplicated_lines, denominator: counts.matched_lines + counts.duplicated_lines })),
      seed,
      resamples,
      { operator: "<=", value: input.policy.receiptGates.longReceipt.duplicatedLineRateMax },
    ),
    measuredRatio(
      "known_truncated_scans_marked_complete_rate",
      reconstruction.filter((counts) => counts.known_truncated && counts.marked_complete).length,
      reconstruction.filter((counts) => counts.known_truncated).length,
      { operator: "<=", value: input.policy.receiptGates.longReceipt.knownTruncatedScansMarkedCompleteMax },
    ),
    measuredRatio(
      "handwritten_financial_fields_high_confidence_rate",
      handwrittenFields.filter((field) => field.confidence_band === "HIGH").length,
      handwrittenFields.length,
      { operator: "<=", value: input.policy.receiptGates.handwriting.highConfidenceFinancialFieldsMax as number },
    ),
    measuredRatio(
      "handwritten_financial_fields_omitted_from_review_rate",
      handwrittenFields.filter((field) => !field.routed_to_review).length,
      handwrittenFields.length,
      { operator: "<=", value: input.policy.receiptGates.handwriting.financialFieldsOmittedFromFocusedReviewMax as number },
    ),
    measuredRatio(
      "stressed_missing_or_conflicting_critical_values_routed_to_review",
      stressedMissing.filter((field) => field.routed_to_review).length,
      stressedMissing.length,
      { operator: ">=", value: input.policy.receiptGates.stressedPrinted.missingOrConflictingCriticalValuesRoutedToReviewMin },
    ),
    measuredRatio(
      "stressed_currency_correct_or_routed_to_review",
      stressedCurrency.filter((field) => field.exact_match === true || field.routed_to_review).length,
      stressedCurrency.length,
      { operator: ">=", value: input.policy.receiptGates.stressedPrinted.currencyCorrectOrRoutedToFocusedReviewMin },
    ),
    measuredRatio(
      "clean_incorrect_currency_high_confidence_rate",
      cleanCurrency.filter((field) => field.exact_match === false && field.confidence_band === "HIGH").length,
      cleanCurrency.length,
      { operator: "<=", value: input.policy.receiptGates.cleanPrinted.incorrectCurrencyCodeGivenHighConfidenceMax },
    ),
    measuredRatio(
      "stressed_incorrect_currency_high_confidence_rate",
      stressedCurrency.filter((field) => field.exact_match === false && field.confidence_band === "HIGH").length,
      stressedCurrency.length,
      { operator: "<=", value: input.policy.receiptGates.stressedPrinted.incorrectCurrencyCodeGivenHighConfidenceMax },
    ),
    bootstrapRatioMetric(
      "processed_composite_gain",
      processed.map((counts) => ({ numerator: counts.processed_correct_fields - counts.original_correct_fields, denominator: counts.scored_financial_fields })),
      seed,
      resamples,
      { operator: ">=", value: input.policy.existingScannerHarnessGates.processedCompositeGainMin },
    ),
    bootstrapRatioMetric(
      "financial_field_regression_rate",
      processed.map((counts) => ({ numerator: counts.regressed_fields, denominator: counts.scored_financial_fields })),
      seed,
      resamples,
      { operator: "<=", value: input.policy.existingScannerHarnessGates.financialFieldRegressionMax },
    ),
    bootstrapRatioMetric(
      "absolute_total_error_minor_when_wrong",
      receipts.flatMap((receipt) => {
        const total = receipt.fields.find((field) => field.field === "total" && field.applicable && field.exact_match === false && field.absolute_error_minor !== undefined);
        return total ? [{ numerator: total.absolute_error_minor!, denominator: 1 }] : [];
      }),
      seed,
      resamples,
      null,
      "MINOR_CURRENCY_UNITS",
    ),
  ];
  return metrics.map((metric) => scopedReceiptMetric(metric, baseScope));
}

function buildDuplicateMetrics(input: ValidatedInputs): MetricReport[] {
  const predictions = input.results.pair_predictions ?? [];
  if (predictions.length === 0) {
    return [
      notMeasured("duplicate_pair_precision", "No complete duplicate-pair prediction collection supplied", { operator: ">=", value: input.policy.duplicateGates.precisionMin }),
      notMeasured("duplicate_pair_recall", "No complete duplicate-pair prediction collection supplied", { operator: ">=", value: input.policy.duplicateGates.recallMin }),
    ];
  }
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const prediction of predictions) {
    const label = input.eligiblePairsById.get(prediction.pair_id)!.pair_label;
    if (prediction.predicted_duplicate && label === "DUPLICATE") truePositive += 1;
    if (prediction.predicted_duplicate && label === "NON_DUPLICATE") falsePositive += 1;
    if (!prediction.predicted_duplicate && label === "DUPLICATE") falseNegative += 1;
  }
  return [
    measuredRatio("duplicate_pair_precision", truePositive, truePositive + falsePositive, { operator: ">=", value: input.policy.duplicateGates.precisionMin }),
    measuredRatio("duplicate_pair_recall", truePositive, truePositive + falseNegative, { operator: ">=", value: input.policy.duplicateGates.recallMin }),
  ];
}

function buildConfidenceBands(input: ValidatedInputs, receipts: ReceiptObservation[], baseScope: string): ConfidenceBandReport[] {
  const supportFloor = input.policy.receiptGates.confidenceBands.reviewedPredictionsPerFieldProviderCohortMin;
  const reports: ConfidenceBandReport[] = [];
  for (const cohort of COHORT_TAGS) {
    const group = receipts.filter((receipt) => receiptCohorts(input, receipt).includes(cohort));
    for (const field of FIELD_NAMES) {
      const applicable = group.flatMap((receipt) => receipt.fields.filter((candidate) => candidate.field === field && candidate.applicable));
      const bands = (["HIGH", "MEDIUM", "LOW"] as const).map((band) => {
        const predictions = applicable.filter((candidate) => candidate.confidence_band === band);
        const errors = predictions.filter((candidate) => candidate.exact_match === false).length;
        return {
          band,
          errors,
          predictions: predictions.length,
          errorRate: predictions.length ? errors / predictions.length : null,
          confidenceInterval: wilson95(errors, predictions.length),
          supportStatus: predictions.length === 0
            ? "NO_PREDICTIONS" as const
            : predictions.length >= supportFloor ? "CALIBRATED" as const : "UNCALIBRATED" as const,
        };
      });
      const activeBands = bands.filter((band) => band.predictions > 0);
      const underSupportedNamedBand = activeBands.some((band) => band.predictions < supportFloor);
      const allThreeSupported = bands.every((band) => band.predictions >= supportFloor);
      const monotonic = allThreeSupported
        ? bands[0]!.errorRate! <= bands[1]!.errorRate! && bands[1]!.errorRate! <= bands[2]!.errorRate!
        : null;
      reports.push({
        field,
        cohort,
        scope: `${baseScope};COHORT:${cohort}`,
        supportFloor,
        applicablePredictions: applicable.length,
        uncalibratedPredictions: applicable.filter((candidate) => candidate.confidence_band === "UNCALIBRATED").length,
        bands,
        monotonicErrorRate: monotonic,
        gateStatus: underSupportedNamedBand ? "NOT_MEASURED" : monotonic === false ? "FAIL" : monotonic === true ? "PASS" : "NOT_MEASURED",
      });
    }
  }
  return reports;
}

function corpusGate(
  id: string,
  observed: number,
  threshold: Threshold,
  decision: CorpusGate["decision"] = "CAPSTONE",
): CorpusGate {
  return { id, decision, observed, threshold, gateStatus: passes(observed, threshold) ? "PASS" : "FAIL" };
}

function buildCorpus(input: ValidatedInputs): PolicyV1Report["corpus"] {
  const counts = input.counts;
  const cohortReceiptCounts = Object.fromEntries(
    COHORT_TAGS.map((cohort) => [input.policy.capstoneCorpus.cohortTagMap[cohort], counts.cohortReceiptIds.get(cohort)!.size]),
  );
  const providerPromotionCohortReceiptCounts = Object.fromEntries(
    COHORT_TAGS.map((cohort) => [input.policy.capstoneCorpus.cohortTagMap[cohort], counts.realCohortReceiptIds.get(cohort)!.size]),
  );
  const maximumVendorTemplateCount = Math.max(0, ...[...counts.vendorReceiptIds.values()].map((receipts) => receipts.size));
  const maximumVendorTemplateShare = counts.consentedRealReceiptIds.size
    ? maximumVendorTemplateCount / counts.consentedRealReceiptIds.size
    : null;
  const captureModeCounts: Record<string, number> = {};
  for (const row of input.primaryBySampleId.values()) captureModeCounts[row.capture_mode] = (captureModeCounts[row.capture_mode] ?? 0) + 1;
  const gates = [
    corpusGate("unique_consented_real_receipts", counts.consentedRealReceiptIds.size, { operator: ">=", value: input.policy.capstoneCorpus.uniqueConsentedRealReceiptsMin }),
    corpusGate("eligible_non_receipts", counts.eligibleNonReceiptSampleIds.size, { operator: ">=", value: input.policy.capstoneCorpus.nonReceiptsMin }),
    corpusGate("eligible_duplicate_pairs", counts.duplicatePairIds.size, { operator: ">=", value: input.policy.capstoneCorpus.knownDuplicatePairsMin }),
    corpusGate("eligible_non_duplicate_pairs", counts.nonDuplicatePairIds.size, { operator: ">=", value: input.policy.capstoneCorpus.knownNonDuplicatePairsMin }),
    corpusGate("duplicate_promotion_duplicate_pairs", counts.duplicatePairIds.size, { operator: ">=", value: input.policy.duplicatePromotionCorpus.knownDuplicatePairsMin }, "DUPLICATE_PROMOTION"),
    corpusGate("duplicate_promotion_non_duplicate_pairs", counts.nonDuplicatePairIds.size, { operator: ">=", value: input.policy.duplicatePromotionCorpus.knownNonDuplicatePairsMin }, "DUPLICATE_PROMOTION"),
    corpusGate("provider_promotion_unique_real_receipts", counts.eligibleRealReceiptIds.size, { operator: ">=", value: input.policy.providerOcrPromotionCorpus.uniqueRealReceiptsMin }, "PROVIDER_PROMOTION"),
    ...COHORT_TAGS.map((cohort) => corpusGate(
      `provider_promotion_cohort.${input.policy.capstoneCorpus.cohortTagMap[cohort]}`,
      counts.realCohortReceiptIds.get(cohort)!.size,
      { operator: ">=", value: input.policy.providerOcrPromotionCorpus.affectedCohortReceiptMinimum },
      "PROVIDER_PROMOTION",
    )),
    corpusGate("maximum_vendor_template_share", maximumVendorTemplateShare ?? 1, { operator: "<=", value: input.policy.capstoneCorpus.vendorTemplateShareMax }),
    ...COHORT_TAGS.map((cohort) => corpusGate(
      `cohort.${input.policy.capstoneCorpus.cohortTagMap[cohort]}`,
      counts.cohortReceiptIds.get(cohort)!.size,
      { operator: ">=", value: input.policy.capstoneCorpus.cohortReceiptMinimums[input.policy.capstoneCorpus.cohortTagMap[cohort]]! },
    )),
  ];
  return {
    eligibleRows: input.eligibleRowsBySampleId.size,
    consentedRealReceipts: counts.consentedRealReceiptIds.size,
    providerPromotionRealReceipts: counts.eligibleRealReceiptIds.size,
    eligibleNonReceipts: counts.eligibleNonReceiptSampleIds.size,
    eligibleDuplicatePairs: counts.duplicatePairIds.size,
    eligibleNonDuplicatePairs: counts.nonDuplicatePairIds.size,
    cohortReceiptCounts,
    providerPromotionCohortReceiptCounts,
    maximumVendorTemplateShare,
    captureModeCounts,
    gates,
  };
}

function assertAggregateOnly(report: PolicyV1Report, input: ValidatedInputs): void {
  const serialized = JSON.stringify(report);
  const stringValues: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") stringValues.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(report);
  const forbidden = [
    ...input.intakeRows.map((row) => row.sample_id),
    ...input.intakeRows.map((row) => row.receipt_id),
    ...input.intakeRows.map((row) => row.capture_attempt_id),
    ...input.intakeRows.map((row) => row.consent_record_id),
    ...input.intakeRows.map((row) => row.donor_pseudonym),
    ...input.intakeRows.map((row) => row.vendor_template_id),
    ...input.intakeRows.map((row) => row.ground_truth_reviewer_1),
    ...input.intakeRows.map((row) => row.ground_truth_reviewer_2),
    ...input.intakeRows.map((row) => row.source_sha256),
    ...input.intakeRows.map((row) => row.ground_truth_sha256),
    ...input.intakeRows.map((row) => row.private_storage_reference),
    ...input.intakeRows.map((row) => row.ground_truth_reference),
    ...input.pairRows.map((row) => row.pair_id),
    ...input.artifactMap.independent_trials.captures.map((trial) => trial.trial_id),
    ...input.artifactMap.independent_trials.receipts.map((trial) => trial.trial_id),
    ...(input.results.captures ?? []).map((result) => result.trial_id),
    ...(input.results.receipts ?? []).map((result) => result.trial_id),
    input.paths.manifestPath,
    input.paths.pairLabelsPath,
    input.paths.artifactMapPath,
    input.paths.sealPath,
    input.paths.groundTruthBundlePath,
    input.paths.resultsPath,
    input.paths.outputPath,
    ...input.privateArtifactPaths,
  ].filter((value) => value && value !== "NOT_APPLICABLE");
  if (forbidden.some((value) => stringValues.includes(value) || (isAbsolutePrivatePath(value) && serialized.includes(value)))) {
    throw new Error("Aggregate report construction included a private identifier or path");
  }
}

export function buildPolicyV1Report(input: ValidatedInputs, generatedAtUtc = new Date().toISOString()): PolicyV1Report {
  const generatedTimestamp = Date.parse(generatedAtUtc);
  const normalizedGeneratedAt = generatedAtUtc.includes(".") ? generatedAtUtc : generatedAtUtc.replace("Z", ".000Z");
  if (!Number.isFinite(generatedTimestamp) || new Date(generatedTimestamp).toISOString() !== normalizedGeneratedAt) {
    throw new Error("Aggregate report generation time must be a real UTC calendar instant");
  }
  if (generatedTimestamp < Date.parse(input.results.run.results_opened_at_utc)) {
    throw new Error("Aggregate report generation time cannot precede the declared result-open time");
  }
  if (generatedTimestamp > Date.parse(input.results.run.planned_review_end_at_utc)) {
    throw new Error("Aggregate report generation time cannot exceed the sealed review window");
  }
  const baseReceiptScope = receiptMetricScope(input);
  const receipts = (input.results.receipts ?? [])
    .filter((receipt) => receiptSourceInMetricPopulation(
      input,
      input.primaryBySampleId.get(receipt.sample_id)!.source_class,
    ))
    .sort((left, right) => compareOpaqueIds(left.sample_id, right.sample_id));
  const hasMixedSourceCapture = [...input.eligibleCaptureRows.values()].some((rows) => {
    const primaries = rows.filter((row) => row.benchmark_count_role === "PRIMARY_RECEIPT");
    return primaries.some((row) => receiptSourceInMetricPopulation(input, row.source_class)) &&
      primaries.some((row) => !receiptSourceInMetricPopulation(input, row.source_class));
  });
  const corpus = buildCorpus(input);
  const metrics = [
    ...buildCaptureMetrics(input),
    ...buildFieldMetrics(input, receipts, baseReceiptScope),
    ...buildReceiptMetrics(input, receipts, baseReceiptScope),
    ...buildDuplicateMetrics(input),
  ];
  const confidenceBands = buildConfidenceBands(input, receipts, baseReceiptScope);
  const unavailableEvidence: PolicyV1Report["unavailableEvidence"] = [
    { id: "physical_android_protocol", status: "NOT_MEASURED", reason: "Requires the declared physical-device matrix and a pre-run device-specific PSS amendment" },
    { id: "deployed_private_storage_signed_url_isolation_and_expiry", status: "NOT_MEASURED", reason: "Requires authenticated checks against the deployed private receipt bucket" },
    { id: "evidence_purge_storage_absence", status: "NOT_MEASURED", reason: "Requires deployed worker completion followed by private-storage inspection" },
    { id: "worker_heartbeat_and_stale_recovery", status: "NOT_MEASURED", reason: "Requires operational worker trial evidence" },
    { id: "security_ownership_adversarial", status: "NOT_MEASURED", reason: "Requires the separate profile-isolation and signed-URL test evidence" },
    { id: "category_quality", status: "NOT_MEASURED", reason: "The receipt scored-results v1 contract does not accept category promotion evidence" },
    { id: "large_import_performance", status: "NOT_MEASURED", reason: "The receipt scored-results v1 contract does not accept import evidence" },
    { id: "provider_or_transform_comparison", status: "NOT_MEASURED", reason: "One report is intentionally limited to one provider and extractor context" },
    { id: "cloud_provider_evidence_contract", status: "NOT_MEASURED", reason: "Policy-v1 input cannot prove sealed region, provider version, transform, Azure F0 resource, page-unit, and lifecycle evidence; cloud results are rejected" },
    { id: "raw_and_normalized_ocr_scoring", status: "NOT_MEASURED", reason: "The scored-results v1 contract accepts normalized field outcomes but not a separate raw-OCR score frame" },
    { id: "provider_cohort_macro_average", status: "NOT_MEASURED", reason: "The scored-results v1 contract does not define the policy-required provider cohort macro-average" },
    { id: "provider_promotion_real_source_metric_set", status: "NOT_MEASURED", reason: "Capstone metrics are isolated to consented-owner receipts; policy-v1 does not emit a separate public-licensed provider-promotion score set" },
    { id: "provider_selection_review", status: "NOT_MEASURED", reason: "Privacy and legal fit, measured cost, and implementation-effort review require separate provider decision evidence" },
    { id: "recapture_robustness_analysis", status: "NOT_MEASURED", reason: "Recapture rows are excluded from ordinary gates and the scored-results v1 contract has no predeclared robustness report" },
    ...(hasMixedSourceCapture
      ? [{ id: "mixed_source_capture_analysis", status: "NOT_MEASURED" as const, reason: "A capture contains both in-scope and out-of-scope receipt sources; capture-level detection and count outcomes cannot be attributed safely" }]
      : []),
    { id: "duplicate_owner_review", status: "NOT_MEASURED", reason: "The scored-results v1 contract does not accept the policy-required owner review decision" },
    { id: "required_metric_splits_beyond_field_exact_match", status: "NOT_MEASURED", reason: "Policy v1 cohort and capture-mode splits are implemented for field exact match; other metric families require a versioned scored-results extension" },
  ];
  const capstoneCorpusFailures = corpus.gates
    .filter((gate) => gate.decision === "CAPSTONE" && gate.gateStatus === "FAIL")
    .map((gate) => gate.id);
  const providerPromotionCorpusFailures = corpus.gates
    .filter((gate) => gate.decision === "PROVIDER_PROMOTION" && gate.gateStatus === "FAIL")
    .map((gate) => gate.id);
  const duplicatePromotionCorpusFailures = corpus.gates
    .filter((gate) => gate.decision === "DUPLICATE_PROMOTION" && gate.gateStatus === "FAIL")
    .map((gate) => gate.id);
  const failedMetrics = metrics.filter((metric) => metric.gateStatus === "FAIL").map((metric) => `${metric.id}:${metric.scope}`);
  const requiredNotMeasured = metrics
    .filter((metric) => metric.gateStatus === "NOT_MEASURED")
    .map((metric) => `${metric.id}:${metric.scope}`);
  const confidenceFailures = confidenceBands.filter((group) => group.gateStatus === "FAIL").map((group) => `confidence_band.${group.field}.${group.cohort}`);
  const confidenceNotMeasured = confidenceBands
    .filter((group) => group.applicablePredictions > 0 && group.gateStatus === "NOT_MEASURED")
    .map((group) => `confidence_band.${group.field}.${group.cohort}`);
  const duplicateMetricFailures = failedMetrics.filter((metric) => metric.startsWith("duplicate_pair_"));
  const duplicateMetricNotMeasured = requiredNotMeasured.filter((metric) => metric.startsWith("duplicate_pair_"));
  const providerMetricFailures = failedMetrics.filter((metric) => !metric.startsWith("duplicate_pair_"));
  const providerMetricNotMeasured = requiredNotMeasured.filter((metric) => !metric.startsWith("duplicate_pair_"));
  const providerPromotionBlockers = [
    ...providerPromotionCorpusFailures,
    ...providerMetricFailures,
    ...providerMetricNotMeasured,
    ...confidenceFailures,
    ...confidenceNotMeasured,
    "provider_or_transform_comparison",
    "cloud_provider_evidence_contract",
    "raw_and_normalized_ocr_scoring",
    "provider_cohort_macro_average",
    "provider_promotion_real_source_metric_set",
    "provider_selection_review",
    "required_metric_splits_beyond_field_exact_match",
    ...(hasMixedSourceCapture ? ["mixed_source_capture_analysis"] : []),
  ];
  const duplicatePromotionBlockers = [
    ...duplicatePromotionCorpusFailures,
    ...duplicateMetricFailures,
    ...duplicateMetricNotMeasured,
    "duplicate_owner_review",
  ];
  const blockers = [
    ...capstoneCorpusFailures,
    ...failedMetrics,
    ...requiredNotMeasured,
    ...confidenceFailures,
    ...confidenceNotMeasured,
    ...unavailableEvidence.map((gap) => gap.id),
  ];
  const report: PolicyV1Report = {
    schemaVersion: "finsight-receipt-policy-v1-aggregate-report-v1",
    generatedAtUtc,
    policy: {
      id: input.policy.policyId,
      status: input.policy.status,
      sha256: input.policySha256,
      normativeArtifactsVerified: true,
    },
    run: {
      purpose: input.results.run.purpose,
      provider: input.results.run.provider,
      providerKind: isLocalProvider(input.results.run.provider) ? "LOCAL" : "CLOUD",
      extractorVersionSha256: input.results.run.extractor_version_sha256,
      declaredHardwareSha256: input.results.run.declared_hardware_sha256,
      coldOrWarm: input.results.run.cold_or_warm,
      resultsOpenedAtUtc: input.results.run.results_opened_at_utc,
      plannedReviewEndAtUtc: input.results.run.planned_review_end_at_utc,
    },
    seals: {
      sealedAtUtc: input.seal.sealed_at_utc,
      manifestSha256: input.manifestSha256,
      pairLabelsSha256: input.pairLabelsSha256,
      artifactMapSha256: input.artifactMapSha256,
      groundTruthBundleSha256: input.groundTruthBundleSha256,
      scoredResultsSha256: input.resultsSha256,
    },
    corpus,
    metrics,
    confidenceBands,
    unavailableEvidence,
    decision: {
      capstoneCorpusStatus: capstoneCorpusFailures.length === 0 ? "PASS" : "FAIL",
      providerPromotionCorpusStatus: providerPromotionCorpusFailures.length === 0 ? "PASS" : "FAIL",
      duplicatePromotionCorpusStatus: duplicatePromotionCorpusFailures.length === 0 ? "PASS" : "FAIL",
      providerPromotionStatus: providerPromotionCorpusFailures.length || providerMetricFailures.length || confidenceFailures.length
        ? "FAIL"
        : "INCOMPLETE",
      duplicatePromotionStatus: duplicatePromotionCorpusFailures.length || duplicateMetricFailures.length
        ? "FAIL"
        : duplicatePromotionBlockers.length ? "INCOMPLETE" : "PASS",
      capstoneCorpusBlockers: capstoneCorpusFailures,
      providerPromotionCorpusBlockers: providerPromotionCorpusFailures,
      duplicatePromotionCorpusBlockers: duplicatePromotionCorpusFailures,
      providerPromotionBlockers,
      duplicatePromotionBlockers,
      measuredMetricStatus: failedMetrics.length || confidenceFailures.length
        ? "FAIL"
        : requiredNotMeasured.length || confidenceNotMeasured.length ? "INCOMPLETE" : "PASS",
      phase2AcceptanceStatus: "OPEN",
      productionAccuracyClaimSupported: false,
      blockers,
    },
    privacy: {
      aggregateOnly: true,
      containsSampleIdentifiers: false,
      containsReceiptTextOrFieldValues: false,
      containsPrivatePathsOrStorageReferences: false,
      outputOutsideRepository: true,
    },
  };
  assertAggregateOnly(report, input);
  return report;
}

export function writePolicyV1Report(report: PolicyV1Report, outputPath: string): void {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function reportSummary(report: PolicyV1Report): string {
  return [
    `Policy: ${report.policy.id}`,
    `Capstone corpus gates: ${report.decision.capstoneCorpusStatus}`,
    `Provider promotion: ${report.decision.providerPromotionStatus} (corpus: ${report.decision.providerPromotionCorpusStatus})`,
    `Duplicate promotion: ${report.decision.duplicatePromotionStatus} (corpus: ${report.decision.duplicatePromotionCorpusStatus})`,
    `Measured metric gates: ${report.decision.measuredMetricStatus}`,
    `Phase 2 acceptance: ${report.decision.phase2AcceptanceStatus}`,
  ].join("\n");
}

function isAbsolutePrivatePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
