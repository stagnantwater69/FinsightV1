/**
 * Client-side helpers for the month-end review month picker — Recovery
 * Target Improvement Plan §10.9/§11 Phase 7.
 *
 * Purely presentational/navigational: which "YYYY-MM" the picker is
 * currently pointed at, and how it reads to a person. Whether that month is
 * actually reviewable yet is a business-local, server-side decision (see
 * `computeMonthEndReview`) — this file never guesses at that.
 */

/** "YYYY-MM" for the calendar month before the one containing `date`, in the device's local time. The most likely month an owner wants to review, so screens default the picker here. */
export function lastMonthKey(date: Date = new Date()): string {
  return shiftMonthKey(monthKeyOf(date), -1);
}

/** "YYYY-MM" for the calendar month containing `date`, in the device's local time. */
export function monthKeyOf(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** Moves a "YYYY-MM" key forward or backward by `delta` whole months. */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** "YYYY-MM" -> "July 2026", for display. */
export function formatMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return monthKey;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
}
