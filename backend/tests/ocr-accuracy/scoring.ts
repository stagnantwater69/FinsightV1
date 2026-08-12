/**
 * How a corpus run is scored, shared by every assessment.
 *
 * Extracted so the deterministic pipeline (run-assessment.ts) and any
 * alternative extractor being evaluated against it (vision-spike.ts) are
 * judged by exactly the same rules. Two comparable numbers require one
 * scorer; a second copy of these rules would eventually drift from the first
 * and quietly make the comparison meaningless.
 *
 * Moved here verbatim from run-assessment.ts — no rule was changed in the
 * move, and the corpus results are identical before and after it.
 *
 * The MATCHERS underneath (is this vendor the same vendor, is this the same
 * amount) have since moved again, to src/lib/fieldComparison, because
 * extractionFeedback.service now asks the same question of live scans. What
 * stays here is everything corpus-specific: the `n/a`/`missed` verdicts, which
 * only mean something when there is a ground-truth answer to be absent. Same
 * rules, same corpus results — see that file's header for why the matchers
 * could not be allowed to exist twice.
 */
import { amountsMatch, itemNamesMatch, normalizeVendor, vendorsMatch } from "../../src/lib/fieldComparison";

// Re-exported so this stays the one import the harness scripts need.
export { itemNamesMatch, normalizeVendor };

export interface ExpectedItem {
  name: string;
  quantity: number | null;
  amount: number;
}

export interface ExtractedItem {
  name: string;
  quantity: number | null;
  amount: number;
}

/**
 * Item scoring is per-item, not per-receipt, and each attribute is counted
 * separately so a right name with a wrong price is visible as exactly that.
 *
 * An extracted item is matched to a ground-truth item by AMOUNT first, since
 * the amount is the field the books actually depend on and the one OCR gets
 * right most often. Name is then scored on that pairing. An extracted item
 * matching no expected amount is a false positive — the number that matters
 * most here, because a fabricated line puts money in the owner's records
 * that was never on the receipt.
 */
export interface ItemScore {
  expected: number;
  matched: number;
  nameCorrect: number;
  quantityCorrect: number;
  quantityScored: number;
  falsePositives: number;
}

export type Verdict = "correct" | "wrong" | "missed" | "n/a";

export function scoreVendor(expected: string | null, actual: string | null): Verdict {
  // Some receipts genuinely contain no vendor name (e.g. the real photo whose
  // header is cropped). Scoring those as failures would be dishonest — the
  // information is not in the image.
  if (expected === null) return "n/a";
  if (actual === null) return "missed";
  return vendorsMatch(expected, actual) ? "correct" : "wrong";
}

export function scoreDate(expected: string | null, actual: string | null): Verdict {
  if (expected === null) return "n/a";
  if (actual === null) return "missed";
  return actual === expected ? "correct" : "wrong";
}

export function scoreAmount(expected: number | null, actual: number | null): Verdict {
  if (expected === null) return "n/a";
  if (actual === null) return "missed";
  return amountsMatch(expected, actual) ? "correct" : "wrong";
}

export function scoreItems(expected: ExpectedItem[], actual: ExtractedItem[]): ItemScore {
  const score: ItemScore = {
    expected: expected.length,
    matched: 0,
    nameCorrect: 0,
    quantityCorrect: 0,
    quantityScored: 0,
    falsePositives: 0,
  };
  const unclaimed = [...expected];

  for (const got of actual) {
    const i = unclaimed.findIndex((e) => amountsMatch(e.amount, got.amount));
    if (i === -1) {
      score.falsePositives++;
      continue;
    }
    const exp = unclaimed.splice(i, 1)[0]!;
    score.matched++;
    if (itemNamesMatch(exp.name, got.name)) score.nameCorrect++;
    // Quantity is only scored where the receipt actually prints one.
    if (exp.quantity !== null) {
      score.quantityScored++;
      if (got.quantity === exp.quantity) score.quantityCorrect++;
    }
  }
  return score;
}

export function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;
}

export const SYMBOL: Record<Verdict, string> = { correct: "✅", wrong: "❌", missed: "⬜", "n/a": "—" };
