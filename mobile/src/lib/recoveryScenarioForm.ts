/**
 * Client-side validation for the Recovery Target "hypothetical scenario"
 * sheet — Expense Reduction Opportunities plan §13.2/§15 Phase 5.
 *
 * Mirrors the server's own rule in
 * backend/src/services/insights.service.ts#simulateRecoveryScenario exactly
 * (finite, >= 0) so an obviously-wrong entry is caught before a request is
 * sent. The server remains the final authority — a value that clears this
 * check can still come back with a 400.
 */

/** Same shape as reductionSimulationForm's `parseSimNumber` — admits a
 * leading minus so the error can name the actual mistake. */
const NUMBER_SHAPE = /^-?\d*(\.\d*)?$/;

export function parseScenarioNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  if (!NUMBER_SHAPE.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Must be a finite number >= 0 — matches the server's own check exactly. */
export function assumedExpensesValidationError(raw: string): string | null {
  const value = parseScenarioNumber(raw);
  if (value === null) {
    return raw.trim() === "" ? "Enter an assumed monthly expense amount." : "Enter a valid number.";
  }
  if (value < 0) return "Enter zero or a positive amount.";
  return null;
}
