import { z } from "zod";
import type { ReceiptProviderRouting } from "../config/receiptProvider";

export const RESCUE_DECISION_VERSION = "receipt-rescue-v1" as const;

export const criticalReceiptFieldSchema = z.enum(["date", "vendor", "currency", "total"]);
export type CriticalReceiptField = z.infer<typeof criticalReceiptFieldSchema>;

export const receiptCalibrationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("CALIBRATED"), version: z.string().trim().min(1).max(64) }).strict(),
  z.object({ state: z.literal("UNCALIBRATED"), version: z.null() }).strict(),
  z.object({ state: z.literal("OUT_OF_SCOPE"), version: z.string().trim().min(1).max(64) }).strict(),
]);
export type ReceiptCalibration = z.infer<typeof receiptCalibrationSchema>;

const conditionSignalSchema = z.enum(["NOT_DETECTED", "SUSPECTED", "UNKNOWN"]);

export const localReceiptAssessmentSchema = z
  .object({
    validation: z.enum(["VALIDATED", "FAILED"]),
    missingCriticalFields: z.array(criticalReceiptFieldSchema).max(4),
    conflictingCriticalFields: z.array(criticalReceiptFieldSchema).max(4),
    handwriting: conditionSignalSchema,
    damage: conditionSignalSchema,
    calibration: receiptCalibrationSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    const missing = new Set(assessment.missingCriticalFields);
    if (missing.size !== assessment.missingCriticalFields.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missingCriticalFields"],
        message: "duplicate critical field",
      });
    }
    if (new Set(assessment.conflictingCriticalFields).size !== assessment.conflictingCriticalFields.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conflictingCriticalFields"],
        message: "duplicate critical field",
      });
    }
    for (const field of assessment.conflictingCriticalFields) {
      if (missing.has(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conflictingCriticalFields"],
          message: `${field} cannot be both missing and conflicting`,
        });
      }
    }
  });
export type LocalReceiptAssessment = z.infer<typeof localReceiptAssessmentSchema>;

export const rescueReasonCodeSchema = z.enum([
  "LOCAL_VALIDATION_FAILED",
  "MISSING_CRITICAL_DATE",
  "MISSING_CRITICAL_VENDOR",
  "MISSING_CRITICAL_CURRENCY",
  "MISSING_CRITICAL_TOTAL",
  "CONFLICTING_CRITICAL_DATE",
  "CONFLICTING_CRITICAL_VENDOR",
  "CONFLICTING_CRITICAL_CURRENCY",
  "CONFLICTING_CRITICAL_TOTAL",
  "HANDWRITING_SUSPECTED",
  "DAMAGE_SUSPECTED",
  "HANDWRITING_UNASSESSED",
  "DAMAGE_UNASSESSED",
  "CALIBRATION_UNAVAILABLE",
  "CALIBRATION_OUT_OF_SCOPE",
  "PROVIDER_ROUTING_ALWAYS",
]);
export type RescueReasonCode = z.infer<typeof rescueReasonCodeSchema>;

const PROVIDER_RESCUE_REASONS = new Set<RescueReasonCode>([
  "LOCAL_VALIDATION_FAILED",
  "MISSING_CRITICAL_DATE",
  "MISSING_CRITICAL_VENDOR",
  "MISSING_CRITICAL_CURRENCY",
  "MISSING_CRITICAL_TOTAL",
  "CONFLICTING_CRITICAL_DATE",
  "CONFLICTING_CRITICAL_VENDOR",
  "CONFLICTING_CRITICAL_CURRENCY",
  "CONFLICTING_CRITICAL_TOTAL",
  "HANDWRITING_SUSPECTED",
  "DAMAGE_SUSPECTED",
  "PROVIDER_ROUTING_ALWAYS",
]);

/** The reason that actually opened the provider gate, skipping review-only signals. */
export function firstProviderRescueReason(reasons: readonly RescueReasonCode[]): RescueReasonCode | null {
  return reasons.find((reason) => PROVIDER_RESCUE_REASONS.has(reason)) ?? null;
}

