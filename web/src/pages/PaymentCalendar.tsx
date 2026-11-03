import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isAxiosError } from "axios";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { api } from "../lib/api";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { getErrorMessage } from "../lib/errors";
import {
  addDays,
  calendarEntries,
  isClosedDay,
  localTodayKey,
  monthBounds,
  monthGrid,
  shiftMonth,
  type CalendarEntry,
} from "../lib/paymentCalendar";
import type {
  OperatingDayOverride,
  OperatingDayOverridePage,
  OperatingScheduleEntry,
  RecurringPattern,
  RecurringSchedule,
} from "../lib/types";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { AddExpenseModal, type DuplicateExpenseSeed } from "../components/AddExpenseModal";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { ScheduleFormModal } from "./RecurringScheduleForm";
import { EmptyState } from "../components/EmptyState";
import { SkeletonPanel } from "../components/Skeleton";
import { Callout, Card, Pill } from "../components/ui";
import { formatMoney } from "../components/Money";
import {
  dismissRecurringPattern,
  recurringPatternsRequest,
  recurringSchedulesRequest,
  watchRecurringPattern,
} from "./expenseInsight/reviewRequests";

/**
 * Payment calendar — a web-first trial.
 *
 * Shows, by date, the payments the owner asked FinSight to watch and the ones
 * the detector suggests, plus the days the business is closed. The detector
 * proposes; the owner double-checks with "Watch this" or "Not recurring",
 * right on the day — the same two answers the Expense insight panel offers.
 *
 * Nothing new is stored: every read already exists. Later dates of a watched
 * payment are projections and are labelled "Expected". No totals are summed
 * here; money arithmetic stays on the server.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** How many entries a day cell lists before "+N more". */
const CELL_ENTRY_LIMIT = 2;
/**
 * Waits between refetches after a payment is recorded. The last step only
 * marks the wait as slow; it does not fetch.
 */
const SETTLE_POLL_MS = [2_500, 5_000, 10_000, 3_000];

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const KIND_LOOK: Record<CalendarEntry["kind"], { chip: string; pill: "ok" | "neutral" | "info"; label: string }> = {
  due: { chip: "bg-tint-brand text-tone-brand ring-1 ring-edge-brand", pill: "ok", label: "Due" },
  expected: { chip: "bg-paper text-ink-700 ring-1 ring-paper-200", pill: "neutral", label: "Expected" },
  suggested: {
    chip: "border border-dashed border-edge-info bg-paper text-tone-info",
    pill: "info",
    label: "Suggested by FinSight",
  },
};
const OVERDUE_CHIP = "bg-tint-danger text-tone-danger ring-1 ring-edge-danger";

