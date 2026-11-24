import { useEffect, useRef, useState } from "react";
import { useListDisclosure } from "../components/ListDisclosure";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  Target,
  Wallet,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import {
  ReportingPeriodScope,
  useReportingPeriod,
} from "../context/ReportingPeriodContext";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { recoveryInsightRequest } from "../lib/screenRequests";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { PeriodFilter } from "../components/PeriodFilter";
import { Button, ButtonLink } from "../components/Button";
import { useAddRecordPopups } from "../components/useAddRecordPopups";
import { PageTip } from "../components/PageTip";
import { CumulativeSalesChart } from "./recovery/RecoveryCharts";
import { buildCumulativeSeries } from "./recovery/recoverySeries";
import type { RecoveryInsight, RecoveryPlan } from "../lib/types";
import { AiCard, Callout, Card, Kw, PageHead, Panel } from "../components/ui";
import { formatMoney } from "../components/Money";
import { EmptyState } from "../components/EmptyState";
import { SkeletonPanel, SkeletonRows, SkeletonStatTile } from "../components/Skeleton";
import { THIS_WEEK, periodKey, type PeriodSelection } from "../lib/reportingPeriod";
import {
  statusLabel,
  recoveryPeriodLabel,
  recoveryPeriodPhrase,
  recoveryPeriodStatusLabel,
  formatOperatingDayNumber,
  formatOperatingDays,
  reportingPeriodBasisSource,
  legacyReportingPeriod,
} from "./recovery/recoveryLabels";
import { RecoveryDailyCoverage } from "./recovery/RecoveryDailyCoverage";
import { RecoveryCheckpoints } from "./recovery/RecoveryCheckpoints";
import { RecoverySectionNav } from "./recovery/RecoverySectionNav";
import {
  SavedRecoveryPlanPanel,
  RecoveryScenarioPanel,
} from "./recovery/RecoveryPlanning";
import {
  RecoveryPrimaryAction,
  RecoveryChangeSincePreviousDay,
  RecoveryHero,
  RecoveryPaceCard,
  InputTile,
  OperatingDayDots,
  DailyTargetDrift,
  TileProgress,
  TodayProgressCard,
  RemainingTargetVisual,
} from "./recovery/RecoveryOverview";

export function RecoveryInsightPage() {
  return (
    <ReportingPeriodScope scope="recovery-target">
      <RecoveryInsightContent />
    </ReportingPeriodScope>
  );
}

