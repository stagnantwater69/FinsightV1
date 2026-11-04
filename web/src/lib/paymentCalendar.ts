import type {
  OperatingDayOverride,
  OperatingScheduleEntry,
  RecurringPattern,
  RecurringSchedule,
} from "./types";

/*
 * The payment calendar's date logic, kept free of React so it can be tested
 * on its own.
 *
 * Every date here is a "YYYY-MM-DD" key. Due dates are date-only columns
 * stored at midnight UTC, so they are read and stepped in UTC — formatting
 * them in local time would show the previous day west of UTC.
 *
 * The server computes exactly one date per schedule: the next one. Every
 * later occurrence on this calendar is a projection (next date + n ×
 * interval) and is labelled "expected" — a late payment or an edited
 * schedule moves it. No amounts are summed here; totals stay server-side.
 */

export type CalendarEntryKind =
  /** The server's next due date for a watched payment. */
  | "due"
  /** A watched payment's later dates, projected from its interval. */
  | "expected"
  /** A detector suggestion the owner has not answered yet. */
  | "suggested";

export interface CalendarEntry {
  key: string;
  date: string;
  kind: CalendarEntryKind;
  label: string;
  amount: number;
  categoryName: string | null;
  intervalDays: number;
  /** Set on a watched payment's server date when it is already late. */
  overdue: boolean;
  scheduleId?: number;
  patternId?: number;
}

const DAY_MS = 86_400_000;

export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function keyToUtc(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}

export function addDays(key: string, days: number): string {
  return dateKey(new Date(keyToUtc(key) + days * DAY_MS));
}

/** "2026-11" → the first and last day keys of that month. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = `${month}-01`;
  const last = dateKey(new Date(Date.UTC(y, m, 0)));
  return { first, last };
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return dateKey(d).slice(0, 7);
}

/**
 * The grid's days: whole Monday-to-Sunday weeks covering the month, so
 * weekday columns line up with the operating schedule's 1 = Monday.
 */
export function monthGrid(month: string): string[] {
  const { first, last } = monthBounds(month);
  const lead = isoWeekday(first) - 1;
  const trail = 7 - isoWeekday(last);
  const days: string[] = [];
  for (let key = addDays(first, -lead); key <= addDays(last, trail); key = addDays(key, 1)) {
    days.push(key);
  }
  return days;
}

/** 1 = Monday … 7 = Sunday, the backend's `BusinessOperatingDay` convention. */
export function isoWeekday(key: string): number {
  const day = new Date(keyToUtc(key)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Every date from `start`, stepping `intervalDays`, that falls in
 * [from, to]. Never steps backwards: `start` is the earliest date claimed.
 */
export function occurrencesInRange(
  start: string,
  intervalDays: number,
  from: string,
  to: string,
): string[] {
  if (!Number.isFinite(intervalDays) || intervalDays < 1) {
    return start >= from && start <= to ? [start] : [];
  }
  const dates: string[] = [];
  let key = start;
  if (key < from) {
    const behind = Math.ceil((keyToUtc(from) - keyToUtc(key)) / DAY_MS / intervalDays);
    key = addDays(key, behind * intervalDays);
  }
  for (; key <= to; key = addDays(key, intervalDays)) dates.push(key);
  return dates;
}

/**
 * Watched payments and open suggestions placed on the days of [from, to].
 *
 * Paused schedules are left off: FinSight is deliberately not watching them,
 * and a date on the calendar would read as a payment that is coming.
 * Suggestions that already became a schedule are left off too, so the same
 * payment never appears twice.
 */
export function calendarEntries(
  schedules: RecurringSchedule[],
  patterns: RecurringPattern[],
  from: string,
  to: string,
): Map<string, CalendarEntry[]> {
  const byDate = new Map<string, CalendarEntry[]>();
  const push = (entry: CalendarEntry) => {
    const list = byDate.get(entry.date);
    if (list) list.push(entry);
    else byDate.set(entry.date, [entry]);
  };

  const watchedPatternIds = new Set(
    schedules.map((schedule) => schedule.sourcePatternId).filter((id): id is number => id !== null),
  );

  for (const schedule of schedules) {
    if (!schedule.isActive) continue;
    const next = schedule.nextDueDate.slice(0, 10);
    for (const date of occurrencesInRange(next, schedule.intervalDays, from, to)) {
      push({
        key: `schedule-${schedule.id}-${date}`,
        date,
        kind: date === next ? "due" : "expected",
        label: schedule.label,
        amount: schedule.expectedAmount,
        categoryName: schedule.categoryName,
        intervalDays: schedule.intervalDays,
        overdue: date === next && schedule.dueState === "OVERDUE",
        scheduleId: schedule.id,
      });
    }
  }

  for (const pattern of patterns) {
    if (pattern.status !== "CANDIDATE" || watchedPatternIds.has(pattern.id)) continue;
    const next = pattern.nextExpectedDate.slice(0, 10);
    for (const date of occurrencesInRange(next, pattern.intervalDays, from, to)) {
      push({
        key: `pattern-${pattern.id}-${date}`,
        date,
        kind: "suggested",
        label: pattern.description,
        amount: pattern.expectedAmount,
        categoryName: pattern.category.name,
        intervalDays: pattern.intervalDays,
        overdue: false,
        patternId: pattern.id,
      });
    }
  }

  const order: Record<CalendarEntryKind, number> = { due: 0, expected: 1, suggested: 2 };
  for (const list of byDate.values()) {
    list.sort((a, b) => Number(b.overdue) - Number(a.overdue) || order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  }
  return byDate;
}

/**
 * Whether the business is closed on a day: a date exception wins over the
 * weekly schedule. An empty schedule means "never configured", which the
 * rest of the app treats as open every day.
 */
export function isClosedDay(
  key: string,
  weekly: OperatingScheduleEntry[],
  overrides: OperatingDayOverride[],
): boolean {
  const override = overrides.find((o) => o.date.slice(0, 10) === key);
  if (override) return override.type === "CLOSED";
  if (weekly.length !== 7) return false;
  return weekly.find((entry) => entry.weekday === isoWeekday(key))?.isOpen === false;
}
