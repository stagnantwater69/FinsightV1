import { beforeEach, describe, expect, it, vi } from "vitest";
import { localExtraction, providerRequest } from "../helpers/receiptProviderFixtures";
// Adapters return `unknown` because provider output is untrusted until the
// contract parses it; these tests read the outcome the adapter built.
import type { ReceiptProviderOutcome } from "../../src/services/receiptProviderContract";

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
    const outcome = (await createGeminiReceiptAdapter().extract(request)) as ReceiptProviderOutcome;

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

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

    expect(outcome.extraction?.itemsEvidence).toMatchObject({ validationState: "VALIDATED" });
    expect(outcome.extraction?.itemsEvidence?.validationCodes).toContain("ARITHMETIC_VALID");
  });

  it("keeps unreconciled Veryfi items unvalidated too", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: unreconciledReceipt });

    const outcome = (await createVeryfiReceiptAdapter().extract(providerRequest({ provider: "veryfi" }))) as ReceiptProviderOutcome;

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
    const outcome = (await createGeminiReceiptAdapter().extract(request)) as ReceiptProviderOutcome;
    const merged = mergeReceiptProviderOutcome(localExtraction(), request, outcome);

    expect(merged.appliedFields).toContain("items");
    expect(merged.itemsOwnerReviewRequired).toBe(true);
    expect(merged.receipt.items).toHaveLength(3);
    expect(merged.receipt.itemsEvidence?.validationState).toBe("UNVALIDATED");
  });
});

/*
 * When the check cannot answer, the reading stands unchecked instead of being
 * discarded for the local read. Lines that miss the total are used here so the
 * check runs at all; billing counts the check whenever it may have been charged.
 */
describe("a check that cannot answer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractReceiptWithVision.mockResolvedValue({ receipt: unreconciledReceipt });
  });

  it.each([
    ["not_attempted", 1],
    ["auth", 1],
    ["http", 1],
    ["rate_limited", 1],
    ["server", 1],
    ["timeout", 2],
    ["cancelled", 2],
    ["transport", 2],
    ["unusable", 2],
  ] as const)("keeps the reading for review when the check fails with %s, billing %i", async (failure, units) => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure });

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.finalBillableUnits).toBe(units);
    expect(outcome.extraction?.total.value).toBe(350);
    expect(outcome.extraction?.vendor.evidence?.validationCodes).toContain("OWNER_REVIEW_REQUIRED");
    // Unchecked lines that miss the total are offered for review, never validated.
    expect(outcome.extraction?.itemsEvidence?.validationState).toBe("UNVALIDATED");
  });

  it("keeps a refusal's Retry-After on the outcome", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: null, failure: "rate_limited", httpStatus: 429, retryAfterMs: 45_000 });

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

    expect(outcome.retryAfterMs).toBe(45_000);
  });

  it("leaves an accepted verdict succeeding and billing both calls", async () => {
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

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

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

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

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

    expect(outcome).toMatchObject({
      status: "FAILED",
      outcomeCode: "RATE_LIMITED",
      retryAfterMs: 30_000,
    });
  });

  it("preserves extraction server Retry-After", async () => {
    extractReceiptWithVision.mockResolvedValue({
      receipt: null,
      rejectReason: null,
      failure: { kind: "server", httpStatus: 503, retryAfterMs: 45_000 },
      requestMs: 12,
    });

    const outcome = (await createGeminiReceiptAdapter().extract(providerRequest())) as ReceiptProviderOutcome;

    expect(outcome).toMatchObject({
      status: "FAILED",
      outcomeCode: "PROVIDER_SERVER_ERROR",
      retryAfterMs: 45_000,
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

    const outcome = (await createVeryfiReceiptAdapter().extract(providerRequest({ provider: "veryfi" }))) as ReceiptProviderOutcome;

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
    const outcome = (await createVeryfiReceiptAdapter().extract(request)) as ReceiptProviderOutcome;
    const merged = mergeReceiptProviderOutcome(localExtraction(), request, outcome);

    expect(merged.providerCurrency).toBe("USD");
    expect(merged.appliedFields).not.toContain("currency");
    expect(merged.receipt.currency.value).toBe("PHP");
  });

  it("reports it even when the local read found no currency at all", async () => {
    extractReceiptWithVeryfi.mockResolvedValue({ receipt: { ...reconciledReceipt, currency: "USD" } });

    const request = providerRequest({ provider: "veryfi" });
    const outcome = (await createVeryfiReceiptAdapter().extract(request)) as ReceiptProviderOutcome;
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
    const outcome = (await createVeryfiReceiptAdapter().extract(request)) as ReceiptProviderOutcome;

    expect(outcome.extraction?.currency).toEqual({ value: null, evidence: null });
    expect(mergeReceiptProviderOutcome(localExtraction(), request, outcome).providerCurrency).toBeNull();
  });
});

/*
 * The verifier is skipped only when the local read corroborated the date and
 * the total on the paper, Gemini read the same two values, and Gemini's lines
 * add up. Every other case still pays for, and waits for, the second check.
 */
