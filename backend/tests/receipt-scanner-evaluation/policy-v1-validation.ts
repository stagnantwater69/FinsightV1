import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import {
  ArtifactMap,
  artifactMapSchema,
  BenchmarkPolicy,
  COHORT_TAGS,
  EvaluationSeal,
  FIELD_NAMES,
  INTAKE_HEADERS,
  IntakeHeader,
  IntakeRow,
  MetricFamily,
  PAIR_HEADERS,
  PairHeader,
  PairRow,
  scoredResultsSchema,
  ScoredResults,
  sealSchema,
} from "./policy-v1-contract";

const BENCHMARK_ROLES = new Set([
  "PRIMARY_RECEIPT",
  "SAME_RECEIPT_SUPPORT",
  "RECAPTURE_ROBUSTNESS",
  "DERIVED_NOT_COUNTED",
  "NON_RECEIPT",
  "EXCLUDED",
]);
const SOURCE_CLASSES = new Set(["CONSENTED_OWNER", "PUBLIC_LICENSED", "SYNTHETIC", "SYNTHETIC_DEGRADED"]);
const CAPTURE_MODES = new Set([
  "ANDROID_CUSTOM_STANDARD",
  "ANDROID_CUSTOM_LONG",
  "ANDROID_MANUAL",
  "ANDROID_ML_KIT",
  "IOS_MANUAL",
  "WEB_UPLOAD",
  "EXTERNAL_DATASET",
]);
const RECEIPT_TYPES = new Set([
  "THERMAL",
  "PLAIN_PAPER",
  "SALES_INVOICE",
  "HANDWRITTEN",
  "MIXED",
  "NON_RECEIPT",
  "OTHER_RECORDED",
]);
const CONDITION_TAGS = new Set([
  "CLEAN",
  "FADED",
  "CRUMPLED",
  "TILTED",
  "SHADOWED",
  "GLARE",
  "LOW_LIGHT",
  "BLURRED",
  "DAMAGED",
  "LONG",
  "HANDWRITTEN_NOTE",
  "HANDWRITTEN_FINANCIAL_FIELD",
  "MULTI_PAGE",
  "MULTI_RECEIPT",
  "REPHOTOGRAPHED",
  "OBSTRUCTED",
  "OTHER_RECORDED",
]);
const REDACTION_STATES = new Set(["NONE_NEEDED", "REDACTED_WITH_MAP", "REDACTION_PENDING", "EXCLUDED_SENSITIVE"]);
const PERMITTED_USES = new Set(["LOCAL_ENGINEERING", "CAPSTONE_DEMO", "CLOUD_BENCHMARK", "POST_MVP_RESEARCH"]);
const PAIR_LABELS = new Set(["DUPLICATE", "NON_DUPLICATE"]);
const RELATIONSHIP_BASES = new Set([
  "SAME_PURCHASE_RECAPTURE",
  "SAME_FILE_REIMPORT",
  "DIFFERENT_PURCHASE_SAME_VENDOR_AMOUNT_DATE",
  "DIFFERENT_PURCHASE",
  "OTHER_RECORDED",
]);
const LOCAL_PROVIDERS = new Set(["LOCAL_TESSERACT"]);
const CLOUD_PROVIDER_CONSENT_IDS = new Set(["AZURE_DOCUMENT_INTELLIGENCE_F0"]);
const CRITICAL_RECEIPT_FIELDS = new Set<(typeof FIELD_NAMES)[number]>(["vendor", "date", "currency_code", "total"]);
const HANDWRITING_FINANCIAL_FIELDS = new Set<(typeof FIELD_NAMES)[number]>([
  ...CRITICAL_RECEIPT_FIELDS,
  "subtotal",
  "tax",
  "discount",
]);
const MACHINE_REVIEWER = /^(ai|model|gpt|claude|gemini|tesseract|azure|ocr)([-_:]|$)/i;
const SHA256 = /^[a-f0-9]{64}$/;
const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const POLICY_V1_SHA256 = "4368086c7ef0ae38be67d7c510c91b7b8cc37fb383a179e6ab543cfb2039650f";

export interface EvaluationPaths {
  repositoryRoot: string;
  manifestPath: string;
  pairLabelsPath: string;
  artifactMapPath: string;
  sealPath: string;
  groundTruthBundlePath: string;
  resultsPath: string;
  outputPath: string;
}

export interface CorpusCounts {
  consentedRealReceiptIds: Set<string>;
  eligibleRealReceiptIds: Set<string>;
  eligibleNonReceiptSampleIds: Set<string>;
  cohortReceiptIds: Map<string, Set<string>>;
  realCohortReceiptIds: Map<string, Set<string>>;
  vendorReceiptIds: Map<string, Set<string>>;
  duplicatePairIds: Set<string>;
  nonDuplicatePairIds: Set<string>;
}

export interface ValidatedInputs {
  repositoryRoot: string;
  paths: EvaluationPaths;
  policy: BenchmarkPolicy;
  policySha256: string;
  seal: EvaluationSeal;
  manifestSha256: string;
  pairLabelsSha256: string;
  artifactMapSha256: string;
  groundTruthBundleSha256: string;
  resultsSha256: string;
  artifactMap: ArtifactMap;
  privateArtifactPaths: string[];
  intakeRows: IntakeRow[];
  pairRows: PairRow[];
  results: ScoredResults;
  counts: CorpusCounts;
  primaryBySampleId: Map<string, IntakeRow>;
  eligibleRowsBySampleId: Map<string, IntakeRow>;
  eligibleCaptureRows: Map<string, IntakeRow[]>;
  eligiblePairsById: Map<string, PairRow>;
}

export class EvaluationInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EvaluationInputError";
  }
}

function fail(code: string, message: string): never {
  throw new EvaluationInputError(code, message);
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return fail("INVALID_JSON", "An external JSON input is not valid JSON");
  }
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function externalExistingPath(path: string, repositoryRoot: string, label: string): string {
  if (!isAbsolute(path)) fail("PRIVATE_PATH_NOT_ABSOLUTE", `${label} must be an absolute path outside the repository`);
  if (!existsSync(path)) fail("PRIVATE_PATH_MISSING", `${label} does not exist`);
  const realPath = realpathSync(path);
  if (isInside(repositoryRoot, realPath)) {
    fail("PRIVATE_PATH_INSIDE_REPOSITORY", `${label} must remain outside the repository`);
  }
  return realPath;
}

function validateOutputPath(path: string, repositoryRoot: string): void {
  if (!isAbsolute(path)) fail("OUTPUT_PATH_NOT_ABSOLUTE", "Output must be an absolute path outside the repository");
  if (existsSync(path)) fail("OUTPUT_EXISTS", "Output already exists; choose a new path so evidence is not overwritten");
  const parent = resolve(path, "..");
  if (!existsSync(parent)) fail("OUTPUT_PARENT_MISSING", "The output directory must exist before the run");
  if (isInside(repositoryRoot, realpathSync(parent))) {
    fail("OUTPUT_INSIDE_REPOSITORY", "Output must remain outside the repository");
  }
}

