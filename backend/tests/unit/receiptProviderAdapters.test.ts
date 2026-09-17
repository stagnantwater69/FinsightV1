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
    verifyVisionReceipt.mockResolvedValue({ accept: true });

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
    verifyVisionReceipt.mockResolvedValue({ accept: true });

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
    verifyVisionReceipt.mockResolvedValue({ accept: true });

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