describe("settling Gemini's day/month order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });
  });

  const extractWith = async (receipt: Record<string, unknown>, referenceDate: string | null) => {
    // Lines that miss the total, so the check runs and its input can be inspected.
    extractReceiptWithVision.mockResolvedValue({ receipt: { ...unreconciledReceipt, warnings: [], ...receipt } });
    return (await createGeminiReceiptAdapter().extract(providerRequest({ referenceDate }))) as ReceiptProviderOutcome;
  };

  it("re-reads the printed date with the upload-date rule and marks the order inferred", async () => {
    const outcome = await extractWith({ date: "2024-06-07", dateText: "07/06/2024" }, "2024-07-06");
    expect(outcome.extraction?.date.value).toBe("2024-07-06");
    expect(outcome.extraction?.date.evidence?.validationCodes).toContain("DATE_ORDER_INFERRED");
    // The verifier checks the settled date, not the model's day-first one.
    expect(verifyVisionReceipt.mock.calls[0]![1]).toMatchObject({ date: "2024-07-06" });
  });

  it("falls back to the ambiguity warning's text when no printed date came back", async () => {
    const outcome = await extractWith({
      date: "2024-06-07",
      dateText: null,
      warnings: [{ code: "AMBIGUOUS_DATE", field: "date", detail: "07/06/2024" }],
    }, "2024-07-06");
    expect(outcome.extraction?.date.value).toBe("2024-07-06");
  });

  it("does not flag a date the paper or the upload date settles", async () => {
    const outcome = await extractWith({ date: "2024-06-18", dateText: "06/18/2024" }, "2024-07-06");
    expect(outcome.extraction?.date.value).toBe("2024-06-18");
    expect(outcome.extraction?.date.evidence?.validationCodes).not.toContain("DATE_ORDER_INFERRED");
  });

  it("keeps the model's date when its printed text reads as a different date", async () => {
    const outcome = await extractWith({ date: "2024-06-07", dateText: "07/08/2024" }, "2024-07-06");
    expect(outcome.extraction?.date.value).toBe("2024-06-07");
    expect(outcome.extraction?.date.evidence?.validationCodes).not.toContain("DATE_ORDER_INFERRED");
  });
});

describe("skipping the verifier when the local read agrees", () => {
  const agreeing = { localCorroboration: { date: "2026-09-14", total: 350 } };

  beforeEach(() => {
    vi.clearAllMocks();
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: true, rejectedFields: [] }, failure: null });
  });

  it("accepts without a second call, bills one unit and records the local match", async () => {
    extractReceiptWithVision.mockResolvedValue({ receipt: reconciledReceipt, requestMs: 2_800 });

    const request = providerRequest(agreeing);
    const outcome = (await createGeminiReceiptAdapter().extract(request)) as ReceiptProviderOutcome;

    expect(verifyVisionReceipt).not.toHaveBeenCalled();
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.finalBillableUnits).toBe(1);
    expect(outcome.stageTimings).toEqual({ extractionMs: 2_800, verificationMs: 0 });
    expect(outcome.extraction?.date.evidence?.validationCodes).toContain("LOCAL_MATCH");
    expect(outcome.extraction?.total.evidence?.validationCodes).toContain("LOCAL_MATCH");
    // Nothing checked the store name, and its evidence does not pretend otherwise.
    expect(outcome.extraction?.vendor.evidence?.validationCodes).not.toContain("LOCAL_MATCH");
    expect(outcome.extraction?.vendor.evidence?.validationCodes).toContain("OWNER_REVIEW_REQUIRED");
  });

  it.each([
    ["a different total", { date: "2026-09-14", total: 305 }],
    ["a different date", { date: "2026-09-15", total: 350 }],
  ])("skips the check on lines that add up, even beside a local read with %s", async (_label, localCorroboration) => {
    extractReceiptWithVision.mockResolvedValue({ receipt: reconciledReceipt });

    const outcome = (await createGeminiReceiptAdapter().extract(
      providerRequest({ localCorroboration }),
    )) as ReceiptProviderOutcome;

    expect(verifyVisionReceipt).not.toHaveBeenCalled();
    expect(outcome.status).toBe("SUCCEEDED");
    expect(outcome.finalBillableUnits).toBe(1);
    // Corroborated by its own arithmetic, not by the local read.
    expect(outcome.extraction?.itemsEvidence?.validationCodes).toContain("ARITHMETIC_VALID");
    expect(outcome.extraction?.total.evidence?.validationCodes).not.toContain("LOCAL_MATCH");
    expect(outcome.extraction?.vendor.evidence?.validationCodes).toContain("OWNER_REVIEW_REQUIRED");
  });

  it.each([
    ["lines that miss the total", { date: "2026-09-14", total: 350 }, unreconciledReceipt],
  ])("still verifies on %s", async (_label, localCorroboration, receipt) => {
    extractReceiptWithVision.mockResolvedValue({ receipt });

    const outcome = (await createGeminiReceiptAdapter().extract(
      providerRequest({ localCorroboration }),
    )) as ReceiptProviderOutcome;

    expect(verifyVisionReceipt).toHaveBeenCalledTimes(1);
    expect(outcome.finalBillableUnits).toBe(2);
    expect(outcome.extraction?.total.evidence?.validationCodes).not.toContain("LOCAL_MATCH");
  });

  it("still verifies lines that miss the total when the local read sent nothing to compare", async () => {
    extractReceiptWithVision.mockResolvedValue({ receipt: unreconciledReceipt });

    await createGeminiReceiptAdapter().extract(providerRequest({ localCorroboration: null }));
    await createGeminiReceiptAdapter().extract(providerRequest());

    expect(verifyVisionReceipt).toHaveBeenCalledTimes(2);
  });

  it("still falls back when the verifier does run and rejects", async () => {
    extractReceiptWithVision.mockResolvedValue({ receipt: unreconciledReceipt });
    verifyVisionReceipt.mockResolvedValue({ verdict: { accept: false, rejectedFields: ["amount"] }, failure: null });

    const outcome = (await createGeminiReceiptAdapter().extract(
      providerRequest({ localCorroboration: { date: "2026-09-14", total: 999 } }),
    )) as ReceiptProviderOutcome;

    expect(outcome.status).toBe("FAILED");
    expect(outcome.outcomeCode).toBe("INVALID_RESULT");
  });
});
