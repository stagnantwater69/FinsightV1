/**
 * Client-side validation for the Recovery Target notification preferences
 * screen — Recovery Target Improvement Plan §7.5/§10.8/§11 Phase 6.
 *
 * Mirrors the server's own zod schema exactly
 * (backend/src/controllers/recoveryNotificationPreference.controller.ts):
 * threshold percent 1-100, cooldown hours 1-168, quiet hours as 24-hour
 * "HH:MM" strings that must be set together or not at all. The server remains
 * the final authority — a value that clears this check can still come back
 * with a 400.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Same integer-or-decimal shape recoveryScenarioForm/reductionSimulationForm use, without a leading minus — every field here is a positive count. */
const NUMBER_SHAPE = /^\d*(\.\d*)?$/;

export function parsePreferenceNumber(raw: string): number | null {
  const cleaned = raw.trim();
  if (cleaned === "") return null;
  if (!NUMBER_SHAPE.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** 1-100, matching `targetIncreaseThresholdPercent` on the server. */
export function thresholdPercentError(raw: string): string | null {
  const value = parsePreferenceNumber(raw);
  if (value === null) return "Enter a percentage.";
  if (value < 1 || value > 100) return "Enter a percentage between 1 and 100.";
  return null;
}

/** 1-168 (one week), matching `minHoursBetweenNotifications` on the server. */
export function minHoursBetweenNotificationsError(raw: string): string | null {
  const value = parsePreferenceNumber(raw);
  if (value === null) return "Enter a number of hours.";
  if (!Number.isInteger(value) || value < 1 || value > 168) {
    return "Enter a whole number of hours between 1 and 168.";
  }
  return null;
}

/** A single quiet-hours time field, empty or "HH:MM" — the both-or-neither rule is checked separately, across both fields. */
export function quietHourTimeError(raw: string): string | null {
  if (raw.trim() === "") return null;
  if (!TIME_RE.test(raw.trim())) return "Enter a time as HH:MM, e.g. 21:00.";
  return null;
}

/** Both set or both empty — re-checked here, and again by the server against the merged record. */
export function quietHoursBothOrNeitherError(start: string, end: string): string | null {
  const startSet = start.trim() !== "";
  const endSet = end.trim() !== "";
  if (startSet !== endSet) {
    return "Set both a start and an end time for quiet hours, or leave both blank.";
  }
  return null;
}
