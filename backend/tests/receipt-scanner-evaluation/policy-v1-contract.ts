import { z } from "zod";

export const INTAKE_HEADERS = [
  "sample_id",
  "receipt_id",
  "capture_attempt_id",
  "benchmark_count_role",
  "source_class",
  "consent_record_id",
  "consent_scope_version",
  "donor_pseudonym",
  "captured_at_utc",
  "intake_at_utc",
  "capture_device_model",
  "android_os_api",
  "app_build",
  "capture_mode",
  "language_tags",
  "receipt_type",
  "condition_tags",
  "cohort_tags",
  "vendor_template_id",
  "page_group_id",
  "page_number",
  "segment_group_id",
  "source_sha256",
  "redaction_state",
  "ground_truth_version",
  "ground_truth_reference",
  "ground_truth_sha256",
  "ground_truth_sealed_at_utc",
  "ground_truth_reviewer_1",
  "ground_truth_reviewer_2",
  "permitted_uses",
  "allowed_cloud_providers",
  "retention_expires_at_utc",
  "private_storage_reference",
  "release_gate_eligible",
  "exclusion_reason",
] as const;

export const PAIR_HEADERS = [
  "pair_id",
  "left_sample_id",
  "right_sample_id",
  "pair_label",
  "relationship_basis",
  "ground_truth_reviewer_1",
  "ground_truth_reviewer_2",
  "reviewed_at_utc",
  "release_gate_eligible",
  "exclusion_reason",
] as const;

export const FIELD_NAMES = [
  "vendor",
  "invoice_number",
  "date",
  "time",
  "currency_code",
  "subtotal",
  "tax",
  "discount",
  "total",
  "payment_method",
] as const;

export const COHORT_TAGS = [
  "CLEAN_PRINTED",
  "STRESSED_OR_FADED",
  "LONG",
  "HANDWRITTEN_OR_HAND_ANNOTATED",
  "FILIPINO_OR_MIXED_LANGUAGE",
  "DAMAGED_OR_LOW_LIGHT",
] as const;

export const METRIC_FAMILIES = [
  "CAPTURE_DETECTION_LATENCY",
  "CAPTURE_LIVE_GUIDANCE_LATENCY",
  "NORMALIZED_CORNER_ERROR",
  "HANDWRITING_TEXT",
  "LINE_ITEMS",
  "LONG_RECONSTRUCTION",
  "MANUAL_CORRECTIONS",
  "LOCAL_RESULT_LATENCY",
  "PROCESSED_COMPOSITE",
] as const;

export type IntakeHeader = (typeof INTAKE_HEADERS)[number];
export type PairHeader = (typeof PAIR_HEADERS)[number];
export type FieldName = (typeof FIELD_NAMES)[number];
export type CohortTag = (typeof COHORT_TAGS)[number];
export type MetricFamily = (typeof METRIC_FAMILIES)[number];

export type IntakeRow = Record<IntakeHeader, string> & { rowNumber: number };
export type PairRow = Record<PairHeader, string> & { rowNumber: number };

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const utcSchema = z.string().datetime({ offset: false }).refine((value) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalizedInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  return new Date(timestamp).toISOString() === normalizedInput;
}, "Timestamp must be a real UTC calendar instant");
const providerSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(80);
const finiteNonnegative = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();

export const sealSchema = z.object({
  schema_version: z.literal("finsight-receipt-evaluation-seal-v1"),
  policy_id: z.literal("finsight-core-evidence-gates-v1"),
  policy_sha256: sha256Schema,
  manifest_sha256: sha256Schema,
  pair_labels_sha256: sha256Schema,
  artifact_map_sha256: sha256Schema,
  ground_truth_bundle_sha256: sha256Schema,
  sealed_at_utc: utcSchema,
}).strict();

const purposeSchema = z.enum(["LOCAL_ENGINEERING", "CAPSTONE_DEMO", "CLOUD_BENCHMARK", "POST_MVP_RESEARCH"]);
const coldOrWarmSchema = z.enum(["COLD", "WARM"]);

const sealedRunPlanSchema = z.object({
  purpose: purposeSchema,
  provider: providerSchema,
  extractor_version_sha256: sha256Schema,
  planned_review_end_at_utc: utcSchema,
  declared_hardware_sha256: sha256Schema,
  cold_or_warm: coldOrWarmSchema,
}).strict();

