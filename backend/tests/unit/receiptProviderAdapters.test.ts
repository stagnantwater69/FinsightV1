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

  it("records an unconfigured verifier as an authentication failure billed for the extraction only", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "not_attempted" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("AUTH_ERROR");
    expect(outcome.timeoutOutcome).toBe("NOT_TIMED_OUT");
    expect(outcome.finalBillableUnits).toBe(1);
  });

  it("keeps an authentication rejection distinct from a generic HTTP failure", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "auth", httpStatus: 403 });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("AUTH_ERROR");
    expect(outcome.finalBillableUnits).toBe(1);
  });

  it("preserves a verifier rate limit and Retry-After", async () => {
    verifyVisionReceipt.mockResolvedValue({
      verdict: null,
      failure: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 45_000,
    });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("RATE_LIMITED");
    expect(outcome.retryAfterMs).toBe(45_000);
  });

  it("keeps provider 5xx failures distinct from transport failures", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "server", httpStatus: 503 });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("PROVIDER_SERVER_ERROR");
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

  it("keeps cancellation distinct from timeout", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "cancelled" });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome.status).toBe("AMBIGUOUS");
    expect(outcome.outcomeCode).toBe("REQUEST_CANCELLED");
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

describe("extraction failure taxonomy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["auth", "AUTH_ERROR", "FAILED"],
    ["server", "PROVIDER_SERVER_ERROR", "FAILED"],
    ["transport", "TRANSPORT_ERROR", "AMBIGUOUS"],
    ["cancelled", "REQUEST_CANCELLED", "AMBIGUOUS"],
    ["timeout", "TIMEOUT_AFTER_SUBMISSION", "AMBIGUOUS"],
  ] as const)("maps %s without collapsing it", async (kind, outcomeCode, status) => {
    extractReceiptWithVision.mockResolvedValue({
      receipt: null,
      rejectReason: null,
      failure: { kind, httpStatus: null, retryAfterMs: null },
      requestMs: 17,
    });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome).toMatchObject({ status, outcomeCode, stageTimings: { extractionMs: 17, verificationMs: 0 } });
    expect(verifyVisionReceipt).not.toHaveBeenCalled();
  });

  it("preserves extraction rate-limit delay", async () => {
    extractReceiptWithVision.mockResolvedValue({
      receipt: null,
      rejectReason: null,
      failure: { kind: "rate_limited", httpStatus: 429, retryAfterMs: 30_000 },
      requestMs: 12,
    });

    const outcome = await createGeminiReceiptAdapter().extract(providerRequest());

    expect(outcome).toMatchObject({
      status: "FAILED",
      outcomeCode: "RATE_LIMITED",
      retryAfterMs: 30_000,
    });
  });
});

/*
 * A blurry foreign receipt that tesseract could not read at all used to be
 * booked as pesos: the adapter hardcoded a null currency, so the only currency
 * signal at confirm time was the local rawText the provider was called to
 * replace.
 */
describe("provider currency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries a Veryfi currency through with evidence, unvalidated", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: { ...reconciledReceipt, currency: "USD" } });

    const outcome = await createVeryfiReceiptAdapter().extract(providerRequest({ provider: "veryfi" }));

    expect(outcome.extraction?.currency.value).toBe("USD");
    expect(outcome.extraction?.currency.evidence).toMatchObject({
      source: "veryfi",
      validationState: "UNVALIDATED",
      confidenceBand: "LOW",
    });
    expect(outcome.extraction?.currency.evidence?.validationCodes).toContain("OWNER_REVIEW_REQUIRED");
  });

  it("reports the provider currency without letting it displace the printed local one", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: { ...reconciledReceipt, currency: "USD" } });

    const request = providerRequest({ provider: "veryfi" });
    const outcome = await createVeryfiReceiptAdapter().extract(request);
    const merged = mergeReceiptProviderOutcome(localExtraction(), request, outcome);

    expect(merged.providerCurrency).toBe("USD");
    expect(merged.appliedFields).not.toContain("currency");
    expect(merged.receipt.currency.value).toBe("PHP");
  });

  it("reports it even when the local read found no currency at all", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: { ...reconciledReceipt, currency: "USD" } });

    const request = providerRequest({ provider: "veryfi" });
    const outcome = await createVeryfiReceiptAdapter().extract(request);
    const merged = mergeReceiptProviderOutcome(
      localExtraction({ currency: { value: null, evidence: null } }),
      request,
      outcome,
    );

    expect(merged.providerCurrency).toBe("USD");
    expect(merged.receipt.currency.value).toBeNull();
  });

  it("leaves the currency null when the provider did not report one", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: reconciledReceipt });

    const request = providerRequest({ provider: "veryfi" });
    const outcome = await createVeryfiReceiptAdapter().extract(request);

    expect(outcome.extraction?.currency).toEqual({ value: null, evidence: null });
    expect(mergeReceiptProviderOutcome(localExtraction(), request, outcome).providerCurrency).toBeNull();
  });
});
