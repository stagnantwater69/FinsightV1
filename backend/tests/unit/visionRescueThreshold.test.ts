import { describe, expect, it } from "vitest";
import { LOW_CONFIDENCE } from "../../src/services/receiptScan/extraction";

/**
 * Pins the vision-rescue confidence trigger to its evidenced value.
 *
 * Raised from 75 to 88 in Phase 4 of docs/receipt-ocr-accuracy-plan.md, once
 * the OCR-accuracy corpus grew to 45 real photos (of 73) and Phase 3's parser
 * fixes had landed. A fresh sweep of every corpus image
 * (`npx tsx tests/ocr-accuracy/confidence-calibration.ts`, see
 * tests/ocr-accuracy/CONFIDENCE-CALIBRATION-REPORT.md and
 * confidence-calibration.json for the full per-image numbers) showed 88 is
 * the highest value that adds zero new false triggers on the corpus's clean
 * receipts versus the old value of 75 (one clean receipt already fires below
 * 75 and continues to be the only one through 89), while catching 8 more real
 * broken cases than 75 did — including all 3 wrong-AMOUNT cases 75 missed.
 * 90 is the first value that buys anything more at the cost of a second false
 * trigger, which is why this stops at 88.
 *
 * This is a deliberate, evidenced change to a financial-safety-relevant
 * threshold — see the extended rationale next to the constant itself in
 * receiptScan/extraction.ts before changing this test.
 */
describe("vision-rescue confidence threshold", () => {
  it("is 88, per the Phase 4 corpus re-calibration", () => {
    expect(LOW_CONFIDENCE).toBe(88);
  });
});
