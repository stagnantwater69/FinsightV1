import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  CAPTURE_CONDITIONS, captureConditionsOf, validateDevelopmentCohort, type CaptureCondition,
} from "./development-cohort";
import { COHORT_TAGS } from "./policy-v1-contract";
import { classifyProvenance, localCorpusEntrySchema, type LocalCorpusEntry, type ProvenanceLabel } from "./local-corpus-contract";

export const EXCLUSION_REASONS = [
  "SYNTHETIC_OR_DERIVED", "PUBLIC_SINGLE_REVIEW", "UNKNOWN_CONSENT", "GROUND_TRUTH_UNREVIEWED",
  "DEVELOPMENT_COHORT_MISSING", "CALIBRATION_ONLY", "CAPTURE_CONDITIONS_MISSING", "PH_JURISDICTION_NOT_DECLARED",
] as const;
type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export class CohortReadinessError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function representativeExclusion(entry: LocalCorpusEntry): ExclusionReason | null {
  if (entry.kind !== "real") return "SYNTHETIC_OR_DERIVED";
  if (entry.provenance?.label === "PUBLIC_LICENSED_REAL_SINGLE_REVIEW") return "PUBLIC_SINGLE_REVIEW";
  if (entry.provenance?.label !== "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED") return "UNKNOWN_CONSENT";
  if (entry.needs_review) return "GROUND_TRUTH_UNREVIEWED";
  if (!entry.developmentCohort) return "DEVELOPMENT_COHORT_MISSING";
  if (entry.developmentCohort.partition !== "HOLDOUT") return "CALIBRATION_ONLY";
  if (!entry.developmentCohort.captureConditions) return "CAPTURE_CONDITIONS_MISSING";
  if (entry.developmentCohort.captureConditions.jurisdiction !== "PH") return "PH_JURISDICTION_NOT_DECLARED";
  return null;
}

export function representativeEntries(entries: readonly LocalCorpusEntry[]): LocalCorpusEntry[] {
  const validated = localCorpusEntrySchema.array().parse(entries);
  validateDevelopmentCohort(validated);
  return validated.filter((entry) => representativeExclusion(entry) === null);
}

/** Hash every declared image, including calibration, before checking or scoring a held-out subset. */
export function verifyDeclaredImages(entries: readonly LocalCorpusEntry[], imageRoot: string): void {
  validateDevelopmentCohort(entries);
  const declared = entries.filter((entry) => entry.developmentCohort !== undefined);
  if (declared.length === 0) return;
  if (!existsSync(imageRoot)) throw new CohortReadinessError("IMAGE_ROOT_MISSING", "The declared image directory is unavailable.");
  const root = realpathSync(imageRoot);
  for (const entry of declared) {
    const path = resolve(root, entry.file);
    if (!existsSync(path)) throw new CohortReadinessError("SOURCE_IMAGE_MISSING", "A declared source image is unavailable.");
    const canonical = realpathSync(path);
    const relativePath = relative(root, canonical);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../")) {
      throw new CohortReadinessError("SOURCE_IMAGE_OUTSIDE_ROOT", "A declared source image resolves outside the image directory.");
    }
    if (!statSync(canonical).isFile()) throw new CohortReadinessError("SOURCE_IMAGE_NOT_FILE", "A declared source image is not a regular file.");
    const hash = createHash("sha256").update(readFileSync(canonical)).digest("hex");
    if (hash !== entry.developmentCohort!.sourceSha256) {
      throw new CohortReadinessError("SOURCE_HASH_MISMATCH", "Declared source image bytes changed after intake.");
    }
  }
}

interface CoverageCount { samples: number; uniqueReceipts: number; failureRate: null }

export interface CohortReadinessReport {
  schemaVersion: "finsight-ph-receipt-readiness-v1";
  generatedAtUtc: string;
  mode: "READINESS_ONLY";
  scope: "EXPLICIT_PH_CONSENTED_HOLDOUT";
  status: "BLOCKED_NO_ELIGIBLE_SAMPLES" | "BLOCKED_MISSING_COVERAGE" | "READY_FOR_LOCAL_EVALUATION";
  ocrExecuted: false;
  externalProviderCalls: false;
  accuracyStatus: "NOT_MEASURED";
  accuracyClaimSupported: false;
  consentAndIndependentReviewVerified: false;
  metrics: { failureRate: null; vendorAccuracy: null; dateAccuracy: null; totalAccuracy: null; itemPrecision: null; itemRecall: null };
  counts: {
    totalManifestEntries: number;
    declaredConsentedRealEntries: number;
    eligibleSamples: number;
    excludedSamples: number;
    uniqueEligibleReceipts: number;
    exclusionsByReason: Record<ExclusionReason, number>;
    provenanceCounts: Partial<Record<ProvenanceLabel, number>>;
  };
  coverage: {
    captureConditions: Record<CaptureCondition, CoverageCount>;
    cohorts: Record<(typeof COHORT_TAGS)[number], CoverageCount>;
    missingCaptureConditions: CaptureCondition[];
    missingCohorts: (typeof COHORT_TAGS)[number][];
    unknownCaptureMetadata: { lighting: number; perspective: number; pageCount: number; handwriting: number; printQuality: number };
  };
}