export function PaymentCalendarPage() {
  const { selected } = useBusinessProfiles();
  const today = localTodayKey();
  const [month, setMonth] = useState(today.slice(0, 7));
  /** The day open in the day popup, if any. */
  const [openDay, setOpenDay] = useState<string | null>(null);

  const [schedules, setSchedules] = useState<RecurringSchedule[] | null>(null);
  const [schedulesAvailable, setSchedulesAvailable] = useState(true);
  const [patterns, setPatterns] = useState<RecurringPattern[]>([]);
  const [weekly, setWeekly] = useState<OperatingScheduleEntry[]>([]);
  const [overrides, setOverrides] = useState<OperatingDayOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The schedule open in the edit popup; null with `formOpen` is "add". */
  const [editing, setEditing] = useState<RecurringSchedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  /**
   * The payment open in the record-payment popup: the fields it starts with,
   * the day to return to, and the schedule it pays, if it is a watched one.
   */
  const [recording, setRecording] = useState<{
    seed: DuplicateExpenseSeed;
    day: string;
    schedule?: RecurringSchedule;
  } | null>(null);
  const { categories } = useExpenseCategories();
  /**
   * Schedules with a payment just recorded, keyed by id, holding the due date
   * they had at the time. The analysis job matches the expense in the
   * background, so the due date moves a little later; until it does the entry
   * says so instead of still looking unpaid.
   */
  const [settling, setSettling] = useState<Record<number, { due: string; slow: boolean }>>({});
  const requestId = useRef(0);
  const toast = useToast();
  const confirm = useConfirm();

  const days = useMemo(() => monthGrid(month), [month]);
  const gridFrom = days[0]!;
  const gridTo = days[days.length - 1]!;

  async function loadRecurring(force = false) {
    if (!selected) return;
    const thisRequestId = ++requestId.current;
    const current = () => thisRequestId === requestId.current;
    const schedulesRequest = recurringSchedulesRequest(selected.id);
    const patternsRequest = recurringPatternsRequest(selected.id);
    const cachedSchedules = peekCachedApiData<RecurringSchedule[]>(
      schedulesRequest.url,
      { params: schedulesRequest.params },
      schedulesRequest.scope,
    );
    const cachedPatterns = peekCachedApiData<RecurringPattern[]>(
      patternsRequest.url,
      { params: patternsRequest.params },
      patternsRequest.scope,
    );
    if (cachedSchedules) setSchedules(cachedSchedules.data);
    if (cachedPatterns) setPatterns(cachedPatterns.data);
    setLoading(!cachedSchedules && !cachedPatterns);
    setLoadError(null);

    const failures: string[] = [];
    await Promise.all([
      cachedApiGet<RecurringSchedule[]>(
        schedulesRequest.url,
        { params: schedulesRequest.params },
        schedulesRequest.scope,
        { force },
      ).then(
        ({ data }) => {
          if (!current()) return;
          setSchedules(data);
          setSchedulesAvailable(true);
        },
        (err: unknown) => {
          if (!current()) return;
          // 404 is the server saying schedules are switched off, not a failure.
          if (isAxiosError(err) && err.response?.status === 404) {
            setSchedules([]);
            setSchedulesAvailable(false);
          } else {
            failures.push(getErrorMessage(err));
          }
        },
      ),
      cachedApiGet<RecurringPattern[]>(
        patternsRequest.url,
        { params: patternsRequest.params },
        patternsRequest.scope,
        { force },
      ).then(
        ({ data }) => {
          if (current()) setPatterns(data);
        },
        (err: unknown) => {
          if (current()) failures.push(getErrorMessage(err));
        },
      ),
    ]);
    if (!current()) return;
    setLoadError(failures[0] ?? null);
    setLoading(false);
  }

  useEffect(() => {
    void loadRecurring();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // Closed days are decoration, not data the page depends on: if they fail to
  // load, the calendar simply shows every day as open.
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const base = `/business-profiles/${selected.id}`;
    void Promise.all([
      api.get<OperatingScheduleEntry[]>(`${base}/operating-schedule`, { signal: controller.signal }),
      api.get<OperatingDayOverridePage | OperatingDayOverride[]>(`${base}/operating-overrides`, {
        params: { from: gridFrom, to: gridTo, pageSize: 50 },
        signal: controller.signal,
      }),
    ]).then(
      ([weeklyRes, overridesRes]) => {
        if (controller.signal.aborted) return;
        setWeekly(weeklyRes.data);
        setOverrides(Array.isArray(overridesRes.data) ? overridesRes.data : overridesRes.data.items);
      },
      () => {
        if (controller.signal.aborted) return;
        setWeekly([]);
        setOverrides([]);
      },
    );
    return () => controller.abort();
  }, [selected?.id, gridFrom, gridTo, selected]);

  const entriesByDate = useMemo(
    () => calendarEntries(schedules ?? [], patterns, gridFrom, gridTo),
    [schedules, patterns, gridFrom, gridTo],
  );
  const hasAnything =
    (schedules ?? []).some((s) => s.isActive) || patterns.some((p) => p.status === "CANDIDATE");
  const { first: monthFirst, last: monthLast } = monthBounds(month);

  function goToMonth(next: string) {
    setMonth(next);
  }

  function openForm(schedule: RecurringSchedule | null) {
    setEditing(schedule);
    setFormOpen(true);
  }

  async function answerSuggestion(patternId: number, answer: "watch" | "dismiss") {
    if (!selected) return;
    setActionError(null);
    try {
      if (answer === "watch") {
        await watchRecurringPattern(selected.id, patternId);
        // Refetched, not patched: the new schedule's due state is server-computed.
        await loadRecurring(true);
      } else {
        await dismissRecurringPattern(selected.id, patternId);
        setPatterns((list) =>
          list.map((p) => (p.id === patternId ? { ...p, status: "DISMISSED" } : p)),
        );
      }
    } catch (err) {
      setActionError(getErrorMessage(err));
    }
  }

  // A schedule is settled once the server has moved its due date on.
  useEffect(() => {
    if (!schedules) return;
    setSettling((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of Object.keys(current).map(Number)) {
        const schedule = schedules.find((s) => s.id === id);
        if (!schedule || schedule.nextDueDate.slice(0, 10) !== current[id]!.due) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [schedules]);

  // Refetch a few times while a recorded payment waits for its match. If the
  // job is slow (or the worker is down), stop polling and say so plainly.
  const waiting = Object.values(settling).some((s) => !s.slow);
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = () => {
      timer = setTimeout(() => {
        if (attempt < SETTLE_POLL_MS.length - 1) {
          void loadRecurring(true);
          attempt += 1;
          tick();
        } else {
          setSettling((current) =>
            Object.fromEntries(Object.entries(current).map(([id, s]) => [id, { ...s, slow: true }])),
          );
        }
      }, SETTLE_POLL_MS[attempt]);
    };
    tick();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  // Two watched payments with the same name and category are almost always
  // one payment entered twice; each would want its own expense every cycle.
  const duplicateScheduleIds = useMemo(() => {
    const seen = new Map<string, number[]>();
    for (const s of schedules ?? []) {
      if (!s.isActive) continue;
      const key = `${s.categoryId}|${s.label.trim().toLowerCase()}`;
      seen.set(key, [...(seen.get(key) ?? []), s.id]);
    }
    return new Set([...seen.values()].filter((ids) => ids.length > 1).flat());
  }, [schedules]);

  /** Where a schedule's payment that is due now sits on the calendar. */
  function currentDueOf(scheduleId: number): { date: string; overdue: boolean } | undefined {
    const schedule = schedules?.find((s) => s.id === scheduleId);
    if (!schedule) return undefined;
    return { date: schedule.nextDueDate.slice(0, 10), overdue: schedule.dueState === "OVERDUE" };
  }

  /**
   * Opens the expense form filled in from the entry, for the owner to check
   * and save. A watched payment's fields are copied from its schedule, so the
   * expense matches it by construction: the detector pairs them on category,
   * paid-to and description.
   */
  async function startRecording(entry: CalendarEntry, day: string) {
    if (entry.scheduleId !== undefined) {
      const schedule = schedules?.find((s) => s.id === entry.scheduleId);
      if (!schedule) return;
      // Paying twice in one cycle is the easy mistake. Same-week doubles are
      // also caught by the near-duplicate check, but a second payment later
      // in the month is not, so ask here before the form opens.
      const last = schedule.lastRecordedDate?.slice(0, 10);
      setOpenDay(null);
      if (last && daysBetweenKeys(last, today) < schedule.intervalDays / 2) {
        const again = await confirm({
          title: "Already paid?",
          body: (
            <>
              FinSight matched a <b className="font-semibold">{schedule.label}</b> payment on{" "}
              {dayLabel(last)}. Record another one?
            </>
          ),
          confirmLabel: "Record another",
        });
        if (!again) {
          setOpenDay(day);
          return;
        }
      }
      setRecording({
        day,
        schedule,
        seed: {
          description: schedule.label,
          vendor: schedule.vendor ?? "",
          categoryId: schedule.categoryId,
          amount: schedule.expectedAmount,
        },
      });
      return;
    }
    const pattern = patterns.find((p) => p.id === entry.patternId);
    if (!pattern) return;
    setOpenDay(null);
    setRecording({
      day,
      seed: {
        description: pattern.description,
        vendor: pattern.vendor ?? "",
        // A suggestion carries its category by name only; left blank for the
        // owner to pick if the name no longer matches one of theirs.
        categoryId: categories.find((c) => c.name === pattern.category.name)?.id ?? "",
        amount: pattern.expectedAmount,
      },
    });
  }

  async function skipCycle(scheduleId: number) {
    const schedule = schedules?.find((s) => s.id === scheduleId);
    if (!schedule || !selected) return;
    const nextDue = addDays(schedule.nextDueDate.slice(0, 10), schedule.intervalDays);
    const ok = await confirm({
      title: "Skip this payment?",
      body: (
        <>
          <b className="font-semibold">{schedule.label}</b> moves to {dayLabel(nextDue)}. No expense is
          recorded.
        </>
      ),
      confirmLabel: "Skip",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await api.patch(
        `/insights/recurring-schedules/${schedule.id}`,
        { nextDueDate: nextDue },
        { serverStateScope: { businessProfileId: selected.id } },
      );
      toast(`Skipped. Next due ${dayLabel(nextDue)}`);
      await loadRecurring(true);
    } catch (err) {
      setActionError(getErrorMessage(err));
    }
  }

  const openEntries = openDay ? (entriesByDate.get(openDay) ?? []) : [];
  const openClosed = openDay ? isClosedDay(openDay, weekly, overrides) : false;
  const actionErrorCallout = actionError ? (
    <div className="mb-4">
      <Callout tone="warn">
        <span role="alert">That didn’t save. {actionError}</span>
      </Callout>
    </div>
  ) : null;

  // Counts for the month on screen only — the grid's lead-in and trailing
  // days belong to the neighbouring months. Counts, never sums: totals are a
  // server calculation.
  const monthStats = useMemo(() => {
    const stats = { due: 0, overdue: 0, expected: 0, suggested: 0, closed: 0 };
    for (const key of days) {
      if (key < monthFirst || key > monthLast) continue;
      if (isClosedDay(key, weekly, overrides)) stats.closed += 1;
      for (const entry of entriesByDate.get(key) ?? []) {
        if (entry.overdue) stats.overdue += 1;
        else stats[entry.kind] += 1;
      }
    }
    return stats;
  }, [days, monthFirst, monthLast, weekly, overrides, entriesByDate]);

  return (
    <div>
      {/* No visible header: the month toolbar is the page's real heading. The
          page still needs an h1 for screen readers. */}
      <h1 className="sr-only">Payment calendar</h1>

      {/* While the day popup is open the page behind it is inert, so the
          error shows inside the popup instead. */}
      {openDay ? null : actionErrorCallout}

      {loadError ? (
        <div className="mb-4">
          <Callout tone="warn">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span role="status">Some payments couldn’t load. {loadError}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void loadRecurring(true)}>
                Retry
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {!selected ? (
        <EmptyState compact title="No business selected" icon="↻">
          Choose a business to see its payment calendar.
        </EmptyState>
      ) : loading ? (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading payment calendar…</span>
          <SkeletonPanel lines={8} />
        </div>
      ) : !hasAnything && !loadError ? (
        <EmptyState
          compact
          title="No payments to show yet"
          icon="↻"
          action={
            <Button type="button" variant="primary" onClick={() => openForm(null)}>
              Add a recurring payment
            </Button>
          }
        >
          Add rent, salaries or bills you pay on a schedule. FinSight will also suggest ones it
          notices in your expenses for you to check.
        </EmptyState>
      ) : (
        <Card className="min-w-0 p-4 sm:p-5">
          {/* Toolbar: the month is the heading of the card it controls. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl font-semibold text-ink-900" aria-live="polite">
              {monthLabel(month)}
            </h2>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="secondary" onClick={() => openForm(null)}>
                <Plus aria-hidden className="mr-1 h-4 w-4" />
                Add payment
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Previous month"
                onClick={() => goToMonth(shiftMonth(month, -1))}
              >
                <ChevronLeft aria-hidden className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={month === today.slice(0, 7)}
                onClick={() => goToMonth(today.slice(0, 7))}
              >
                Today
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Next month"
                onClick={() => goToMonth(shiftMonth(month, 1))}
              >
                <ChevronRight aria-hidden className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <MonthSummary stats={monthStats} />

          <div
            key={month}
            role="grid"
            aria-label={`Payments in ${monthLabel(month)}`}
            className="mt-4 animate-fade-up overflow-hidden rounded-xl border border-paper-200"
          >
            <div role="row" className="grid grid-cols-7 border-b border-paper-200 bg-paper-50">
              {WEEKDAYS.map((weekday) => (
                <div
                  key={weekday}
                  role="columnheader"
                  className="py-2 text-center text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500"
                >
                  {weekday}
                </div>
              ))}
            </div>
            {/* `gap-px` over a hairline-coloured backing draws the grid
                lines, so no cell needs to know whether it sits on an edge. */}
            <div className="grid gap-px bg-paper-200">
              {Array.from({ length: days.length / 7 }, (_, week) => (
                <div role="row" key={week} className="grid grid-cols-7 gap-px">
                  {days.slice(week * 7, week * 7 + 7).map((day) => (
                    <DayCell
                      key={day}
                      day={day}
                      inMonth={day >= monthFirst && day <= monthLast}
                      isToday={day === today}
                      isSelected={day === openDay}
                      closed={isClosedDay(day, weekly, overrides)}
                      entries={entriesByDate.get(day) ?? []}
                      onSelect={() => {
                        setActionError(null);
                        setOpenDay(day);
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <Legend />
        </Card>
      )}

      <Modal open={openDay !== null} onClose={() => setOpenDay(null)} title={openDay ? dayLabel(openDay) : ""}>
        {openDay ? (
          <>
            {actionErrorCallout}
            <p className="-mt-1 mb-4 text-sm text-ink-600">
              {openDay === today ? "Today · " : ""}
              {openClosed
                ? "Business closed"
                : openEntries.length === 0
                  ? "Nothing due"
                  : `${openEntries.length} ${openEntries.length === 1 ? "payment" : "payments"}`}
            </p>
            {openEntries.length === 0 ? (
              <p className="rounded-xl border border-dashed border-paper-200 px-4 py-6 text-center text-sm text-ink-500">
                {openClosed ? "Closed, and nothing due this day." : "Nothing due this day."}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {openEntries.map((entry) => (
                  <DayEntry
                    key={entry.key}
                    entry={entry}
                    canWatch={schedulesAvailable}
                    settling={entry.scheduleId !== undefined ? settling[entry.scheduleId] : undefined}
                    currentDue={entry.kind === "expected" ? currentDueOf(entry.scheduleId!) : undefined}
                    duplicate={entry.scheduleId !== undefined && duplicateScheduleIds.has(entry.scheduleId)}
                    onRecord={() => void startRecording(entry, openDay)}
                    onSkip={() => void skipCycle(entry.scheduleId!)}
                    onAnswer={(answer) => void answerSuggestion(entry.patternId!, answer)}
                    onEdit={() => {
                      const schedule = schedules?.find((s) => s.id === entry.scheduleId);
                      if (!schedule) return;
                      // One popup at a time: the edit form replaces the day.
                      setOpenDay(null);
                      openForm(schedule);
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </Modal>

      {selected ? (
        <AddExpenseModal
          businessProfileId={selected.id}
          open={recording !== null}
          title="Record payment"
          duplicateFrom={recording?.seed}
          onSaved={() => {
            const schedule = recording?.schedule;
            if (!schedule) return;
            setSettling((current) => ({
              ...current,
              [schedule.id]: { due: schedule.nextDueDate.slice(0, 10), slow: false },
            }));
            void loadRecurring(true);
          }}
          onClose={() => {
            // Back to the day the owner came from, where the entry now shows
            // its progress.
            const day = recording?.day ?? null;
            setRecording(null);
            setOpenDay(day);
          }}
        />
      ) : null}

      <ScheduleFormModal
        open={formOpen}
        schedule={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => void loadRecurring(true)}
      />
    </div>
  );
}

/** The month at a glance: what needs attention, in counts. */
function MonthSummary({
  stats,
}: {
  stats: { due: number; overdue: number; expected: number; suggested: number; closed: number };
}) {
  const items: { label: string; value: number; dot: string }[] = [
    { label: "Due", value: stats.due, dot: "bg-tone-brand" },
    { label: "Overdue", value: stats.overdue, dot: "bg-tone-danger" },
    { label: "Expected", value: stats.expected, dot: "bg-ink-400" },
    { label: "To check", value: stats.suggested, dot: "bg-tone-info" },
    { label: "Closed days", value: stats.closed, dot: "bg-paper-200" },
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-paper-200 bg-paper-50 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
            <span aria-hidden className={`h-2 w-2 rounded-full ${item.dot}`} />
            {item.label}
          </dt>
          <dd className="figure mt-0.5 text-lg font-bold text-ink-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DayCell({
  day,
  inMonth,
  isToday,
  isSelected,
  closed,
  entries,
  onSelect,
}: {
  day: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  closed: boolean;
  entries: CalendarEntry[];
  onSelect: () => void;
}) {
  const hidden = entries.length - CELL_ENTRY_LIMIT;
  const summary = [
    closed ? "closed" : null,
    entries.length > 0 ? `${entries.length} ${entries.length === 1 ? "payment" : "payments"}` : "nothing due",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div role="gridcell" className="min-w-0">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={`${day}, ${summary}`}
        className={`relative flex h-full min-h-[4.25rem] w-full flex-col items-stretch gap-1 p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 sm:min-h-[6.75rem] sm:p-2 ${
          closed ? "bg-paper-100" : inMonth ? "bg-paper hover:bg-paper-50" : "bg-paper-50"
        } ${isSelected ? "ring-2 ring-inset ring-brand-500" : ""}`}
      >
        <span className="flex items-center justify-between gap-1">
          <span
            className={`figure flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold ${
              isToday ? "bg-brand-600 text-white" : inMonth ? "text-ink-800" : "text-ink-600"
            }`}
          >
            {Number(day.slice(8))}
          </span>
          {closed ? (
            <span className="hidden text-[10px] font-semibold uppercase tracking-wide text-ink-600 sm:inline">
              Closed
            </span>
          ) : null}
        </span>

        {/* Below `sm` a cell is too narrow for names: dots, one per payment. */}
        {entries.length > 0 ? (
          <span aria-hidden className={`flex flex-wrap gap-1 sm:hidden ${inMonth ? "" : "opacity-60"}`}>
            {entries.slice(0, 4).map((entry) => (
              <span key={entry.key} className={`h-1.5 w-1.5 rounded-full ${dotClass(entry)}`} />
            ))}
          </span>
        ) : null}

        <span aria-hidden className={`hidden min-w-0 flex-col gap-1 sm:flex ${inMonth ? "" : "opacity-60"}`}>
          {entries.slice(0, CELL_ENTRY_LIMIT).map((entry) => (
            <span
              key={entry.key}
              className={`flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                entry.overdue ? OVERDUE_CHIP : KIND_LOOK[entry.kind].chip
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(entry)}`} />
              <span className="truncate">{entry.label}</span>
            </span>
          ))}
          {hidden > 0 ? (
            <span className="px-1 text-[11px] font-semibold text-ink-600">+{hidden} more</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

function dotClass(entry: CalendarEntry): string {
  if (entry.overdue) return "bg-tone-danger";
  if (entry.kind === "suggested") return "bg-tone-info";
  if (entry.kind === "due") return "bg-tone-brand";
  return "bg-ink-400";
}

function daysBetweenKeys(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

function shortDate(key: string): string {
  return new Date(`${key}T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function DayEntry({
  entry,
  canWatch,
  settling,
  currentDue,
  duplicate,
  onRecord,
  onSkip,
  onAnswer,
  onEdit,
}: {
  entry: CalendarEntry;
  canWatch: boolean;
  /** Set while a just-recorded payment waits for the server to match it. */
  settling?: { slow: boolean };
  /** For a projected date: the payment that is due now, which comes first. */
  currentDue?: { date: string; overdue: boolean };
  /** Another watched payment has the same name and category. */
  duplicate: boolean;
  onRecord: () => void;
  onSkip: () => void;
  onAnswer: (answer: "watch" | "dismiss") => void;
  onEdit: () => void;
}) {
  const look = KIND_LOOK[entry.kind];
  const suggested = entry.kind === "suggested";
  const accent = entry.overdue
    ? "border-l-tone-danger"
    : suggested
      ? "border-l-tone-info"
      : entry.kind === "due"
        ? "border-l-tone-brand"
        : "border-l-ink-300";

  // One short line under the header, at most: what this entry means now.
  let note: ReactNode = null;
  if (settling) {
    note = (
      <p role="status" className="text-tone-brand">
        {settling.slow ? "Payment recorded. It can take a few minutes to show here." : "Payment recorded. Updating…"}
      </p>
    );
  } else if (suggested) {
    note = <p className="text-ink-600">FinSight noticed this repeating. Is it a regular payment?</p>;
  } else if (entry.kind === "expected" && currentDue && currentDue.date !== entry.date) {
    // A payment recorded now always counts toward the oldest unpaid one,
    // never this later date, so say which one it will clear.
    note = (
      <p className={currentDue.overdue ? "text-tone-danger" : "text-ink-600"}>
        Pays the {currentDue.overdue ? "overdue " : ""}
        {shortDate(currentDue.date)} payment first.
      </p>
    );
  }

  return (
    <li
      className={`rounded-xl border border-l-4 bg-paper-50 p-3.5 ${accent} ${
        suggested ? "border-dashed border-y-edge-info border-r-edge-info" : "border-y-paper-200 border-r-paper-200"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-snug text-ink-900">{entry.label}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-600">
            {entry.overdue ? <Pill tone="danger">Overdue</Pill> : <Pill tone={look.pill}>{look.label}</Pill>}
            <span>
              {entry.categoryName ?? "No category"} · every {entry.intervalDays} days
            </span>
          </div>
        </div>
        <p className="figure shrink-0 text-sm font-bold text-ink-900">{formatMoney(entry.amount)}</p>
      </div>

      {note ? <div className="mt-2 text-xs">{note}</div> : null}
      {duplicate ? (
        <p className="mt-2 rounded-lg bg-tint-info px-2.5 py-1.5 text-xs text-tone-info">
          Another watched payment has this name. If it is a copy, delete one in Edit schedule.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-paper-200 pt-3">
        {suggested ? (
          <>
            <button type="button" onClick={onRecord} className="tap-inline text-xs link-action">
              Record payment
              <span className="sr-only"> for {entry.label}</span>
            </button>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => onAnswer("dismiss")}>
                Not recurring
                <span className="sr-only"> — {entry.label}</span>
              </Button>
              {canWatch ? (
                <Button type="button" size="sm" onClick={() => onAnswer("watch")}>
                  Watch this
                  <span className="sr-only"> — {entry.label}</span>
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="flex gap-x-4">
              {entry.kind === "due" && !settling ? (
                <button type="button" onClick={onSkip} className="tap-inline text-xs link-action">
                  Skip this time
                  <span className="sr-only"> {entry.label}</span>
                </button>
              ) : null}
              <button type="button" onClick={onEdit} className="tap-inline text-xs link-action">
                Edit schedule
                <span className="sr-only"> {entry.label}</span>
              </button>
            </div>
            {!settling ? (
              <Button
                type="button"
                size="sm"
                // Brand fill on the payment due now; outlined on a later one.
                variant={entry.kind === "due" ? "brand" : "secondary"}
                onClick={onRecord}
              >
                Record payment
                <span className="sr-only"> for {entry.label}</span>
              </Button>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function Legend() {
  const items: { label: string; dot: string }[] = [
    { label: "Due", dot: "bg-tone-brand" },
    { label: "Overdue", dot: "bg-tone-danger" },
    { label: "Expected", dot: "bg-ink-400" },
    { label: "Suggested — check it", dot: "bg-tone-info" },
  ];
  return (
    <ul aria-label="Legend" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-500">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className={`h-2 w-2 rounded-full ${item.dot}`} />
          {item.label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-3 rounded-sm bg-paper-100 ring-1 ring-paper-200" />
        Closed day
      </li>
    </ul>
  );
}
