import { describe, expect, it } from "vitest";
import { buildFieldEvidence } from "../../src/services/receiptScan/extraction";
import type { ParsedReceiptFields } from "../../src/services/ocr.service";
import type { RescuedFields } from "../../src/services/receiptScan/types";

/**
 * Pins where the vendor's evidence says it came from. The provider's reading
 * is "vision"; the parser's own reading, or a confirmed name history snapping
 * found in the OCR text, is "ocr".
 */
const page = "LOCAL STORE\nRice 60.00\nTOTAL PHP 100.00";

function parsed(vendor: string | null): ParsedReceiptFields {
  return { date: null, vendor, description: null, amount: null, dateAmbiguous: false, dateSourceText: null };
}

function rescued(vendor: string | null): RescuedFields {
  return { ...parsed(vendor), items: [], visionAssisted: vendor !== null } as unknown as RescuedFields;
}

describe("buildFieldEvidence vendor source", () => {
  it("reports the parser's own vendor as ocr, located on its page", () => {
    const evidence = buildFieldEvidence([page], parsed("LOCAL STORE"), rescued("LOCAL STORE"), "LOCAL STORE");
    expect(evidence.vendor).toEqual({ pageNumber: 1, sourceText: "LOCAL STORE", source: "ocr" });
  });

  it("reports a provider vendor that replaced the parser's as vision", () => {
    const evidence = buildFieldEvidence([page], parsed("TOTAL PHP 100.00"), rescued("SM Savemore"), "SM Savemore");
    expect(evidence.vendor).toEqual({ pageNumber: null, sourceText: null, source: "vision" });
  });

  it("reports a confirmed vendor restored over the provider's reading as ocr", () => {
    const evidence = buildFieldEvidence([page], parsed("LOCAL STORE"), rescued("SM Savemore"), "LOCAL STORE");
    expect(evidence.vendor).toEqual({ pageNumber: 1, sourceText: "LOCAL STORE", source: "ocr" });
  });

  it("reports a confirmed vendor found in the text as ocr when no reader produced one", () => {
    const evidence = buildFieldEvidence([page], parsed(null), rescued(null), "LOCAL STORE");
    expect(evidence.vendor?.source).toBe("ocr");
  });
});
