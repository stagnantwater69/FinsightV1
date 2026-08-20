import type { RecurringSchedule } from "./types";

/**
 * How the recurring agenda is arranged, and how its dates are written.
 *
 * A SEPARATE MODULE FROM THE SCREEN because this is the only part of the
 * agenda that can be tested at all: mobile has no render harness, so anything
 * left inline in InsightsScreens.tsx is verified by reading it and nothing
 * else. Grouping and date rendering are pure functions of the payload, so they
 * come out here where a test can hold them to their rules.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: work out whether a payment is overdue.
 * `dueState` is computed server-side (recurringSchedule.service.ts) precisely
 * so the two clients cannot disagree about the boundary, and recomputing it
 * here from `nextDueDate` would reintroduce exactly the drift that decision
 * prevents. This module only ARRANGES what the server already decided.
 */

export type AgendaGroupKey = "OVERDUE" | "DUE_SOON" | "SCHEDULED" | "PAUSED";

export interface AgendaGroup {
  key: AgendaGroupKey;
  /** The section heading. */
  title: string;
  /** One line under it, saying what the group means. */
  caption: string;
  items: RecurringSchedule[];
}

/**
 * Reading order: what is already late, then what is about to be, then the rest,
 * then the ones nobody is watching.
 *
 * PAUSED IS ITS OWN GROUP rather than a badge inside the due groups. A paused
 * schedule still carries a `dueState` — the server computes it from the date
 * regardless — so left in place a paused rent would be listed under "Overdue"
 * in alarm colours while FinSight is deliberately not watching it, which is
 * the same class of false alarm as the empty state this screen used to show.
 * It also matches the order the server already sorts in (`isActive` desc), so
 * the two agree about what the bottom of the list is for.
 */
const GROUPS: { key: AgendaGroupKey; title: string; caption: string }[] = [
  {
    key: "OVERDUE",
    title: "Overdue",
    caption: "Due before today, with nothing recorded against it yet.",
  },
  {
    key: "DUE_SOON",
    title: "Due soon",
    caption: "Coming up in the next few days.",
  },
  {
    key: "SCHEDULED",
    title: "Scheduled",
    caption: "Further out — nothing to do yet.",
  },
  {
    key: "PAUSED",
    title: "Paused",
    caption: "Kept on file, but FinSight is not watching these.",
  },
];

/** Which section a schedule belongs in. Paused wins over its due state. */
export function agendaGroupOf(schedule: RecurringSchedule): AgendaGroupKey {
  return schedule.isActive ? schedule.dueState : "PAUSED";
}

/**
 * The agenda, in sections. Empty sections are dropped — a heading over nothing
 * reads as a list that failed to load.
 *
 * Order WITHIN a section is the order the server sent, which is soonest-due
 * first. Re-sorting here would be a second opinion about the same thing.
 */
export function groupSchedules(schedules: readonly RecurringSchedule[]): AgendaGroup[] {
  return GROUPS.map((group) => ({
    ...group,
    items: schedules.filter((schedule) => agendaGroupOf(schedule) === group.key),
  })).filter((group) => group.items.length > 0);
}

/**
 * What the section badge counts.
 *
 * OVERDUE SCHEDULES, NOT CANDIDATES. The badges on this screen count things
 * that need a DECISION. A payment that was due and has not been recorded is a
 * decision — pay it, record it, or change the schedule. A candidate is
 * FinSight offering to watch something, which can wait indefinitely without
 * costing the owner anything.
 *
 * Paused schedules are excluded for the same reason they sort last: nothing is
 * expected of a schedule the owner has switched off.
 */
export function overdueScheduleCount(schedules: readonly RecurringSchedule[]): number {
  return schedules.filter((schedule) => schedule.isActive && schedule.dueState === "OVERDUE").length;
}

