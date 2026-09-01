import { describe, expect, it } from "vitest";
import { selectOcrCandidate } from "../../src/services/receiptScan/ocrCandidateSelection";
import type { OcrResult } from "../../src/services/ocr.service";

const result = (text: string, confidence: number): OcrResult => ({ text, confidence, lines: [] });

describe("processed receipt OCR candidate selection", () => {
  it("keeps the original on a tie", () => {
    const original = result("STORE\n2026-08-31\nTOTAL 100.00", 80);
    expect(selectOcrCandidate(original, { ...original }).source).toBe("original");
  });

  it("uses a processed reading when it objectively restores financial fields", () => {
    const selected = selectOcrCandidate(
      result("STORE\nblurred", 35),
      result("STORE\n2026-08-31\nBread 100.00\nTOTAL 100.00", 88),
    );
    expect(selected.source).toBe("processed");
    expect(selected.fieldCount).toBeGreaterThan(0);
  });

  it("never trades away a reconciled original for a higher-confidence incomplete result", () => {
    const selected = selectOcrCandidate(
      result("STORE\n2026-08-31\nBread 100.00\nTOTAL 100.00", 60),
      result("STORE HEADER", 99),
    );
    expect(selected.source).toBe("original");
  });
});
