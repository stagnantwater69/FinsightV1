import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isAbsolute, normalize, resolve } from "node:path";
import { z } from "zod";
import { parseLineItems, parseReceiptFields } from "../../src/services/ocr.service";
import {
  scoreAmount,
  scoreDate,
  scoreItems,
  scoreVendor,
  type ExpectedItem,
  type ItemScore,
  type Verdict,
} from "../ocr-accuracy/scoring";

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
    (value) => !isAbsolute(value)
      && normalize(value) === value
      && !value.split(/[\\/]/).includes(".."),
    "file must be a normalized relative path inside the image root",
  ),
  kind: z.enum(["real", "synthetic", "degraded"]),
  derived_from: z.string().min(1).optional(),
  conditions: z.string(),
  needs_review: z.boolean().optional(),
  provenance: explicitProvenanceSchema.optional(),
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

const thresholdProfileSchema = z.object({
  includedProvenance: z.array(z.enum(PROVENANCE_LABELS)).min(1),
  minimumSamples: z.number().int().positive(),
  maximumFailureRate: z.number().min(0).max(1),
  minimumAccuracy: z.object({
    vendor: z.number().min(0).max(1),
    date: z.number().min(0).max(1),
    total: z.number().min(0).max(1),
    items: z.number().min(0).max(1),
  }).strict(),
  maximumItemFalsePositiveRate: z.number().min(0).max(1),
  maximumLatencyMs: z.object({
    p50: z.number().finite().positive(),
    p95: z.number().finite().positive(),
  }).strict(),
}).strict();

export const localQualityThresholdsSchema = z.object({
  schemaVersion: z.literal("finsight-local-ocr-thresholds-v1"),
  profile: thresholdProfileSchema,
}).strict();

export type LocalQualityThresholds = z.infer<typeof localQualityThresholdsSchema>;

export interface LocalSampleObservation {
  id: string;
  provenance: ProvenanceLabel;
  outcome: "SUCCESS" | "FAILED";
  latencyMs: number;
  fields: {
    vendor: Verdict;
    date: Verdict;
    total: Verdict;
    items: "correct" | "wrong" | "n/a";
  };
  itemScore: ItemScore | null;
  failureKind: string | null;
}

interface AccuracyMetric {
  correct: number;
  denominator: number;
  value: number | null;
}

export interface LocalQualityMetrics {
  samples: number;
  successes: number;
  failures: number;
  successRate: number | null;
  failureRate: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  accuracy: {
    vendor: AccuracyMetric;
    date: AccuracyMetric;
    total: AccuracyMetric;
    items: AccuracyMetric;
  };
  itemLineRecall: number | null;
  itemLinePrecision: number | null;
  itemFalsePositiveRate: number | null;
}

export interface GateCheck {
  id: string;
  actual: number | null;
  operator: ">=" | "<=";
  threshold: number;
  status: "PASS" | "FAIL" | "NOT_MEASURED";
}

export interface LocalQualityReport {
  schemaVersion: "finsight-local-ocr-quality-report-v2";
  generatedAtUtc: string;
  engine: {
    provider: "LOCAL_TESSERACT";
    externalProviderCalls: false;
  };
  corpus: {
    requestedScope: "synthetic" | "all" | "anonymized-real";
    discoveredSamples: number;
    totalReviewedManifestSamples: number;
    attemptedSamples: number;
    skippedUnreviewedSamples: number;
    provenanceCounts: Record<ProvenanceLabel, number>;
    anonymizedRealEvidence: "AVAILABLE" | "NOT_AVAILABLE";
    productionAccuracyClaimSupported: false;
  };
  metrics: LocalQualityMetrics;
  metricsByProvenance: Partial<Record<ProvenanceLabel, LocalQualityMetrics>>;
  gate: {
    profile: LocalQualityThresholds["profile"];
    checks: GateCheck[];
    status: "PASS" | "FAIL";
  };
  samples: LocalSampleObservation[];
}

export function classifyProvenance(entry: LocalCorpusEntry): ProvenanceLabel {
  if (entry.kind === "synthetic") return "SYNTHETIC_GENERATED";
  if (entry.kind === "degraded") return "SYNTHETIC_DERIVED";
  if (!entry.provenance) throw new Error("Real corpus entry is missing explicit provenance evidence");
  return entry.provenance.label;
}