/**
 * What the Recurring section may show, given how the schedules read went.
 *
 * NULL IS NOT THE EMPTY LIST, and this is the whole point of the function.
 * `GET /insights/recurring-schedules` sits behind the server's
 * ANOMALY_RECURRING_ENABLED flag, which is off by default and answers 404 while
 * it is — so the ordinary path for this fetch today is failure. Handing the
 * screen an empty array in that case makes it draw "No repeating payments yet",
 * which is a claim about the OWNER'S BUSINESS made on the strength of a request
 * the server refused to answer. It is flatly false for anyone whose schedules
 * exist and were simply not handed over. Null means "hide the agenda", and
 * hidden is the honest rendering of a feature that is not on.
 *
 * THE TEST IS ON `error`, NOT ON THE STATUS CODE. A 500 or a dead connection
 * leaves us knowing exactly as much about the owner's schedules as a 404 does —
 * nothing — so nothing here asks WHY the read failed. Status-sniffing for 404
 * would leave the identical lie in place for every other failure mode. Mirrors
 * web's `loadPanel`, which settles each supplementary panel on the same rule
 * (web/src/pages/ExpenseInsight.tsx).
 *
 * IT ALSO DROPS ANYTHING ALREADY LOADED. `useInsight` keeps the previous
 * payload on a failed refetch, which is right for a screen's main read and
 * wrong here: the flag being switched off mid-session would otherwise leave an
 * agenda on screen that the server no longer stands behind, with rows that
 * 404 the moment one is opened.
 */
export interface RecurringAvailability {
  /** The agenda to draw, or null to draw no agenda at all. */
  schedules: RecurringSchedule[] | null;
  /**
   * Whether a candidate may be confirmed.
   *
   * `POST /insights/recurring-patterns/:id/confirm` is behind the SAME server
   * gate as the schedules read — confirming creates a schedule — so when the
   * agenda is unavailable that button can only 404. The candidates list itself
   * is ungated detector output and stays, as does "Not recurring"
   * (`PATCH /insights/recurring-patterns/:id`, also ungated).
   */
  canConfirm: boolean;
  /**
   * What the section badge counts. Zero while unavailable, so no badge is
   * drawn — a count carried over from a read that failed is a number the owner
   * would act on and we cannot support.
   */
  overdueCount: number;
}

export function recurringAvailability(fetch: {
  data: readonly RecurringSchedule[] | null;
  error: string | null;
}): RecurringAvailability {
  if (fetch.error !== null) return { schedules: null, canConfirm: false, overdueCount: 0 };
  const schedules = [...(fetch.data ?? [])];
  return { schedules, canConfirm: true, overdueCount: overdueScheduleCount(schedules) };
}

/**
 * The longest gap the server will accept between two payments.
 *
 * MUST MATCH `intervalDays: z.number().int().positive().max(366)` in
 * backend/src/controllers/insights.controller.ts, on both the create and the
 * update schema. web/src/pages/RecurringScheduleForm.tsx carries the same
 * figure as `max={366}` on its number input.
 */
export const MAX_INTERVAL_DAYS = 366;

/**
 * Why the entered interval cannot be used, or null if it can.
 *
 * OUT HERE RATHER THAN INLINE IN THE SCREEN for the reason given at the top of
 * this file — a rule left in RecurringScheduleScreen.tsx is verified by reading
 * it and nothing else.
 *
 * THE CEILING IS CHECKED CLIENT-SIDE not as a security control — the server
 * enforces it regardless — but because the server's refusal is a generic
 * `{ error: "Validation failed" }`, and errorMessage() surfaces that string
 * alone. An owner who typed 400 would be told only that something was wrong,
 * with no hint of which box or what the limit is.
 */
export function intervalDaysError(intervalDays: number): string | null {
  if (!Number.isInteger(intervalDays) || intervalDays <= 0) {
    return "How many days between payments? Enter a whole number of days.";
  }
  if (intervalDays > MAX_INTERVAL_DAYS) {
    return `FinSight watches payments that repeat at least once a year — enter ${MAX_INTERVAL_DAYS} days or fewer.`;
  }
  return null;
}

/**
 * A date-only value, written for a person.
 *
 * `timeZone: "UTC"` is not optional. `nextDueDate` is a `@db.Date` and arrives
 * as midnight UTC, so rendering it in Manila time (UTC+8) is fine and
 * rendering it anywhere behind UTC silently shows the previous day — the exact
 * off-by-one DateField's own header warns about, from the other direction.
 */
export function formatDueDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The same value as the "YYYY-MM-DD" string every form field and API body in
 * this app uses.
 *
 * Sliced from the ISO text rather than read off a `Date`, because
 * `date.getDate()` would apply the device's offset to a value that has none —
 * which is how a due date edited on a phone behind UTC would save itself one
 * day earlier every time the form was opened and saved.
 */
export function dueDateISO(value: string): string {
  return value.slice(0, 10);
}
