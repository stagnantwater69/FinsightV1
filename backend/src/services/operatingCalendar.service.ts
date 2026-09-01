// Exact operating-calendar resolution — RECOVERY-TARGET-IMPROVEMENT-PLAN.md
// §7.2/§7.3/§9.2, Phase 2.
//
// Read-only. This module never writes BusinessOperatingDay or
// BusinessOperatingDayOverride rows — schedule/override CRUD is a separate
// backend-api surface. It only turns whatever rows already exist into a
// per-date open/closed calendar for `analysis.service.ts`/`insights.service.ts`
// to consume.
//
// A business profile with zero BusinessOperatingDay rows has no schedule
// configured yet — every caller here must fall back to the existing
// operatingDays-count approximation for that profile, unchanged. That is the
// majority of existing profiles today.

import { prisma } from "../config/prisma";
import { utcAddDays, utcDateKey, utcDaysInMonth, utcIsoWeekday, utcStartOfMonth } from "../lib/dates";

/**
 * Resolves open/closed state for every calendar date in `[rangeStart, rangeEnd]`
 * (inclusive, both UTC-midnight-encoded date-only boundaries).
 *
 * Returns `null` when the profile has NO `BusinessOperatingDay` rows at all —
 * "no schedule configured yet" — so callers know to fall back to
 * approximation mode rather than reading absence-of-weekday-row as "closed."
 *
 * Precedence per §9.2: a date override, when present, always wins over the
 * weekly schedule. A weekday with no row in the (non-empty) weekly schedule
 * is treated as closed defensively — this should not happen once schedule
 * setup is complete (the CRUD layer is responsible for keeping all seven
 * weekdays present), but resolving it as "closed" rather than crashing or
 * assuming "open" is the safe default here.
 *
 * Both the schedule and the overrides are loaded with exactly one bounded
 * query each — never per-day — per plan §15.1.
 */
export async function resolveOperatingCalendar(
  businessProfileId: number,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, boolean> | null> {
  const scheduleRows = await prisma.businessOperatingDay.findMany({
    where: { businessProfileId },
    select: { weekday: true, isOpen: true },
  });
  if (scheduleRows.length === 0) return null;

  const scheduleByWeekday = new Map<number, boolean>();
  for (const row of scheduleRows) scheduleByWeekday.set(row.weekday, row.isOpen);

  const overrideRows = await prisma.businessOperatingDayOverride.findMany({
    where: { businessProfileId, date: { gte: rangeStart, lte: rangeEnd } },
    select: { date: true, type: true },
  });
  const overrideByDateKey = new Map<string, boolean>();
  for (const row of overrideRows) {
    overrideByDateKey.set(utcDateKey(row.date), row.type === "OPEN");
  }

  const calendar = new Map<string, boolean>();
  for (let d = new Date(rangeStart); d <= rangeEnd; d = utcAddDays(d, 1)) {
    const key = utcDateKey(d);
    const override = overrideByDateKey.get(key);
    if (override !== undefined) {
      calendar.set(key, override);
      continue;
    }
    // Defensive default: a weekday absent from a *configured* (non-empty)
    // schedule is closed, never open — see doc comment above.
    calendar.set(key, scheduleByWeekday.get(utcIsoWeekday(d)) ?? false);
  }
  return calendar;
}

/** Exact operating-day counts for the calendar month `today` falls in. */
export interface ExactOperatingCounts {
  /** Every open date in the month, regardless of `today`'s position in it. */
  operatingDaysThisMonth: number;
  /**
   * Open dates from the 1st of the month through `today`, inclusive of
   * today (plan §9.3/§9.4: today's full daily target already counts toward
   * "expected sales to date").
   */
  elapsedOperatingDays: number;
  /**
   * Open dates from `today` through the end of the month, inclusive of
   * today (matching the existing approximation's convention that today can
   * still receive sales and so counts as remaining).
   *
   * NOTE: today is intentionally counted in BOTH `elapsedOperatingDays` and
   * `remainingOperatingDays` — they answer different questions ("pace so
   * far including today's target" vs. "days left to hit the rest of the
   * target, including today") and are not expected to sum to
   * `operatingDaysThisMonth`.
   */
  remainingOperatingDays: number;
  /** The full month's resolved calendar, keyed by YYYY-MM-DD, for callers that also need per-day open/closed state (e.g. daily coverage tables). */
  calendar: Map<string, boolean>;
}

/**
 * Pure open/elapsed/remaining-day counts for an already-resolved calendar
 * map, as of an arbitrary `asOfDateKey` (not necessarily "now"). Factored out
 * of `resolveExactOperatingCounts` so a caller that already has this month's
 * calendar loaded (`getRecoveryInsight`, for the plan §8.2/§10.3 "yesterday"
 * re-run) can re-derive counts for a different day in the SAME month
 * without a second schedule/override query — see plan §15.1's "avoid a
 * second identical schedule/override query" and the "Why your target
 * changed" comment in insights.service.ts.
 */
export function deriveOperatingCounts(
  calendar: Map<string, boolean>,
  asOfDateKey: string,
): Omit<ExactOperatingCounts, "calendar"> {
  let operatingDaysThisMonth = 0;
  let elapsedOperatingDays = 0;
  let remainingOperatingDays = 0;
  for (const [key, isOpen] of calendar) {
    if (!isOpen) continue;
    operatingDaysThisMonth++;
    if (key <= asOfDateKey) elapsedOperatingDays++;
    if (key >= asOfDateKey) remainingOperatingDays++;
  }
  return { operatingDaysThisMonth, elapsedOperatingDays, remainingOperatingDays };
}

/**
 * Convenience wrapper around `resolveOperatingCalendar` that derives the
 * exact monthly/elapsed/remaining open-day counts `computeRecoveryTarget`
 * needs for exact mode (plan §9.2). Returns `null` when no schedule is
 * configured for this profile — see `resolveOperatingCalendar`.
 */
export async function resolveExactOperatingCounts(
  businessProfileId: number,
  today: Date,
): Promise<ExactOperatingCounts | null> {
  const monthStart = utcStartOfMonth(today);
  const monthEnd = utcAddDays(monthStart, utcDaysInMonth(today) - 1);

  const calendar = await resolveOperatingCalendar(businessProfileId, monthStart, monthEnd);
  if (!calendar) return null;

  return { ...deriveOperatingCounts(calendar, utcDateKey(today)), calendar };
}
