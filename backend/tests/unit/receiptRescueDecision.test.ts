import { describe, expect, it } from "vitest";
import {
  decideReceiptRescue,
  firstProviderRescueReason,
  localReceiptAssessmentSchema,
  type LocalReceiptAssessment,
} from "../../src/services/receiptRescueDecision";

function assessment(overrides: Partial<LocalReceiptAssessment> = {}): LocalReceiptAssessment {
  return {
    validation: "VALIDATED",
    missingCriticalFields: [],
    conflictingCriticalFields: [],
    handwriting: "NOT_DETECTED",
    damage: "NOT_DETECTED",
    calibration: { state: "CALIBRATED", version: "routing-v1" },
    ...overrides,
  };
}

describe("receipt rescue decision", () => {
  it("keeps a clean validated receipt on the standard local review path", () => {
    expect(decideReceiptRescue(assessment())).toEqual({
      version: "receipt-rescue-v1",
      providerRescueRequested: false,
      reviewLevel: "STANDARD",
      localResultDisposition: "PREFILL_FOR_REVIEW",
      reasons: [],
      calibration: { state: "CALIBRATED", version: "routing-v1" },
    });
  });

  it("requests calibrated rescue for validation failures and ordered missing or conflicting critical fields", () => {
    expect(decideReceiptRescue(assessment({
      validation: "FAILED",
      missingCriticalFields: ["total", "date"],
      conflictingCriticalFields: ["currency", "vendor"],
    }))).toMatchObject({
      providerRescueRequested: true,
      reviewLevel: "FOCUSED",
      localResultDisposition: "KEEP_AS_FALLBACK",
      reasons: [
        "LOCAL_VALIDATION_FAILED",
        "MISSING_CRITICAL_DATE",
        "CONFLICTING_CRITICAL_VENDOR",
        "CONFLICTING_CRITICAL_CURRENCY",
        "MISSING_CRITICAL_TOTAL",
      ],
    });
  });

  it.each([
    ["handwriting", { handwriting: "SUSPECTED" as const }, "HANDWRITING_SUSPECTED"],
    ["damage", { damage: "SUSPECTED" as const }, "DAMAGE_SUSPECTED"],
  ])("requests calibrated rescue when %s is suspected", (_label, override, reason) => {
    expect(decideReceiptRescue(assessment(override))).toMatchObject({
      providerRescueRequested: true,
      reviewLevel: "FOCUSED",
      localResultDisposition: "KEEP_AS_FALLBACK",
      reasons: [reason],
    });
  });

  it("marks unknown condition signals for focused owner review without treating them as rescue evidence", () => {
    expect(decideReceiptRescue(assessment({ handwriting: "UNKNOWN", damage: "UNKNOWN" }))).toMatchObject({
      providerRescueRequested: false,
      reviewLevel: "FOCUSED",
      localResultDisposition: "PREFILL_FOR_REVIEW",
      reasons: ["HANDWRITING_UNASSESSED", "DAMAGE_UNASSESSED"],
    });
  });

  it.each([
    [
      "uncalibrated",
      { state: "UNCALIBRATED" as const, version: null },
      "CALIBRATION_UNAVAILABLE",
    ],
    [
      "out-of-scope",
      { state: "OUT_OF_SCOPE" as const, version: "routing-v1" },
      "CALIBRATION_OUT_OF_SCOPE",
    ],
  ])("keeps a failed %s result reviewable but requests zero provider rescue", (_label, calibration, reason) => {
    expect(decideReceiptRescue(assessment({ validation: "FAILED", calibration }))).toMatchObject({
      providerRescueRequested: false,
      reviewLevel: "FOCUSED",
      localResultDisposition: "PREFILL_FOR_REVIEW",
      reasons: ["LOCAL_VALIDATION_FAILED", reason],
    });
  });

  it("requests calibrated rescue for a clean validated receipt only under always routing", () => {
    expect(decideReceiptRescue(assessment(), { routing: "rescue" })).toMatchObject({
      providerRescueRequested: false,
      reviewLevel: "STANDARD",
      reasons: [],
    });
    expect(decideReceiptRescue(assessment(), { routing: "always" })).toEqual({
      version: "receipt-rescue-v1",
      providerRescueRequested: true,
      reviewLevel: "FOCUSED",
      localResultDisposition: "KEEP_AS_FALLBACK",
      reasons: ["PROVIDER_ROUTING_ALWAYS"],
      calibration: { state: "CALIBRATED", version: "routing-v1" },
    });
  });

  it("lists the always-routing reason after evidence reasons and never overrides calibration", () => {
    expect(decideReceiptRescue(assessment({ missingCriticalFields: ["total"], handwriting: "UNKNOWN" }), { routing: "always" }))
      .toMatchObject({
        providerRescueRequested: true,
        reasons: ["MISSING_CRITICAL_TOTAL", "HANDWRITING_UNASSESSED", "PROVIDER_ROUTING_ALWAYS"],
      });
    expect(firstProviderRescueReason(["HANDWRITING_UNASSESSED", "PROVIDER_ROUTING_ALWAYS"])).toBe("PROVIDER_ROUTING_ALWAYS");
    expect(firstProviderRescueReason(["HANDWRITING_UNASSESSED", "DAMAGE_SUSPECTED"])).toBe("DAMAGE_SUSPECTED");
    expect(firstProviderRescueReason(["HANDWRITING_UNASSESSED"])).toBeNull();

    expect(decideReceiptRescue(
      assessment({ calibration: { state: "UNCALIBRATED", version: null } }),
      { routing: "always" },
    )).toMatchObject({
      providerRescueRequested: false,
      reviewLevel: "FOCUSED",
      localResultDisposition: "PREFILL_FOR_REVIEW",
      reasons: ["PROVIDER_ROUTING_ALWAYS", "CALIBRATION_UNAVAILABLE"],
    });
  });

  it("rejects duplicate and contradictory critical-field assessments", () => {
    expect(() => decideReceiptRescue(assessment({ missingCriticalFields: ["total", "total"] }))).toThrow();
    expect(() => decideReceiptRescue(assessment({ conflictingCriticalFields: ["date", "date"] }))).toThrow();
    expect(() => decideReceiptRescue(assessment({
      missingCriticalFields: ["vendor"],
      conflictingCriticalFields: ["vendor"],
    }))).toThrow();
  });

  it("does not accept raw receipt content or confidence as routing input", () => {
    const unsafe = { ...assessment(), receiptText: "PRIVATE RECEIPT", rawConfidence: 0.21 };
    expect(localReceiptAssessmentSchema.safeParse(unsafe).success).toBe(false);
    expect(() => decideReceiptRescue(unsafe as unknown as LocalReceiptAssessment)).toThrow();
  });
});