function RecoveryInsightContent() {
  const { selected } = useBusinessProfiles();
  const {
    selection: sharedSelection,
    setSelection,
    ready: periodReady,
  } = useReportingPeriod();
  const selection: PeriodSelection =
    sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  const selectionKey = periodKey(selection);
  const recoveryScopeKey = JSON.stringify({
    businessProfileId: selected?.id ?? null,
    period: selection,
    periodReady,
  });
  const activeRecoveryScopeRef = useRef(recoveryScopeKey);
  activeRecoveryScopeRef.current = recoveryScopeKey;

  useEffect(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [setSelection, sharedSelection]);

  const [recoveryResult, setRecoveryResult] = useState<{
    scopeKey: string | null;
    data: RecoveryInsight | null;
    updatedAt: number | null;
  }>({ scopeKey: null, data: null, updatedAt: null });
  const [loading, setLoading] = useState(true);
  const [errorResult, setErrorResult] = useState<{
    scopeKey: string | null;
    message: string | null;
  }>({ scopeKey: null, message: null });
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the "expand on this" link below hands one through to
  // be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Recovery Target");
  // Guards against a slow response for a since-abandoned profile landing
  // after a newer one — without it, switching profiles quickly can let an
  // in-flight request for the PREVIOUS profile overwrite the current one's
  // freshly-loaded data.
  const requestId = useRef(0);
  const ownsRecoveryResult = recoveryResult.scopeKey === recoveryScopeKey;
  const data = ownsRecoveryResult ? recoveryResult.data : null;
  const dailyCoverageDisclosure = useListDisclosure({
    total: data?.dailyCoverage.length ?? 0,
    resetKey: recoveryScopeKey,
  });
  const dailyCoverageRows = data?.dailyCoverage ?? [];
  const visibleDailyCoverage = dailyCoverageDisclosure.expanded
    ? dailyCoverageRows
    : [...dailyCoverageRows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, dailyCoverageDisclosure.visibleCount);
  const dataUpdatedAt = ownsRecoveryResult ? recoveryResult.updatedAt : null;
  const recoveryLoading = ownsRecoveryResult ? loading : true;
  const error =
    errorResult.scopeKey === recoveryScopeKey ? errorResult.message : null;
  const reportingPeriod = data
    ? data.reportingPeriod ?? legacyReportingPeriod(data)
    : null;
  const isCurrentMonthView = Boolean(
    reportingPeriod?.kind === "month" && reportingPeriod.isCurrent,
  );
  const monthKey =
    reportingPeriod?.kind === "month" && reportingPeriod.month
      ? reportingPeriod.month
      : null;
  const planScopeKey =
    selected && isCurrentMonthView && monthKey
      ? `${selected.id}:${monthKey}`
      : null;
  const [planResult, setPlanResult] = useState<{
    scopeKey: string | null;
    plan: RecoveryPlan | null;
    state: "loading" | "ready" | "stale" | "unavailable";
    updatedAt: number | null;
  }>({ scopeKey: null, plan: null, state: "ready", updatedAt: null });
  const [planLoading, setPlanLoading] = useState(false);
  const planRequestId = useRef(0);
  const addRecord = useAddRecordPopups(() => void load(undefined, true));
  const ownsPlanResult = planScopeKey !== null && planResult.scopeKey === planScopeKey;
  const plan = ownsPlanResult ? planResult.plan : null;
  const planState = ownsPlanResult ? planResult.state : "ready";
  const planUpdatedAt = ownsPlanResult ? planResult.updatedAt : null;

  async function loadPlan(
    businessProfileId: number,
    planMonth: string,
    signal?: AbortSignal,
    force = false,
  ) {
    const thisPlanRequestId = ++planRequestId.current;
    const requestPlanScopeKey = `${businessProfileId}:${planMonth}`;
    const url = `/business-profiles/${businessProfileId}/recovery-plans`;
    const params = { month: planMonth };
    const scope = {
      businessProfileId,
      period: { month: planMonth },
      tags: ["recovery-plan", "financial"],
    };
    const cached = peekCachedApiData<RecoveryPlan[]>(url, { params }, scope);
    const retainedPlan = cached?.data[0] ?? (
      planResult.scopeKey === requestPlanScopeKey ? planResult.plan : null
    );
    const retainedUpdatedAt = cached?.updatedAt ?? (
      planResult.scopeKey === requestPlanScopeKey ? planResult.updatedAt : null
    );

    setPlanLoading(!cached || cached.stale || force);
    if (cached) {
      setPlanResult({
        scopeKey: requestPlanScopeKey,
        plan: cached.data[0] ?? null,
        state: "ready",
        updatedAt: cached.updatedAt,
      });
    } else if (!force) {
      setPlanResult({ scopeKey: requestPlanScopeKey, plan: null, state: "loading", updatedAt: null });
    }
    try {
      const { data } = await cachedApiGet<RecoveryPlan[]>(
        url,
        { signal, params },
        scope,
        { force },
      );
      if (
        signal?.aborted ||
        thisPlanRequestId !== planRequestId.current ||
        planScopeKey !== requestPlanScopeKey
      ) return;
      const snapshot = peekCachedApiData<RecoveryPlan[]>(url, { params }, scope);
      setPlanResult({
        scopeKey: requestPlanScopeKey,
        plan: data[0] ?? null,
        state: "ready",
        updatedAt: snapshot?.updatedAt ?? Date.now(),
      });
    } catch {
      if (
        signal?.aborted ||
        thisPlanRequestId !== planRequestId.current ||
        planScopeKey !== requestPlanScopeKey
      ) return;
      setPlanResult({
        scopeKey: requestPlanScopeKey,
        plan: retainedPlan,
        state: cached || retainedUpdatedAt !== null ? "stale" : "unavailable",
        updatedAt: retainedUpdatedAt,
      });
    } finally {
      if (!signal?.aborted && thisPlanRequestId === planRequestId.current) setPlanLoading(false);
    }
  }

  function applyPlanChange(nextPlan: RecoveryPlan | null) {
    if (!planScopeKey) return;
    setPlanResult({
      scopeKey: planScopeKey,
      plan: nextPlan,
      state: "ready",
      updatedAt: Date.now(),
    });
  }

  async function load(signal?: AbortSignal, force = false) {
    const requestScopeKey = recoveryScopeKey;
    if (activeRecoveryScopeRef.current !== requestScopeKey) return;
    const thisRequestId = ++requestId.current;
    /*
     * No business — an owner who chose "Skip for now". Settles rather than
     * bails: `loading` starts true and `isInitialLoad` is `loading && !data`,
     * so returning silently pinned this page to its skeleton for good.
    */
    if (!selected) {
      setRecoveryResult({ scopeKey: requestScopeKey, data: null, updatedAt: null });
      setErrorResult({ scopeKey: requestScopeKey, message: null });
      setLoading(false);
      return;
    }
    if (!periodReady) {
      setRecoveryResult({ scopeKey: requestScopeKey, data: null, updatedAt: null });
      setErrorResult({ scopeKey: requestScopeKey, message: null });
      setLoading(true);
      return;
    }
    const { url, params, scope } = recoveryInsightRequest(selected.id, selection);
    const cached = peekCachedApiData<RecoveryInsight>(url, { params }, scope);

    setLoading(!cached || cached.stale || force);
    setErrorResult({ scopeKey: requestScopeKey, message: null });
    if (cached) {
      setRecoveryResult({
        scopeKey: requestScopeKey,
        data: cached.data,
        updatedAt: cached.updatedAt,
      });
    } else if (!force) {
      setRecoveryResult({ scopeKey: requestScopeKey, data: null, updatedAt: null });
    }
    try {
      const { data: nextData } = await cachedApiGet<RecoveryInsight>(url, { signal, params }, scope, { force });
      if (
        signal?.aborted ||
        thisRequestId !== requestId.current ||
        activeRecoveryScopeRef.current !== requestScopeKey
      ) return;
      const snapshot = peekCachedApiData<RecoveryInsight>(
        "/insights/recovery",
        { params },
        scope,
      );
      setRecoveryResult({
        scopeKey: requestScopeKey,
        data: nextData,
        updatedAt: snapshot?.updatedAt ?? Date.now(),
      });
    } catch (err) {
      if (
        signal?.aborted ||
        (err as { name?: string })?.name === "AbortError" ||
        thisRequestId !== requestId.current ||
        activeRecoveryScopeRef.current !== requestScopeKey
      ) return;
      setErrorResult({
        scopeKey: requestScopeKey,
        message: getErrorMessage(err),
      });
    } finally {
      if (
        !signal?.aborted &&
        thisRequestId === requestId.current &&
        activeRecoveryScopeRef.current === requestScopeKey
      ) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selectionKey, periodReady]);

  useEffect(() => {
    const controller = new AbortController();
    if (selected && planScopeKey && monthKey) {
      void loadPlan(selected.id, monthKey, controller.signal);
    } else {
      planRequestId.current += 1;
      setPlanResult({
        scopeKey: null,
        plan: null,
        state: "ready",
        updatedAt: null,
      });
      setPlanLoading(false);
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planScopeKey]);

  const isInitialLoad = recoveryLoading && !data;
  const isRefreshing = recoveryLoading && data !== null;

  const currentMonthMeterData =
    data && reportingPeriod && isCurrentMonthView
      ? {
          ...data,
          expectedMonthlyExpenses: reportingPeriod.target,
          operatingDays: reportingPeriod.operatingDays,
          dailyNeededTarget: reportingPeriod.dailyTarget,
          salesThisMonth: reportingPeriod.sales,
          remainingTarget: reportingPeriod.remainingTarget,
          remainingOperatingDays: Number(
            formatOperatingDayNumber(
              reportingPeriod.remainingOperatingDays,
              reportingPeriod.operatingDaysIsApproximated,
            ),
          ),
          remainingOperatingDaysIsApproximated:
            reportingPeriod.operatingDaysIsApproximated,
          adjustedDailyTarget:
            reportingPeriod.adjustedDailyTarget ?? data.adjustedDailyTarget,
          monthCoveragePercent: reportingPeriod.coveragePercent,
          onTrack:
            reportingPeriod.status === "ahead" ||
            reportingPeriod.status === "on_pace" ||
            reportingPeriod.status === "covered",
          status:
            data.reportingPeriod
              ? reportingPeriod.status === "no_data"
                ? ("no_current_month_data" as const)
                : reportingPeriod.status
              : data.status,
        }
      : null;
  const inputAsOfDate = data?.reportingPeriod?.asOfDate ?? data?.asOfDate;
  const inputTimezone = data?.reportingPeriod?.timezone ?? data?.timezone;

  // Names the exact gap and target the card below just described, rather
  // than a generic "how much more sales do I need?".
  const expandQuestion = reportingPeriod
    ? `Why are my recorded sales ${formatMoney(Math.abs(reportingPeriod.paceVarianceAmount))} ${
        reportingPeriod.paceVarianceAmount < 0
          ? "behind"
          : reportingPeriod.paceVarianceAmount > 0
            ? "ahead of"
            : "on"
      } pace ${recoveryPeriodPhrase(reportingPeriod)}, and what should I review?`
    : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Recovery target"
        subtitle={selected ? selected.name : undefined}
        actions={<PeriodFilter showAllTime={false} />}
      />

      <InsightsTabs />

      <PageTip id="recovery-target" title="What the recovery target is">
        It is the sales you need this month to cover your expected monthly expenses. FinSight spreads what is left
        over the open days you have left, so the daily target changes as you record sales.
      </PageTip>

      {error && !data ? (
        <div className="mb-5">
          <Callout tone="warn">
            <b className="font-semibold">Couldn't load your recovery target.</b>{" "}
            {error}
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void load(undefined, true)}
                disabled={recoveryLoading}
              >
                {recoveryLoading ? "Retrying…" : "Retry"}
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}
      {error && data ? (
        <div className="mb-4">
          <Callout tone="warn">
            <b className="font-semibold">Showing the last successful result.</b>{" "}
            Refreshing failed: {error}
            {dataUpdatedAt ? (
              <> Last updated at {new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}.</>
            ) : null}
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void load(undefined, true)}
              >
                Retry
              </Button>
            </div>
          </Callout>
        </div>
      ) : null}

      {isInitialLoad ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading your recovery target…</span>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <SkeletonPanel lines={4} />
            <SkeletonPanel lines={4} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SkeletonPanel lines={6} />
            </div>
            <SkeletonPanel lines={6} />
          </div>
          <Card>
            <SkeletonRows rows={5} />
          </Card>
        </div>
      ) : !selected ? (
        /* A recovery target needs a selected business and its monthly basis. */
        <EmptyState
          image="/mascot/04-empty-states/nosalesrecords.webp"
          title="No recovery target yet"
          action={
            <ButtonLink to="/onboarding" variant="primary">
              Finish business setup
            </ButtonLink>
          }
        >
          Set up your business to track your sales target.
        </EmptyState>
      ) : data && reportingPeriod ? (
        <div
          className={`space-y-6 transition-opacity duration-200 ${isRefreshing ? "opacity-60" : ""}`}
          aria-busy={isRefreshing}
        >
          {isRefreshing ? (
            <span className="sr-only">Refreshing your recovery target…</span>
          ) : null}

          <RecoverySectionNav
            showCheckpoints={Boolean(
              reportingPeriod.kind === "month" &&
                data.weeklyCheckpoints?.length,
            )}
            showDailyPlan={!reportingPeriod.isComplete}
            showPlanning={isCurrentMonthView}
            hasSavedPlan={plan !== null}
          />

          <div
            id="recovery-overview"
            className="grid scroll-mt-6 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
          >
            <RecoveryHero
              title={
                isCurrentMonthView
                  ? "Month-to-date pace"
                  : reportingPeriod.kind === "week"
                    ? "This week's pace"
                    : `${recoveryPeriodLabel(reportingPeriod)} result`
              }
              period={reportingPeriod}
              currentMonthStatus={
                currentMonthMeterData ? currentMonthMeterData.status : null
              }
            />
            <RecoveryPaceCard
              period={reportingPeriod}
              action={
                isCurrentMonthView ? (
                  <RecoveryPrimaryAction
                    status={currentMonthMeterData?.status}
                    businessProfileId={selected.id}
                    onAddSale={addRecord.openSales}
                  />
                ) : null
              }
            />
          </div>

          <AiCard
            title="Summary"
            subtitle="Composed from your records, not AI-written"
            footer={
              <button
                type="button"
                onClick={() => askFinSight(expandQuestion)}
                className="tap-inline inline-flex items-center gap-1.5 font-semibold text-brand-200 underline-offset-2 hover:underline"
              >
                Ask about this period
                <ArrowRight
                  aria-hidden
                  className="size-3.5"
                />
              </button>
            }
          >
            Recorded sales {recoveryPeriodPhrase(reportingPeriod)} are{" "}
            <Kw>
              <span className="figure">
                {formatMoney(reportingPeriod.sales)}
              </span>
            </Kw>{" "}
            against a {formatMoney(reportingPeriod.target)} target. {" "}
            {recoveryPeriodStatusLabel(reportingPeriod)}.
            {!reportingPeriod.isComplete &&
            reportingPeriod.adjustedDailyTarget !== null ? (
              <>
                {" "}The remaining target is{" "}
                <Kw>
                  <span className="figure">
                    {formatMoney(reportingPeriod.remainingTarget)}
                  </span>
                </Kw>
                , or about{" "}
                <Kw>
                  <span className="figure">
                    {formatMoney(reportingPeriod.adjustedDailyTarget)}
                  </span>
                </Kw>{" "}
                per open day left.
              </>
            ) : null}
          </AiCard>

          <section aria-labelledby="recovery-inputs-title">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2
                id="recovery-inputs-title"
                className="text-lg font-semibold text-ink-900"
              >
                Inputs
              </h2>
              <span className="text-xs text-ink-500">
                {inputAsOfDate
                  ? `As of ${new Date(inputAsOfDate).toLocaleDateString(
                      undefined,
                      {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      },
                    )}${inputTimezone ? `, ${inputTimezone} time` : ""}`
                  : "Today"}
              </span>
            </div>
            <div
              className={`grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 ${
                isCurrentMonthView ? "xl:grid-cols-4" : "xl:grid-cols-3"
              }`}
            >
              <InputTile
                icon={Wallet}
                tone="neutral"
                label={
                  reportingPeriod.kind === "month"
                    ? "Monthly costs"
                    : "This week's target"
                }
                value={formatMoney(reportingPeriod.target)}
                sublabel={reportingPeriodBasisSource(data, reportingPeriod)}
              />
              <InputTile
                order={1}
                visual={
                  <OperatingDayDots
                    total={reportingPeriod.operatingDays}
                    elapsed={reportingPeriod.elapsedOperatingDays}
                    approximated={reportingPeriod.operatingDaysIsApproximated}
                  />
                }
                icon={CalendarDays}
                tone="info"
                label={
                  reportingPeriod.kind === "month"
                    ? "Operating days / month"
                    : "Operating days this week"
                }
                value={formatOperatingDays(
                  reportingPeriod.operatingDays,
                  reportingPeriod.operatingDaysIsApproximated,
                )}
                sublabel={
                  reportingPeriod.operatingScheduleConfigured
                    ? "From your operating schedule"
                    : reportingPeriod.kind === "week"
                      ? "Estimated for this week from your business profile"
                      : "Estimated from your business profile"
                }
              />
              <InputTile
                icon={Target}
                tone="brand"
                label={
                  reportingPeriod.operatingDaysIsApproximated
                    ? "Open-day target"
                    : "Sell this much each day"
                }
                value={formatMoney(reportingPeriod.dailyTarget)}
                sublabel="Computed from the two figures beside it"
                order={2}
                visual={
                  !reportingPeriod.isComplete &&
                  reportingPeriod.adjustedDailyTarget !== null ? (
                    <DailyTargetDrift
                      dailyTarget={reportingPeriod.dailyTarget}
                      adjusted={reportingPeriod.adjustedDailyTarget}
                    />
                  ) : undefined
                }
              />
              {isCurrentMonthView ? (
                <InputTile
                  icon={data.todaysStatus === "below" ? AlertTriangle : Check}
                  tone={data.todaysStatus === "below" ? "danger" : "brand"}
                  label="Status today"
                  order={3}
                  visual={
                    data.todaysTarget > 0 ? (
                      <TileProgress
                        percent={(data.todaysSales / data.todaysTarget) * 100}
                        tone={data.todaysStatus === "below" ? "danger" : "brand"}
                      />
                    ) : undefined
                  }
                  value={statusLabel(data.todaysStatus)}
                  sublabel={
                    data.todaysTarget > 0
                      ? `${((data.todaysSales / data.todaysTarget) * 100).toFixed(0)}% of today's target reached`
                      : undefined
                  }
                />
              ) : null}
            </div>
            <p className="mt-3 text-xs text-ink-500">
              {reportingPeriod.operatingDaysIsApproximated
                ? "Open-day target = the period's target ÷ its estimated open days."
                : "Sell this much each day = the period's target ÷ its open days."}
            </p>
            {reportingPeriod.kind === "month" && reportingPeriod.isComplete ? (
              <p className="mt-1 text-xs text-ink-500">
                Targets use your current business profile settings. Past
                versions are not stored.
              </p>
            ) : null}
          </section>

          {isCurrentMonthView ? (
            <RecoveryChangeSincePreviousDay
              change={data.changeSincePreviousDay}
            />
          ) : null}

          <Panel
              title="Sales vs. target"
              eyebrow={`Running totals, ${recoveryPeriodLabel(reportingPeriod)}`}
              className="min-w-0"
            >
              <CumulativeSalesChart
                points={buildCumulativeSeries(
                  data.dailyCoverage,
                  reportingPeriod,
                  reportingPeriod.kind === "month"
                    ? data.weeklyCheckpoints ?? []
                    : [],
                )}
              />
            </Panel>

          {/* `tabIndex={-1}` makes this focusable-by-script-only (not part of
              the normal tab order) so `focusSection` above can move keyboard
              focus here after the "View today's plan" anchor scrolls to it —
              WCAG 2.4.3. */}
          {!reportingPeriod.isComplete ? (
            <div
              id="remaining-recovery-target"
              tabIndex={-1}
              className="scroll-mt-6 focus:outline-none"
            >
              <Panel
                title={
                  reportingPeriod.kind === "month"
                    ? "Remaining recovery target"
                    : "Remaining weekly target"
                }
                eyebrow="What's left, split across your open days"
              >
                <RemainingTargetVisual
                  targetLabel={
                    reportingPeriod.kind === "month"
                      ? "Monthly costs"
                      : "This week's target"
                  }
                  target={reportingPeriod.target}
                  targetSource={reportingPeriodBasisSource(data, reportingPeriod)}
                  sales={reportingPeriod.sales}
                  remaining={reportingPeriod.remainingTarget}
                  daysLeft={formatOperatingDays(
                    reportingPeriod.remainingOperatingDays,
                    reportingPeriod.operatingDaysIsApproximated,
                  )}
                  operatingDays={reportingPeriod.operatingDays}
                  elapsedDays={reportingPeriod.elapsedOperatingDays}
                  approximated={reportingPeriod.operatingDaysIsApproximated}
                  dailyGoal={reportingPeriod.adjustedDailyTarget}
                />
                {reportingPeriod.operatingDaysIsApproximated ? (
                  <p className="mt-3 text-xs text-ink-500">
                    Open days left is an estimate: your profile
                    records how many days a month you operate, not which days of
                    the week, so this scales the count across the selected
                    period.{" "}
                    <Link
                      to={`/business-profiles/${selected.id}/operating-schedule`}
                      className="tap-inline inline-flex items-center gap-1.5 link"
                    >
                      Edit operating schedule
                      <ArrowRight
                        aria-hidden
                        className="size-3.5"
                      />
                    </Link>
                  </p>
                ) : reportingPeriod.operatingScheduleConfigured ? (
                  <p className="mt-3 text-xs text-ink-500">
                    Based on your configured operating days
                    {` (${formatOperatingDayNumber(
                      reportingPeriod.operatingDays,
                      false,
                    )} in ${recoveryPeriodLabel(reportingPeriod)})`}.
                  </p>
                ) : null}
                {reportingPeriod.dataWarnings.length > 0 &&
                reportingPeriod.provisionalSales > 0 ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Includes {formatMoney(reportingPeriod.provisionalSales)}{" "}
                    pending review or flagged as a possible duplicate.
                  </p>
                ) : null}
              </Panel>
            </div>
          ) : null}

          {(() => {
            const showCheckpoints = Boolean(
              reportingPeriod.kind === "month" &&
                data.weeklyCheckpoints &&
                data.weeklyCheckpoints.length > 0,
            );
            if (!showCheckpoints && !isCurrentMonthView) return null;
            return (
              <div className="grid gap-4 lg:grid-cols-3">
                {showCheckpoints ? (
                  <div
                    id="recovery-checkpoints"
                    className={`min-w-0 scroll-mt-6 ${
                      isCurrentMonthView ? "lg:col-span-2" : "lg:col-span-3"
                    }`}
                  >
                    <RecoveryCheckpoints
                      key={recoveryScopeKey}
                      checkpoints={data.weeklyCheckpoints!}
                      todayKey={reportingPeriod.asOfDate}
                      periodName={recoveryPeriodLabel(reportingPeriod)}
                      periodComplete={reportingPeriod.isComplete}
                    />
                  </div>
                ) : null}
                {isCurrentMonthView ? (
                  <div
                    className={`min-w-0 ${showCheckpoints ? "" : "lg:col-span-3"}`}
                  >
                    <TodayProgressCard data={data} />
                  </div>
                ) : null}
              </div>
            );
          })()}

          {isCurrentMonthView &&
          monthKey &&
          (planState === "stale" || planState === "unavailable") ? (
            <div role="status">
              <Callout tone="warn">
                <b className="font-semibold">
                  {planState === "stale"
                    ? plan
                      ? "Showing the last loaded saved plan."
                      : "Showing the last saved-plan check."
                    : "Couldn't check for a saved plan."}
                </b>{" "}
                {planState === "stale"
                  ? `${plan ? "The latest refresh failed" : "It found no plan, but the latest refresh failed"}${
                      planUpdatedAt
                        ? `; last checked at ${new Date(planUpdatedAt).toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                          })}`
                        : ""
                    }.`
                  : "Your recovery target is still available, but saved-plan details are temporarily unavailable."}
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void loadPlan(selected.id, monthKey, undefined, true)
                    }
                    disabled={planLoading}
                  >
                    {planLoading ? "Retrying saved plan…" : "Retry saved plan"}
                  </Button>
                </div>
              </Callout>
            </div>
          ) : null}

          {isCurrentMonthView && monthKey && plan ? (
            <div id="recovery-saved-plan" className="scroll-mt-6">
              <SavedRecoveryPlanPanel
                key={`${selected.id}-${monthKey}`}
                businessProfileId={selected.id}
                monthKey={monthKey}
                plan={plan}
                onPlanChange={applyPlanChange}
              />
            </div>
          ) : null}

          {isCurrentMonthView && monthKey ? (
            <div id="recovery-scenario" className="scroll-mt-6">
              <RecoveryScenarioPanel
                // Forces a remount on profile or planning month switch so the
                // scenario's local input and result cannot leak across scope.
                key={`${selected.id}-${monthKey}`}
                businessProfileId={selected.id}
                currentExpectedMonthlyExpenses={reportingPeriod.target}
                monthKey={monthKey}
                hasSavedPlan={plan !== null}
                onPlanSaved={applyPlanChange}
              />
            </div>
          ) : null}

          <RecoveryDailyCoverage
            rows={data.dailyCoverage}
            visibleRows={visibleDailyCoverage}
            totalRows={dailyCoverageRows.length}
            disclosure={dailyCoverageDisclosure}
            reportingPeriod={reportingPeriod}
            businessName={selected.name}
            scopeKey={recoveryScopeKey}
          />

        </div>
      ) : null}

      {addRecord.popups}
      <AskFinSightButton originModule="Recovery Target" />
    </div>
  );
}