export function buildReadinessReport(entries: readonly LocalCorpusEntry[], generatedAtUtc = new Date().toISOString()): CohortReadinessReport {
  const eligible = representativeEntries(entries);
  const exclusionsByReason = Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<ExclusionReason, number>;
  const provenanceCounts: CohortReadinessReport["counts"]["provenanceCounts"] = {};
  for (const entry of entries) {
    const reason = representativeExclusion(entry);
    if (reason !== null) exclusionsByReason[reason] += 1;
    const provenance = classifyProvenance(entry);
    provenanceCounts[provenance] = (provenanceCounts[provenance] ?? 0) + 1;
  }
  const coverageCount = (rows: LocalCorpusEntry[]): CoverageCount => ({
    samples: rows.length,
    uniqueReceipts: new Set(rows.map((entry) => entry.developmentCohort!.receiptGroupId)).size,
    failureRate: null,
  });
  const captureConditions = Object.fromEntries(CAPTURE_CONDITIONS.map((condition) => [condition,
    coverageCount(eligible.filter((entry) => captureConditionsOf(entry).includes(condition))),
  ])) as CohortReadinessReport["coverage"]["captureConditions"];
  const cohorts = Object.fromEntries(COHORT_TAGS.map((cohort) => [cohort,
    coverageCount(eligible.filter((entry) => entry.developmentCohort!.cohortTags.includes(cohort))),
  ])) as CohortReadinessReport["coverage"]["cohorts"];
  const missingCaptureConditions = CAPTURE_CONDITIONS.filter((condition) => captureConditions[condition].samples === 0);
  const missingCohorts = COHORT_TAGS.filter((cohort) => cohorts[cohort].samples === 0);
  const unknownCaptureMetadata = { lighting: 0, perspective: 0, pageCount: 0, handwriting: 0, printQuality: 0 };
  for (const entry of eligible) {
    const conditions = entry.developmentCohort!.captureConditions!;
    for (const key of ["lighting", "perspective", "handwriting", "printQuality"] as const) {
      if (conditions[key] === "UNKNOWN") unknownCaptureMetadata[key] += 1;
    }
    if (conditions.pageCount === null) unknownCaptureMetadata.pageCount += 1;
  }
  return {
    schemaVersion: "finsight-ph-receipt-readiness-v1",
    generatedAtUtc,
    mode: "READINESS_ONLY",
    scope: "EXPLICIT_PH_CONSENTED_HOLDOUT",
    status: eligible.length === 0 ? "BLOCKED_NO_ELIGIBLE_SAMPLES"
      : missingCaptureConditions.length > 0 || missingCohorts.length > 0 ? "BLOCKED_MISSING_COVERAGE" : "READY_FOR_LOCAL_EVALUATION",
    ocrExecuted: false,
    externalProviderCalls: false,
    accuracyStatus: "NOT_MEASURED",
    accuracyClaimSupported: false,
    consentAndIndependentReviewVerified: false,
    metrics: { failureRate: null, vendorAccuracy: null, dateAccuracy: null, totalAccuracy: null, itemPrecision: null, itemRecall: null },
    counts: {
      totalManifestEntries: entries.length,
      declaredConsentedRealEntries: entries.filter((entry) => entry.provenance?.label === "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED").length,
      eligibleSamples: eligible.length,
      excludedSamples: entries.length - eligible.length,
      uniqueEligibleReceipts: new Set(eligible.map((entry) => entry.developmentCohort!.receiptGroupId)).size,
      exclusionsByReason,
      provenanceCounts,
    },
    coverage: { captureConditions, cohorts, missingCaptureConditions, missingCohorts, unknownCaptureMetadata },
  };
}

export function readinessExitCode(report: CohortReadinessReport): 0 | 3 {
  return report.status === "READY_FOR_LOCAL_EVALUATION" ? 0 : 3;
}