export function opaqueSampleId(id: string): string {
  return `sample-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

export function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(probability * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function fieldAccuracy(observations: LocalSampleObservation[], field: "vendor" | "date" | "total"): AccuracyMetric {
  const measured = observations.filter((observation) => observation.fields[field] !== "n/a");
  const correct = measured.filter((observation) => observation.fields[field] === "correct").length;
  return { correct, denominator: measured.length, value: ratio(correct, measured.length) };
}

export function summarizeObservations(observations: LocalSampleObservation[]): LocalQualityMetrics {
  const successes = observations.filter((observation) => observation.outcome === "SUCCESS").length;
  const itemObservations = observations.filter((observation) => observation.fields.items !== "n/a");
  const exactItems = itemObservations.filter((observation) => observation.fields.items === "correct").length;
  const itemScores = observations.flatMap((observation) => observation.itemScore ? [observation.itemScore] : []);
  const expectedItems = itemScores.reduce((sum, score) => sum + score.expected, 0);
  const matchedItems = itemScores.reduce((sum, score) => sum + score.matched, 0);
  const falsePositives = itemScores.reduce((sum, score) => sum + score.falsePositives, 0);
  const predictedItems = matchedItems + falsePositives;

  return {
    samples: observations.length,
    successes,
    failures: observations.length - successes,
    successRate: ratio(successes, observations.length),
    failureRate: ratio(observations.length - successes, observations.length),
    latencyMs: {
      p50: percentile(observations.map((observation) => observation.latencyMs), 0.5),
      p95: percentile(observations.map((observation) => observation.latencyMs), 0.95),
    },
    accuracy: {
      vendor: fieldAccuracy(observations, "vendor"),
      date: fieldAccuracy(observations, "date"),
      total: fieldAccuracy(observations, "total"),
      items: { correct: exactItems, denominator: itemObservations.length, value: ratio(exactItems, itemObservations.length) },
    },
    itemLineRecall: ratio(matchedItems, expectedItems),
    itemLinePrecision: ratio(matchedItems, predictedItems),
    itemFalsePositiveRate: ratio(falsePositives, predictedItems),
  };
}

function compare(id: string, actual: number | null, operator: ">=" | "<=", threshold: number): GateCheck {
  return {
    id,
    actual,
    operator,
    threshold,
    status: actual === null ? "NOT_MEASURED" : operator === ">="
      ? actual >= threshold ? "PASS" : "FAIL"
      : actual <= threshold ? "PASS" : "FAIL",
  };
}

export function evaluateGate(
  observations: LocalSampleObservation[],
  profile: LocalQualityThresholds["profile"],
): LocalQualityReport["gate"] {
  const included = observations.filter((observation) => profile.includedProvenance.includes(observation.provenance));
  const metrics = summarizeObservations(included);
  const checks = [
    compare("minimum_samples", metrics.samples, ">=", profile.minimumSamples),
    compare("failure_rate", metrics.failureRate, "<=", profile.maximumFailureRate),
    compare("vendor_accuracy", metrics.accuracy.vendor.value, ">=", profile.minimumAccuracy.vendor),
    compare("date_accuracy", metrics.accuracy.date.value, ">=", profile.minimumAccuracy.date),
    compare("total_accuracy", metrics.accuracy.total.value, ">=", profile.minimumAccuracy.total),
    compare("items_exact_receipt_accuracy", metrics.accuracy.items.value, ">=", profile.minimumAccuracy.items),
    compare("item_false_positive_rate", metrics.itemFalsePositiveRate, "<=", profile.maximumItemFalsePositiveRate),
    compare("latency_p50_ms", metrics.latencyMs.p50, "<=", profile.maximumLatencyMs.p50),
    compare("latency_p95_ms", metrics.latencyMs.p95, "<=", profile.maximumLatencyMs.p95),
  ];
  return {
    profile,
    checks,
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
  };
}

function isExactItemReceipt(score: ItemScore): boolean {
  return score.matched === score.expected
    && score.nameCorrect === score.expected
    && score.quantityCorrect === score.quantityScored
    && score.falsePositives === 0;
}

function failedObservation(entry: LocalCorpusEntry, provenance: ProvenanceLabel, latencyMs: number, error: unknown): LocalSampleObservation {
  const itemsApplicable = entry.expected.items !== undefined && entry.expected.items !== null;
  return {
    id: entry.id,
    provenance,
    outcome: "FAILED",
    latencyMs,
    fields: {
      vendor: scoreVendor(entry.expected.vendor, null),
      date: scoreDate(entry.expected.date, null),
      total: scoreAmount(entry.expected.amount, null),
      items: itemsApplicable ? "wrong" : "n/a",
    },
    itemScore: itemsApplicable ? scoreItems(entry.expected.items ?? [], []) : null,
    failureKind: error instanceof Error ? error.name : "UnknownError",
  };
}

export async function evaluateEntry(
  entry: LocalCorpusEntry,
  imageRoot: string,
  extractText: (buffer: Buffer) => Promise<string>,
  now: () => number = () => performance.now(),
): Promise<LocalSampleObservation> {
  const provenance = classifyProvenance(entry);
  const buffer = readFileSync(resolve(imageRoot, entry.file));
  const startedAt = now();
  try {
    const text = await extractText(buffer);
    const fields = parseReceiptFields(text);
    const actualItems = parseLineItems(text).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      amount: item.amount,
    }));
    const latencyMs = Math.max(0, now() - startedAt);
    const expectedItems = entry.expected.items;
    const itemScore = expectedItems === undefined || expectedItems === null
      ? null
      : scoreItems(expectedItems as ExpectedItem[], actualItems);
    return {
      id: entry.id,
      provenance,
      outcome: "SUCCESS",
      latencyMs,
      fields: {
        vendor: scoreVendor(entry.expected.vendor, fields.vendor),
        date: scoreDate(entry.expected.date, fields.date),
        total: scoreAmount(entry.expected.amount, fields.amount),
        items: itemScore === null ? "n/a" : isExactItemReceipt(itemScore) ? "correct" : "wrong",
      },
      itemScore,
      failureKind: null,
    };
  } catch (error) {
    return failedObservation(entry, provenance, Math.max(0, now() - startedAt), error);
  }
}

export function entriesForScope(
  entries: LocalCorpusEntry[],
  scope: LocalQualityReport["corpus"]["requestedScope"],
): LocalCorpusEntry[] {
  return entries.filter((entry) => {
    const provenance = classifyProvenance(entry);
    if (scope === "synthetic") return provenance === "SYNTHETIC_GENERATED" || provenance === "SYNTHETIC_DERIVED";
    if (scope === "anonymized-real") return provenance === "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED";
    return true;
  });
}

export function buildLocalQualityReport(options: {
  allEntries: LocalCorpusEntry[];
  attemptedEntries: LocalCorpusEntry[];
  observations: LocalSampleObservation[];
  thresholds: LocalQualityThresholds;
  requestedScope: LocalQualityReport["corpus"]["requestedScope"];
  generatedAtUtc?: string;
}): LocalQualityReport {
  const reviewedEntries = options.allEntries.filter((entry) => !entry.needs_review);
  const scopedReviewedEntries = entriesForScope(reviewedEntries, options.requestedScope);
  const scopedEntries = entriesForScope(options.allEntries, options.requestedScope);
  const provenanceCounts = Object.fromEntries(PROVENANCE_LABELS.map((label) => [label, 0])) as Record<ProvenanceLabel, number>;
  for (const entry of scopedReviewedEntries) provenanceCounts[classifyProvenance(entry)] += 1;

  const metricsByProvenance: LocalQualityReport["metricsByProvenance"] = {};
  for (const label of PROVENANCE_LABELS) {
    const matching = options.observations.filter((observation) => observation.provenance === label);
    if (matching.length > 0) metricsByProvenance[label] = summarizeObservations(matching);
  }

  return {
    schemaVersion: "finsight-local-ocr-quality-report-v2",
    generatedAtUtc: options.generatedAtUtc ?? new Date().toISOString(),
    engine: { provider: "LOCAL_TESSERACT", externalProviderCalls: false },
    corpus: {
      requestedScope: options.requestedScope,
      discoveredSamples: scopedReviewedEntries.length,
      totalReviewedManifestSamples: reviewedEntries.length,
      attemptedSamples: options.attemptedEntries.length,
      skippedUnreviewedSamples: scopedEntries.length - scopedReviewedEntries.length,
      provenanceCounts,
      anonymizedRealEvidence: options.attemptedEntries.some((entry) =>
        classifyProvenance(entry) === "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED"
        && options.observations.some((observation) => observation.id === entry.id),
      ) ? "AVAILABLE" : "NOT_AVAILABLE",
      productionAccuracyClaimSupported: false,
    },
    metrics: summarizeObservations(options.observations),
    metricsByProvenance,
    gate: evaluateGate(options.observations, options.thresholds.profile),
    samples: options.observations.map((observation) => ({ ...observation, id: opaqueSampleId(observation.id) })),
  };
}