export const rescueDecisionSchema = z
  .object({
    version: z.literal(RESCUE_DECISION_VERSION),
    providerRescueRequested: z.boolean(),
    reviewLevel: z.enum(["STANDARD", "FOCUSED"]),
    localResultDisposition: z.enum(["PREFILL_FOR_REVIEW", "KEEP_AS_FALLBACK"]),
    reasons: z.array(rescueReasonCodeSchema),
    calibration: receiptCalibrationSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    const reasons = new Set(decision.reasons);
    if (reasons.size !== decision.reasons.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "duplicate reason" });
    }

    const shouldRequestProvider =
      decision.calibration.state === "CALIBRATED" && decision.reasons.some((reason) => PROVIDER_RESCUE_REASONS.has(reason));
    if (decision.providerRescueRequested !== shouldRequestProvider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerRescueRequested"],
        message: "provider routing does not match calibration and reasons",
      });
    }

    const expectedReviewLevel = decision.reasons.length === 0 ? "STANDARD" : "FOCUSED";
    if (decision.reviewLevel !== expectedReviewLevel) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewLevel"], message: "review level does not match reasons" });
    }

    const expectedDisposition = decision.providerRescueRequested ? "KEEP_AS_FALLBACK" : "PREFILL_FOR_REVIEW";
    if (decision.localResultDisposition !== expectedDisposition) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localResultDisposition"],
        message: "local disposition does not match routing",
      });
    }

    const hasUnavailable = reasons.has("CALIBRATION_UNAVAILABLE");
    const hasOutOfScope = reasons.has("CALIBRATION_OUT_OF_SCOPE");
    if (
      (decision.calibration.state === "CALIBRATED" && (hasUnavailable || hasOutOfScope)) ||
      (decision.calibration.state === "UNCALIBRATED" && (!hasUnavailable || hasOutOfScope)) ||
      (decision.calibration.state === "OUT_OF_SCOPE" && (hasUnavailable || !hasOutOfScope))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: "calibration reason mismatch" });
    }
  });
export type RescueDecision = z.infer<typeof rescueDecisionSchema>;

const FIELD_ORDER: readonly CriticalReceiptField[] = ["date", "vendor", "currency", "total"];

function fieldReason(prefix: "MISSING" | "CONFLICTING", field: CriticalReceiptField): RescueReasonCode {
  return `${prefix}_CRITICAL_${field.toUpperCase()}` as RescueReasonCode;
}

export interface RescueDecisionOptions {
  routing?: ReceiptProviderRouting;
}

/**
 * Produces routing metadata only; raw OCR confidence and receipt content are
 * not inputs. `routing: "always"` adds a policy reason so a clean local read
 * still requests the provider, but calibration keeps the final say.
 */
export function decideReceiptRescue(input: LocalReceiptAssessment, options: RescueDecisionOptions = {}): RescueDecision {
  const assessment = localReceiptAssessmentSchema.parse(input);
  const reasons: RescueReasonCode[] = [];
  const rescueReasons = new Set<RescueReasonCode>();

  if (assessment.validation === "FAILED") {
    reasons.push("LOCAL_VALIDATION_FAILED");
    rescueReasons.add("LOCAL_VALIDATION_FAILED");
  }

  const missing = new Set(assessment.missingCriticalFields);
  const conflicting = new Set(assessment.conflictingCriticalFields);
  for (const field of FIELD_ORDER) {
    if (missing.has(field)) {
      const reason = fieldReason("MISSING", field);
      reasons.push(reason);
      rescueReasons.add(reason);
    }
    if (conflicting.has(field)) {
      const reason = fieldReason("CONFLICTING", field);
      reasons.push(reason);
      rescueReasons.add(reason);
    }
  }

  if (assessment.handwriting === "SUSPECTED") {
    reasons.push("HANDWRITING_SUSPECTED");
    rescueReasons.add("HANDWRITING_SUSPECTED");
  } else if (assessment.handwriting === "UNKNOWN") {
    reasons.push("HANDWRITING_UNASSESSED");
  }

  if (assessment.damage === "SUSPECTED") {
    reasons.push("DAMAGE_SUSPECTED");
    rescueReasons.add("DAMAGE_SUSPECTED");
  } else if (assessment.damage === "UNKNOWN") {
    reasons.push("DAMAGE_UNASSESSED");
  }

  if (options.routing === "always") {
    reasons.push("PROVIDER_ROUTING_ALWAYS");
    rescueReasons.add("PROVIDER_ROUTING_ALWAYS");
  }

  if (assessment.calibration.state === "UNCALIBRATED") {
    reasons.push("CALIBRATION_UNAVAILABLE");
  } else if (assessment.calibration.state === "OUT_OF_SCOPE") {
    reasons.push("CALIBRATION_OUT_OF_SCOPE");
  }

  const providerRescueRequested = assessment.calibration.state === "CALIBRATED" && rescueReasons.size > 0;
  return rescueDecisionSchema.parse({
    version: RESCUE_DECISION_VERSION,
    providerRescueRequested,
    reviewLevel: reasons.length === 0 ? "STANDARD" : "FOCUSED",
    localResultDisposition: providerRescueRequested ? "KEEP_AS_FALLBACK" : "PREFILL_FOR_REVIEW",
    reasons,
    calibration: assessment.calibration,
  });
}
