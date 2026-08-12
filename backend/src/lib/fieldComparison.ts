/**
 * When are two readings of the same receipt field "the same"?
 *
 * These rules already existed, in tests/ocr-accuracy/scoring.ts, where they
 * decide whether a corpus image parsed correctly. They now have a SECOND
 * caller: extractionFeedback.service, which asks the same question of live
 * scans — did what FinSight read match what the owner confirmed?
 *
 * They live here, in src/, rather than in the harness, for the reason the
 * harness itself gives for having one scorer: "a second copy of these rules
 * would eventually drift from the first and quietly make the comparison
 * meaningless". That risk is worse across this particular boundary, not
 * better. The whole point of the live figures is to be comparable with the
 * corpus figures — "the corpus says 87% and production says 62%" is only a
 * finding if both numbers were produced by the same definition of correct. Two
 * copies would make that sentence unfalsifiable.
 *
 * Direction note: the harness compares ground truth against a parse, and the
 * service compares an owner's confirmation against a parse. Every matcher here
 * is therefore SYMMETRIC — none of them may take "which side is the truth"
 * into account, because the two callers disagree about that.
 */

/** Vendor matching is deliberately lenient about OCR character noise. */
export function normalizeVendor(v: string | null): string {
  return (v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Same normalisation as a vendor, used for item names.
 *
 * Kept as its own function rather than aliased: the two happen to share an
 * implementation today, and an item name is not a vendor name — a future
 * change to one should not silently reach the other.
 */
function normalizeName(v: string): string {
  return v
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Do these two strings agree once OCR noise is discounted?
 *
 * The rule: after normalising, what share of the FIRST string's words appear
 * in the second, allowing a four-character prefix match so `MERCADO` and
 * `MERCAD0` (a zero for an O — the classic thermal-print misread) still count.
 *
 * `threshold` differs between the two callers by inheritance, not by design:
 * vendors have always been scored at 0.7 and item names at 0.6. Preserved
 * exactly, because changing either would silently move every number in
 * OCR-ACCURACY-REPORT.md and make the reports incomparable across the change.
 */
function wordOverlapMatches(a: string, b: string, threshold: number): boolean {
  if (a === b) return true;
  const aw = a.split(" ").filter(Boolean);
  const bw = b.split(" ").filter(Boolean);
  if (aw.length === 0) return false;
  const hits = aw.filter((w) => bw.some((x) => x === w || (w.length > 3 && x.includes(w.slice(0, 4))))).length;
  return hits / aw.length >= threshold;
}

export function vendorsMatch(a: string | null, b: string | null): boolean {
  return wordOverlapMatches(normalizeVendor(a), normalizeVendor(b), 0.7);
}

export function itemNamesMatch(expected: string, actual: string): boolean {
  return wordOverlapMatches(normalizeName(expected), normalizeName(actual), 0.6);
}

/**
 * Exact to the centavo. An amount that is "close" is still wrong money.
 *
 * The 0.005 tolerance absorbs binary floating-point representation only — it is
 * half a centavo, so no two genuinely different peso amounts can pass it.
 */
export function amountsMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.005;
}

/** Dates are compared as YYYY-MM-DD strings; see `utcDateKey` for the source. */
export function datesMatch(a: string | null, b: string | null): boolean {
  return a === b;
}
