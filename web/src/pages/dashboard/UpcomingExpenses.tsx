import { Link } from "react-router-dom";
import { AlertCircle, CalendarClock, CalendarDays, CalendarOff, Clock } from "lucide-react";
import { Panel } from "../../components/ui";
import { ArrowLink, IconTile, PanelTitle } from "./DashboardBits";
import { formatMoney } from "../../components/Money";
import { formatDueDate } from "../../components/RecurringAgenda";
import { FeedNotice } from "./FeedNotice";
import { useUpcomingExpenses } from "./useDashboardFeeds";

export function UpcomingExpenses({ businessProfileId }: { businessProfileId: number }) {
  const { state, reload } = useUpcomingExpenses(businessProfileId);
  const priority = { OVERDUE: 0, DUE_SOON: 1, SCHEDULED: 2 };
  const schedules = state.data?.filter((schedule) => schedule.isActive)
    .sort((a, b) => priority[a.dueState] - priority[b.dueState] || a.nextDueDate.localeCompare(b.nextDueDate))
    .slice(0, 3);

  return (
    <Panel title={<PanelTitle icon={CalendarClock}>Upcoming expenses</PanelTitle>} className="min-w-0 lg:col-span-5"
      action={state.status !== "unavailable" ? (
        <ArrowLink to="/insights/expense-behavior#expense-recurring">Manage schedules</ArrowLink>
      ) : undefined}>
      {state.status === "unavailable" ? (
        <div className="flex h-full flex-col items-center justify-center py-10 text-center">
          <IconTile icon={CalendarOff} size="lg" />
          <p className="mt-3 max-w-[28ch] text-sm text-ink-600">Recurring expense schedules aren’t available for this business.</p>
        </div>
      ) : state.status === "error" && !state.data ? (
        <FeedNotice label="Upcoming expenses" onRetry={reload} />
      ) : !schedules ? (
        <p role="status" className="py-8 text-center text-sm text-ink-500">Loading upcoming expenses…</p>
      ) : (
        <>
          {state.status === "error" ? <FeedNotice label="Upcoming expenses" onRetry={reload} retained /> : null}
          {schedules.length ? (
            <ul className="divide-y divide-paper-200">
              {schedules.map((schedule) => (
                <li key={schedule.id} className="flex items-start gap-3 py-3 first:pt-0">
                  <IconTile
                    size="sm"
                    icon={schedule.dueState === "OVERDUE" ? AlertCircle : schedule.dueState === "DUE_SOON" ? Clock : CalendarDays}
                  />
                  <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <Link to={`/insights/recurring-schedules/${schedule.id}/edit`} className="tap-inline break-words text-sm link-action">
                      {schedule.label}
                    </Link>
                    <span className="figure break-all text-sm font-semibold text-ink-900">{formatMoney(schedule.expectedAmount)}</span>
                  </div>
                  <p className={`text-xs ${schedule.dueState === "OVERDUE" ? "text-tone-danger" : "text-ink-500"}`}>
                    {schedule.dueState === "OVERDUE" ? "Past due date" : schedule.dueState === "DUE_SOON" ? "Due soon" : "Scheduled"}
                    {" · "}{formatDueDate(schedule.nextDueDate)}
                  </p>
                  {schedule.dueState === "OVERDUE" ? <p className="mt-1 text-xs text-ink-500">No matching expense recorded yet.</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-6">
              <p className="text-sm font-medium text-ink-800">No active recurring expenses</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">Add rent, bills, or other repeat expenses to see what’s coming up.</p>
              <ArrowLink to="/insights/recurring-schedules/new" className="mt-2 text-sm">Add a schedule</ArrowLink>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