function parseStrictCsvBytes<THeader extends string>(bytes: Uint8Array, expectedHeaders: readonly THeader[], code: string) {
  let records: string[][];
  try {
    records = parseCsv(bytes, {
      bom: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as string[][];
  } catch {
    return fail(code, "A CSV input could not be parsed with a strict column count");
  }
  if (records.length === 0) fail(code, "A CSV input is missing its header row");
  const actualHeaders = records[0]!;
  if (
    actualHeaders.length !== expectedHeaders.length ||
    actualHeaders.some((header, index) => header !== expectedHeaders[index])
  ) {
    fail(code, "A CSV header does not exactly match its frozen v1 schema");
  }
  return records.slice(1).map((record, index) => {
    const row = Object.fromEntries(expectedHeaders.map((header, column) => [header, record[column] ?? ""]));
    return { ...row, rowNumber: index + 2 } as Record<THeader, string> & { rowNumber: number };
  });
}

function parseStrictCsv<THeader extends string>(path: string, expectedHeaders: readonly THeader[], code: string) {
  return parseStrictCsvBytes(readFileSync(path), expectedHeaders, code);
}

function splitControlled(value: string, allowed: Set<string>, label: string, rowNumber: number, allowNotApplicable = false) {
  if (allowNotApplicable && value === "NOT_APPLICABLE") return [];
  const values = value.split("|");
  if (values.length === 0 || values.some((entry) => !entry || !allowed.has(entry))) {
    fail("CONTROLLED_VALUE_INVALID", `Manifest row ${rowNumber} has an invalid ${label}`);
  }
  if (new Set(values).size !== values.length) {
    fail("CONTROLLED_VALUE_DUPLICATE", `Manifest row ${rowNumber} repeats a ${label}`);
  }
  return values;
}

function parseBoolean(value: string, label: string, rowNumber: number): boolean {
  if (value !== "true" && value !== "false") {
    fail("BOOLEAN_INVALID", `${label} on row ${rowNumber} must be exactly true or false`);
  }
  return value === "true";
}

function parseUtc(value: string, label: string, rowNumber: number): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    fail("UTC_TIMESTAMP_INVALID", `${label} on row ${rowNumber} must be an ISO 8601 UTC timestamp ending in Z`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("UTC_TIMESTAMP_INVALID", `${label} on row ${rowNumber} is not a valid timestamp`);
  const normalizedInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  if (new Date(timestamp).toISOString() !== normalizedInput) {
    fail("UTC_TIMESTAMP_INVALID", `${label} on row ${rowNumber} is not a real calendar instant`);
  }
  return timestamp;
}

function validateReviewerPair(first: string, second: string, rowNumber: number, source: "manifest" | "pair"): void {
  if (!first || !second || first === second) {
    fail("REVIEWER_SEPARATION_INVALID", `${source} row ${rowNumber} requires two distinct reviewer custodian IDs`);
  }
  if (MACHINE_REVIEWER.test(first) || MACHINE_REVIEWER.test(second)) {
    fail("MODEL_REVIEWER_FORBIDDEN", `${source} row ${rowNumber} names a model or OCR system as a reviewer`);
  }
}

function validateOpaqueReference(value: string, label: string, rowNumber: number): void {
  if (
    !value || value === "NOT_APPLICABLE" || isAbsolute(value) || /^[a-z]+:\/\//i.test(value) ||
    /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value === "." || value === ".."
  ) {
    fail("PRIVATE_REFERENCE_INVALID", `${label} on row ${rowNumber} must be a non-path opaque reference`);
  }
}

function validateLongCaptureFact(row: IntakeRow, conditions: string[]): void {
  if (row.capture_mode === "ANDROID_CUSTOM_LONG" && !conditions.includes("LONG")) {
    fail("CAPTURE_COHORT_FACT_INVALID", `Manifest row ${row.rowNumber} uses the long capture mode without the LONG condition`);
  }
}

function derivedCohorts(
  rows: IntakeRow[],
  artifactBySampleId: Map<string, ArtifactMap["artifacts"][number]>,
): Set<string> {
  const conditions = new Set(rows.flatMap((row) => row.condition_tags.split("|")));
  const languages = new Set(rows.flatMap((row) => row.language_tags === "NOT_APPLICABLE" ? [] : row.language_tags.split("|")));
  const stressedConditions = new Set([
    "FADED", "CRUMPLED", "TILTED", "SHADOWED", "GLARE", "BLURRED", "REPHOTOGRAPHED", "OBSTRUCTED",
  ]);
  const applicableCriticalFields = new Set(
    rows
      .flatMap((row) => artifactBySampleId.get(row.sample_id)!.applicable_fields)
      .filter((field) => CRITICAL_RECEIPT_FIELDS.has(field)),
  );
  const handwrittenCriticalFields = new Set(
    rows
      .flatMap((row) => artifactBySampleId.get(row.sample_id)!.handwritten_fields)
      .filter((field) => CRITICAL_RECEIPT_FIELDS.has(field)),
  );
  const handwrittenFinancialFields = new Set(
    rows
      .flatMap((row) => artifactBySampleId.get(row.sample_id)!.handwritten_fields)
      .filter((field) => HANDWRITING_FINANCIAL_FIELDS.has(field)),
  );
  const machinePrinted = applicableCriticalFields.size > 0 && handwrittenCriticalFields.size === 0;
  const hasHandwrittenReceiptType = rows.some((row) => row.receipt_type === "HANDWRITTEN" || row.receipt_type === "MIXED");
  const hasHandwritingCondition = conditions.has("HANDWRITTEN_NOTE") || conditions.has("HANDWRITTEN_FINANCIAL_FIELD");
  if (handwrittenFinancialFields.size > 0 && !hasHandwrittenReceiptType && !hasHandwritingCondition) {
    fail("COHORT_HANDWRITING_FACT_INVALID", "Sealed handwritten financial fields require a supporting receipt type or condition");
  }
  const hasStressedCondition = [...conditions].some((tag) => stressedConditions.has(tag));
  const predicates = new Map<string, boolean>([
    ["CLEAN_PRINTED", machinePrinted && !hasStressedCondition && !conditions.has("LOW_LIGHT") && !conditions.has("DAMAGED")],
    ["STRESSED_OR_FADED", machinePrinted && hasStressedCondition],
    ["LONG", conditions.has("LONG")],
    [
      "HANDWRITTEN_OR_HAND_ANNOTATED",
      hasHandwrittenReceiptType || hasHandwritingCondition,
    ],
    ["FILIPINO_OR_MIXED_LANGUAGE", [...languages].some((tag) => tag.toLowerCase() === "fil-ph")],
    ["DAMAGED_OR_LOW_LIGHT", conditions.has("DAMAGED") || conditions.has("LOW_LIGHT")],
  ]);
  return new Set([...predicates].filter(([, applies]) => applies).map(([cohort]) => cohort));
}

function validateLogicalReceiptCohorts(
  rows: IntakeRow[],
  artifactBySampleId: Map<string, ArtifactMap["artifacts"][number]>,
): void {
  const groups = new Map<string, IntakeRow[]>();
  for (const row of rows.filter((candidate) =>
    candidate.release_gate_eligible === "true" &&
    (candidate.benchmark_count_role === "PRIMARY_RECEIPT" || candidate.benchmark_count_role === "SAME_RECEIPT_SUPPORT")
  )) {
    const group = groups.get(row.receipt_id) ?? [];
    group.push(row);
    groups.set(row.receipt_id, group);
  }
  for (const group of groups.values()) {
    const primary = group.find((row) => row.benchmark_count_role === "PRIMARY_RECEIPT");
    if (!primary) continue;
    const primaryArtifact = artifactBySampleId.get(primary.sample_id)!;
    const primaryApplicableFields = new Set(primaryArtifact.applicable_fields);
    const primaryHandwrittenFields = new Set(primaryArtifact.handwritten_fields);
    for (const support of group.filter((row) => row.benchmark_count_role === "SAME_RECEIPT_SUPPORT")) {
      const supportArtifact = artifactBySampleId.get(support.sample_id)!;
      if (supportArtifact.applicable_fields.some((field) => !primaryApplicableFields.has(field))) {
        fail(
          "LOGICAL_RECEIPT_APPLICABILITY_INVALID",
          `Manifest row ${primary.rowNumber} does not aggregate every support-page applicable field`,
        );
      }
      if (supportArtifact.handwritten_fields.some((field) => !primaryHandwrittenFields.has(field))) {
        fail(
          "LOGICAL_RECEIPT_HANDWRITING_INVALID",
          `Manifest row ${primary.rowNumber} does not aggregate every support-page handwritten field`,
        );
      }
    }
    const hasLongCondition = group.some((row) => row.condition_tags.split("|").includes("LONG"));
    const orderedGroupRows = new Map<string, IntakeRow[]>();
    for (const row of group) {
      for (const [kind, groupId] of [["PAGE", row.page_group_id], ["SEGMENT", row.segment_group_id]] as const) {
        if (groupId === "NOT_APPLICABLE") continue;
        const key = `${kind}:${groupId}`;
        const members = orderedGroupRows.get(key) ?? [];
        members.push(row);
        orderedGroupRows.set(key, members);
      }
    }
    const hasOrderedMultiArtifactEvidence = [...orderedGroupRows.values()].some((members) => {
      const positions = members.map((row) => Number(row.page_number)).sort((left, right) => left - right);
      return positions.length > 1 && positions.every((position, index) => position === index + 1);
    });
    const hasSealedMultiFrameEvidence =
      (primaryArtifact.metric_denominators.long_reconstruction?.acquisition_frame_count ?? 0) >= 2;
    const hasLongAcquisitionEvidence = hasOrderedMultiArtifactEvidence || hasSealedMultiFrameEvidence;
    if (hasLongCondition && !hasLongAcquisitionEvidence) {
      fail(
        "LONG_COHORT_EVIDENCE_MISSING",
        `Manifest row ${primary.rowNumber} declares LONG without ordered-page, segment, or sealed multi-frame evidence`,
      );
    }
    const declared = new Set(primary.cohort_tags === "NOT_APPLICABLE" ? [] : primary.cohort_tags.split("|"));
    const required = derivedCohorts(group, artifactBySampleId);
    if ([...required].some((cohort) => !declared.has(cohort))) {
      fail("COHORT_TAG_MISSING", `Manifest row ${primary.rowNumber} omits a cohort required by sealed logical-receipt facts`);
    }
    if ([...declared].some((cohort) => !required.has(cohort))) {
      fail("COHORT_PREDICATE_INVALID", `Manifest row ${primary.rowNumber} declares a cohort not supported by sealed logical-receipt facts`);
    }
  }
}

function validateIntakeRows(rows: IntakeRow[], runPlan: ArtifactMap["run_plan"], seal: EvaluationSeal): void {
  const sampleIds = new Set<string>();
  const reviewEnd = Date.parse(runPlan.planned_review_end_at_utc);

  for (const row of rows) {
    for (const header of INTAKE_HEADERS) {
      if (header !== "exclusion_reason" && row[header] !== row[header].trim()) {
        fail("CSV_WHITESPACE_INVALID", `Manifest row ${row.rowNumber} has leading or trailing whitespace`);
      }
      if (header !== "exclusion_reason" && row[header] === "") {
        fail("REQUIRED_FIELD_MISSING", `Manifest row ${row.rowNumber} is missing ${header}`);
      }
    }
    if (!row.sample_id || sampleIds.has(row.sample_id)) {
      fail("SAMPLE_ID_DUPLICATE", `Manifest row ${row.rowNumber} has a missing or duplicate sample_id`);
    }
    sampleIds.add(row.sample_id);
    if (!BENCHMARK_ROLES.has(row.benchmark_count_role)) fail("CONTROLLED_VALUE_INVALID", `Manifest row ${row.rowNumber} has an invalid benchmark_count_role`);
    if (!SOURCE_CLASSES.has(row.source_class)) fail("CONTROLLED_VALUE_INVALID", `Manifest row ${row.rowNumber} has an invalid source_class`);
    if (!CAPTURE_MODES.has(row.capture_mode)) fail("CONTROLLED_VALUE_INVALID", `Manifest row ${row.rowNumber} has an invalid capture_mode`);
    if (!RECEIPT_TYPES.has(row.receipt_type)) fail("CONTROLLED_VALUE_INVALID", `Manifest row ${row.rowNumber} has an invalid receipt_type`);
    if (!REDACTION_STATES.has(row.redaction_state)) fail("CONTROLLED_VALUE_INVALID", `Manifest row ${row.rowNumber} has an invalid redaction_state`);
    if (!SHA256.test(row.source_sha256) || !SHA256.test(row.ground_truth_sha256)) {
      fail("SHA256_INVALID", `Manifest row ${row.rowNumber} has an invalid SHA-256 value`);
    }

    const conditions = splitControlled(row.condition_tags, CONDITION_TAGS, "condition_tags", row.rowNumber);
    splitControlled(row.cohort_tags, new Set(COHORT_TAGS), "cohort_tags", row.rowNumber, true);
    const uses = splitControlled(row.permitted_uses, PERMITTED_USES, "permitted_uses", row.rowNumber);
    const providers: string[] = [];
    if (row.allowed_cloud_providers !== "NONE") {
      const supplied = row.allowed_cloud_providers.split("|");
      if (supplied.some((provider) => !CLOUD_PROVIDER_CONSENT_IDS.has(provider)) || new Set(supplied).size !== supplied.length) {
        fail("CLOUD_PROVIDER_INVALID", `Manifest row ${row.rowNumber} has an invalid allowed_cloud_providers value`);
      }
      providers.push(...supplied);
    }
    const languages = row.language_tags === "NOT_APPLICABLE" ? [] : row.language_tags.split("|");
    if (languages.some((tag) => !BCP47.test(tag)) || new Set(languages).size !== languages.length) {
      fail("LANGUAGE_TAG_INVALID", `Manifest row ${row.rowNumber} has an invalid or duplicate language tag`);
    }

    const eligible = parseBoolean(row.release_gate_eligible, "release_gate_eligible", row.rowNumber);
    if (eligible && row.benchmark_count_role === "EXCLUDED") {
      fail("EXCLUDED_ROLE_ELIGIBLE", `Manifest row ${row.rowNumber} cannot be both EXCLUDED and release-gate eligible`);
    }
    const capturedAt = parseUtc(row.captured_at_utc, "captured_at_utc", row.rowNumber);
    const intakeAt = parseUtc(row.intake_at_utc, "intake_at_utc", row.rowNumber);
    const groundTruthSealedAt = parseUtc(row.ground_truth_sealed_at_utc, "ground_truth_sealed_at_utc", row.rowNumber);
    const retentionExpiresAt = parseUtc(row.retention_expires_at_utc, "retention_expires_at_utc", row.rowNumber);
    if (capturedAt > intakeAt || intakeAt > groundTruthSealedAt) {
      fail("INTAKE_TIME_ORDER_INVALID", `Manifest row ${row.rowNumber} has an invalid capture, intake, or ground-truth order`);
    }
    if (groundTruthSealedAt > Date.parse(seal.sealed_at_utc)) {
      fail("GROUND_TRUTH_NOT_PRESEALED", `Manifest row ${row.rowNumber} was sealed after the benchmark seal`);
    }
    validateReviewerPair(row.ground_truth_reviewer_1, row.ground_truth_reviewer_2, row.rowNumber, "manifest");
    validateOpaqueReference(row.private_storage_reference, "private_storage_reference", row.rowNumber);
    validateOpaqueReference(row.ground_truth_reference, "ground_truth_reference", row.rowNumber);

    if (row.source_class === "CONSENTED_OWNER") {
      if ([row.consent_record_id, row.consent_scope_version, row.donor_pseudonym].some((value) => !value || value === "NOT_APPLICABLE")) {
        fail("CONSENT_RECORD_MISSING", `Manifest row ${row.rowNumber} lacks recorded owner consent metadata`);
      }
    }
    if (row.benchmark_count_role === "NON_RECEIPT") {
      if (row.receipt_id !== "NOT_APPLICABLE" || row.receipt_type !== "NON_RECEIPT") {
        fail("NON_RECEIPT_ROLE_INVALID", `Manifest row ${row.rowNumber} has inconsistent non-receipt fields`);
      }
    } else if (row.benchmark_count_role !== "EXCLUDED") {
      if (row.receipt_id === "NOT_APPLICABLE" || row.receipt_type === "NON_RECEIPT") {
        fail("RECEIPT_ROLE_INVALID", `Manifest row ${row.rowNumber} has inconsistent receipt fields`);
      }
    }
    if (row.page_number !== "NOT_APPLICABLE" && !/^[1-9]\d*$/.test(row.page_number)) {
      fail("PAGE_NUMBER_INVALID", `Manifest row ${row.rowNumber} has an invalid page_number`);
    }
    validateLongCaptureFact(row, conditions);

    if (eligible) {
      if (!uses.includes(runPlan.purpose)) {
        fail("PURPOSE_NOT_PERMITTED", `Manifest row ${row.rowNumber} does not permit this run purpose`);
      }
      if (retentionExpiresAt <= reviewEnd) {
        fail("RETENTION_WINDOW_INVALID", `Manifest row ${row.rowNumber} expires before the planned review ends`);
      }
      if (!new Set(["NONE_NEEDED", "REDACTED_WITH_MAP"]).has(row.redaction_state)) {
        fail("REDACTION_INCOMPLETE", `Manifest row ${row.rowNumber} is not ready for an eligible run`);
      }
      if (!LOCAL_PROVIDERS.has(runPlan.provider) && !providers.includes(runPlan.provider)) {
        fail("CLOUD_PROVIDER_NOT_CONSENTED", `Manifest row ${row.rowNumber} does not allow the declared cloud provider`);
      }
      if (row.exclusion_reason && row.exclusion_reason !== "NOT_APPLICABLE") {
        fail("ELIGIBILITY_CONTRADICTION", `Manifest row ${row.rowNumber} is eligible but has an exclusion reason`);
      }
    } else if (!row.exclusion_reason || row.exclusion_reason === "NOT_APPLICABLE") {
      fail("EXCLUSION_REASON_MISSING", `Manifest row ${row.rowNumber} is ineligible without an exclusion reason`);
    }
  }
}

function validatePairRows(
  rows: PairRow[],
  intakeRows: IntakeRow[],
  runPlan: ArtifactMap["run_plan"],
  seal: EvaluationSeal,
): void {
  const sampleById = new Map(intakeRows.map((row) => [row.sample_id, row]));
  const pairIds = new Set<string>();
  const samplePairs = new Set<string>();
  for (const row of rows) {
    for (const header of PAIR_HEADERS) {
      if (header !== "exclusion_reason" && (!row[header] || row[header] !== row[header].trim())) {
        fail("PAIR_REQUIRED_FIELD_INVALID", `Pair row ${row.rowNumber} has a missing or padded ${header}`);
      }
    }
    if (pairIds.has(row.pair_id)) fail("PAIR_ID_DUPLICATE", `Pair row ${row.rowNumber} repeats a pair_id`);
    pairIds.add(row.pair_id);
    if (row.left_sample_id >= row.right_sample_id) {
      fail("PAIR_ORDER_INVALID", `Pair row ${row.rowNumber} is not in canonical lexicographic order`);
    }
    const pairKey = `${row.left_sample_id}\u0000${row.right_sample_id}`;
    if (samplePairs.has(pairKey)) fail("PAIR_DUPLICATE", `Pair row ${row.rowNumber} repeats a sample pair`);
    samplePairs.add(pairKey);
    if (!PAIR_LABELS.has(row.pair_label) || !RELATIONSHIP_BASES.has(row.relationship_basis)) {
      fail("PAIR_CONTROLLED_VALUE_INVALID", `Pair row ${row.rowNumber} has an invalid controlled value`);
    }
    if (
      row.pair_label === "DUPLICATE" &&
      !new Set(["SAME_PURCHASE_RECAPTURE", "SAME_FILE_REIMPORT", "OTHER_RECORDED"]).has(row.relationship_basis)
    ) {
      fail("PAIR_BASIS_CONTRADICTION", `Pair row ${row.rowNumber} contradicts its duplicate label`);
    }
    if (
      row.pair_label === "NON_DUPLICATE" &&
      !new Set(["DIFFERENT_PURCHASE_SAME_VENDOR_AMOUNT_DATE", "DIFFERENT_PURCHASE", "OTHER_RECORDED"]).has(row.relationship_basis)
    ) {
      fail("PAIR_BASIS_CONTRADICTION", `Pair row ${row.rowNumber} contradicts its non-duplicate label`);
    }
    validateReviewerPair(row.ground_truth_reviewer_1, row.ground_truth_reviewer_2, row.rowNumber, "pair");
    if (parseUtc(row.reviewed_at_utc, "reviewed_at_utc", row.rowNumber) > Date.parse(seal.sealed_at_utc)) {
      fail("PAIR_NOT_PRESEALED", `Pair row ${row.rowNumber} was reviewed after the benchmark seal`);
    }
    const eligible = parseBoolean(row.release_gate_eligible, "release_gate_eligible", row.rowNumber);
    const left = sampleById.get(row.left_sample_id);
    const right = sampleById.get(row.right_sample_id);
    if (!left || !right) fail("PAIR_SAMPLE_UNKNOWN", `Pair row ${row.rowNumber} references an unknown sample`);
    const receiptPair = left.receipt_id !== "NOT_APPLICABLE" && right.receipt_id !== "NOT_APPLICABLE";
    if (row.pair_label === "DUPLICATE" && (!receiptPair || left.receipt_id !== right.receipt_id)) {
      fail("PAIR_RECEIPT_IDENTITY_INVALID", `Pair row ${row.rowNumber} labels samples from different receipt identities as duplicate`);
    }
    if (row.pair_label === "NON_DUPLICATE" && (!receiptPair || left.receipt_id === right.receipt_id)) {
      fail("PAIR_RECEIPT_IDENTITY_INVALID", `Pair row ${row.rowNumber} does not identify two distinct receipts`);
    }
    if (eligible) {
      if (left.release_gate_eligible !== "true" || right.release_gate_eligible !== "true") {
        fail("PAIR_SAMPLE_INELIGIBLE", `Pair row ${row.rowNumber} depends on an ineligible sample`);
      }
      const useAllowed = [left, right].every((sample) => sample.permitted_uses.split("|").includes(runPlan.purpose));
      if (!useAllowed) fail("PAIR_PURPOSE_NOT_PERMITTED", `Pair row ${row.rowNumber} is not eligible for this purpose`);
      if (row.exclusion_reason && row.exclusion_reason !== "NOT_APPLICABLE") {
        fail("PAIR_ELIGIBILITY_CONTRADICTION", `Pair row ${row.rowNumber} is eligible but has an exclusion reason`);
      }
    } else if (!row.exclusion_reason || row.exclusion_reason === "NOT_APPLICABLE") {
      fail("PAIR_EXCLUSION_REASON_MISSING", `Pair row ${row.rowNumber} is ineligible without an exclusion reason`);
    }
  }
}

function validateCountingStructure(intakeRows: IntakeRow[]): void {
  const eligibleReceiptRows = intakeRows.filter(
    (row) => row.release_gate_eligible === "true" && !new Set(["NON_RECEIPT", "EXCLUDED"]).has(row.benchmark_count_role),
  );
  const byReceipt = new Map<string, IntakeRow[]>();
  for (const row of eligibleReceiptRows) {
    const group = byReceipt.get(row.receipt_id) ?? [];
    group.push(row);
    byReceipt.set(row.receipt_id, group);
  }
  for (const group of byReceipt.values()) {
    if (group.filter((row) => row.benchmark_count_role === "PRIMARY_RECEIPT").length !== 1) {
      fail("PRIMARY_RECEIPT_COUNT_INVALID", "Each eligible receipt_id requires exactly one PRIMARY_RECEIPT row");
    }
    const stableFields = ["source_class", "vendor_template_id", "ground_truth_version", "ground_truth_sha256"] as const;
    for (const field of stableFields) {
      if (new Set(group.map((row) => row[field])).size !== 1) {
        fail("RECEIPT_METADATA_INCONSISTENT", `Rows for one receipt_id disagree on ${field}`);
      }
    }
  }
  for (const role of ["SAME_RECEIPT_SUPPORT", "DERIVED_NOT_COUNTED"]) {
    for (const row of intakeRows.filter((candidate) => candidate.benchmark_count_role === role)) {
      if (!intakeRows.some((candidate) => candidate.receipt_id === row.receipt_id && candidate.benchmark_count_role === "PRIMARY_RECEIPT")) {
        fail("SUPPORT_WITHOUT_PRIMARY", `Manifest row ${row.rowNumber} has no primary receipt row`);
      }
    }
  }
}

function validateArtifactContracts(
  intakeRows: IntakeRow[],
  artifactBySampleId: Map<string, ArtifactMap["artifacts"][number]>,
  eligibleCaptureRows: Map<string, IntakeRow[]>,
  provider: string,
): void {
  const captureSampleIds = new Set([...eligibleCaptureRows.values()].flatMap((rows) => rows.map((row) => row.sample_id)));
  const cornerSampleIds = new Set(
    [...eligibleCaptureRows.values()]
      .filter((rows) => rows.some((row) => row.benchmark_count_role !== "NON_RECEIPT"))
      .flatMap((rows) => rows.filter((row) => row.benchmark_count_role === "PRIMARY_RECEIPT").map((row) => row.sample_id)),
  );
  for (const row of intakeRows.filter((candidate) => candidate.release_gate_eligible === "true")) {
    const artifact = artifactBySampleId.get(row.sample_id)!;
    if (
      new Set(artifact.applicable_fields).size !== artifact.applicable_fields.length ||
      new Set(artifact.handwritten_fields).size !== artifact.handwritten_fields.length ||
      new Set(artifact.metric_families).size !== artifact.metric_families.length
    ) {
      fail("ARTIFACT_APPLICABILITY_DUPLICATE", `Artifact-map entry for manifest row ${row.rowNumber} repeats a sealed applicability value`);
    }
    const applicableFields = new Set(artifact.applicable_fields);
    if (artifact.handwritten_fields.some((field) => !applicableFields.has(field))) {
      fail("HANDWRITING_APPLICABILITY_INVALID", `Artifact-map entry for manifest row ${row.rowNumber} marks a non-applicable field as handwritten`);
    }
    const expectedFamilies = new Set<MetricFamily>();
    if (captureSampleIds.has(row.sample_id)) {
      expectedFamilies.add("CAPTURE_DETECTION_LATENCY");
      expectedFamilies.add("CAPTURE_LIVE_GUIDANCE_LATENCY");
    }
    if (cornerSampleIds.has(row.sample_id)) expectedFamilies.add("NORMALIZED_CORNER_ERROR");
    if (row.benchmark_count_role === "PRIMARY_RECEIPT") {
      expectedFamilies.add("LINE_ITEMS");
      expectedFamilies.add("MANUAL_CORRECTIONS");
      expectedFamilies.add("PROCESSED_COMPOSITE");
      const cohorts = new Set(row.cohort_tags.split("|"));
      if (cohorts.has("HANDWRITTEN_OR_HAND_ANNOTATED")) expectedFamilies.add("HANDWRITING_TEXT");
      if (cohorts.has("LONG")) expectedFamilies.add("LONG_RECONSTRUCTION");
      if (LOCAL_PROVIDERS.has(provider) && artifact.ground_truth_page_count === 1) {
        expectedFamilies.add("LOCAL_RESULT_LATENCY");
      }
      if (artifact.ground_truth_page_count < 1) {
        fail("SEALED_PAGE_COUNT_INVALID", `Artifact-map entry for manifest row ${row.rowNumber} has no receipt page`);
      }
    } else if (row.benchmark_count_role === "NON_RECEIPT") {
      if (artifact.ground_truth_page_count !== 0 || artifact.applicable_fields.length || artifact.handwritten_fields.length) {
        fail("NON_RECEIPT_APPLICABILITY_INVALID", `Artifact-map entry for manifest row ${row.rowNumber} assigns receipt truth to a non-receipt`);
      }
    }
    const suppliedFamilies = new Set<MetricFamily>(artifact.metric_families);
    if (
      suppliedFamilies.size !== expectedFamilies.size ||
      [...suppliedFamilies].some((family) => !expectedFamilies.has(family))
    ) {
      fail("METRIC_FAMILY_APPLICABILITY_INVALID", `Artifact-map entry for manifest row ${row.rowNumber} does not match the frozen metric frame`);
    }
    const denominators = artifact.metric_denominators;
    const denominatorBindings = [
      ["HANDWRITING_TEXT", denominators.handwriting_text],
      ["LINE_ITEMS", denominators.line_items],
      ["LONG_RECONSTRUCTION", denominators.long_reconstruction],
      ["MANUAL_CORRECTIONS", denominators.manual_corrections],
      ["PROCESSED_COMPOSITE", denominators.processed_composite],
    ] as const;
    for (const [family, denominatorBlock] of denominatorBindings) {
      if (expectedFamilies.has(family) !== (denominatorBlock !== undefined)) {
        fail("SEALED_DENOMINATOR_COVERAGE_INVALID", `Artifact-map entry for manifest row ${row.rowNumber} does not bind a metric denominator`);
      }
    }
    if (row.benchmark_count_role === "PRIMARY_RECEIPT") {
      const applicableFinancialFieldCount = artifact.applicable_fields
        .filter((field) => HANDWRITING_FINANCIAL_FIELDS.has(field)).length;
      if (denominators.processed_composite!.scored_financial_fields !== applicableFinancialFieldCount) {
        fail(
          "PROCESSED_FINANCIAL_FRAME_INVALID",
          `Artifact-map entry for manifest row ${row.rowNumber} does not bind processed scoring to applicable financial fields`,
        );
      }
    }
  }
}

function validateIndependentTrialPlan(
  trialPlan: ArtifactMap["independent_trials"],
  primaryBySampleId: Map<string, IntakeRow>,
  eligibleCaptureRows: Map<string, IntakeRow[]>,
): void {
  const validatePlan = (
    units: Array<{ unitId: string; trialId: string }>,
    expectedUnitIds: Set<string>,
    code: string,
  ) => {
    const unitIds = units.map((unit) => unit.unitId);
    const trialIds = units.map((unit) => unit.trialId);
    if (
      unitIds.length !== expectedUnitIds.size || new Set(unitIds).size !== unitIds.length ||
      unitIds.some((unitId) => !expectedUnitIds.has(unitId)) || new Set(trialIds).size !== trialIds.length
    ) {
      fail(code, "The sealed independent-trial plan must bind each eligible unit to one distinct trial");
    }
  };
  validatePlan(
    trialPlan.captures.map((trial) => ({ unitId: trial.capture_attempt_id, trialId: trial.trial_id })),
    new Set(eligibleCaptureRows.keys()),
    "CAPTURE_TRIAL_PLAN_INVALID",
  );
  validatePlan(
    trialPlan.receipts.map((trial) => ({ unitId: trial.sample_id, trialId: trial.trial_id })),
    new Set(primaryBySampleId.keys()),
    "RECEIPT_TRIAL_PLAN_INVALID",
  );
}

function validateResultCoverage(
  results: ScoredResults,
  primaryBySampleId: Map<string, IntakeRow>,
  eligibleCaptureRows: Map<string, IntakeRow[]>,
  eligiblePairsById: Map<string, PairRow>,
  artifactBySampleId: Map<string, ArtifactMap["artifacts"][number]>,
  trialPlan: ArtifactMap["independent_trials"],
): void {
  const validateExactSet = (actual: string[], expected: Set<string>, code: string) => {
    if (actual.length !== new Set(actual).size || actual.length !== expected.size || actual.some((id) => !expected.has(id))) {
      fail(code, "A supplied result collection must cover each eligible unit exactly once");
    }
  };

  if (results.captures !== undefined) {
    validateExactSet(results.captures.map((entry) => entry.capture_attempt_id), new Set(eligibleCaptureRows.keys()), "CAPTURE_RESULT_COVERAGE_INVALID");
    if (new Set(results.captures.map((entry) => entry.trial_id)).size !== results.captures.length) {
      fail("TRIAL_ID_DUPLICATE", "Capture observations require distinct trial_id values");
    }
    for (const [index, capture] of results.captures.entries()) {
      const plannedTrial = trialPlan.captures.find((trial) => trial.capture_attempt_id === capture.capture_attempt_id)!;
      if (capture.trial_id !== plannedTrial.trial_id) {
        fail("CAPTURE_TRIAL_MISMATCH", `Capture observation ${index + 1} does not match its pre-result sealed trial`);
      }
      const rows = eligibleCaptureRows.get(capture.capture_attempt_id)!;
      const families = rows.map((row) => new Set(artifactBySampleId.get(row.sample_id)!.metric_families));
      const expects = (family: MetricFamily) => {
        const decisions = families.map((entry) => entry.has(family));
        if (new Set(decisions).size !== 1) {
          fail("CAPTURE_METRIC_APPLICABILITY_INCONSISTENT", `Capture observation ${index + 1} has inconsistent sealed metric applicability`);
        }
        return decisions[0]!;
      };
      const metrics = [
        ["CAPTURE_DETECTION_LATENCY", "detection_latency_ms"],
        ["CAPTURE_LIVE_GUIDANCE_LATENCY", "live_guidance_latency_ms"],
      ] as const;
      for (const [family, property] of metrics) {
        if (expects(family) !== (capture[property] !== undefined)) {
          fail("CAPTURE_METRIC_COVERAGE_INVALID", `Capture observation ${index + 1} does not match its sealed metric applicability`);
        }
      }
      const expectedCornerSamples = new Set(
        rows
          .filter((row) => row.benchmark_count_role === "PRIMARY_RECEIPT")
          .filter((row) => artifactBySampleId.get(row.sample_id)!.metric_families.includes("NORMALIZED_CORNER_ERROR"))
          .map((row) => row.sample_id),
      );
      if ((capture.corner_errors !== undefined) !== (expectedCornerSamples.size > 0)) {
        fail("CAPTURE_METRIC_COVERAGE_INVALID", `Capture observation ${index + 1} does not match sealed corner-error applicability`);
      }
      if (capture.corner_errors) {
        validateExactSet(
          capture.corner_errors.map((entry) => entry.sample_id),
          expectedCornerSamples,
          "CORNER_RESULT_COVERAGE_INVALID",
        );
      }
    }
  }
  if (results.receipts !== undefined) {
    validateExactSet(results.receipts.map((entry) => entry.sample_id), new Set(primaryBySampleId.keys()), "RECEIPT_RESULT_COVERAGE_INVALID");
    if (new Set(results.receipts.map((entry) => entry.trial_id)).size !== results.receipts.length) {
      fail("TRIAL_ID_DUPLICATE", "Receipt observations require distinct trial_id values");
    }
    for (const [index, receipt] of results.receipts.entries()) {
      const plannedTrial = trialPlan.receipts.find((trial) => trial.sample_id === receipt.sample_id)!;
      if (receipt.trial_id !== plannedTrial.trial_id) {
        fail("RECEIPT_TRIAL_MISMATCH", `Receipt observation ${index + 1} does not match its pre-result sealed trial`);
      }
      const artifact = artifactBySampleId.get(receipt.sample_id)!;
      const applicableFields = new Set(artifact.applicable_fields);
      const handwrittenFields = new Set(artifact.handwritten_fields);
      const metricFamilies = new Set(artifact.metric_families);
      const denominators = artifact.metric_denominators;
      if (receipt.page_count !== artifact.ground_truth_page_count) {
        fail("PAGE_COUNT_MISMATCH", `Receipt observation ${index + 1} does not match its sealed page count`);
      }
      const fieldNames = receipt.fields.map((field) => field.field);
      if (fieldNames.length !== FIELD_NAMES.length || new Set(fieldNames).size !== FIELD_NAMES.length || FIELD_NAMES.some((field) => !fieldNames.includes(field))) {
        fail("FIELD_RESULT_COVERAGE_INVALID", `Receipt observation ${index + 1} must score every v1 field exactly once`);
      }
      if (receipt.status !== "SUCCESS" && receipt.fields.some((field) => field.exact_match === true)) {
        fail("FAILED_RESULT_SCORED_CORRECT", `Receipt observation ${index + 1} marks a failed result as correct`);
      }
      for (const field of receipt.fields) {
        if (field.applicable !== applicableFields.has(field.field)) {
          fail("FIELD_APPLICABILITY_MISMATCH", `Receipt observation ${index + 1} does not match sealed field applicability`);
        }
        if (field.handwritten !== handwrittenFields.has(field.field)) {
          fail("HANDWRITING_APPLICABILITY_MISMATCH", `Receipt observation ${index + 1} does not match sealed handwriting applicability`);
        }
        if (field.applicable && field.value_state !== "PRESENT" && field.exact_match !== false) {
          fail("FIELD_STATE_CONTRADICTION", `Receipt observation ${index + 1} has a contradictory field state`);
        }
        if (field.field === "total" && field.applicable && field.exact_match === true && field.absolute_error_minor !== undefined && field.absolute_error_minor !== 0) {
          fail("TOTAL_ERROR_CONTRADICTION", `Receipt observation ${index + 1} gives an exact total a nonzero error`);
        }
        if (
          field.field === "total" && field.applicable && field.exact_match === false &&
          receipt.status === "SUCCESS" && field.value_state === "PRESENT" && field.absolute_error_minor === undefined
        ) {
          fail("TOTAL_ABSOLUTE_ERROR_MISSING", `Receipt observation ${index + 1} omits absolute error for an incorrect total`);
        }
        if (
          field.field === "total" && field.absolute_error_minor !== undefined &&
          (receipt.status !== "SUCCESS" || field.value_state !== "PRESENT")
        ) {
          fail("TOTAL_ABSOLUTE_ERROR_NOT_APPLICABLE", `Receipt observation ${index + 1} assigns numeric error without a numeric total prediction`);
        }
        if (receipt.status !== "SUCCESS" && field.applicable && (
          field.exact_match !== false || field.value_state !== "MISSING" || field.confidence_band !== "NOT_ASSIGNED"
        )) {
          fail("NON_SUCCESS_FIELD_INVALID", `Receipt observation ${index + 1} does not score a non-success field as missing and incorrect`);
        }
        if (receipt.status !== "SUCCESS" && field.applicable && CRITICAL_RECEIPT_FIELDS.has(field.field) && !field.routed_to_review) {
          fail("NON_SUCCESS_REVIEW_ROUTING_INVALID", `Receipt observation ${index + 1} does not route a critical non-success field to review`);
        }
      }
      const familyProperties = [
        ["HANDWRITING_TEXT", "text"],
        ["LINE_ITEMS", "items"],
        ["LONG_RECONSTRUCTION", "reconstruction"],
        ["MANUAL_CORRECTIONS", "corrections"],
        ["LOCAL_RESULT_LATENCY", "local_result_latency_ms"],
        ["PROCESSED_COMPOSITE", "processed_composite"],
      ] as const;
      for (const [family, property] of familyProperties) {
        if (metricFamilies.has(family) !== (receipt[property] !== undefined)) {
          fail("RECEIPT_METRIC_COVERAGE_INVALID", `Receipt observation ${index + 1} does not match its sealed metric applicability`);
        }
      }
      const items = receipt.items;
      if (receipt.text && (
        receipt.text.ground_truth_characters !== denominators.handwriting_text!.ground_truth_characters ||
        receipt.text.ground_truth_words !== denominators.handwriting_text!.ground_truth_words
      )) fail("SEALED_DENOMINATOR_MISMATCH", `Receipt observation ${index + 1} changes a sealed text denominator`);
      if (items && (
        items.matched_items > items.predicted_items || items.matched_items > items.ground_truth_items ||
        items.quantity_applicable > items.ground_truth_items ||
        items.unit_price_applicable > items.ground_truth_items ||
        items.line_total_applicable > items.ground_truth_items ||
        items.quantity_exact > items.quantity_applicable || items.unit_price_exact > items.unit_price_applicable ||
        items.line_total_exact > items.line_total_applicable ||
        items.quantity_exact > items.matched_items || items.unit_price_exact > items.matched_items ||
        items.line_total_exact > items.matched_items
      )) fail("ITEM_COUNTS_INVALID", `Receipt observation ${index + 1} has impossible item counts`);
      if (items && (
        items.ground_truth_items !== denominators.line_items!.ground_truth_items ||
        items.quantity_applicable !== denominators.line_items!.quantity_applicable ||
        items.unit_price_applicable !== denominators.line_items!.unit_price_applicable ||
        items.line_total_applicable !== denominators.line_items!.line_total_applicable
      )) fail("SEALED_DENOMINATOR_MISMATCH", `Receipt observation ${index + 1} changes sealed item denominators`);
      const reconstruction = receipt.reconstruction;
      if (reconstruction && (
        reconstruction.matched_lines > reconstruction.ground_truth_lines ||
        reconstruction.ordered_lines > reconstruction.matched_lines
      )) fail("RECONSTRUCTION_COUNTS_INVALID", `Receipt observation ${index + 1} has impossible reconstruction counts`);
      if (reconstruction && (
        reconstruction.ground_truth_lines !== denominators.long_reconstruction!.ground_truth_lines ||
        reconstruction.known_truncated !== denominators.long_reconstruction!.known_truncated
      )) fail("SEALED_DENOMINATOR_MISMATCH", `Receipt observation ${index + 1} changes sealed reconstruction truth`);
      const corrections = receipt.corrections;
      if (corrections && (corrections.changed_fields > corrections.reviewed_fields || corrections.changed_items > corrections.reviewed_items)) {
        fail("CORRECTION_COUNTS_INVALID", `Receipt observation ${index + 1} has impossible correction counts`);
      }
      if (corrections && (
        corrections.reviewed_fields !== denominators.manual_corrections!.reviewed_fields ||
        corrections.reviewed_items !== denominators.manual_corrections!.reviewed_items
      )) fail("SEALED_DENOMINATOR_MISMATCH", `Receipt observation ${index + 1} changes sealed correction denominators`);
      const comparison = receipt.processed_composite;
      if (comparison && (
        comparison.original_correct_fields > comparison.scored_financial_fields ||
        comparison.processed_correct_fields > comparison.scored_financial_fields ||
        comparison.regressed_fields < Math.max(0, comparison.original_correct_fields - comparison.processed_correct_fields) ||
        comparison.regressed_fields > Math.min(
          comparison.original_correct_fields,
          comparison.scored_financial_fields - comparison.processed_correct_fields,
        )
      )) fail("PROCESSED_COMPARISON_INVALID", `Receipt observation ${index + 1} has impossible processed-composite counts`);
      if (comparison && comparison.scored_financial_fields !== denominators.processed_composite!.scored_financial_fields) {
        fail("SEALED_DENOMINATOR_MISMATCH", `Receipt observation ${index + 1} changes a sealed processed-composite denominator`);
      }
      if (receipt.status !== "SUCCESS") {
        if (items && (
          items.matched_items !== 0 || items.quantity_exact !== 0 || items.unit_price_exact !== 0 || items.line_total_exact !== 0
        )) fail("NON_SUCCESS_ITEM_SCORE_INVALID", `Receipt observation ${index + 1} gives correct item output to a non-success result`);
        if (reconstruction && (
          reconstruction.matched_lines !== 0 || reconstruction.ordered_lines !== 0 || reconstruction.marked_complete
        )) fail("NON_SUCCESS_RECONSTRUCTION_INVALID", `Receipt observation ${index + 1} gives correct reconstruction output to a non-success result`);
        if (receipt.text && (
          receipt.text.character_errors < receipt.text.ground_truth_characters ||
          receipt.text.word_errors < receipt.text.ground_truth_words
        )) fail("NON_SUCCESS_TEXT_SCORE_INVALID", `Receipt observation ${index + 1} understates text error for a non-success result`);
        if (comparison && comparison.processed_correct_fields !== 0) {
          fail("NON_SUCCESS_PROCESSED_SCORE_INVALID", `Receipt observation ${index + 1} gives correct processed output to a non-success result`);
        }
      }
    }
  }
  if (results.pair_predictions !== undefined) {
    validateExactSet(results.pair_predictions.map((entry) => entry.pair_id), new Set(eligiblePairsById.keys()), "PAIR_RESULT_COVERAGE_INVALID");
  }
}

function countCorpus(intakeRows: IntakeRow[], pairRows: PairRow[]): CorpusCounts {
  const consentedRealReceiptIds = new Set<string>();
  const eligibleRealReceiptIds = new Set<string>();
  const eligibleNonReceiptSampleIds = new Set<string>();
  const cohortReceiptIds = new Map(COHORT_TAGS.map((cohort) => [cohort, new Set<string>()]));
  const realCohortReceiptIds = new Map(COHORT_TAGS.map((cohort) => [cohort, new Set<string>()]));
  const vendorReceiptIds = new Map<string, Set<string>>();
  for (const row of intakeRows) {
    if (row.release_gate_eligible !== "true") continue;
    if (row.benchmark_count_role === "NON_RECEIPT") {
      eligibleNonReceiptSampleIds.add(row.sample_id);
      continue;
    }
    if (row.benchmark_count_role !== "PRIMARY_RECEIPT") continue;
    const realSource = row.source_class === "CONSENTED_OWNER" || row.source_class === "PUBLIC_LICENSED";
    if (realSource) {
      eligibleRealReceiptIds.add(row.receipt_id);
      for (const cohort of row.cohort_tags.split("|")) realCohortReceiptIds.get(cohort as typeof COHORT_TAGS[number])?.add(row.receipt_id);
    }
    if (row.source_class !== "CONSENTED_OWNER") continue;
    consentedRealReceiptIds.add(row.receipt_id);
    for (const cohort of row.cohort_tags.split("|")) cohortReceiptIds.get(cohort as typeof COHORT_TAGS[number])?.add(row.receipt_id);
    const vendorGroup = vendorReceiptIds.get(row.vendor_template_id) ?? new Set<string>();
    vendorGroup.add(row.receipt_id);
    vendorReceiptIds.set(row.vendor_template_id, vendorGroup);
  }
  return {
    consentedRealReceiptIds,
    eligibleRealReceiptIds,
    eligibleNonReceiptSampleIds,
    cohortReceiptIds,
    realCohortReceiptIds,
    vendorReceiptIds,
    duplicatePairIds: new Set(pairRows.filter((row) => row.release_gate_eligible === "true" && row.pair_label === "DUPLICATE").map((row) => row.pair_id)),
    nonDuplicatePairIds: new Set(pairRows.filter((row) => row.release_gate_eligible === "true" && row.pair_label === "NON_DUPLICATE").map((row) => row.pair_id)),
  };
}

function validatePreResultCapstoneCorpus(policy: BenchmarkPolicy, counts: CorpusCounts): void {
  const largestVendorGroup = Math.max(0, ...[...counts.vendorReceiptIds.values()].map((receipts) => receipts.size));
  const vendorShare = counts.consentedRealReceiptIds.size === 0
    ? 1
    : largestVendorGroup / counts.consentedRealReceiptIds.size;
  const cohortFloorMissed = COHORT_TAGS.some((cohort) =>
    counts.cohortReceiptIds.get(cohort)!.size <
      policy.capstoneCorpus.cohortReceiptMinimums[policy.capstoneCorpus.cohortTagMap[cohort]]!
  );
  if (
    counts.consentedRealReceiptIds.size < policy.capstoneCorpus.uniqueConsentedRealReceiptsMin ||
    counts.eligibleNonReceiptSampleIds.size < policy.capstoneCorpus.nonReceiptsMin ||
    counts.duplicatePairIds.size < policy.capstoneCorpus.knownDuplicatePairsMin ||
    counts.nonDuplicatePairIds.size < policy.capstoneCorpus.knownNonDuplicatePairsMin ||
    vendorShare > policy.capstoneCorpus.vendorTemplateShareMax ||
    cohortFloorMissed
  ) {
    fail(
      "CAPSTONE_CORPUS_FLOOR_NOT_MET",
      "The sealed CAPSTONE_DEMO corpus does not meet every pre-result receipt, cohort, non-receipt, pair, and vendor-share floor",
    );
  }
}

function validatePolicy(policy: BenchmarkPolicy, repositoryRoot: string): void {
  if (policy.policyId !== "finsight-core-evidence-gates-v1") fail("POLICY_ID_INVALID", "The repository policy ID is not policy v1");
  const artifacts = [
    policy.capstoneCorpus.normativeIntakeArtifacts.dataDictionary,
    policy.capstoneCorpus.normativeIntakeArtifacts.receiptIntakeHeader,
    policy.capstoneCorpus.normativeIntakeArtifacts.pairLabelHeader,
    { path: policy.existingScannerHarnessGates.source, sha256: policy.existingScannerHarnessGates.sourceSha256 },
  ];
  for (const artifact of artifacts) {
    const path = realpathSync(resolve(repositoryRoot, artifact.path));
    if (!isInside(repositoryRoot, path) || sha256File(path) !== artifact.sha256) {
      fail("NORMATIVE_ARTIFACT_HASH_MISMATCH", "A frozen normative artifact no longer matches policy v1");
    }
  }
  const intakeHeaderRows = parseStrictCsv(
    resolve(repositoryRoot, policy.capstoneCorpus.normativeIntakeArtifacts.receiptIntakeHeader.path),
    INTAKE_HEADERS,
    "NORMATIVE_INTAKE_HEADER_INVALID",
  );
  const pairHeaderRows = parseStrictCsv(
    resolve(repositoryRoot, policy.capstoneCorpus.normativeIntakeArtifacts.pairLabelHeader.path),
    PAIR_HEADERS,
    "NORMATIVE_PAIR_HEADER_INVALID",
  );
  if (intakeHeaderRows.length !== 0 || pairHeaderRows.length !== 0) {
    fail("NORMATIVE_HEADER_NOT_EMPTY", "Frozen header examples must remain header-only");
  }
}

export function loadAndValidateInputs(options: EvaluationPaths): ValidatedInputs {
  const repositoryRoot = realpathSync(options.repositoryRoot);
  const policyPath = realpathSync(resolve(repositoryRoot, "docs/phase-0/benchmark-policy-v1.json"));
  const policyBytes = readFileSync(policyPath);
  const policySha256 = sha256Bytes(policyBytes);
  if (policySha256 !== POLICY_V1_SHA256) {
    fail("POLICY_FILE_HASH_MISMATCH", "The repository policy file does not match the pinned policy-v1 SHA-256");
  }
  const policy = readJsonBytes(policyBytes) as BenchmarkPolicy;
  validatePolicy(policy, repositoryRoot);

  const manifestPath = externalExistingPath(options.manifestPath, repositoryRoot, "Manifest");
  const pairLabelsPath = externalExistingPath(options.pairLabelsPath, repositoryRoot, "Pair labels");
  const artifactMapPath = externalExistingPath(options.artifactMapPath, repositoryRoot, "Artifact map");
  const sealPath = externalExistingPath(options.sealPath, repositoryRoot, "Seal");
  const groundTruthBundlePath = externalExistingPath(options.groundTruthBundlePath, repositoryRoot, "Ground-truth bundle");
  const resultsPath = externalExistingPath(options.resultsPath, repositoryRoot, "Scored results");
  validateOutputPath(options.outputPath, repositoryRoot);

  const manifestBytes = readFileSync(manifestPath);
  const pairLabelsBytes = readFileSync(pairLabelsPath);
  const artifactMapBytes = readFileSync(artifactMapPath);
  const sealBytes = readFileSync(sealPath);
  const groundTruthBundleBytes = readFileSync(groundTruthBundlePath);
  const seal = sealSchema.parse(readJsonBytes(sealBytes));
  const manifestSha256 = sha256Bytes(manifestBytes);
  const pairLabelsSha256 = sha256Bytes(pairLabelsBytes);
  const artifactMapSha256 = sha256Bytes(artifactMapBytes);
  const groundTruthBundleSha256 = sha256Bytes(groundTruthBundleBytes);
  if (seal.policy_sha256 !== policySha256) fail("POLICY_SEAL_MISMATCH", "The seal does not match the frozen policy bytes");
  if (seal.manifest_sha256 !== manifestSha256) fail("MANIFEST_SEAL_MISMATCH", "The manifest changed after sealing");
  if (seal.pair_labels_sha256 !== pairLabelsSha256) fail("PAIR_SEAL_MISMATCH", "The pair labels changed after sealing");
  if (seal.artifact_map_sha256 !== artifactMapSha256) fail("ARTIFACT_MAP_SEAL_MISMATCH", "The artifact map changed after sealing");
  if (seal.ground_truth_bundle_sha256 !== groundTruthBundleSha256) fail("GROUND_TRUTH_BUNDLE_SEAL_MISMATCH", "The ground-truth bundle changed after sealing");

  const artifactMap = artifactMapSchema.parse(readJsonBytes(artifactMapBytes));
  const runPlan = artifactMap.run_plan;
  if (!LOCAL_PROVIDERS.has(runPlan.provider)) {
    fail(
      "PROVIDER_EVIDENCE_CONTRACT_UNSUPPORTED",
      "Policy-v1 accepts only LOCAL_TESSERACT; every other provider requires a versioned sealed provider and lifecycle evidence contract",
    );
  }

  const intakeRows = parseStrictCsvBytes<IntakeHeader>(manifestBytes, INTAKE_HEADERS, "MANIFEST_SCHEMA_INVALID") as IntakeRow[];
  const pairRows = parseStrictCsvBytes<PairHeader>(pairLabelsBytes, PAIR_HEADERS, "PAIR_SCHEMA_INVALID") as PairRow[];
  validateIntakeRows(intakeRows, runPlan, seal);
  validatePairRows(pairRows, intakeRows, runPlan, seal);
  validateCountingStructure(intakeRows);

  const eligibleRows = intakeRows.filter((row) => row.release_gate_eligible === "true");
  const eligibleRowsBySampleId = new Map(eligibleRows.map((row) => [row.sample_id, row]));
  const artifactBySampleId = new Map<string, typeof artifactMap.artifacts[number]>();
  for (const artifact of artifactMap.artifacts) {
    if (artifactBySampleId.has(artifact.sample_id)) fail("ARTIFACT_MAP_DUPLICATE", "The artifact map repeats a sample_id");
    artifactBySampleId.set(artifact.sample_id, artifact);
  }
  if (
    artifactBySampleId.size !== eligibleRowsBySampleId.size ||
    [...artifactBySampleId.keys()].some((sampleId) => !eligibleRowsBySampleId.has(sampleId))
  ) {
    fail("ARTIFACT_MAP_COVERAGE_INVALID", "The artifact map must cover exactly the eligible manifest samples");
  }
  validateLogicalReceiptCohorts(intakeRows, artifactBySampleId);
  const privateArtifactPaths = new Set<string>();
  const artifactHashes = new Map<string, string>();
  const hashArtifact = (path: string) => {
    const existing = artifactHashes.get(path);
    if (existing) return existing;
    const hash = sha256File(path);
    artifactHashes.set(path, hash);
    return hash;
  };
  for (const row of eligibleRows) {
    const artifact = artifactBySampleId.get(row.sample_id)!;
    const sourcePath = externalExistingPath(artifact.source_path, repositoryRoot, "Mapped source artifact");
    const groundTruthPath = externalExistingPath(artifact.ground_truth_path, repositoryRoot, "Mapped ground-truth artifact");
    privateArtifactPaths.add(artifact.source_path);
    privateArtifactPaths.add(artifact.ground_truth_path);
    privateArtifactPaths.add(sourcePath);
    privateArtifactPaths.add(groundTruthPath);
    if (hashArtifact(sourcePath) !== row.source_sha256) fail("SOURCE_HASH_MISMATCH", `Manifest row ${row.rowNumber} source bytes do not match`);
    if (hashArtifact(groundTruthPath) !== row.ground_truth_sha256) fail("GROUND_TRUTH_HASH_MISMATCH", `Manifest row ${row.rowNumber} ground-truth bytes do not match`);
  }

  const primaryBySampleId = new Map(
    intakeRows
      .filter((row) => row.release_gate_eligible === "true" && row.benchmark_count_role === "PRIMARY_RECEIPT")
      .map((row) => [row.sample_id, row]),
  );
  const eligibleGateCaptureIds = new Set(
    eligibleRows
      .filter((row) => row.benchmark_count_role === "PRIMARY_RECEIPT" || row.benchmark_count_role === "NON_RECEIPT")
      .map((row) => row.capture_attempt_id),
  );
  const eligibleCaptureRows = new Map<string, IntakeRow[]>();
  for (const row of eligibleRows.filter((candidate) =>
    eligibleGateCaptureIds.has(candidate.capture_attempt_id) &&
    !new Set(["EXCLUDED", "RECAPTURE_ROBUSTNESS", "DERIVED_NOT_COUNTED"]).has(candidate.benchmark_count_role)
  )) {
    const group = eligibleCaptureRows.get(row.capture_attempt_id) ?? [];
    group.push(row);
    eligibleCaptureRows.set(row.capture_attempt_id, group);
  }
  for (const rows of eligibleCaptureRows.values()) {
    if (new Set(rows.map((row) => row.capture_mode)).size !== 1) {
      fail("CAPTURE_MODE_INCONSISTENT", "Rows from one capture attempt disagree on capture_mode");
    }
  }
  const eligiblePairsById = new Map(pairRows.filter((row) => row.release_gate_eligible === "true").map((row) => [row.pair_id, row]));
  validateArtifactContracts(intakeRows, artifactBySampleId, eligibleCaptureRows, runPlan.provider);
  validateIndependentTrialPlan(artifactMap.independent_trials, primaryBySampleId, eligibleCaptureRows);
  const counts = countCorpus(intakeRows, pairRows);
  if (runPlan.purpose === "CAPSTONE_DEMO") validatePreResultCapstoneCorpus(policy, counts);

  const resultsBytes = readFileSync(resultsPath);
  const resultsSha256 = sha256Bytes(resultsBytes);
  const results = scoredResultsSchema.parse(readJsonBytes(resultsBytes));
  if (Date.parse(seal.sealed_at_utc) >= Date.parse(results.run.results_opened_at_utc)) {
    fail("RESULTS_OPENED_BEFORE_SEAL", "The corpus must be sealed before result data is opened");
  }
  if (Date.parse(runPlan.planned_review_end_at_utc) < Date.parse(results.run.results_opened_at_utc)) {
    fail("REVIEW_WINDOW_INVALID", "The planned review end precedes the result-open time");
  }
  if (
    runPlan.purpose !== results.run.purpose ||
    runPlan.provider !== results.run.provider ||
    runPlan.extractor_version_sha256 !== results.run.extractor_version_sha256 ||
    runPlan.planned_review_end_at_utc !== results.run.planned_review_end_at_utc ||
    runPlan.declared_hardware_sha256 !== results.run.declared_hardware_sha256 ||
    runPlan.cold_or_warm !== results.run.cold_or_warm
  ) {
    fail("RUN_PLAN_MISMATCH", "Scored-result run metadata does not match the pre-result sealed run plan");
  }
  validateResultCoverage(
    results,
    primaryBySampleId,
    eligibleCaptureRows,
    eligiblePairsById,
    artifactBySampleId,
    artifactMap.independent_trials,
  );

  return {
    repositoryRoot,
    paths: { ...options, manifestPath, pairLabelsPath, artifactMapPath, sealPath, groundTruthBundlePath, resultsPath },
    policy,
    policySha256,
    seal,
    manifestSha256,
    pairLabelsSha256,
    artifactMapSha256,
    groundTruthBundleSha256,
    resultsSha256,
    artifactMap,
    privateArtifactPaths: [...privateArtifactPaths],
    intakeRows,
    pairRows,
    results,
    counts,
    primaryBySampleId,
    eligibleRowsBySampleId,
    eligibleCaptureRows,
    eligiblePairsById,
  };
}

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider);
}
