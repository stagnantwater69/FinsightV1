import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { developmentCohortSchema } from "./development-cohort";

export const PROVENANCE_LABELS = [
  "SYNTHETIC_GENERATED",
  "SYNTHETIC_DERIVED",
  "PUBLIC_LICENSED_REAL_SINGLE_REVIEW",
  "EXISTING_REAL_UNKNOWN_CONSENT",
  "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
] as const;
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

const explicitProvenanceSchema = z.discriminatedUnion("label", [
  z.object({
    label: z.literal("PUBLIC_LICENSED_REAL_SINGLE_REVIEW"),
    sourceAttributionRecorded: z.literal(true),
    licenseAttributionRecorded: z.literal(true),
    groundTruthReviewerCount: z.literal(1),
  }).strict(),
  z.object({
    label: z.literal("EXISTING_REAL_UNKNOWN_CONSENT"),
    consentRecorded: z.literal(false),
    sourceAttributionRecorded: z.literal(false),
  }).strict(),
  z.object({
    label: z.literal("ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED"),
    consentRecorded: z.literal(true),
    anonymizationReviewed: z.literal(true),
    groundTruthReviewerCount: z.number().int().min(2),
  }).strict(),
]);

export const localCorpusEntrySchema = z.object({
  id: z.string().min(1).max(160),
  file: z.string().min(1).refine(
    (value) => !isAbsolute(value) && normalize(value) === value && !value.split(/[\\/]/).includes(".."),
    "file must be a normalized relative path inside the image root",
  ),
  kind: z.enum(["real", "synthetic", "degraded"]),
  derived_from: z.string().min(1).optional(),
  conditions: z.string(),
  needs_review: z.boolean().optional(),
  provenance: explicitProvenanceSchema.optional(),
  developmentCohort: developmentCohortSchema.optional(),
  expected: z.object({
    date: z.string().nullable(),
    vendor: z.string().nullable(),
    amount: z.number().finite().nullable(),
    items: z.array(z.object({
      name: z.string(),
      quantity: z.number().finite().nullable(),
      amount: z.number().finite(),
    }).strict()).nullable().optional(),
  }).strict(),
}).passthrough().superRefine((entry, context) => {
  if (entry.kind === "real" && !entry.provenance) {
    context.addIssue({ code: "custom", path: ["provenance"], message: "real fixtures require explicit provenance evidence" });
  }
  if (entry.kind !== "real" && entry.provenance) {
    context.addIssue({ code: "custom", path: ["provenance"], message: "synthetic fixtures cannot claim real-receipt provenance" });
  }
});

export type LocalCorpusEntry = z.infer<typeof localCorpusEntrySchema>;

export function classifyProvenance(entry: LocalCorpusEntry): ProvenanceLabel {
  if (entry.kind === "synthetic") return "SYNTHETIC_GENERATED";
  if (entry.kind === "degraded") return "SYNTHETIC_DERIVED";
  if (!entry.provenance) throw new Error("Real corpus entry is missing explicit provenance evidence");
  return entry.provenance.label;
}