export const artifactMapSchema = z.object({
  schema_version: z.literal("finsight-receipt-artifact-map-v1"),
  run_plan: sealedRunPlanSchema,
  independent_trials: z.object({
    captures: z.array(z.object({
      capture_attempt_id: z.string().min(1).max(160),
      trial_id: z.string().min(1).max(160),
    }).strict()),
    receipts: z.array(z.object({
      sample_id: z.string().min(1).max(160),
      trial_id: z.string().min(1).max(160),
    }).strict()),
  }).strict(),
  artifacts: z.array(z.object({
    sample_id: z.string().min(1).max(160),
    source_path: z.string().min(1),
    ground_truth_path: z.string().min(1),
    ground_truth_page_count: count,
    applicable_fields: z.array(z.enum(FIELD_NAMES)),
    handwritten_fields: z.array(z.enum(FIELD_NAMES)),
    metric_families: z.array(z.enum(METRIC_FAMILIES)),
    metric_denominators: z.object({
      handwriting_text: z.object({
        ground_truth_characters: positiveCount,
        ground_truth_words: positiveCount,
      }).strict().optional(),
      line_items: z.object({
        ground_truth_items: count,
        quantity_applicable: count,
        unit_price_applicable: count,
        line_total_applicable: count,
      }).strict().optional(),
      long_reconstruction: z.object({
        ground_truth_lines: positiveCount,
        known_truncated: z.boolean(),
        acquisition_frame_count: z.number().int().min(2),
      }).strict().optional(),
      manual_corrections: z.object({
        reviewed_fields: positiveCount,
        reviewed_items: count,
      }).strict().optional(),
      processed_composite: z.object({ scored_financial_fields: count }).strict().optional(),
    }).strict(),
  }).strict()),
}).strict();

const fieldObservationSchema = z.object({
  field: z.enum(FIELD_NAMES),
  applicable: z.boolean(),
  exact_match: z.boolean().nullable(),
  confidence_band: z.enum(["HIGH", "MEDIUM", "LOW", "UNCALIBRATED", "NOT_ASSIGNED"]),
  value_state: z.enum(["PRESENT", "MISSING", "CONFLICTING", "NOT_APPLICABLE"]),
  routed_to_review: z.boolean(),
  handwritten: z.boolean(),
  absolute_error_minor: finiteNonnegative.optional(),
}).strict().superRefine((field, context) => {
  if (field.field !== "total" && field.absolute_error_minor !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only total may carry absolute_error_minor" });
  }
  if (!field.applicable) {
    if (field.exact_match !== null || field.value_state !== "NOT_APPLICABLE") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Non-applicable fields require null exact_match and NOT_APPLICABLE state" });
    }
    return;
  }
  if (field.exact_match === null || field.value_state === "NOT_APPLICABLE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Applicable fields require a scored result and applicable value state" });
  }
});

const receiptObservationSchema = z.object({
  sample_id: z.string().min(1).max(160),
  trial_id: z.string().min(1).max(160),
  status: z.enum(["SUCCESS", "FAILED", "TIMED_OUT", "MISSING"]),
  page_count: z.number().int().positive(),
  fields: z.array(fieldObservationSchema),
  text: z.object({
    character_errors: count,
    ground_truth_characters: count,
    word_errors: count,
    ground_truth_words: count,
  }).strict().optional(),
  items: z.object({
    predicted_items: count,
    ground_truth_items: count,
    matched_items: count,
    quantity_applicable: count,
    quantity_exact: count,
    unit_price_applicable: count,
    unit_price_exact: count,
    line_total_applicable: count,
    line_total_exact: count,
  }).strict().optional(),
  reconstruction: z.object({
    ground_truth_lines: count,
    matched_lines: count,
    ordered_lines: count,
    duplicated_lines: count,
    known_truncated: z.boolean(),
    marked_complete: z.boolean(),
  }).strict().optional(),
  corrections: z.object({
    reviewed_fields: count,
    changed_fields: count,
    reviewed_items: count,
    changed_items: count,
  }).strict().optional(),
  local_result_latency_ms: finiteNonnegative.optional(),
  processed_composite: z.object({
    scored_financial_fields: count,
    original_correct_fields: count,
    processed_correct_fields: count,
    regressed_fields: count,
  }).strict().optional(),
}).strict();

const captureObservationSchema = z.object({
  capture_attempt_id: z.string().min(1).max(160),
  trial_id: z.string().min(1).max(160),
  actual_document_count: count,
  likelihood_outcome: z.enum(["RECEIPT", "UNCERTAIN", "OBVIOUS_NON_RECEIPT"]),
  detection_latency_ms: finiteNonnegative.optional(),
  live_guidance_latency_ms: finiteNonnegative.optional(),
  corner_errors: z.array(z.object({
    sample_id: z.string().min(1).max(160),
    normalized_corner_error: z.number().finite().min(0).max(1),
  }).strict()).optional(),
}).strict();

