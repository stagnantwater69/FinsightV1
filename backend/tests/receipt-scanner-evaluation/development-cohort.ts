import { z } from "zod";
import { COHORT_TAGS } from "./policy-v1-contract";

export const PARTITIONS = ["CALIBRATION", "HOLDOUT"] as const;
export type DevelopmentPartition = (typeof PARTITIONS)[number];
const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

export const CAPTURE_CONDITIONS = [
  "LOW_LIGHT", "SKEWED_PERSPECTIVE", "MULTI_PAGE", "HANDWRITTEN_OR_ANNOTATED", "FADED_OR_STRESSED",
] as const;
export type CaptureCondition = (typeof CAPTURE_CONDITIONS)[number];

export const captureConditionsSchema = z.object({
  jurisdiction: z.enum(["PH", "OTHER", "UNKNOWN"]),
  lighting: z.enum(["NORMAL", "LOW_LIGHT", "UNKNOWN"]),
  perspective: z.enum(["FRONTAL", "SKEWED", "UNKNOWN"]),
  pageCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  handwriting: z.enum(["PRINTED", "HANDWRITTEN_OR_ANNOTATED", "UNKNOWN"]),
  printQuality: z.enum(["CLEAR", "FADED_OR_STRESSED", "UNKNOWN"]),
}).strict();

export const developmentCohortSchema = z.object({
  receiptGroupId: opaqueId,
  vendorTemplateId: opaqueId,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  partition: z.enum(PARTITIONS),
  cohortTags: z.array(z.enum(COHORT_TAGS)).min(1).refine((tags) => new Set(tags).size === tags.length),
  languageTags: z.array(z.enum(["ENGLISH", "FILIPINO", "MIXED", "OTHER"])).min(1)
    .refine((tags) => new Set(tags).size === tags.length),
  reviewerIds: z.tuple([opaqueId, opaqueId]).refine(([first, second]) => first !== second),
  captureConditions: captureConditionsSchema.optional(),
}).strict();

interface CohortEntry {
  id: string;
  kind: "real" | "synthetic" | "degraded";
  needs_review?: boolean;
  provenance?: { label: string };
  developmentCohort?: z.infer<typeof developmentCohortSchema>;
}

export interface DevelopmentCohortReport {
  status: "NOT_AVAILABLE" | "DECLARED_METADATA_CHECKED";
  evidenceVerified: false;
  acceptanceClaimSupported: false;
  declaredSamples: number;
  byPartition: Record<DevelopmentPartition, {
    samples: number;
    uniqueReceiptGroups: number;
    vendorTemplates: number;
    cohortReceiptGroups: Record<(typeof COHORT_TAGS)[number], number>;
  }>;
  missingCohorts: Record<DevelopmentPartition, (typeof COHORT_TAGS)[number][]>;
}

export function validateDevelopmentCohort(entries: readonly CohortEntry[]): void {
  const sampleIds = new Set<string>();
  const groupBindings = new Map<string, string>();
  const partitionsByBinding = new Map<string, DevelopmentPartition>();
  const receiptByContent = new Map<string, string>();
  for (const entry of entries) {
    if (sampleIds.has(entry.id)) throw new Error("Development corpus repeats a sample ID");
    sampleIds.add(entry.id);
    if (!entry.developmentCohort) continue;
    const cohort = developmentCohortSchema.parse(entry.developmentCohort);
    const receiptForBytes = receiptByContent.get(cohort.sourceSha256);
    if (receiptForBytes !== undefined && receiptForBytes !== cohort.receiptGroupId) {
      throw new Error("Duplicate image bytes cannot represent different logical receipts");
    }
    receiptByContent.set(cohort.sourceSha256, cohort.receiptGroupId);
    if (entry.kind !== "real" || entry.needs_review
      || entry.provenance?.label !== "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED") {
      throw new Error("Development cohort entries require reviewed consented anonymized real provenance");
    }
    const groupBinding = JSON.stringify({
      vendor: cohort.vendorTemplateId,
      cohorts: [...cohort.cohortTags].sort(),
      languages: [...cohort.languageTags].sort(),
      partition: cohort.partition,
      jurisdiction: cohort.captureConditions?.jurisdiction ?? "UNKNOWN",
      pageCount: cohort.captureConditions?.pageCount ?? null,
    });
    const previous = groupBindings.get(cohort.receiptGroupId);
    if (previous !== undefined && previous !== groupBinding) {
      throw new Error("Recaptures disagree on their receipt group metadata");
    }
    groupBindings.set(cohort.receiptGroupId, groupBinding);
    // Related captures, template variants, and duplicate bytes cannot cross the holdout boundary.
    for (const binding of [
      `receipt:${cohort.receiptGroupId}`,
      `vendor:${cohort.vendorTemplateId}`,
      `content:${cohort.sourceSha256}`,
    ]) {
      const existing = partitionsByBinding.get(binding);
      if (existing !== undefined && existing !== cohort.partition) {
        throw new Error("Calibration and holdout share a receipt, vendor template, or source image");
      }
      partitionsByBinding.set(binding, cohort.partition);
    }
  }
}

export function captureConditionsOf(entry: CohortEntry): CaptureCondition[] {
  const conditions = entry.developmentCohort?.captureConditions;
  if (!conditions) return [];
  const matched: CaptureCondition[] = [];
  if (conditions.lighting === "LOW_LIGHT") matched.push("LOW_LIGHT");
  if (conditions.perspective === "SKEWED") matched.push("SKEWED_PERSPECTIVE");
  if (conditions.pageCount !== null && conditions.pageCount > 1) matched.push("MULTI_PAGE");
  if (conditions.handwriting === "HANDWRITTEN_OR_ANNOTATED") matched.push("HANDWRITTEN_OR_ANNOTATED");
  if (conditions.printQuality === "FADED_OR_STRESSED") matched.push("FADED_OR_STRESSED");
  return matched;
}

export function developmentCohortReport(entries: readonly CohortEntry[]): DevelopmentCohortReport {
  validateDevelopmentCohort(entries);
  const declared = entries.filter((entry) => entry.developmentCohort !== undefined);
  const byPartition = Object.fromEntries(PARTITIONS.map((partition) => {
    const rows = declared.filter((entry) => entry.developmentCohort!.partition === partition);
    return [partition, {
      samples: rows.length,
      uniqueReceiptGroups: new Set(rows.map((entry) => entry.developmentCohort!.receiptGroupId)).size,
      vendorTemplates: new Set(rows.map((entry) => entry.developmentCohort!.vendorTemplateId)).size,
      cohortReceiptGroups: Object.fromEntries(COHORT_TAGS.map((cohort) => [cohort,
        new Set(rows.filter((entry) => entry.developmentCohort!.cohortTags.includes(cohort))
          .map((entry) => entry.developmentCohort!.receiptGroupId)).size,
      ])),
    }];
  })) as DevelopmentCohortReport["byPartition"];
  return {
    status: declared.length === 0 ? "NOT_AVAILABLE" : "DECLARED_METADATA_CHECKED",
    evidenceVerified: false,
    acceptanceClaimSupported: false,
    declaredSamples: declared.length,
    byPartition,
    missingCohorts: Object.fromEntries(PARTITIONS.map((partition) => [partition,
      COHORT_TAGS.filter((cohort) => byPartition[partition].cohortReceiptGroups[cohort] === 0),
    ])) as DevelopmentCohortReport["missingCohorts"],
  };
}
