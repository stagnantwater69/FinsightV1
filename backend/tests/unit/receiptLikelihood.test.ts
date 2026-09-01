import { describe, expect, it } from "vitest";
import { assessReceiptLikelihood, RECEIPT_LIKELIHOOD_VERSION } from "../../src/lib/receiptLikelihood";

describe("receipt likelihood", () => {
  it("recognises several independent receipt signals", () => {
    const result = assessReceiptLikelihood({
      documentConfidence: 0.9,
      rawText: "ALING NENA STORE\n2026-08-31\n2 x 50.00\nSUBTOTAL 100.00\nTOTAL PHP 100.00\nVAT TIN 123",
    });
    expect(result.version).toBe(RECEIPT_LIKELIHOOD_VERSION);
    expect(result.outcome).toBe("likely-receipt");
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  it("does not reject a plausible handwritten page only because keywords are absent", () => {
    const result = assessReceiptLikelihood({
      documentConfidence: 0.8,
      rawText: "Maria\n3 bread 45\n31/08/2026",
    });
    expect(result.outcome).not.toBe("obvious-non-receipt");
  });

  it("calls an empty non-document obvious without making that decision irreversible", () => {
    expect(assessReceiptLikelihood({ documentConfidence: 0.08, rawText: "" }).outcome).toBe(
      "obvious-non-receipt",
    );
  });

  it("keeps money evidence uncertain even when document geometry is unavailable", () => {
    expect(assessReceiptLikelihood({ rawText: "amount 250.00" }).outcome).toBe("uncertain");
  });
});
