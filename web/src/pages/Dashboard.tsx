import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { CategoryComparisonChart } from "../components/CategoryComparisonChart";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { SkeletonDashboard } from "../components/Skeleton";
import { EmptyState, SetupProgress } from "../components/EmptyState";
import { GreetingHero } from "../components/GreetingHero";
import { TourInvite } from "../components/tour/TourInvite";
import { ButtonLink } from "../components/Button";
import { formatMoney } from "../components/Money";
import { DonutChart } from "../components/DonutChart";
import { PeriodFilter } from "../components/PeriodFilter";
import { Callout, Panel, PageHead, Pill } from "../components/ui";
import { IconArrowRight } from "../components/icons";
import { ALL_TIME, formatDayRange, periodLabel, periodPhrase, previousLabel } from "../lib/reportingPeriod";
import { formatCalendarDate } from "../lib/dates";
import {
  ArrowDownLeft,
  BarChart3,
  BellRing,
  CheckCircle2,
  ChevronRight,
  Flag,
  GitCompareArrows,
  History,
  Lightbulb,
  ListOrdered,
  Minus,
  PieChart,
  Plus,
  Receipt,
  RefreshCw,
  Scale,
  ScanLine,
  ShoppingBag,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { ArrowLink, IconTile, PanelTitle } from "./dashboard/DashboardBits";
import { CashflowChart } from "./dashboard/CashflowChart";
import { FeedNotice } from "./dashboard/FeedNotice";
import { RecoveryFocus } from "./dashboard/RecoveryFocus";
import { UpcomingExpenses } from "./dashboard/UpcomingExpenses";
import { useDashboardOverview } from "./dashboard/useDashboardOverview";
import {
  useCashflow,
  useRecentRecords,
  type CashflowGranularity,
} from "./dashboard/useDashboardFeeds";

export function Dashboard() {
  return (
    <ReportingPeriodScope scope="dashboard">
      <DashboardPage />
    </ReportingPeriodScope>
  );
}

type KpiTone = "brand" | "info" | "accent" | "danger" | "neutral";
const KPI_WASH: Record<KpiTone, string> = {
  brand: "from-tint-brand/70",
  info: "from-tint-info/70",
  accent: "from-tint-accent/70",
  danger: "from-tint-danger/70",
  neutral: "from-tint-neutral/70",
};
const KPI_MARK: Record<KpiTone, string> = {
  brand: "text-tone-brand",
  info: "text-tone-info",
  accent: "text-tone-accent",
  danger: "text-tone-danger",
  neutral: "text-tone-neutral",
};

function KpiCell({
  label,
  icon: Icon,
  tone,
  value,
  caption,
  delta = null,
  valueTone,
  className = "",
}: {
  label: string;
  icon: LucideIcon;
  tone: KpiTone;
  value: string;
  caption: ReactNode;
  delta?: { percent: number | null; amount: number; against: string; upIsBad: boolean } | null;
  valueTone?: "danger" | "brand";
  className?: string;
}) {
  const up = (delta?.amount ?? 0) > 0;
  const bad = delta ? (up ? delta.upIsBad : !delta.upIsBad) : false;
  const Trend = up ? TrendingUp : TrendingDown;
  let changeLabel = "No change";
  if (delta && delta.amount !== 0) {
    const magnitude = delta.percent === null
      ? formatMoney(Math.abs(delta.amount))
      : `${Math.abs(delta.percent).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    changeLabel = `${magnitude} ${up ? "increase" : "decrease"}`;
  }
  return (
    <div className={`relative isolate min-w-0 overflow-hidden bg-gradient-to-b ${KPI_WASH[tone]} to-paper to-70% p-4 sm:p-5 ${className}`}>
      <Icon
        aria-hidden="true"
        focusable="false"
        strokeWidth={1.5}
        className={`pointer-events-none absolute -bottom-6 -right-6 -z-10 size-28 -rotate-12 opacity-[0.07] ${KPI_MARK[tone]}`}
      />
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-ink-600">{label}</p>
        <IconTile icon={Icon} size="sm" />
      </div>
      <p
        className={`figure mt-1 break-all text-xl font-semibold leading-tight tracking-[-0.02em] sm:text-[1.75rem] ${
          valueTone === "danger" ? "text-tone-danger" : valueTone === "brand" ? "text-tone-brand" : "text-ink-900"
        }`}
      >
        {value}
      </p>
      <div className="mt-2 text-xs leading-relaxed text-ink-500">
        <p>{caption}</p>
        {delta ? <p className="mt-1">
          <span className={`figure inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold ${delta.amount === 0 ? "bg-tint-neutral text-tone-neutral" : bad ? "bg-tint-danger text-tone-danger" : "bg-tint-brand text-tone-brand"}`}>
            {delta.amount === 0 ? <Minus aria-hidden className="h-3 w-3" /> : <Trend aria-hidden className="h-3 w-3" />}
            {changeLabel}
          </span>{" "}vs {delta.against}
        </p> : null}
      </div>
    </div>
  );
}

function AttentionRow({
  icon,
  title,
  value,
  detail,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  value?: string;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-5 py-3.5">
      <IconTile icon={icon} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink-900">{title}</p>
        <div className="mt-0.5 text-xs leading-relaxed text-ink-500">{detail}</div>
        {action ? <div className="mt-1.5">{action}</div> : null}
      </div>
      {value !== undefined ? (
        <span className="figure text-xl font-semibold text-ink-900">{value}</span>
      ) : <span />}
    </li>
  );
}

function DashboardPage() {
  const { selected } = useBusinessProfiles();
  // This preference only controls the daily dashboard message.
  const { preferences } = useAuth();
  const { categories } = useExpenseCategories();
  const { selection, setSelection, ready: periodReady } = useReportingPeriod();
  const [showDetails, setShowDetails] = useState(false);
  const askFinSight = useAskFinSight("Dashboard");
  const [granularity, setGranularity] = useState<CashflowGranularity>("monthly");
  const cashflow = useCashflow(selected?.id ?? null, granularity);
  const allTime = selection.kind === "all";
  const {
    summary, overviewUpdatedAt, loading, error, reload,
    comparison, comparisonState, topOpportunity, opportunityState,
    overviewRefreshError, reloadExpenseOverview,
  } = useDashboardOverview(selected?.id ?? null, selection, periodReady);
  const isInitialLoad = loading && !summary;
  const isRefreshing = loading && !!summary;

  // Setup completion uses lifetime records, with a fallback for older servers.
  const hasAnyRecords = summary?.lifetime
    ? summary.lifetime.recordCount > 0
    : !!summary && (summary.overview.totalExpenses > 0 || summary.overview.totalSalesReference > 0);

  const periodIsEmpty =
    !!summary &&
    hasAnyRecords &&
    summary.overview.totalExpenses === 0 &&
    summary.overview.totalSalesReference === 0;
  const latestRecordDate = summary?.lifetime?.latestRecordDate ?? null;
  const fundsCalculation = summary?.overview.availableFundsCalculation;
  const fundsProvenance = fundsCalculation
    ? `Starting ${formatMoney(fundsCalculation.baselineAmount)}; ${fundsCalculation.confirmedSalesRecordCount} confirmed ${fundsCalculation.confirmedSalesRecordCount === 1 ? "sale" : "sales"} and ${fundsCalculation.confirmedExpenseRecordCount} confirmed ${fundsCalculation.confirmedExpenseRecordCount === 1 ? "expense" : "expenses"} since ${formatCalendarDate(fundsCalculation.baselineDate)}.`
    : "From your business profile";
  const recoveryNeedsSetup =
    !summary ||
    summary.recoveryStatus.status === "needs_setup" ||
    (!summary.recoveryStatus.status &&
      (summary.recoveryStatus.needsSetup ??
        summary.recoveryStatus.expectedMonthlyExpenses <= 0));

  const periodCaption = periodLabel(selection);
  const recent = useRecentRecords(
    selected?.id ?? null,
    summary && !allTime
      ? { dateFrom: summary.periodStart.slice(0, 10), dateTo: summary.periodEnd.slice(0, 10) }
      : null,
    !!summary,
  );

  const topCategory = summary?.expenseCategoryBreakdown?.length
    ? [...summary.expenseCategoryBreakdown].sort((a, b) => b.total - a.total)[0]
    : null;

  // Give the assistant the review count or largest category as the question's context.
  const expandQuestion = summary
    ? summary.recordsNeedingReview > 0
      ? `What should I do about the ${summary.recordsNeedingReview} record${summary.recordsNeedingReview === 1 ? "" : "s"} that need${summary.recordsNeedingReview === 1 ? "s" : ""} review?`
      : topCategory
        ? `Why is ${topCategory.categoryName} my largest expense category ${periodPhrase(selection)}?`
        : undefined
    : undefined;

  const recoveryAction = recoveryNeedsSetup
    ? selected
      ? { to: `/business-profiles/${selected.id}/edit`, label: "Set starting estimate" }
      : { to: "/onboarding", label: "Finish setup" }
    : summary.recoveryStatus.status === "data_incomplete" || summary.recordsNeedingReview > 0
      ? { to: "/records/flagged", label: "Review flagged records" }
      : summary.recoveryStatus.status === "no_current_month_data"
        ? { to: "/records/sales/new", label: "Add a sales record" }
        : { to: "/insights/recovery", label: "View recovery plan" };

  const comparisonTrends = comparison?.categoryTrends.filter((t) => t.current > 0 || t.previous > 0) ?? [];
  const net = summary ? summary.overview.totalSalesReference - summary.overview.totalExpenses : 0;
  const comparedWith = previousLabel(comparison?.period);
  const changePercent =
    comparison && comparison.totals.previous > 0
      ? ((comparison.totals.current - comparison.totals.previous) / comparison.totals.previous) * 100
      : null;
  const periodComparison = summary?.periodComparison;
  const previousPeriodCaption = periodComparison
    ? periodComparison.previousStart.slice(0, 4) === periodComparison.previousEnd.slice(0, 4)
      ? `${formatDayRange(periodComparison.previousStart.slice(0, 10), periodComparison.previousEnd.slice(0, 10))}, ${periodComparison.previousStart.slice(0, 4)}`
      : `${formatCalendarDate(periodComparison.previousStart)} to ${formatCalendarDate(periodComparison.previousEnd)}`
    : null;
  const summaryDelta = (kind: "sales" | "expenses" | "net") => periodComparison && previousPeriodCaption
    ? {
        percent: periodComparison[kind].changePercent,
        amount: periodComparison[kind].changeAmount,
        against: previousPeriodCaption,
        upIsBad: kind === "expenses",
      }
    : null;
  const recordsHref = summary && !allTime
    ? `/records?${new URLSearchParams({ dateFrom: summary.periodStart.slice(0, 10), dateTo: summary.periodEnd.slice(0, 10) })}`
    : "/records";

  return (
    <div>
      <PageHead
        title="Dashboard"
        subtitle={selected ? <b className="font-semibold text-ink-700">{selected.name}</b> : "Set up your business to see figures."}
        actions={<PeriodFilter />}
      />

      {isRefreshing ? (
        <p role="status" aria-live="polite" className="sr-only">
          Refreshing dashboard…
        </p>
      ) : null}

      {/* First so it is seen above the fold on a phone; renders nothing unless offered. */}
      <TourInvite />

      {/* The recovery panel shares this tour marker when the greeting is disabled.
          A business is required because the greeting waits for its summary. */}
      {selected && preferences.showDashboardMascotMessage ? (
        <div data-tour="dashboard-summary">
          <GreetingHero summary={isInitialLoad ? null : summary} action={summary && summary.recordsNeedingReview > 0 ? (
            <Link to="/records/flagged" className="tap-inline group inline-flex items-center gap-0.5 text-xs font-semibold underline decoration-current/40 decoration-[1.5px] underline-offset-[3px] hover:decoration-current">
              Review {summary.recordsNeedingReview} {summary.recordsNeedingReview === 1 ? "record" : "records"}
              <ChevronRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </Link>
          ) : undefined} shortcuts={
            <nav aria-label="Quick actions" className="grid grid-cols-3 gap-2 sm:w-[19rem]">
              {[
                { to: "/records/sales/new", label: "Add sale", icon: Plus },
                { to: "/records/expenses/new", label: "Add expense", icon: Receipt },
                { to: "/records/receipts/new", label: "Scan receipt", icon: ScanLine },
              ].map(({ to, label, icon }) => (
                <Link
                  key={to}
                  to={to}
                  className="group flex min-h-tap flex-col items-center gap-2 rounded-xl px-2 py-3 text-center text-xs font-semibold text-ink-700 transition-colors hover:bg-paper-50 hover:text-ink-900"
                >
                  <IconTile icon={icon} />
                  {label}
                </Link>
              ))}
            </nav>
          } />
        </div>
      ) : null}

      {/* Zero-size marker for the tour's auto-start gate: present only once the
          dashboard fetch has settled, so the tour never opens over a skeleton. */}
      {!loading ? <span data-tour="dashboard-loaded" aria-hidden className="hidden" /> : null}

      {!loading && (summary || !selected) ? (
        <SetupProgress
          steps={[
            { label: "Set up your business profile", done: !!selected, href: "/onboarding" },
            { label: "Add an expense category", done: categories.length > 0, href: selected ? "/categories" : undefined },
            { label: "Record your first expense or sale", done: hasAnyRecords, href: selected ? "/records/expenses/new" : undefined },
            {
              label: "Set your expected monthly expenses",
              done: !recoveryNeedsSetup,
              href: selected ? `/business-profiles/${selected.id}/edit` : undefined,
            },
          ]}
        />
      ) : null}

      {!loading && periodIsEmpty ? (
        <div className="mb-6">
          <Callout tone="info">
            <b className="font-semibold">No records {periodPhrase(selection)}.</b>{" "}
            {latestRecordDate ? (
              <>
                Latest record:{" "}
                <span className="figure font-semibold text-ink-700">
                  {/* UTC: date-only columns stored at midnight UTC. */}
                  {new Date(latestRecordDate).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                </span>
                .{" "}
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setSelection(ALL_TIME)}
              className="tap-inline link"
            >
              Show all time
            </button>
          </Callout>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-tint-danger p-4 text-sm text-tone-danger ring-1 ring-edge-danger">
          <div>
            <b className="font-semibold">
              {summary ? "Dashboard couldn’t refresh." : "Dashboard couldn’t load."}
            </b>
            <p className="mt-0.5">{error}</p>
          </div>
          <button type="button" onClick={reload} className="tap rounded-lg bg-paper px-3 py-2 font-semibold text-ink-800 shadow-sm">
            Try again
          </button>
        </div>
      ) : null}

      {overviewRefreshError ? (
        <div className="mb-4">
          <Callout tone="warn">
            <b className="font-semibold">Dashboard details couldn’t refresh.</b>{" "}
            Showing recently loaded comparison and opportunity data. {overviewRefreshError}
            <button type="button" onClick={reloadExpenseOverview} className="tap-inline ml-2 font-semibold underline underline-offset-2">Reload dashboard details</button>
          </Callout>
        </div>
      ) : null}

      {isInitialLoad ? (
        <SkeletonDashboard />
      ) : !selected ? (
        <EmptyState
          image="/mascot/01-onboarding/emptydashboard.webp"
          title="Nothing to show yet"
          action={
            <ButtonLink to="/onboarding" variant="primary">
              Finish business setup
            </ButtonLink>
          }
        >
          Add your business details to see your figures.
        </EmptyState>
      ) : !summary ? null
      : (
        <div
          className="space-y-6"
          aria-busy={isRefreshing}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 text-xs leading-relaxed text-ink-500">
            <p className="inline-flex items-center gap-1.5"><RefreshCw aria-hidden className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin motion-reduce:animate-none" : ""}`} />{isRefreshing ? "Refreshing overview…" : overviewUpdatedAt ? <>Overview updated <time dateTime={new Date(overviewUpdatedAt).toISOString()}>{new Date(overviewUpdatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></> : "Overview update time unavailable"}</p>
            <p className="inline-flex items-center gap-1.5"><History aria-hidden className="h-3.5 w-3.5" />Latest transaction recorded: {latestRecordDate ? <time dateTime={latestRecordDate.slice(0, 10)}>{formatCalendarDate(latestRecordDate)}</time> : summary.lifetime?.recordCount === 0 ? "No records yet" : "Unavailable"}</p>
          </div>

          <section
            aria-label="Key figures"
            className="grid grid-cols-1 overflow-hidden rounded-xl border border-paper-200 bg-paper min-[360px]:grid-cols-2 xl:grid-cols-4"
          >
            <h2 className="sr-only">Key figures</h2>
            <div className="relative isolate min-w-0 overflow-hidden border-b border-paper-200 bg-gradient-to-b from-tint-brand/70 to-paper to-70% p-4 min-[360px]:border-r sm:p-5 xl:border-b-0">
              <Wallet
                aria-hidden="true"
                focusable="false"
                strokeWidth={1.5}
                className="pointer-events-none absolute -bottom-6 -right-6 -z-10 size-28 -rotate-12 text-tone-brand opacity-[0.07]"
              />
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-medium text-ink-600">
                  <span>Available funds</span>
                </p>
                <IconTile icon={Wallet} size="sm" />
              </div>
              <p className="figure mt-1 break-all text-xl font-semibold leading-tight tracking-[-0.02em] text-ink-900 sm:text-[1.75rem]">
                {formatMoney(summary.overview.availableFunds)}
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{fundsCalculation ? "Starting balance + confirmed records" : "From your business profile"}</p>
              <details className="mt-1 text-xs text-ink-500">
                <summary className="disclosure">How it’s calculated</summary>
                <p className="pb-1 leading-relaxed">{fundsProvenance}</p>
              </details>
            </div>
            <KpiCell
              label="Sales"
              icon={ArrowDownLeft}
              tone="info"
              value={formatMoney(summary.overview.totalSalesReference)}
              caption={periodCaption}
              delta={summaryDelta("sales")}
              className="border-b border-paper-200 xl:border-b-0 xl:border-r"
            />
            <KpiCell
              label="Expenses"
              icon={Receipt}
              tone="accent"
              value={formatMoney(summary.overview.totalExpenses)}
              caption={periodCaption}
              delta={
                summaryDelta("expenses") ?? (periodComparison === undefined && changePercent !== null && comparedWith && comparison
                  ? { percent: changePercent, amount: comparison.totals.current - comparison.totals.previous, against: comparedWith, upIsBad: true }
                  : null
                )
              }
              className="border-b border-paper-200 min-[360px]:border-b-0 min-[360px]:border-r"
            />
            <KpiCell
              label="Net"
              icon={Scale}
              tone={net < 0 ? "danger" : "brand"}
              value={`${net >= 0 ? "+" : "−"}${formatMoney(Math.abs(net))}`}
              valueTone={net < 0 ? "danger" : net > 0 ? "brand" : undefined}
              delta={summaryDelta("net")}
              caption={
                net < 0 ? "Expenses exceeded sales"
                  : summary.overview.totalSalesReference > 0
                  ? `${Math.round((net / summary.overview.totalSalesReference) * 100)}% of sales kept`
                  : "Sales minus expenses"
              }
            />
          </section>

          <div className="grid gap-5 lg:grid-cols-12">
            <RecoveryFocus summary={summary} needsSetup={recoveryNeedsSetup} action={recoveryAction} />
            <Panel title={<PanelTitle icon={BellRing}>Needs attention</PanelTitle>} className="min-w-0 lg:col-span-5" bodyClassName="!px-0 !pb-1">
              <ul className="divide-y divide-paper-200 border-t border-paper-200">
                <AttentionRow
                  icon={summary.recordsNeedingReview ? Flag : CheckCircle2}
                  title="Records to review"
                  value={String(summary.recordsNeedingReview)}
                  detail={summary.recordsNeedingReview ? "Flagged or pending review · all dates" : "All clear across your records"}
                  action={summary.recordsNeedingReview ? <ArrowLink to="/records/flagged">Review records</ArrowLink> : null}
                />
                {topOpportunity ? (
                  <AttentionRow icon={Lightbulb} title={topOpportunity.categoryName}
                    detail={<><span className="block text-ink-700">{topOpportunity.observation}</span><span className="mt-1 block">Spent {periodPhrase(selection)}: <span className="figure font-semibold">{formatMoney(topOpportunity.evidence.currentAmount)}</span></span></>}
                    action={<ArrowLink to="/insights/expense-behavior">Review reduction opportunity</ArrowLink>}
                  />
                ) : opportunityState === "error" ? (
                  <li className="px-5 py-3"><FeedNotice label="Reduction opportunities" onRetry={reloadExpenseOverview} /></li>
                ) : opportunityState === "loading" ? (
                  <li role="status" className="px-5 py-4 text-xs text-ink-500">Checking spending opportunities…</li>
                ) : topCategory ? (
                  <AttentionRow icon={PieChart} title="Largest expense category" value={`${Math.round(topCategory.percent)}%`}
                    detail={<><span className="font-medium text-ink-700">{topCategory.categoryName}</span> · <span className="figure">{formatMoney(topCategory.total)}</span><span className="mt-1 block">Of expenses {periodPhrase(selection)}</span></>}
                    action={<ArrowLink to="/insights/expense-behavior">See category spending</ArrowLink>}
                  />
                ) : null}
              </ul>
              <div className="grid grid-cols-2 border-t border-paper-200">
                <button type="button" onClick={() => askFinSight(expandQuestion)} aria-label="Ask FinSight about these figures" className="flex min-h-tap items-center justify-center gap-2 border-r border-paper-200 px-3 py-3 text-xs font-semibold text-tone-brand transition-colors hover:bg-paper-50">
                  <Sparkles aria-hidden className="h-4 w-4" />Ask FinSight
                </button>
                <Link to="/insights/spending-impact" className="flex min-h-tap items-center justify-center gap-2 px-3 py-3 text-xs font-semibold text-tone-brand transition-colors hover:bg-paper-50">
                  <ShoppingBag aria-hidden className="h-4 w-4" />Plan a purchase
                </Link>
              </div>
            </Panel>
          </div>

          <div className="grid gap-5 lg:grid-cols-12">
            <Panel
              title={<PanelTitle icon={BarChart3}>Cash flow</PanelTitle>}
              className="min-w-0 lg:col-span-12"
              action={
                <div role="group" aria-label="Cash flow range" className="inline-flex rounded-lg bg-paper-100 p-0.5 ring-1 ring-paper-200">
                  {(["monthly", "daily"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      aria-pressed={granularity === g}
                      onClick={() => setGranularity(g)}
                      className="min-h-tap rounded-md px-3 text-xs font-semibold text-ink-600 transition-colors aria-pressed:bg-paper aria-pressed:text-ink-900 aria-pressed:shadow-sm"
                    >
                      {g === "daily" ? "7 days" : "6 months"}
                    </button>
                  ))}
                </div>
              }
            >
              <p className="mb-4 text-xs text-ink-500">{granularity === "daily" ? "Last 7 days" : "Last 6 months"}, through today</p>
              {cashflow.state.status === "error" && cashflow.state.data ? <FeedNotice label="Cash flow" onRetry={cashflow.reload} retained /> : null}
              {cashflow.state.status === "error" && !cashflow.state.data ? (
                <FeedNotice label="Cash flow" onRetry={cashflow.reload} />
              ) : !cashflow.state.data ? (
                <div aria-live="polite" className="py-16 text-center text-sm text-ink-500">Loading cash flow…</div>
              ) : cashflow.state.data.points.every((p) => p.sales === 0 && p.expenses === 0) ? (
                <div className="py-14 text-center">
                  <p className="text-sm text-ink-600">
                    No sales or expenses in the {granularity === "daily" ? "last 7 days" : "last 6 months"}.
                  </p>
                  {granularity === "daily" ? (
                    <button
                      type="button"
                      onClick={() => setGranularity("monthly")}
                      className="tap-inline mt-2 text-sm link-action"
                    >
                      Show the last 6 months
                    </button>
                  ) : null}
                </div>
              ) : (
                <CashflowChart points={cashflow.state.data.points} granularity={cashflow.state.data.granularity} />
              )}
            </Panel>

          </div>

          <div className="grid gap-5 lg:grid-cols-12">
            <Panel
              title={<PanelTitle icon={ListOrdered}>Recent records</PanelTitle>}
              className="min-w-0 lg:col-span-7"
              bodyClassName="!px-0 !pb-2"
              action={<ArrowLink to={recordsHref}>View all records</ArrowLink>}
            >
              <p className="px-5 pb-3 text-xs text-ink-500">{periodCaption}</p>
              {recent.state.status === "error" && recent.state.data ? <div className="px-5"><FeedNotice label="Recent records" onRetry={recent.reload} retained /></div> : null}
              {recent.state.status === "error" && !recent.state.data ? (
                <div className="px-5"><FeedNotice label="Recent records" onRetry={recent.reload} /></div>
              ) : !recent.state.data ? (
                <div aria-live="polite" className="px-5 py-10 text-center text-sm text-ink-500">Loading records…</div>
              ) : recent.state.data.items.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-ink-500">No records {periodPhrase(selection)}.</p>
              ) : (
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <caption className="sr-only">Most recent records, {periodCaption}.</caption>
                  <colgroup>
                    <col className="w-[4rem] sm:w-24" />
                    <col />
                    <col className="w-[6rem] sm:w-36" />
                  </colgroup>
                  <thead>
                    <tr className="border-y border-paper-200 bg-paper-50 text-[11px] uppercase tracking-[0.06em] text-ink-500">
                      <th scope="col" className="px-3 py-2 font-semibold sm:px-5">Date</th>
                      <th scope="col" className="px-2 py-2 font-semibold sm:px-3">Record</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold sm:px-5">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.state.data.items.map((r) => (
                      <tr key={`${r.type}-${r.id}`} className="border-b border-paper-200 last:border-0">
                        <td className="figure px-3 py-2.5 text-xs text-ink-500 sm:px-5">
                          {new Date(r.date).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}
                        </td>
                        <td className="px-2 py-2 sm:px-3">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <IconTile size="sm" icon={r.type === "sales" ? ArrowDownLeft : Receipt} />
                            <Link to={`/records/${r.type === "sales" ? "sales" : "expenses"}/${r.id}/edit`} className="tap-inline break-words link-action">{r.description}</Link>
                          </div>
                          <p className="truncate pl-[2.375rem] text-xs text-ink-500">
                            {r.type === "sales"
                              ? "Sales"
                              : categories.find((c) => c.id === r.categoryId)?.name ?? "Expense"}
                          </p>
                          {r.reviewStatus === "Needs Review" || r.duplicateStatus === "Flagged" ? (
                            <div className="mt-1 flex flex-wrap gap-1 pl-[2.375rem]">
                              {r.reviewStatus === "Needs Review" ? <span className="rounded bg-tint-danger px-1.5 py-0.5 text-[11px] font-semibold text-tone-danger">Needs review</span> : null}
                              {r.duplicateStatus === "Flagged" ? <span className="rounded bg-tint-accent px-1.5 py-0.5 text-[11px] font-semibold text-tone-accent">Possible duplicate</span> : null}
                            </div>
                          ) : null}
                        </td>
                        <td className={`figure break-all px-3 py-2.5 text-right text-xs font-semibold sm:px-5 sm:text-sm ${r.type === "sales" ? "text-tone-brand" : "text-ink-900"}`}>
                          <span className="sr-only">{r.type === "sales" ? "Sale of " : "Expense of "}</span>
                          {r.type === "sales" ? "+" : "−"}
                          {formatMoney(r.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <UpcomingExpenses businessProfileId={selected.id} />
          </div>

          <div className="lg:hidden">
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((value) => !value)}
              className="tap flex min-h-tap w-full items-center justify-between rounded-xl border border-paper-200 bg-paper px-4 text-sm font-semibold text-ink-700 shadow-sm"
            >
              {showDetails ? "Hide charts" : "Show charts"}
              <IconArrowRight className={`h-4 w-4 transition-transform ${showDetails ? "rotate-90" : ""}`} />
            </button>
          </div>

          <div className={`${showDetails ? "grid" : "hidden"} gap-5 lg:grid ${allTime ? "" : "lg:grid-cols-12"}`}>
            <Panel
              title={<PanelTitle icon={PieChart}>Spending by category</PanelTitle>}
              className="min-w-0 lg:col-span-6"
              action={<ArrowLink to="/insights/expense-behavior">Expense insight</ArrowLink>}
            >
              {summary.expenseCategoryBreakdown.length === 0 ? (
                <EmptyState compact title={`No expenses ${periodPhrase(selection)}`} icon="◔" />
              ) : (
                <DonutChart breakdown={summary.expenseCategoryBreakdown} />
              )}
            </Panel>

            {/* All time has nothing before it to compare with. */}
            {!allTime ? (
              <Panel
                title={<PanelTitle icon={GitCompareArrows}>Expense comparison</PanelTitle>}
                className="min-w-0 lg:col-span-6"
                action={
                  changePercent !== null && comparedWith ? (
                    <Pill tone={changePercent > 0 ? "warn" : "ok"}>
                      {changePercent === 0 ? "No change" : `${Math.abs(changePercent).toFixed(0)}% ${changePercent > 0 ? "increase" : "decrease"}`} vs {comparedWith}
                    </Pill>
                  ) : null
                }
              >
                {comparisonState === "loading" ? (
                  <div aria-live="polite" className="py-8 text-center text-sm text-ink-500">Loading comparison…</div>
                ) : comparisonState === "error" ? (
                  <EmptyState
                    compact
                    title="Comparison couldn’t load"
                    action={
                      <button type="button" onClick={reloadExpenseOverview} className="tap rounded-lg border border-paper-200 bg-paper px-3 py-2 text-sm font-semibold text-brand-700">
                        Try again
                      </button>
                    }
                  />
                ) : comparisonTrends.length === 0 ? (
                  <EmptyState compact title="Nothing to compare yet" icon="◔" />
                ) : (
                  <CategoryComparisonChart
                    trends={comparison!.categoryTrends}
                    currentLabel={periodCaption}
                    resetKey={`${selected.id}:${JSON.stringify(selection)}`}
                    previousLabel={comparedWith ?? "Before"}
                  />
                )}
              </Panel>
            ) : null}
          </div>

          {!hasAnyRecords ? (
            <EmptyState
              image="/mascot/01-onboarding/emptydashboard.webp"
              title="No records yet"
              action={
                <ButtonLink to="/records/expenses/new" variant="primary">
                  Add your first expense
                </ButtonLink>
              }
            >
              Record an expense or import a CSV to see your figures.
            </EmptyState>
          ) : null}
        </div>
      )}

      <AskFinSightButton originModule="Dashboard" />
    </div>
  );
}
