import type { DocumentCandidate } from "./edgeDetection";

export const RECEIPT_LIKELIHOOD_VERSION = "receipt-likelihood-v1";

export type ReceiptLikelihoodOutcome = "likely-receipt" | "uncertain" | "obvious-non-receipt";

export interface ReceiptLikelihoodAssessment {
  version: typeof RECEIPT_LIKELIHOOD_VERSION;
  score: number;
  outcome: ReceiptLikelihoodOutcome;
  signals: {
    document: boolean;
    textLines: number;
    moneyPatterns: number;
    receiptKeywords: number;
    datePatterns: number;
    itemPatterns: number;
    administrationPatterns: number;
    handwrittenRelaxation: boolean;
  };
}

const MONEY = /(?:₱|\bPHP\b|\bP\s*)?\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})\b/gi;
const RECEIPT_WORDS = /\b(?:total|subtotal|amount(?:\s+due)?|cash|change|balance)\b/gi;
const DATE = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/g;
const ITEM = /(?:\bqty\b|\bquantity\b|\b\d+(?:\.\d+)?\s*[x×@]\s*\d+(?:[.,]\d{2})?\b)/gi;
const ADMIN = /\b(?:VAT|TIN|invoice|receipt|OR\s*no|SI\s*no)\b/gi;

function matches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Advisory receipt evidence. It deliberately has an uncertain middle state
 * and never treats empty OCR as proof that a plausible sheet is not a receipt.
 */
export function assessReceiptLikelihood(args: {
  rawText?: string | null;
  documentConfidence?: number | null;
  candidates?: DocumentCandidate[];
}): ReceiptLikelihoodAssessment {
  const rawText = args.rawText?.trim() ?? "";
  const textLines = rawText.split(/\r?\n/).filter((line) => line.trim().length >= 3).length;
  const documentConfidence = Math.max(
    args.documentConfidence ?? 0,
    ...(args.candidates ?? []).map((candidate) => candidate.confidence),
  );
  const document = documentConfidence >= 0.55;
  const moneyPatterns = matches(rawText, MONEY);
  const receiptKeywords = matches(rawText, RECEIPT_WORDS);
  const datePatterns = matches(rawText, DATE);
  const itemPatterns = matches(rawText, ITEM);
  const administrationPatterns = matches(rawText, ADMIN);

  let score = 0;
  score += Math.round(Math.min(1, documentConfidence) * 30);
  score += Math.min(20, textLines * 4);
  score += Math.min(20, moneyPatterns * 7);
  score += Math.min(15, receiptKeywords * 8);
  score += Math.min(10, datePatterns * 10);
  score += Math.min(10, itemPatterns * 5);
  score += Math.min(5, administrationPatterns * 3);
  score = Math.min(100, score);

  // A plausible page containing several text/number lines may be handwritten.
  // It stays uncertain even without machine-readable receipt vocabulary.
  const handwrittenRelaxation = document && textLines >= 2 && /\d/.test(rawText) && score < 55;
  const outcome: ReceiptLikelihoodOutcome =
    score >= 55
      ? "likely-receipt"
      : document || handwrittenRelaxation || textLines >= 3 || moneyPatterns > 0
        ? "uncertain"
        : "obvious-non-receipt";

  return {
    version: RECEIPT_LIKELIHOOD_VERSION,
    score,
    outcome,
    signals: {
      document,
      textLines,
      moneyPatterns,
      receiptKeywords,
      datePatterns,
      itemPatterns,
      administrationPatterns,
      handwrittenRelaxation,
    },
  };
}