const pairPredictionSchema = z.object({
  pair_id: z.string().min(1).max(160),
  predicted_duplicate: z.boolean(),
}).strict();

export const scoredResultsSchema = z.object({
  schema_version: z.literal("finsight-receipt-scored-results-v1"),
  policy_id: z.literal("finsight-core-evidence-gates-v1"),
  run: z.object({
    purpose: purposeSchema,
    provider: providerSchema,
    extractor_version_sha256: sha256Schema,
    results_opened_at_utc: utcSchema,
    planned_review_end_at_utc: utcSchema,
    declared_hardware_sha256: sha256Schema,
    cold_or_warm: coldOrWarmSchema,
  }).strict(),
  captures: z.array(captureObservationSchema).optional(),
  receipts: z.array(receiptObservationSchema).optional(),
  pair_predictions: z.array(pairPredictionSchema).optional(),
}).strict();

export type EvaluationSeal = z.infer<typeof sealSchema>;
export type ArtifactMap = z.infer<typeof artifactMapSchema>;
export type ScoredResults = z.infer<typeof scoredResultsSchema>;
export type ReceiptObservation = NonNullable<ScoredResults["receipts"]>[number];
export type CaptureObservation = NonNullable<ScoredResults["captures"]>[number];
export type FieldObservation = ReceiptObservation["fields"][number];

export interface BenchmarkPolicy {
  policyId: string;
  status: string;
  existingScannerHarnessGates: {
    source: string;
    sourceVersion: string;
    sourceSha256: string;
    documentPrecisionMin: number;
    documentRecallMin: number;
    obviousNonReceiptFalseTriggerMax: number;
    medianNormalizedCornerErrorMax: number;
    multiReceiptCountAccuracyMin: number;
    processedCompositeGainMin: number;
    financialFieldRegressionMax: number;
    handwrittenHardRejectMax: number;
    analysisLatencyP95MillisecondsMax: number;
  };
  capstoneCorpus: {
    uniqueConsentedRealReceiptsMin: number;
    cohortReceiptMinimums: Record<string, number>;
    nonReceiptsMin: number;
    knownDuplicatePairsMin: number;
    knownNonDuplicatePairsMin: number;
    vendorTemplateShareMax: number;
    independentGroundTruthReviewersMin: number;
    cohortTagMap: Record<CohortTag, string>;
    normativeIntakeArtifacts: {
      dataDictionary: { path: string; sha256: string };
      receiptIntakeHeader: { path: string; sha256: string };
      pairLabelHeader: { path: string; sha256: string };
    };
  };
  duplicatePromotionCorpus: {
    knownDuplicatePairsMin: number;
    knownNonDuplicatePairsMin: number;
  };
  providerOcrPromotionCorpus: {
    uniqueRealReceiptsMin: number;
    affectedCohortReceiptMinimum: number;
    eachAffectedCohortMustMeetApplicablePointGates: boolean;
    aggregateResultMayOverrideAffectedCohortFailure: boolean;
  };
  receiptGates: {
    cleanPrinted: {
      totalExactMatchMin: number;
      normalizedVendorExactMatchMin: number;
      dateExactMatchMin: number;
      currencyCodeExactMatchMin: number;
      incorrectCurrencyCodeGivenHighConfidenceMax: number;
    };
    stressedPrinted: {
      totalExactMatchMin: number;
      missingOrConflictingCriticalValuesRoutedToReviewMin: number;
      currencyCorrectOrRoutedToFocusedReviewMin: number;
      incorrectCurrencyCodeGivenHighConfidenceMax: number;
    };
    handwriting: {
      highConfidenceFinancialFieldsMax: number;
      financialFieldsOmittedFromFocusedReviewMax: number;
      reportCharacterErrorRate: boolean;
      reportWordErrorRate: boolean;
      reportFieldExactMatch: boolean;
    };
    longReceipt: {
      lineRecallMin: number;
      duplicatedLineRateMax: number;
      lineOrderAccuracyMin: number;
      knownTruncatedScansMarkedCompleteMax: number;
    };
    confidenceBands: { reviewedPredictionsPerFieldProviderCohortMin: number };
  };
  duplicateGates: { precisionMin: number; recallMin: number; ownerReviewRequired: boolean };
  performanceGates: {
    liveCaptureGuidanceP95MillisecondsMax: number;
    onePageLocalResultP95MillisecondsMax: number;
  };
  reporting: {
    confidenceIntervals: {
      bootstrapResamples: number;
      bootstrapSeed: number;
    };
  };
}
