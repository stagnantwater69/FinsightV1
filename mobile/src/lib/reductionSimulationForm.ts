/**
 * Client-side validation for the "Simulate reduction" sheet — Expense
 * Reduction Opportunities plan §12.3, Phase 4.
 *
 * Mirrors the server's own rules in
 * backend/src/services/reductionOpportunity.service.ts#computeReductionSimulation
 * exactly, so a mistake is caught before a request is sent wherever
 * possible. The server is still the final authority — see
 * `simAmountValidationError`'s `baseline` parameter, which is a courtesy
 * figure read from the opportunity card already on screen, not something
 * this sheet is entitled to treat as fresh. A submit that clears client-side
 * validation can still come back with a 400 (a stale baseline, or a
 * zero-baseline category), and that response is shown exactly as sent
 * rather than re-derived here.
 */

/** Same shape as `parseAmount` in spendingImpactForm.ts — admits a leading
 * minus so the error can name the actual mistake instead of "not a number". */
const NUMBER_SHAPE = /^-?\d*(\.\d*)?$/;

export function parseSimNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  if (!NUMBER_SHAPE.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Percent must be greater than zero and no greater than 100 — §12.3, first
 * bullet.
 */
export function percentValidationError(raw: string): string | null {
  const value = parseSimNumber(raw);
  if (value === null) {
    return raw.trim() === "" ? "Enter a percentage." : "Enter a valid number.";
  }
  if (value <= 0) return "Enter a percentage greater than zero.";
  if (value > 100) return "Enter 100 or less.";
  return null;
}

/**
 * Amount must be greater than zero and no greater than the category
 * baseline — §12.3, second bullet.
 *
 * `baseline` is `null` when the sheet has nothing to check against yet (the
 * opportunity card's own evidence figure is unavailable for some reason);
 * the upper bound is then left to the server's 400, which still fires.
 */
export function simAmountValidationError(raw: string, baseline: number | null): string | null {
  const value = parseSimNumber(raw);
  if (value === null) {
    return raw.trim() === "" ? "Enter an amount." : "Enter a valid number.";
  }
  if (value <= 0) return "Enter an amount greater than zero.";
  if (baseline !== null && value > baseline) {
    return `Enter an amount no greater than this category's period total.`;
  }
  return null;
}
