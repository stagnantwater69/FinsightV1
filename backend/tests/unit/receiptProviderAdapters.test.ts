import { beforeEach, describe, expect, it, vi } from "vitest";
import { localExtraction, providerRequest } from "../helpers/receiptProviderFixtures";

const extractReceiptWithVision = vi.fn();
const verifyVisionReceipt = vi.fn();
const extractReceiptWithVeryfi = vi.fn();

vi.mock("../../src/services/visionOcr.service", () => ({
  get VISION_MODEL() {
    return "gemini-test";
  },
  extractReceiptWithVision: (...args: unknown[]) => extractReceiptWithVision(...args),
  verifyVisionReceipt: (...args: unknown[]) => verifyVisionReceipt(...args),
}));

vi.mock("../../src/services/veryfiOcr.service", () => ({
  extractReceiptWithVeryfi: (...args: unknown[]) => extractReceiptWithVeryfi(...args),
}));

const { createGeminiReceiptAdapter, createVeryfiReceiptAdapter } = await import(
  "../../src/services/receiptScan/providerAdapters"
);
const { mergeReceiptProviderOutcome } = await import("../../src/services/receiptProviderContract");

const unreconciledReceipt = {
  date: "2026-09-14",
  vendor: "Provider Store",
  amount: 350,
  items: [
    { name: "A", quantity: 1, amount: 100 },
    { name: "B", quantity: 1, amount: 100 },
    { name: "C", quantity: 1, amount: 100 },
  ],
};

const reconciledReceipt = {
  ...unreconciledReceipt,
  items: [
    { name: "A", quantity: 1, amount: 150 },
    { name: "B", quantity: 1, amount: 100 },
    { name: "C", quantity: 1, amount: 100 },
  ],
};

describe("provider adapter item evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not validate a Gemini item list that misses the total, even when the verifier accepts", async () => {
    extractReceiptWithVision.mockResolvedValue({ receipt: unreconciledReceipt });
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });

    const request = providerRequest();
    const outcome = await createGeminiReceiptAdapter().extract(request);

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.extraction?.itemsEvidence).toMatchObject({
      validationState: "UNVALIDATED",
      confidenceBand: "LOW",
    });
    expect(outcome.extraction?.itemsEvidence?.validationCodes).toContain("OWNER_REVIEW_REQUIRED");
    expect(outcome.extraction?.itemsEvidence?.validationCodes).not.toContain("ARITHMETIC_VALID");
  });

  it("still validates a Gemini item list that adds up to the total", async () => {
    extractReceiptWithVision.mockResolvedValue({ receipt: reconciledReceipt });
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.extraction?.itemsEvidence).toMatchObject({ validationState: "VALIDATED" });
    expect(outcome.extraction?.itemsEvidence?.validationCodes).toContain("ARITHMETIC_VALID");
  });

  it("keeps unreconciled Veryfi items unvalidated too", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: unreconciledReceipt });

    const outcome = await createVeryfiReceiptAdapter().extract(providerRequest({ provider: "veryfi" }));

    expect(outcome.extraction?.itemsEvidence).toMatchObject({ validationState: "UNVALIDATED" });
  });

  it("prefills unreconciled always-routed items for owner review instead of replacing the local list", async () => {
    extractReceiptWithVision.mockResolvedValue({ receipt: unreconciledReceipt });
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });

    const request = providerRequest({
      rescueDecision: {
        version: "receipt-rescue-v1",
        providerRescueRequested: true,
        reviewLevel: "FOCUSED",
        localResultDisposition: "KEEP_AS_FALLBACK",
        reasons: ["PROVIDER_ROUTING_ALWAYS"],
        calibration: { state: "CALIBRATED", version: "routing-v1" },
      },
    });
    const outcome = await createGeminiReceiptAdapter().extract(request);
    const merged = mergeReceiptProviderOutcome(localExtraction(), request, outcome);

    expect(merged.appliedFields).toContain("items");
    expect(merged.itemsOwnerReviewRequired).toBe(true);
    expect(merged.receipt.items).toHaveLength(3);
    expect(merged.receipt.itemsEvidence?.validationState).toBe("UNVALIDATED");
  });
});

/*
 * AMBIGUOUS / TIMEOUT_AFTER_SUBMISSION is a claim about billing: submitted,
 * possibly charged, outcome unknown. Recording every absent verifier verdict
 * that way put spend in the dispatch telemetry that a rotated key or a dead
 * socket never incurred, and buried the misconfiguration behind it.
 */
describe("verifier reachability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractReceiptWithVision.mockResolvedValue({ receipt: reconciledReceipt });
  });

  it("records an unconfigured verifier as a transport failure billed for the extraction only", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "not_attempted" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("TRANSPORT_ERROR");
    expect(outcome.timeoutOutcome).toBe("NOT_TIMED_OUT");
    expect(outcome.finalBillableUnits).toBe(1);
  });

  it("records a refused request as an HTTP error, not a timeout", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "http" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("HTTP_ERROR");
    expect(outcome.finalBillableUnits).toBe(1);
  });

  it("records a dropped connection as a transport failure", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "transport" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.outcomeCode).toBe("TRANSPORT_ERROR");
    expect(outcome.finalBillableUnits).toBe(1);
  });

  it("still records a real timeout as ambiguous, because the charge is genuinely unknown", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "timeout" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("AMBIGUOUS");
    expect(outcome.outcomeCode).toBe("TIMEOUT_AFTER_SUBMISSION");
    expect(outcome.finalBillableUnits).toBeNull();
  });

  it("bills both calls when the verifier answered with something that is not a verdict", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "unusable" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("INVALID_RESULT");
    expect(outcome.finalBillableUnits).toBe(2);
  });

  it("leaves an accepted verdict succeeding as before", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.finalBillableUnits).toBe(2);
  });
});
