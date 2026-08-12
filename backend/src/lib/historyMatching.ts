/**
 * Snapping OCR text back to names this business has already confirmed.
 *
 * The premise: a shop buys from the same suppliers over and over. Once an
 * owner has confirmed "SAVEMORE MARKET" on a receipt, a later scan that reads
 * "SAVEM0RE MARKET" is not a new vendor — it is the same one with a zero where
 * an O should be. The business's own confirmed history is the highest-quality
 * reference data FinSight has, it costs nothing to consult, and unlike a model
 * it was verified by the person who was actually there.
 *
 * WHAT THIS MAY AND MAY NOT TOUCH: text only. Never an amount, never a date.
 * A vendor name is a label the owner can see and correct on the confirm
 * screen; a figure is money in their books. The same rule the vision fallback
 * follows — the reading may be improved, the numbers may not be invented.
 *
 * APPLIED TO VENDORS ONLY, and that limit was measured rather than assumed.
 * The obvious next step is to snap ITEM names the same way, and the first
 * attempt at it was wrong: "RICE 25KG" and "RICE 20KG" score 0.889 — above any
 * threshold loose enough to be useful — so a 25kg sack would have been filed
 * under the 20kg one. Item names carry quantities, and a single digit is the
 * whole difference between two real products while being exactly the kind of
 * character OCR gets wrong. Longer names make it worse, not better: "PORK
 * BELLY 1KG" against "PORK BELLY 2KG" scores 0.93, because the disagreeing
 * digit is a smaller fraction of a longer string.
 *
 * Vendor names do not have that problem — they rarely carry quantities, and
 * where they carry digits at all ("7-ELEVEN") both sides carry the same ones.
 * Matching item names needs a quantity-aware comparison that this deliberately
 * does not attempt, and item wording already has its own fix: the vision
 * re-read takes the model's wording when a page reads badly.
 */

/**
 * Comparable form: case, punctuation and spacing removed.
 *
 * Receipts print the same vendor as "SAVEMORE MARKET", "Savemore Market" and
 * "SAVEMORE  MARKET,INC." — none of those differences are a different shop.
 */
export function normaliseForMatch(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/[015826]/g, (d) => OCR_CONFUSABLE[d]!);
}

/**
 * Glyphs tesseract genuinely swaps, folded to one canonical letter.
 *
 * These are not arbitrary: a zero for an O and a five for an S are the
 * substitutions that actually appear on thermal print, and they are the whole
 * reason a known vendor fails to match itself. Folding them means "SAVEM0RE"
 * and "SAVEMORE" compare as identical rather than merely similar, which lets
 * the threshold below stay strict enough to keep genuinely different shops
 * apart instead of being loosened to forgive noise.
 */
const OCR_CONFUSABLE: Record<string, string> = {
  "0": "O",
  "1": "I",
  "5": "S",
  "8": "B",
  "2": "Z",
  "6": "G",
};

/** Standard iterative Levenshtein, two rows rather than a full matrix. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 1 for identical, 0 for nothing in common, on the normalised forms. */
export function similarity(a: string, b: string): number {
  const x = normaliseForMatch(a);
  const y = normaliseForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const longest = Math.max(x.length, y.length);
  return 1 - editDistance(x, y) / longest;
}

/**
 * How alike two names must be before one is treated as a misreading of the
 * other.
 *
 * 0.88 is chosen against the case that decides it, which is NOT how much OCR
 * noise to forgive — it is how to avoid merging two shops that genuinely have
 * similar names. "SM SUPERMARKET" against "SM HYPERMARKET" scores 0.85: two
 * characters apart, and two completely different businesses. Anything loose
 * enough to forgive three characters of noise on a short name is also loose
 * enough to file a receipt under the wrong shop, and a wrong name presented
 * confidently is worse than a mangled one the owner can see is mangled.
 *
 * The cost of being strict is only a missed correction, which leaves the owner
 * exactly where they are today.
 */
export const MATCH_THRESHOLD = 0.88;

/**
 * Names shorter than this are never matched.
 *
 * On a short string a single character is a large fraction of the whole, so
 * similarity stops discriminating: "TAN" and "TAM" score 0.67, and a threshold
 * low enough to relate real short names would relate unrelated ones too.
 */
export const MIN_MATCH_LENGTH = 6;

export interface Match {
  value: string;
  score: number;
}

/**
 * The confirmed name a candidate is most likely a misreading of, or null.
 *
 * Returns null rather than a weak guess whenever nothing clears the threshold.
 * Null means "leave it as OCR read it", which is the current behaviour and
 * always safe.
 */
export function bestMatch(candidate: string | null | undefined, known: readonly string[]): Match | null {
  if (!candidate) return null;
  const normalised = normaliseForMatch(candidate);
  if (normalised.length < MIN_MATCH_LENGTH) return null;

  let best: Match | null = null;
  for (const entry of known) {
    if (normaliseForMatch(entry).length < MIN_MATCH_LENGTH) continue;
    const score = similarity(candidate, entry);
    if (score >= MATCH_THRESHOLD && (best === null || score > best.score)) {
      best = { value: entry, score };
    }
  }
  return best;
}

/**
 * Searches every line of a receipt for a vendor this business already knows.
 *
 * This exists because the vendor parser's hardest failure is not misreading
 * the right line — it is picking the WRONG one. A stylised logo that OCR
 * mangles into a short scrap of letters can outrank the real registered name
 * printed below it. Scanning all the lines means a known vendor is found
 * wherever it sits on the page, header or footer.
 *
 * Only the best match across the whole receipt is returned, and it still has
 * to clear the same threshold, so a receipt from a genuinely new shop matches
 * nothing and the parser's own answer stands.
 */
export function findKnownVendorInText(text: string, known: readonly string[]): Match | null {
  let best: Match | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = bestMatch(trimmed, known);
    if (match && (best === null || match.score > best.score)) best = match;
  }
  return best;
}
