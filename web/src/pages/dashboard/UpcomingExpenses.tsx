import { useState } from "react";
import { EXPENSE_RECURRING_PATH } from "../expenseInsight/reviewRequests";
import { AlertCircle, CalendarClock, CalendarDays, CalendarOff, Clock } from "lucide-react";
import { Panel } from "../../components/ui";
import { ArrowLink, IconTile, PanelTitle } from "./DashboardBits";
import { formatMoney } from "../../components/Money";
import { formatDueDate } from "../../components/RecurringAgenda";
import { FeedNotice } from "./FeedNotice";
import { useUpcomingExpenses } from "./useDashboardFeeds";
import { ScheduleFormModal } from "../RecurringScheduleForm";
import type { RecurringSchedule } from "../../lib/types";

export function UpcomingExpenses({ businessProfileId }: { businessProfileId: number }) {
  const { state, reload } = useUpcomingExpenses(businessProfileId);
  // Add and edit open as a popup over the dashboard, not a separate page.
  const [form, setForm] = useState<{ schedule: RecurringSchedule | null } | null>(null);
  const priority = { OVERDUE: 0, DUE_SOON: 1, SCHEDULED: 2 };
  const active = state.data?.filter((schedule) => schedule.isActive)
    .sort((a, b) => priority[a.dueState] - priority[b.dueState] || a.nextDueDate.localeCompare(b.nextDueDate));
  // Two schedules with the same name, amount and due date read as one payment
  // listed twice, so they share a row that says so instead of repeating.
  const rows: { schedule: RecurringSchedule; copies: number }[] = [];
  for (const schedule of active ?? []) {
    const twin = rows.find(({ schedule: s }) =>
      s.label === schedule.label && s.expectedAmount === schedule.expectedAmount && s.nextDueDate === schedule.nextDueDate);
    if (twin) twin.copies += 1;
    else rows.push({ schedule, copies: 1 });
  }
  const schedules = active ? rows.slice(0, 3) : undefined;
  const overdueCount = active?.filter((schedule) => schedule.dueState === "OVERDUE").length ?? 0;

  return (
    <Panel title={<PanelTitle icon={CalendarClock}>Recurring payments</PanelTitle>} className="min-w-0"
      action={state.status !== "unavailable" ? (
        <ArrowLink to={EXPENSE_RECURRING_PATH}>Manage schedules</ArrowLink>
      ) : undefined}>
      {state.status === "unavailable" ? (
        <div className="flex h-full flex-col items-center justify-center py-10 text-center">
          <IconTile icon={CalendarOff} size="lg" />
          <p className="mt-3 max-w-[28ch] text-sm text-ink-600">Recurring expense schedules aren’t available for this business.</p>
        </div>
      ) : state.status === "error" && !state.data ? (
        <FeedNotice label="Recurring payments" onRetry={reload} />
      ) : !schedules ? (
        <p role="status" className="py-8 text-center text-sm text-ink-500">Loading recurring payments…</p>
      ) : (
        // Capped so long names scroll inside the card instead of stretching the row.
        <div className="scroll-none max-h-72 overflow-y-auto overscroll-contain">
          {state.status === "error" ? <FeedNotice label="Recurring payments" onRetry={reload} retained /> : null}
          {overdueCount > 0 ? (
            <p className="mb-2 text-xs font-semibold text-tone-danger">
              {overdueCount} overdue, oldest first
            </p>
          ) : null}
          {schedules.length ? (
            <ul className="divide-y divide-paper-200">
              {schedules.map(({ schedule, copies }) => (
                <li key={schedule.id} className="flex items-start gap-3 py-3 first:pt-0">
                  <IconTile
                    size="sm"
                    icon={schedule.dueState === "OVERDUE" ? AlertCircle : schedule.dueState === "DUE_SOON" ? Clock : CalendarDays}
                  />
                  <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <button
                      type="button"
                      onClick={() => setForm({ schedule })}
                      className="tap-inline text-left text-sm link-action [overflow-wrap:anywhere]"
                    >
                      {schedule.label}
                    </button>
                    <span className="figure whitespace-nowrap text-sm font-semibold text-ink-900">{formatMoney(schedule.expectedAmount)}</span>
                  </div>
                  <p className={`text-xs ${schedule.dueState === "OVERDUE" ? "text-tone-danger" : "text-ink-500"}`}>
                    {schedule.dueState === "OVERDUE" ? "Overdue since" : schedule.dueState === "DUE_SOON" ? "Due soon" : "Scheduled"}
                    {schedule.dueState === "OVERDUE" ? " " : " · "}{formatDueDate(schedule.nextDueDate)}
                  </p>
                  {copies > 1 ? (
                    <p className="mt-1 text-xs text-ink-500">{copies} schedules with this name and date. Open one to edit or remove it.</p>
                  ) : null}
                  {schedule.dueState === "OVERDUE" ? <p className="mt-1 text-xs text-ink-500">No matching expense recorded yet.</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-6">
              <p className="text-sm font-medium text-ink-800">No active recurring expenses</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">Add rent, bills, or other repeat expenses to see what’s coming up.</p>
              <button
                type="button"
                onClick={() => setForm({ schedule: null })}
                className="tap-inline mt-2 text-sm link-action"
              >
                Add a schedule
              </button>
            </div>
          )}
        </div>
      )}
      <ScheduleFormModal
        open={form !== null}
        schedule={form?.schedule ?? null}
        onClose={() => setForm(null)}
        onSaved={reload}
      />
    </Panel>
  );
}
