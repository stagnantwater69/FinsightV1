import { describe, expect, it } from "vitest";
import { selectOcrCandidate } from "../../src/services/receiptScan/ocrCandidateSelection";
import { overallConfidence, type OcrResult } from "../../src/services/ocr.service";

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

describe("persisted OCR confidence boundary", () => {
  it.each([
    [Number.NaN, 0],
    [-1, 0],
    [101, 100],
  ])("normalizes %s to %s", (confidence, expected) => {
    expect(overallConfidence(result("receipt", confidence))).toBe(expected);
  });
});

describe("choosing between two readings of a long two-line page", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => {
    const code = String(3_000_000 + index).padStart(9, "0");
    return `${code} 2 10.25 20.50T\nPRODUCT NUMBER ${index + 1} 55G`;
  }).join("\n");

  it("prefers the reading that confirmed more rows by their own arithmetic", () => {
    // Both readings are past the eight-item cap; only the rows beyond it can tell them apart.
    const selected = selectOcrCandidate(result(rows(12), 80), result(rows(20), 80));
    expect(selected.source).toBe("processed");
  });

  it("keeps the original when it read more of them", () => {
    expect(selectOcrCandidate(result(rows(20), 80), result(rows(12), 90)).source).toBe("original");
  });
});
