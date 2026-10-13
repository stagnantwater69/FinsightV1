import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { getErrorMessage } from "../lib/errors";
import { CategoryBreakdownChart } from "../components/CategoryBreakdownChart";
import { CategoryComparisonChart } from "../components/CategoryComparisonChart";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { SkeletonDashboard } from "../components/Skeleton";
import { EmptyState, SetupProgress } from "../components/EmptyState";
import { GreetingHero } from "../components/GreetingHero";
import { ButtonLink } from "../components/Button";
import { formatMoney } from "../components/Money";
import { DonutChart } from "../components/DonutChart";
import { PeriodFilter } from "../components/PeriodFilter";
import { Callout, KpiCard, Panel, PageHead, Pill } from "../components/ui";
import { IconArrowRight, IconCheck, IconExpense, IconInsights, IconSales } from "../components/icons";
import type { DashboardSummary, ReductionOpportunity } from "../lib/types";
import type { DashboardExpenseComparison, DashboardExpenseOverview } from "../lib/expenseOverview";
import { ALL_TIME, periodLabel, periodParams, periodPhrase, previousLabel } from "../lib/reportingPeriod";
import { useServerStateRefresh } from "../lib/useServerStateRefresh";
import { formatCalendarDate } from "../lib/dates";

export function Dashboard() {
  return (
    <ReportingPeriodScope>
      <DashboardPage />
    </ReportingPeriodScope>
  );
}

