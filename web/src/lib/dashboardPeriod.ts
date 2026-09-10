/**
 * What window the Dashboard's figures cover, and how that window is named.
 *
 * The server decides the arithmetic: `/dashboard/summary` takes `periodDays`
 * and returns a ROLLING lookback ending today — `startDate = today - (n - 1)`,
 * inclusive of today (see `getDashboardSummary` in dashboard.service.ts).
 * `periodDays: 0` is the sentinel for "all time", where the date filter is
 * dropped entirely rather than widened.
 *
 * That is worth naming carefully, because the labels used to lie about it.
 * A 30-day rolling window was captioned "This month", so on 20 August the
 * cards showed 22 July - 20 August under a heading an owner reads as "August".
 * Reconciling those figures against their own August books cannot work, and
 * nothing on screen explains why. The window is the intended behaviour and it
 * is the server's; only the caption was wrong, so the caption is what changed.
 *
 * Deliberately word-for-word with `mobile/src/lib/dashboardPeriod.ts`: the two
 * clients read the same endpoint, and an owner who checks their phone and their
 * laptop should not be told the two are showing different periods.
 *
 * Nothing here computes a financial figure — it picks a window and phrases it.
 */

/** `periodDays: 0` — the server drops the date filter rather than widening it. */
export const ALL_TIME_PERIOD_DAYS = 0;

/** The Dashboard's default window: the last 30 days, ending today. */
export const DEFAULT_SUMMARY_PERIOD_DAYS = 30;

/**
 * The windows the Dashboard offers, in the order they sit in the segmented
 * control.
 *
 * Labelled by their length rather than by a calendar name for the reason above.
 * "All time" exists because CSV import invites owners to bring in years of
 * history: without it, a business whose records all predate the last 30 days
 * has no setting on this page that can see a single one of them — which is
 * exactly what happened to a 21,097-row import of 2023-2025 data.
 */
export const PERIOD_OPTIONS = [
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: DEFAULT_SUMMARY_PERIOD_DAYS },
  { label: "All time", days: ALL_TIME_PERIOD_DAYS },
] as const;

/** The window as a heading or a card sublabel — "Last 30 days". */
export function periodLabel(days: number): string {
  if (days === ALL_TIME_PERIOD_DAYS) return "Across all records";
  if (days === 1) return "Today";
  return `Last ${days} days`;
}

/**
 * The same window mid-sentence — "No records for the last 30 days".
 *
 * A separate form because the caption reads as a title ("Last 30 days") and
 * the callout reads as a sentence; lowercasing the title, which is how this
 * was done, produced "No records in last 30 days".
 */
export function periodPhrase(days: number): string {
  if (days === ALL_TIME_PERIOD_DAYS) return "all time";
  if (days === 1) return "today";
  return `the last ${days} days`;
}
