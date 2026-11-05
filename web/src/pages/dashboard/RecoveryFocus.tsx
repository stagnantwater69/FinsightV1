import { AlertTriangle, CalendarDays, CheckCircle2, Clock, Gauge, Plus, Target } from "lucide-react";
import { Button, ButtonLink } from "../../components/Button";
import { formatMoney } from "../../components/Money";
import { ProgressRing } from "../../components/MiniCharts";
import { Pill } from "../../components/ui";
import { ArrowLink, IconTile } from "./DashboardBits";
import { monthLabel } from "../../lib/reportingPeriod";
import { todayIso } from "../../lib/dates";
import type { DashboardSummary } from "../../lib/types";

export function RecoveryFocus({ summary, needsSetup, action, onAddSale }: {
  summary: DashboardSummary;
  needsSetup: boolean;
  action: { to: string; label: string };
  onAddSale: () => void;
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
          : recovery.status === "ahead" ? "Ahead"
            : onPace ? "On track" : "Behind";
  const actions = (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      {needsSetup ? (
        <ButtonLink to={action.to} variant="primary">{action.label}</ButtonLink>
      ) : (
        <Button variant="primary" onClick={onAddSale}>
          <Plus aria-hidden className="h-4 w-4" />
          Add sale
        </Button>
      )}
      {!needsSetup ? (
        <ArrowLink to={action.to === "/records/sales/new" ? "/insights/recovery" : action.to} className="text-sm">
          {action.to === "/records/sales/new" ? "View recovery plan" : action.label}
        </ArrowLink>
      ) : null}
    </div>
  );
  // The month's pace, so "Behind" carries its own figure. Target = what is recorded plus what remains.
  const monthTarget = recovery.salesThisMonth + Math.max(0, recovery.remainingTarget);
  const showMonthPace =
    !needsSetup && !incomplete && !covered && recovery.expectedSalesToDate !== undefined && monthTarget > 0;
  const variance = recovery.paceVarianceAmount ?? recovery.salesThisMonth - (recovery.expectedSalesToDate ?? 0);
  const share = (value: number) => `${Math.min(Math.max((value / monthTarget) * 100, 0), 100)}%`;
  const todayPercent = hasTodayTarget ? Math.min((recovery.todaysSales / recovery.todaysTarget) * 100, 100) : 0;

  return (
    <section aria-labelledby="dashboard-recovery" data-tour="dashboard-summary" className="flex min-w-0 flex-col rounded-2xl border border-paper-200 bg-paper p-5 shadow-sm lg:col-span-12">
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
        /* Wide screens: today on the left, the month on the right, so the card
           is short and the two cards below it can sit side by side. */
        <div className="grid gap-x-8 lg:grid-cols-2">
          <div className="mt-5 flex items-center justify-between gap-5">
            <div className="min-w-0 flex-1 [container-type:inline-size]">
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
                  <p className="figure text-[clamp(1.375rem,13cqi,2rem)] font-semibold leading-none tracking-[-0.02em] text-ink-900">{formatMoney(todayRemaining)}</p>
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
                <dl className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div><dt className="text-xs text-ink-500">Sales recorded today</dt><dd className="figure mt-0.5 whitespace-nowrap text-sm font-semibold text-ink-900">{formatMoney(recovery.todaysSales)}</dd></div>
                  <div className="text-right"><dt className="text-xs text-ink-500">Today’s target</dt><dd className="figure mt-0.5 whitespace-nowrap text-sm font-semibold text-ink-900">{formatMoney(recovery.todaysTarget)}</dd></div>
                </dl>
              </div>
            </div>
            {!incomplete ? <div className="hidden shrink-0 sm:block">
              <ProgressRing percent={recovery.monthCoveragePercent} size={96} stroke={9} color="rgb(var(--chart-emphasis))" label={`${Math.round(recovery.monthCoveragePercent)}% of this month's target covered`} />
              <p className="mt-1 text-center text-xs text-ink-500">of the month</p>
            </div> : null}
          </div>

          <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-l lg:border-paper-200 lg:pl-8">
          {/* Three across once each cell can hold a full "PHP 100,000"; below
              that the cells stack as label/value rows instead of truncating
              the amount to "PHP 42,…". From lg to xl this column is half the
              card, too narrow for three, so it stacks again there. */}
          <dl className="mt-5 grid grid-cols-1 divide-y divide-paper-200 rounded-xl bg-paper-50 py-1 ring-1 ring-paper-200 min-[440px]:grid-cols-3 min-[440px]:divide-x min-[440px]:divide-y-0 min-[440px]:py-3 lg:grid-cols-1 lg:divide-x-0 lg:divide-y lg:py-1 xl:grid-cols-3 xl:divide-x xl:divide-y-0 xl:py-3">
            <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 min-[440px]:block min-[440px]:py-0 lg:flex lg:py-2 xl:block xl:py-0">
              <dt className="flex items-center gap-1 text-xs text-ink-600"><CalendarDays aria-hidden className="h-3 w-3" />This month</dt>
              <dd className="figure mt-0.5 shrink-0 truncate text-sm font-semibold text-ink-900">{formatMoney(recovery.salesThisMonth)}</dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 min-[440px]:block min-[440px]:py-0 lg:flex lg:py-2 xl:block xl:py-0">
              <dt className="flex items-center gap-1 text-xs text-ink-600"><Gauge aria-hidden className="h-3 w-3" />Needed per day from now</dt>
              <dd className="figure mt-0.5 shrink-0 truncate text-sm font-semibold text-tone-accent">{covered ? "Covered" : formatMoney(recovery.adjustedDailyTarget)}</dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3 px-3 py-2 min-[440px]:block min-[440px]:py-0 lg:flex lg:py-2 xl:block xl:py-0">
              <dt className="flex items-center gap-1 text-xs text-ink-600"><Clock aria-hidden className="h-3 w-3" />Days left</dt>
              <dd className="figure mt-0.5 shrink-0 truncate text-sm font-semibold text-ink-900">{recovery.remainingOperatingDaysIsApproximated ? "≈ " : ""}{recovery.remainingOperatingDays ?? "—"}</dd>
            </div>
          </dl>
          {!covered && hasTodayTarget && recovery.adjustedDailyTarget - recovery.todaysTarget >= 1 ? (
            <p className="mt-2 text-xs text-ink-500">Higher than today’s target because earlier days this month fell short.</p>
          ) : null}
          {recovery.dataWarnings?.length ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-tone-accent"><AlertTriangle aria-hidden className="h-3.5 w-3.5" />Some records still need review.</p>
          ) : null}

          {showMonthPace ? (
            <div className="mt-5 border-t border-paper-200 pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="text-sm font-semibold text-ink-900">Month so far</h3>
                <p className={`figure text-sm font-semibold ${variance < 0 ? "text-tone-danger" : "text-tone-brand"}`}>
                  {Math.abs(variance) < 1
                    ? "On pace"
                    : `${variance < 0 ? "Behind" : "Ahead"} by ${formatMoney(Math.abs(variance))}`}
                </p>
              </div>
              <div
                role="img"
                aria-label={`${formatMoney(recovery.salesThisMonth)} recorded of ${formatMoney(monthTarget)} this month. ${formatMoney(recovery.expectedSalesToDate ?? 0)} expected by today.`}
                className="relative mt-3 h-2 rounded-full bg-paper-200"
              >
                <div className="h-full rounded-full bg-brand-600" style={{ width: share(recovery.salesThisMonth) }} />
                <span
                  aria-hidden
                  className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-ink-800"
                  style={{ left: share(recovery.expectedSalesToDate ?? 0) }}
                />
              </div>
              <dl className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span aria-hidden className="h-3 w-0.5 rounded-full bg-ink-800" />
                  <dt className="text-ink-500">Expected by today</dt>
                  <dd className="figure font-semibold text-ink-900">{formatMoney(recovery.expectedSalesToDate ?? 0)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="text-ink-500">Month target</dt>
                  <dd className="figure font-semibold text-ink-900">{formatMoney(monthTarget)}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          </div>

          <div className="lg:col-start-1 lg:row-start-2 lg:self-end">{actions}</div>
        </div>
      )}
    </section>
  );
}
