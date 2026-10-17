import { AlertTriangle, CalendarDays, CheckCircle2, Clock, Gauge, Plus, Target } from "lucide-react";
import { ButtonLink } from "../../components/Button";
import { formatMoney } from "../../components/Money";
import { ProgressRing } from "../../components/MiniCharts";
import { Pill } from "../../components/ui";
import { ArrowLink, IconTile } from "./DashboardBits";
import { monthLabel } from "../../lib/reportingPeriod";
import { todayIso } from "../../lib/dates";
import type { DashboardSummary } from "../../lib/types";

export function RecoveryFocus({ summary, needsSetup, action }: {
  summary: DashboardSummary;
  needsSetup: boolean;
  action: { to: string; label: string };
}) {
  const recovery = summary.recoveryStatus;
  const incomplete = recovery.status === "data_incomplete";
  const covered = recovery.status === "covered";
  const hasTodayTarget = recovery.todaysTarget > 0;
  const todayRemaining = Math.max(0, -recovery.todaysGap);
  const onPace = recovery.status ? ["ahead", "on_pace", "covered"].includes(recovery.status) : recovery.onTrack;
  const currentMonth = monthLabel((recovery.asOfDate ?? todayIso(recovery.timezone)).slice(0, 7));
  const status = needsSetup ? "Not set up"
    : incomplete ? "Data incomplete"
      : covered ? "Target reached"
        : recovery.status === "no_current_month_data" ? "No sales yet"
          : recovery.status === "ahead" ? "Ahead of pace"
            : onPace ? "On track" : "Behind pace";
  const actions = (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <ButtonLink to={needsSetup ? action.to : "/records/sales/new"} variant="primary">
        {needsSetup ? null : <Plus aria-hidden className="h-4 w-4" />}
        {needsSetup ? action.label : "Add sale"}
      </ButtonLink>
      {!needsSetup ? (
        <ArrowLink to={action.to === "/records/sales/new" ? "/insights/recovery" : action.to} className="text-sm">
          {action.to === "/records/sales/new" ? "View recovery plan" : action.label}
        </ArrowLink>
      ) : null}
    </div>
  );
  const todayPercent = hasTodayTarget ? Math.min((recovery.todaysSales / recovery.todaysTarget) * 100, 100) : 0;

  return (
    <section aria-labelledby="dashboard-recovery" data-tour="dashboard-summary" className="flex min-w-0 flex-col rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm lg:col-span-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconTile icon={Target} />
          <div>
            <h2 id="dashboard-recovery" className="text-base font-semibold text-ink-900">Today’s recovery target</h2>
            <p className="text-xs text-ink-500">Current month · {currentMonth}</p>
          </div>
        </div>
        <Pill tone={needsSetup || incomplete || recovery.status === "no_current_month_data" ? "info" : onPace ? "ok" : "danger"}>{status}</Pill>
      </div>
      {needsSetup ? (
        <>
          <p className="my-5 max-w-prose text-sm leading-relaxed text-ink-600">Add a starting monthly expense estimate to get a daily sales target.</p>
          {actions}
        </>
      ) : (
        <>
          <div className="mt-5 flex items-center justify-between gap-5">
            <div className="min-w-0 flex-1">
              {incomplete ? (
                <p className="flex items-start gap-2 text-sm font-medium text-ink-800">
                  <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-tone-accent" />
                  <span>Review your records before relying on this target.</span>
                </p>
              ) : covered ? (
                <p className="flex items-center gap-2 font-display text-xl font-semibold text-tone-brand">
                  <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0" />
                  <span>This month’s target is covered</span>
                </p>
              ) : !hasTodayTarget ? (
                <p className="text-lg font-semibold text-ink-900">No target set for today</p>
              ) : todayRemaining > 0 ? (
                <>
                  <p className="figure break-all text-[2rem] font-semibold leading-none tracking-[-0.02em] text-ink-900">{formatMoney(todayRemaining)}</p>
                  <p className="mt-1.5 text-sm text-ink-600">more in sales to reach today’s target</p>
                </>
              ) : (
                <p className="flex items-center gap-2 font-display text-xl font-semibold text-tone-brand">
                  <CheckCircle2 aria-hidden className="h-5 w-5 shrink-0" />
                  <span>Today’s sales target reached</span>
                </p>
              )}

              {/* Today, as one bar: what is recorded against what is needed.
                  The two amounts under it are its only labels. */}
              <div className="mt-4">
                <div aria-hidden className="h-2 overflow-hidden rounded-full bg-paper-200">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                    style={{
                      width: `${todayPercent > 0 ? Math.max(todayPercent, 2) : 0}%`,
                      backgroundColor: todayRemaining > 0 ? "rgb(var(--tone-accent))" : "rgb(var(--tone-brand))",
                    }}
                  />
                </div>
                <dl className="mt-2 flex items-start justify-between gap-4">
                  <div><dt className="text-[11px] text-ink-500">Sales recorded today</dt><dd className="figure mt-0.5 break-all text-sm font-semibold text-ink-900">{formatMoney(recovery.todaysSales)}</dd></div>
                  <div className="text-right"><dt className="text-[11px] text-ink-500">Today’s sales target</dt><dd className="figure mt-0.5 break-all text-sm font-semibold text-ink-900">{formatMoney(recovery.todaysTarget)}</dd></div>
                </dl>
              </div>
            </div>
            {!incomplete ? <div className="hidden shrink-0 sm:block">
              <ProgressRing percent={recovery.monthCoveragePercent} size={96} stroke={9} color="rgb(var(--chart-emphasis))" label={`${Math.round(recovery.monthCoveragePercent)}% of this month's target covered`} />
              <p className="mt-1 text-center text-[11px] text-ink-500">of the month</p>
            </div> : null}
          </div>

          <dl className="mt-5 grid grid-cols-3 divide-x divide-paper-200 rounded-xl bg-paper-50 py-3 ring-1 ring-paper-200">
            <div className="min-w-0 px-3">
              <dt className="flex items-center gap-1 text-[11px] text-ink-600"><CalendarDays aria-hidden className="h-3 w-3" />This month</dt>
              <dd className="figure mt-0.5 truncate text-sm font-semibold text-ink-900">{formatMoney(recovery.salesThisMonth)}</dd>
            </div>
            <div className="min-w-0 px-3">
              <dt className="flex items-center gap-1 text-[11px] text-ink-600"><Gauge aria-hidden className="h-3 w-3" />Daily target</dt>
              <dd className="figure mt-0.5 truncate text-sm font-semibold text-tone-accent">{covered ? "Covered" : formatMoney(recovery.adjustedDailyTarget)}</dd>
            </div>
            <div className="min-w-0 px-3">
              <dt className="flex items-center gap-1 text-[11px] text-ink-600"><Clock aria-hidden className="h-3 w-3" />Days left</dt>
              <dd className="figure mt-0.5 truncate text-sm font-semibold text-ink-900">{recovery.remainingOperatingDaysIsApproximated ? "≈ " : ""}{recovery.remainingOperatingDays ?? "—"}</dd>
            </div>
          </dl>
          {recovery.dataWarnings?.length ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-tone-accent"><AlertTriangle aria-hidden className="h-3.5 w-3.5" />Some records still need review.</p>
          ) : null}

          <div className="mt-auto">{actions}</div>
        </>
      )}
    </section>
  );
}
