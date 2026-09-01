/**
 * Client-side helpers for the "save this as a plan" flow — Recovery Target
 * Improvement Plan §7.5/§10.7/§11 Phase 6.
 *
 * A RecoveryPlan is a purely separate, owner-visible reference note: nothing
 * here is read by the real Recovery Target calculation. Validation mirrors
 * the server's own zod schema in
 * backend/src/controllers/recoveryPlan.controller.ts — `bufferPercent`
 * 0-100, `ownerTargetAmount` a positive number, both optional. The server
 * remains the final authority — a value that clears this check can still
 * come back with a 400.
 */

/** "YYYY-MM" for the calendar month containing today, in the device's local time — same reasoning as OperatingScheduleScreen's own local-date helpers. */
export function currentMonthKey(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

const NUMBER_SHAPE = /^\d*(\.\d*)?$/;

/** Parses a non-negative decimal, or null when the field is empty/invalid. Every field this helper serves is optional, so "empty" is a valid, meaningful input on its own — callers check that separately. */
export function parsePlanNumber(raw: string): number | null {
  const cleaned = raw.trim();
  if (cleaned === "") return null;
  if (!NUMBER_SHAPE.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Optional — empty is valid. 0-100 when provided, matching the server. */
export function bufferPercentError(raw: string): string | null {
  if (raw.trim() === "") return null;
  const value = parsePlanNumber(raw);
  if (value === null) return "Enter a valid number.";
  if (value < 0 || value > 100) return "Enter a percentage between 0 and 100.";
  return null;
}

/** Optional — empty is valid. Must be a positive amount when provided, matching the server's `z.number().positive()`. */
export function ownerTargetAmountError(raw: string): string | null {
  if (raw.trim() === "") return null;
  const value = parsePlanNumber(raw);
  if (value === null) return "Enter a valid number.";
  if (value <= 0) return "Enter an amount greater than zero.";
  return null;
}