function DashboardPage() {
  const { selected } = useBusinessProfiles();
  // The ONE mascot this preference governs — Fin's daily line below. Every
  // other appearance (Ask FinSight, the tour, empty states, onboarding) is a
  // reply to something the owner just did, not an unprompted daily message,
  // and stays put.
  const { preferences } = useAuth();
  const { categories } = useExpenseCategories();
  const { selection, setSelection, ready: periodReady } = useReportingPeriod();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<DashboardExpenseComparison | null>(null);
  const [comparisonState, setComparisonState] = useState<"loading" | "ready" | "error">("loading");
  const [opportunityState, setOpportunityState] = useState<"loading" | "ready" | "error">("loading");
  const [overviewRefreshError, setOverviewRefreshError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  /** The selected period's top eligible opportunity from the overview projection. */
  const [topOpportunity, setTopOpportunity] = useState<ReductionOpportunity | null>(null);
  const askFinSight = useAskFinSight("Dashboard");
  const periodKey = JSON.stringify(selection);
  const allTime = selection.kind === "all";
  const dashboardScopeKey = JSON.stringify({
    businessProfileId: selected?.id ?? null,
    period: selection,
    periodReady,
  });
  const activeDashboardScopeRef = useRef(dashboardScopeKey);
  activeDashboardScopeRef.current = dashboardScopeKey;
  const isInitialLoad = loading && !summary;
  const isRefreshing = loading && !!summary;

  async function load(signal?: AbortSignal, force = false) {
    const requestScopeKey = dashboardScopeKey;
    if (activeDashboardScopeRef.current !== requestScopeKey) return;
    /*
     * No business — an owner who chose "Skip for now". This must SETTLE, not
     * just return: `loading` starts true, so bailing out silently left the
     * page under its skeleton forever.
     */
    if (!selected) {
      setSummary(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Wait for the period's default (the newest month with records) so the
    // page loads once, for the right period.
    if (!periodReady) {
      setSummary(null);
      setError(null);
      setLoading(true);
      return;
    }
    const params = { businessProfileId: selected.id, ...periodParams(selection) };
    const scope = {
      businessProfileId: selected.id,
      period: selection,
      tags: ["dashboard", "financial"],
    };
    const cached = peekCachedApiData<DashboardSummary>(
      "/dashboard/summary",
      { params },
      scope,
    );

    setLoading(!cached || cached.stale || force);
    setError(null);
    if (cached) setSummary(cached.data);
    else if (!force) setSummary(null);
    try {
      const { data } = await cachedApiGet<DashboardSummary>(
        "/dashboard/summary",
        { signal, params },
        scope,
        { force },
      );
      if (activeDashboardScopeRef.current !== requestScopeKey) return;
      setError(null);
      setSummary(data);
    } catch (err) {
      // A superseded request is not a failure: switching business mid-flight
      // must not settle the OLD business's figures under the new heading.
      if (
        signal?.aborted ||
        (err as { name?: string })?.name === "AbortError" ||
        activeDashboardScopeRef.current !== requestScopeKey
      ) return;
      setError(getErrorMessage(err));
    } finally {
      if (!signal?.aborted && activeDashboardScopeRef.current === requestScopeKey) setLoading(false);
    }
  }

  useLayoutEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodKey, periodReady]);

  function applyExpenseOverview(overview: DashboardExpenseOverview) {
    if (overview.comparison.status === "available") {
      setComparison(overview.comparison.data);
      setComparisonState("ready");
    } else {
      setComparison(null);
      setComparisonState("error");
    }

    if (overview.topOpportunity.status === "available") {
      const top = overview.topOpportunity.data;
      setTopOpportunity(top && top.confidence !== "limited" ? top : null);
      setOpportunityState("ready");
    } else {
      setTopOpportunity(null);
      setOpportunityState("error");
    }
  }

  /** One shared server computation supplies both optional dashboard panels. */
  async function loadExpenseOverview(signal?: AbortSignal, force = false) {
    const requestScopeKey = dashboardScopeKey;
    if (activeDashboardScopeRef.current !== requestScopeKey) return;
    if (!selected || !periodReady || allTime) {
      setComparison(null);
      setTopOpportunity(null);
      setComparisonState("ready");
      setOpportunityState("ready");
      setOverviewRefreshError(null);
      return;
    }
    if (!force) setOverviewRefreshError(null);

    const params = {
      businessProfileId: selected.id,
      ...periodParams(selection),
      view: "dashboard" as const,
    };
    const scope = {
      businessProfileId: selected.id,
      period: selection,
      tags: ["dashboard", "financial", "expense-overview"],
    };
    const cached = peekCachedApiData<DashboardExpenseOverview>(
      "/insights/expense-overview",
      { params },
      scope,
    );

    if (cached) {
      applyExpenseOverview(cached.data);
    } else if (!force) {
      setComparison(null);
      setTopOpportunity(null);
      setComparisonState("loading");
      setOpportunityState("loading");
    }

    try {
      const { data } = await cachedApiGet<DashboardExpenseOverview>(
        "/insights/expense-overview",
        { signal, params },
        scope,
        { force },
      );
      if (activeDashboardScopeRef.current !== requestScopeKey) return;
      setOverviewRefreshError(null);
      applyExpenseOverview(data);
    } catch (err) {
      if (
        signal?.aborted ||
        (err as { name?: string })?.name === "AbortError" ||
        activeDashboardScopeRef.current !== requestScopeKey
      ) return;
      const hadUsableData = cached
        ? cached.data.comparison.status === "available" || cached.data.topOpportunity.status === "available"
        : force && (comparisonState === "ready" || opportunityState === "ready");
      if (hadUsableData) {
        setOverviewRefreshError(getErrorMessage(err));
        return;
      }
      setComparison(null);
      setTopOpportunity(null);
      setComparisonState("error");
      setOpportunityState("error");
    }
  }

  useLayoutEffect(() => {
    const controller = new AbortController();
    void loadExpenseOverview(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodKey, periodReady]);

  useServerStateRefresh(
    [{
      resource: "/dashboard/summary",
      businessProfileId: selected?.id ?? null,
      period: selection,
      tags: ["dashboard", "financial"],
    }],
    (signal) => void load(signal, true),
  );

  useServerStateRefresh(
    [{
      resource: "/insights/expense-overview",
      businessProfileId: selected?.id ?? null,
      period: selection,
      tags: ["dashboard", "financial", "expense-overview"],
    }],
    (signal) => void loadExpenseOverview(signal, true),
  );

  /*
   * NO BUSINESS DOES NOT MEAN NO PAGE. The dashboard renders its own chrome —
   * heading, period filter, setup checklist — around its own empty state.
   * Nothing below may assume `selected`.
   */

  /*
   * "Has this business ever recorded anything" — NOT "did it record anything
   * in the selected period". An owner who imported two years of history must
   * not see "Record your first expense or sale" unticked because none of it
   * falls in this week. Falls back to the period figures for an older server.
   */
  const hasAnyRecords = summary?.lifetime
    ? summary.lifetime.recordCount > 0
    : !!summary && (summary.overview.totalExpenses > 0 || summary.overview.totalSalesReference > 0);

  /** Records exist, just none in this period — said, so it never reads as a failed import. */
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

  const topCategory = summary?.expenseCategoryBreakdown?.length
    ? [...summary.expenseCategoryBreakdown].sort((a, b) => b.total - a.total)[0]
    : null;

  /**
   * Recovery reduced to a KPI-sized verdict.
   *
   * Prefers the server's explicit `status` (plan §8.1), which can tell "no
   * sales yet this month" from "behind pace"; falls back to the boolean pair
   * for an older response. An explicit status keeps a valid record-derived
   * zero from being mistaken for missing setup.
   */
  const recovery: { label: string; meta: ReactNode; tone: "brand" | "accent" | "danger" | "info" } = !summary
    ? { label: "—", meta: "", tone: "info" }
    : summary.recoveryStatus.status
      ? (() => {
          const r = summary.recoveryStatus;
          switch (r.status) {
            case "needs_setup":
              return { label: "Not set up", meta: "Add a starting monthly estimate", tone: "info" as const };
            case "no_current_month_data":
              return { label: "No sales yet", meta: "No sales this month", tone: "info" as const };
            case "data_incomplete":
              return { label: "Data incomplete", meta: "Some records need review", tone: "info" as const };
            case "covered":
              return {
                label: "Target reached",
                meta: `${Math.round(r.monthCoveragePercent)}% of the month covered`,
                tone: "brand" as const,
              };
            case "ahead":
              return {
                label: "Ahead of pace",
                meta: `${Math.round(r.monthCoveragePercent)}% of the month covered`,
                tone: "brand" as const,
              };
            case "on_pace":
              return {
                label: "On track",
                meta: `${Math.round(r.monthCoveragePercent)}% of the month covered`,
                tone: "brand" as const,
              };
            case "behind":
            default:
              return {
                label: "Behind pace",
                meta: (
                  <>
                    <span className="figure">{formatMoney(r.remainingTarget)}</span> still needed
                  </>
                ),
                tone: "danger" as const,
              };
          }
        })()
      : recoveryNeedsSetup
        ? { label: "Not set up", meta: "Add a starting monthly estimate", tone: "info" }
        : summary.recoveryStatus.onTrack
          ? {
              label: "On track",
              meta: `${Math.round(summary.recoveryStatus.monthCoveragePercent)}% of the month covered`,
              tone: "brand",
            }
          : {
              label: "Behind pace",
              meta: (
                <>
                  <span className="figure">{formatMoney(summary.recoveryStatus.remainingTarget)}</span> still needed
                </>
              ),
              tone: "danger",
            };

  // Names the specific thing on screen — the records needing review if any,
  // otherwise the top category — rather than a generic "summarise this".
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
  const comparedWith = previousLabel(comparison?.period);
  const changePercent =
    comparison && comparison.totals.previous > 0
      ? ((comparison.totals.current - comparison.totals.previous) / comparison.totals.previous) * 100
      : null;

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

      {/* data-tour="dashboard-summary" is the product tour's "dashboard
          overview" spotlight. The recovery panel below carries the same marker
          as a fallback for an owner who turned the daily message off. The
          `selected &&` guard: with no business there is no fetch, so the
          greeting's skeleton lines would never resolve. */}
      {selected && preferences.showDashboardMascotMessage ? (
        <div data-tour="dashboard-summary">
          <GreetingHero summary={isInitialLoad ? null : summary} />
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
          ]}
        />
      ) : null}

      {/* One line above the panels explains all of them: the records exist,
          just not in this period, and where they are. */}
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
              className="tap-inline font-semibold text-brand-700 underline underline-offset-2"
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
          <button type="button" onClick={() => void load(undefined, true)} className="tap rounded-lg bg-paper px-3 py-2 font-semibold text-ink-800 shadow-sm">
            Try again
          </button>
        </div>
      ) : null}

      {overviewRefreshError ? (
        <div className="mb-4">
          <Callout tone="warn">
            <b className="font-semibold">Dashboard details couldn’t refresh.</b>{" "}
            Showing recently loaded comparison and opportunity data. {overviewRefreshError}
          </Callout>
        </div>
      ) : null}

      {/* Doherty: the dashboard commits to its shape on load and on every
          period or business switch, so the change feels instant. */}
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
          className={`space-y-6 transition-opacity duration-200 ${isRefreshing ? "opacity-60" : ""}`}
          aria-busy={isRefreshing}
        >
          {/*
            Serial position: available funds first (the figure owners check
            most), expenses and sales as a pair in the middle, and the recovery
            verdict as the "so what" an owner leaves with.
          */}
          <Panel
            title="Recovery position"
            className="overflow-hidden border-brand-200 bg-tint-brand"
            action={<Pill tone={recovery.tone === "danger" ? "danger" : recovery.tone === "brand" ? "ok" : "info"}>{recovery.label}</Pill>}
          >
            <div data-tour="dashboard-summary" className="grid items-center gap-5 lg:grid-cols-[0.72fr_1.28fr]">
              <div>
                <p className="text-xs font-semibold text-ink-500">Available funds</p>
                <p className="figure mt-1 font-display text-3xl font-bold tracking-[-0.02em] text-ink-900">
                  {formatMoney(summary.overview.availableFunds)}
                </p>
                <p className="mt-1 max-w-[48ch] text-xs leading-relaxed text-ink-500">
                  {fundsProvenance}
                </p>
                {recovery.meta ? <p className="mt-2 text-sm font-medium text-ink-700">{recovery.meta}</p> : null}
                <ButtonLink to={recoveryAction.to} variant="primary" className="mt-4">
                  {recoveryAction.label}
                </ButtonLink>
              </div>
              <div className="border-t border-paper-200 pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                {!recoveryNeedsSetup ? (
                  <RecoveryMeter recoveryStatus={summary.recoveryStatus} />
                ) : (
                  <p className="text-sm text-ink-600">Add a starting monthly expense estimate to get a daily sales target.</p>
                )}
              </div>
            </div>
          </Panel>

          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard
              label="Total expenses"
              value={<span className="figure">{formatMoney(summary.overview.totalExpenses)}</span>}
              meta={periodCaption}
              glyph={<IconExpense className="h-5 w-5" />}
              tone="accent"
            />
            <KpiCard
              label="Total sales"
              value={<span className="figure">{formatMoney(summary.overview.totalSalesReference)}</span>}
              meta={periodCaption}
              glyph={<IconSales className="h-5 w-5" />}
              tone="info"
            />
            <KpiCard
              label="Records to review"
              value={<span className="figure">{summary.recordsNeedingReview}</span>}
              meta={
                summary.recordsNeedingReview ? (
                  <Link to="/records/flagged" className="tap-inline font-semibold text-brand-700 hover:text-brand-800">
                    Open review queue
                  </Link>
                ) : (
                  "All clear"
                )
              }
              glyph={summary.recordsNeedingReview ? <IconInsights className="h-5 w-5" /> : <IconCheck className="h-5 w-5" />}
              tone={summary.recordsNeedingReview ? "danger" : "brand"}
            />
          </div>

          {/*
            Composed from the figures on this page, NOT AI-written, so it does
            not claim to be. Real AI is one click away in Ask FinSight.
          */}
          <Panel title="Largest expense category">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-600">
                {topCategory ? (
                  <>
                    <b className="font-semibold text-ink-800">{topCategory.categoryName}</b>{" "}
                    <span className="figure font-semibold text-ink-800">{formatMoney(topCategory.total)}</span>
                  </>
                ) : (
                  <>No expenses {periodPhrase(selection)}.</>
                )}
              </p>
              <button
                type="button"
                onClick={() => askFinSight(expandQuestion)}
                aria-label="Ask FinSight about these figures"
                className="tap-inline min-h-tap text-sm font-semibold text-brand-700 hover:text-brand-800"
              >
                Ask FinSight
              </button>
            </div>
          </Panel>

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

          <div className={`${showDetails ? "grid" : "hidden"} gap-5 lg:grid ${allTime ? "" : "lg:grid-cols-2"}`}>
            <Panel title="Expense distribution" className="min-w-0">
              {summary.expenseCategoryBreakdown.length === 0 ? (
                <EmptyState compact title={`No expenses ${periodPhrase(selection)}`} icon="◔" />
              ) : (
                <>
                  <DonutChart breakdown={summary.expenseCategoryBreakdown} />
                  {/* Bars below the donut: a donut answers "what share", the
                      bars answer "how much bigger". */}
                  <div className="mt-5 border-t border-paper-200 pt-4">
                    <CategoryBreakdownChart breakdown={summary.expenseCategoryBreakdown} />
                  </div>
                </>
              )}
            </Panel>

            {/* All time has nothing before it to compare with. */}
            {!allTime ? (
              <Panel
                title="Expense comparison"
                className="min-w-0"
                action={
                  changePercent !== null && comparedWith ? (
                    <Pill tone={changePercent > 0 ? "warn" : "ok"}>
                      <span aria-hidden>{changePercent > 0 ? "▲" : changePercent < 0 ? "▼" : "="}</span>
                      {Math.abs(changePercent).toFixed(0)}% vs {comparedWith}
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
                      <button type="button" onClick={() => void loadExpenseOverview(undefined, true)} className="tap rounded-lg border border-paper-200 bg-paper px-3 py-2 text-sm font-semibold text-brand-700">
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
                    previousLabel={comparedWith ?? "Before"}
                  />
                )}
              </Panel>
            ) : null}
          </div>

          {/* The top reduction opportunity only: the full list stays on Expense
              Insights (§5.1). Hidden rather than shown empty. */}
          {topOpportunity ? (
            <Panel
              title="Reduction opportunity"
              action={<Pill tone="warn">{topOpportunity.categoryName}</Pill>}
            >
              <p className="text-sm text-ink-700">{topOpportunity.observation}</p>
              <p className="mt-2 text-xs text-ink-500">
                Spent {periodPhrase(selection)}:{" "}
                <span className="figure font-semibold text-ink-800">
                  {formatMoney(topOpportunity.evidence.currentAmount)}
                </span>
              </p>
              <div className="mt-4 border-t border-paper-200 pt-3">
                <Link
                  to="/insights/expense-behavior"
                  className="tap-inline text-sm font-semibold text-brand-700 hover:text-brand-800"
                >
                  Review opportunity
                </Link>
              </div>
            </Panel>
          ) : opportunityState === "error" ? (
            <Callout tone="info">
              <b className="font-semibold">Reduction opportunities unavailable.</b>{" "}
              <button type="button" onClick={() => void loadExpenseOverview(undefined, true)} className="tap-inline min-h-tap font-semibold text-brand-700 underline underline-offset-2">
                Try again
              </button>
            </Callout>
          ) : null}

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
