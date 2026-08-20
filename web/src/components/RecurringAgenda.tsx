import { Link } from "react-router-dom";
import { EmptyState } from "./EmptyState";
import { ButtonLink } from "./Button";
import { Money } from "./Money";
import { Panel, Pill } from "./ui";
import type { RecurringDueState, RecurringSchedule } from "../lib/types";

/**
 * The recurring agenda — "what am I forgetting?".
 *
 * These are the payments the OWNER declared, not the ones the detector merely
 * suspects. Before this existed, confirming a recurring payment made it
 * disappear from every screen in the app: FinSight was watching a PHP 9,500
 * salary run that had gone eighty days silent and had nowhere to say so.
 *
 * Grouped Overdue → Due soon → Scheduled, in the same
 * `<section aria-label>` + uppercase `<h2>` + `<ul>` shape the notification
 * archive uses, because it is the same question in a different tense: what
 * needs me now, what needs me shortly, what can wait.
 */

/**
 * Which section a schedule sits in — mirrors `agendaGroupOf` in
 * mobile/src/lib/recurringAgenda.ts, and must keep mirroring it.
 */
export type AgendaGroupKey = RecurringDueState | "PAUSED";

/**
 * The reading order: what is already late, then what is about to be, then the
 * rest, then the ones nobody is watching.
 *
 * `dueState` arrives computed from the server precisely so web and mobile
 * cannot disagree about where a boundary sits — nothing here re-derives it
 * from `nextDueDate`.
 *
 * PAUSED IS ITS OWN GROUP rather than a badge inside the due groups. The server
 * computes `dueState` from the date for paused rows too, so left in place a
 * paused rent would be listed under "Overdue" in alarm colours while FinSight
 * is deliberately not watching it — telling an owner they forgot something they
 * explicitly switched off, which is the same false-alarm class this whole
 * feature exists to remove. It also matches the order the server already sorts
 * in (`isActive` desc), so the two agree about what the bottom of the list is
 * for.
 */
const AGENDA_GROUPS: { key: AgendaGroupKey; label: string; caption: string }[] = [
  { key: "OVERDUE", label: "Overdue", caption: "Due before today, with nothing recorded against it yet." },
  { key: "DUE_SOON", label: "Due soon", caption: "Coming up in the next few days." },
  { key: "SCHEDULED", label: "Scheduled", caption: "Further out — nothing to do yet." },
  { key: "PAUSED", label: "Paused", caption: "Kept on file, but FinSight is not watching these." },
];

export interface ScheduleGroup {
  key: AgendaGroupKey;
  label: string;
  caption: string;
  items: RecurringSchedule[];
}

/**
 * Which section a schedule belongs in. Paused wins over its due state.
 *
 * `isActive` is an explicit owner flag, not a second opinion about the dates —
 * `dueState` itself is still taken exactly as the server sent it.
 */
export function agendaGroupOf(schedule: RecurringSchedule): AgendaGroupKey {
  return schedule.isActive ? schedule.dueState : "PAUSED";
}

/**
 * Buckets schedules into the agenda's sections, dropping empty ones — a heading
 * over nothing reads as a list that failed to load.
 *
 * Input order is preserved inside each group: the API already sorts paused
 * last then soonest-due first, and re-sorting here would only give the two
 * clients a second chance to disagree.
 */
export function groupSchedulesByDueState(schedules: RecurringSchedule[]): ScheduleGroup[] {
  return AGENDA_GROUPS.map((group) => ({
    ...group,
    items: schedules.filter((schedule) => agendaGroupOf(schedule) === group.key),
  })).filter((group) => group.items.length > 0);
}

/**
 * What the panel's badge counts: schedules that need a DECISION — pay it,
 * record it, or change the schedule.
 *
 * Paused rows are excluded for the same reason they sort last. Nothing is
 * expected of a schedule the owner has switched off, however late it looks.
 * Mirrors `overdueScheduleCount` in mobile/src/lib/recurringAgenda.ts.
 */
export function overdueScheduleCount(schedules: RecurringSchedule[]): number {
  return schedules.filter((schedule) => schedule.isActive && schedule.dueState === "OVERDUE").length;
}

/**
 * `nextDueDate` is a date-only column, stored at midnight UTC. Formatted in
 * local time it shows the PREVIOUS day everywhere west of UTC — the same
 * convention Dashboard.tsx spells out for every other date on the site.
 */
export function formatDueDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function ScheduleRow({ schedule }: { schedule: RecurringSchedule }) {
  const meta = [
    schedule.categoryName ?? "—",
    `every ${schedule.intervalDays} days`,
    schedule.vendor,
  ].filter(Boolean);

  return (
    <li
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-xl border border-paper-200 bg-paper-100/60 px-3.5 py-3 ${
        // Paused is a state, not an absence — the row stays legible, it just
        // stops competing with the ones still being watched. No "Paused" badge
        // here: a paused row only ever appears under the Paused heading, and
        // repeating it on every row would be saying the same thing twice.
        schedule.isActive ? "" : "opacity-70"
      }`}
    >
      <div className="min-w-0">
        <p className="min-w-0 text-sm font-semibold text-ink-900">{schedule.label}</p>
        <p className="mt-1 text-xs text-ink-500">
          Due {formatDueDate(schedule.nextDueDate)} · {meta.join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Money value={schedule.expectedAmount} decimals className="text-sm font-semibold text-ink-900" />
        <Link
          to={`/insights/recurring-schedules/${schedule.id}/edit`}
          className="tap-inline rounded-lg px-2 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand"
        >
          Edit
          <span className="sr-only"> {schedule.label}</span>
        </Link>
      </div>
    </li>
  );
}

export function RecurringAgenda({ schedules }: { schedules: RecurringSchedule[] }) {
  const groups = groupSchedulesByDueState(schedules);
  const overdue = overdueScheduleCount(schedules);

  return (
    <Panel
      eyebrow="Recurring expenses"
      title="Payments you asked FinSight to watch"
      action={
        <div className="flex items-center gap-2">
          {overdue > 0 ? (
            <Pill tone="danger">
              {overdue} overdue
            </Pill>
          ) : null}
          <ButtonLink to="/insights/recurring-schedules/new" variant="secondary" size="sm">
            Add a schedule
          </ButtonLink>
        </div>
      }
    >
      {groups.length === 0 ? (
        // `icon`, not a mascot: docs/mascot-scenario-library.md maps this state
        // but 04-empty-states/ ships no art on either client yet, and pointing
        // at a path that does not exist renders a broken image in production.
        <EmptyState
          compact
          title="Nothing scheduled yet"
          icon="↻"
          action={
            <ButtonLink to="/insights/recurring-schedules/new" variant="primary">
              Add a recurring payment
            </ButtonLink>
          }
        >
          Tell FinSight about a payment that repeats — rent, a salary run, an internet bill — and it
          will say so when one is late or comes in at an amount you did not expect.
        </EmptyState>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">
                {group.label}
                <span className="figure font-semibold normal-case tracking-normal">
                  {group.items.length}
                </span>
              </h3>
              {/* One line saying what the group MEANS — the same captions
                  mobile's agenda carries. "Paused" in particular has to say
                  that FinSight is not watching these, or a row sitting quietly
                  at the bottom of the list reads as an oversight. */}
              <p className="mb-2 mt-0.5 text-xs text-ink-400">{group.caption}</p>
              <ul className="space-y-2">
                {group.items.map((schedule) => (
                  <ScheduleRow key={schedule.id} schedule={schedule} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
