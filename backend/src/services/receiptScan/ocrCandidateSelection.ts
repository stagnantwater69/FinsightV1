import {
  overallConfidence,
  parseLineItems,
  parseReceiptFields,
  reconcileItems,
  type OcrResult,
} from "../ocr.service";

export type OcrCandidateSource = "original" | "processed";

export interface RankedOcrCandidate {
  source: OcrCandidateSource;
  result: OcrResult;
  score: number;
  reconciled: boolean;
  fieldCount: number;
  itemCount: number;
}

export function rankOcrCandidate(source: OcrCandidateSource, result: OcrResult): RankedOcrCandidate {
  const parsed = parseReceiptFields(result.text);
  const items = parseLineItems(result.text);
  const reconciled = reconcileItems(result.text, items, parsed.amount).reconciled;
  const fieldCount = [parsed.date, parsed.vendor, parsed.amount].filter((value) => value != null).length;
  const confidence = overallConfidence(result);
  const moneyLines = result.text.split(/\r?\n/).filter((line) => /\d+[.,]\d{2}\b/.test(line)).length;
  const score =
    (reconciled ? 40 : 0) +
    fieldCount * 15 +
    Math.min(items.length, 8) * 2 +
    Math.min(moneyLines, 8) +
    Math.round(confidence / 10);
  return { source, result, score, reconciled, fieldCount, itemCount: items.length };
}

/**
 * A processed reading wins only when it has objective evidence of improvement.
 * Ties always preserve the original, and a processed candidate cannot trade
 * away a parsed financial field or a reconciled original merely for confidence.
 */
export function selectOcrCandidate(original: OcrResult, processed?: OcrResult | null): RankedOcrCandidate {
  const baseline = rankOcrCandidate("original", original);
  if (!processed) return baseline;
  const derived = rankOcrCandidate("processed", processed);
  if (baseline.reconciled && !derived.reconciled) return baseline;
  if (derived.fieldCount < baseline.fieldCount) return baseline;
  return derived.score >= baseline.score + 5 ? derived : baseline;
}
