import { describe, expect, it } from "vitest";
import { documentConfidence, type OcrResult } from "../../src/services/ocr.service";
import { buildScanWarnings, LOW_CONFIDENCE } from "../../src/services/receiptScan/extraction";
import type { RescuedFields } from "../../src/services/receiptScan/types";

/** A page whose every word tesseract scored at `confidence`. */
function page(confidence: number, words: number): OcrResult {
  const line = { text: "w", confidence, words: Array.from({ length: words }, () => ({ text: "w", confidence })) };
  return { text: "w", confidence, lines: [line] };
}

const parsed = { date: "2026-09-28", vendor: "GAISANO GRAND", description: null, amount: 100, dateAmbiguous: false, dateSourceText: null };
const rescued = {
  date: "2026-09-28",
  vendor: "GAISANO GRAND",
  description: null,
  amount: 100,
  items: [{ name: "Goods", quantity: null, unitPrice: null, amount: 100 }],
  dateAmbiguous: false,
  dateSourceText: null,
  visionAssisted: false,
  itemsFromVision: false,
  visionTrigger: null,
  visionLatencyMs: null,
  visionProvider: null,
  visionModel: null,
  visionRejectReason: null,
  verifier: null,
  visionWarnings: [],
  itemEvidence: null,
} as unknown as RescuedFields;

function warningsFor(pageConfidences: number[]) {
  return buildScanWarnings({
    pageQualities: [],
    pageTexts: pageConfidences.map(() => "Goods 100.00\nTOTAL 100.00"),
    combinedText: "Goods 100.00\nTOTAL 100.00",
    seamFreeText: "Goods 100.00\nTOTAL 100.00",
    parsed,
    rescued,
    worstPageConfidence: Math.min(...pageConfidences),
    pageConfidences,
  }).filter((warning) => warning.code === "LOW_CONFIDENCE");
}

describe("confidence for a receipt photographed in sections", () => {
  it("is the mean over every word on every page, not the worst page", () => {
    // One short page with a handwritten note across it, two clean long ones.
    expect(documentConfidence([page(39, 20), page(90, 60), page(92, 60)])).toBe(84);
  });

  it("is unchanged for a single photograph", () => {
    expect(documentConfidence([page(39, 20)])).toBe(39);
  });

  it("falls back to text-length weights when no word tree was read", () => {
    const bare = (confidence: number, text: string): OcrResult => ({ text, confidence, lines: [] });
    expect(documentConfidence([bare(40, "ab"), bare(80, "abcdef")])).toBe(70);
  });
});

describe("low-confidence warnings name the page", () => {
  it("warns once per weak page on a multi-page scan, with its page number", () => {
    expect(warningsFor([39, 90, LOW_CONFIDENCE - 1])).toEqual([
      { code: "LOW_CONFIDENCE", pageNumber: 1, detail: "page 1 confidence 39" },
      { code: "LOW_CONFIDENCE", pageNumber: 3, detail: `page 3 confidence ${LOW_CONFIDENCE - 1}` },
    ]);
  });

  it("does not warn when every page reads above the floor", () => {
    expect(warningsFor([LOW_CONFIDENCE, 95, 99])).toEqual([]);
  });

  it("keeps a single-page warning page-less", () => {
    expect(warningsFor([39])).toEqual([{ code: "LOW_CONFIDENCE", detail: "page confidence 39" }]);
  });
});
