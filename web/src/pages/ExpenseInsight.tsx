import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconTile } from "../components/IconTile";
import { Link } from "react-router-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  ChartPie,
  Flag,
  Lightbulb,
  Repeat,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useExpenseCategories } from "../context/ExpenseCategoryContext";
import { cachedApiGet, peekCachedApiData } from "../lib/serverStateApi";
import { expenseOverviewDetailRequest } from "../lib/screenRequests";
import { getErrorMessage } from "../lib/errors";
import { InsightsTabs } from "../components/AppShell";
import { AskFinSightButton, useAskFinSight } from "../components/AskFinSightButton";
import { DailySpendChart } from "../components/DailySpendChart";
import { SkeletonPanel, SkeletonStatTile } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { SectionNav, type SectionNavItem } from "../components/SectionNav";
import { Button, ButtonLink } from "../components/Button";
import { useAddRecordPopups } from "../components/useAddRecordPopups";
import { formatMoney } from "../components/Money";
import { CATEGORICAL_PALETTE } from "../lib/chartPalette";
import { RecurringAgenda } from "../components/RecurringAgenda";
import { ScheduleFormModal } from "./RecurringScheduleForm";
import { PageHead, Panel, Callout } from "../components/ui";
import { PeriodFilter } from "../components/PeriodFilter";
import { SeeAllFooter } from "../components/SeeAllFooter";
import { CandidateRow } from "./expenseInsight/reviewItems";
import {
  CANDIDATES_PREVIEW_COUNT,
  EXPENSE_RECURRING_PATH,
  SCHEDULES_PREVIEW_COUNT,
  dismissRecurringPattern,
  openFindingsRequest,
  recurringPatternsRequest,
  recurringSchedulesRequest,
  watchRecurringPattern,
} from "./expenseInsight/reviewRequests";
import {
  ReportingPeriodScope,
  useReportingPeriod,
} from "../context/ReportingPeriodContext";
import {
  THIS_WEEK,
  periodLabel as periodCaptionOf,
  periodPhrase,
  previousLabel as previousLabelOf,
  type PeriodSelection,
} from "../lib/reportingPeriod";
import type {
  AnomalyFinding,
  AnomalyFindingPage,
  ExpenseBehavior as ExpenseInsightData,
  FinancialPosition,
  FlaggedRecordCounts,
  FlaggedRecordPage,
  RecordItem,
  RecurringPattern,
  RecurringSchedule,
  ReductionOpportunityResponse,
} from "../lib/types";
import type { DetailExpenseOverview } from "../lib/expenseOverview";
import { useServerStateRefresh } from "../lib/useServerStateRefresh";
import { KpiTile, PairBars, ShareBar, Sparkline } from "./expenseInsight/ExpenseVisuals";
import { ExpenseSummaryCard } from "./expenseInsight/ExpenseSummaryCard";
import { useListDisclosure } from "../components/ListDisclosure";
import {
  loadPanel,
  type SupplementState,
  failedSupplementState,
  combinedSupplementState,
  isDefinitiveScheduleUnavailable,
} from "./expenseInsight/supplement";
import { CategorySummary } from "./expenseInsight/CategorySummary";
import { ReductionOpportunitiesPanel } from "./expenseInsight/ReductionOpportunities";
import {
  SupplementNotice,
  FlaggedExpensesPanel,
  UnusualExpensesPanel,
} from "./expenseInsight/ExpenseReview";

// The donut colours categories by rank, so the largest one is always slot 1.
// Slot 1 is byte-identical in the light and dark palettes (see the table in
// chartPalette.ts), which is why it can be read here without the theme hook.
const TOP_CATEGORY_COLOR = CATEGORICAL_PALETTE[0]!;

/**
 * Expense Insight.
 *
 * The audience is a small-business owner, not an accountant. So every panel
 * here answers a plain question in the order someone actually asks it:
 *
 *   1. How much did I spend, and is that a lot?      — the KPI row
 *   2-4. Where did it go, what changed, exactly      — Category summary table
 *   5. Anything I should act on?                     — Large expense flags + FinSight's own read of the panel
 *   6. When did it leave?                            — Daily spending
 *   7. Anything odd, statistically?                  — Unusual expenses (Z-score)
 *
 * No panel assumes a term the reader might not have. The funds share uses the
 * server's recorded balance; increases lead with pesos before percentages.
 *
 * Every share percentage on this screen divides by the SAME server-computed
 * `totals.current`. That sounds obvious and is exactly what mixed-denominator
 * dashboards get wrong — a donut saying 59.6% beside a table saying 45.7% for
 * the same category destroys trust in every other number on the page.
 */

/**
 * This page is intentionally comprehensive, but comprehensive should not mean
 * forcing an owner to remember where a section sits in a long scroll. The
 * compact index stays ordinary document navigation (real anchors, no hidden
 * state), so it works with keyboard, browser history, and reduced motion.
 */
function ExpenseSectionNav({
  showOpportunities,
  showRecurring,
}: {
  showOpportunities: boolean;
  showRecurring: boolean;
}) {
  const items: SectionNavItem[] = [
    { href: "#expense-overview", label: "Overview", icon: ChartPie },
    { href: "#expense-categories", label: "Categories", icon: Boxes },
    ...(showOpportunities
      ? [
          {
            href: "#expense-opportunities",
            label: "Opportunities",
            icon: Lightbulb,
          },
        ]
      : []),
    { href: "#expense-review", label: "Review", icon: Flag },
    ...(showRecurring
      ? [{ href: "#expense-recurring", label: "Recurring", icon: Repeat }]
      : []),
  ];

  return <SectionNav ariaLabel="Expense insight sections" items={items} />;
}

// The panel is a summary, not the full review queue — FlaggedRecords already
// owns that job. Capped the same way the AI context builder caps it
// server-side (aiContext.service.ts: `take: 5`), so the two surfaces never
// disagree about what "a short list" means.
const MAX_FLAGGED_SHOWN = 5;


/**
 * How many flagged records this panel's short list asks the server for.
 *
 * It only ever shows five expenses, but the flagged list is expenses and sales
 * interleaved by date, so it asks for one page and filters. What it must NOT
 * do is what it did before — send no bound and take the whole flagged history
 * of the business (megabytes, on a re-imported spreadsheet) to render five
 * rows and a count. The count comes from /records/flagged/count now.
 */
const FLAGGED_PANEL_PAGE_SIZE = 100;

export function ExpenseInsight() {
  return (
    <ReportingPeriodScope scope="expense-insight">
      <ExpenseInsightPage />
    </ReportingPeriodScope>
  );
}

function ExpenseInsightPage() {
  const { selected, getFinancialPosition } = useBusinessProfiles();
  const { categories } = useExpenseCategories();
  const {
    selection: sharedSelection,
    setSelection,
    ready: periodReady,
  } = useReportingPeriod();
  // Normalize unsupported All time before this page builds a request.
  const selection: PeriodSelection =
    sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  const periodKey = JSON.stringify(selection);
  const allTime = selection.kind === "all";
  const expenseScopeKey = JSON.stringify({
    businessProfileId: selected?.id ?? null,
    period: selection,
    periodReady,
  });
  const activeExpenseScopeRef = useRef(expenseScopeKey);
  activeExpenseScopeRef.current = expenseScopeKey;

  useEffect(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [setSelection, sharedSelection]);
  const [data, setData] = useState<ExpenseInsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [flaggedExpenses, setFlaggedExpenses] = useState<RecordItem[]>([]);
  const [flaggedListState, setFlaggedListState] = useState<SupplementState>("loading");
  /**
   * How many flagged expenses exist, as opposed to how many are on screen.
   * `null` means the count request didn't answer, in which case the panel
   * falls back to counting what it managed to load rather than claiming a
   * number it doesn't have.
   */
  const [flaggedExpenseCount, setFlaggedExpenseCount] = useState<number | null>(null);
  const [flaggedCountState, setFlaggedCountState] = useState<SupplementState>("loading");
  const [findings, setFindings] = useState<AnomalyFinding[]>([]);
  /** The schedule open in the edit popup; null with the popup open is "add". */
  const [editingSchedule, setEditingSchedule] = useState<RecurringSchedule | null>(null);
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  const [findingsState, setFindingsState] = useState<SupplementState>("loading");
  const [recurringPatterns, setRecurringPatterns] = useState<
    RecurringPattern[]
  >([]);
  const [patternsState, setPatternsState] = useState<SupplementState>("loading");
  /**
   * Owner-declared schedules — the agenda. Distinct from the patterns above,
   * which are only what the detector suspects.
   *
   * NULL IS NOT THE EMPTY LIST. Null means there is no usable schedules
   * snapshot, so the agenda is hidden outright. A failed refresh keeps an
   * existing snapshot and marks it stale instead of turning known payments
   * into a false empty or unavailable state.
   */
  const [recurringSchedules, setRecurringSchedules] = useState<
    RecurringSchedule[] | null
  >(null);
  const [schedulesState, setSchedulesState] = useState<SupplementState>("loading");
  /**
   * Reduction opportunities — a self-contained panel with its own error/retry
   * state (plan §10.3), unlike the supplements above that fail silently into
   * "unavailable". A deterministic review prompt is useful enough on its own
   * that a transient failure here deserves an explicit retry, not a quiet
   * disappearance.
   */
  const [reductionOpportunities, setReductionOpportunities] =
    useState<ReductionOpportunityResponse | null>(null);
  const [reductionLoading, setReductionLoading] = useState(true);
  const [reductionError, setReductionError] = useState<string | null>(null);
  const [financialPosition, setFinancialPosition] =
    useState<FinancialPosition | null>(null);
  const [financialPositionProfileId, setFinancialPositionProfileId] =
    useState<number | null>(null);
  const [financialPositionLoading, setFinancialPositionLoading] =
    useState(false);
  const [financialPositionError, setFinancialPositionError] = useState<
    string | null
  >(null);
  const [financialPositionReload, setFinancialPositionReload] = useState(0);
  // Opens the Ask FinSight drawer over this page. The plain floating trigger
  // goes with no question; the "expand on this" link below hands one through to
  // be typed into the box for them — it is never sent on their behalf.
  const askFinSight = useAskFinSight("Expense Insights");

  useEffect(() => {
    if (!selected) {
      setFinancialPosition(null);
      setFinancialPositionProfileId(null);
      setFinancialPositionLoading(false);
      setFinancialPositionError(null);
      return;
    }

    const businessProfileId = selected.id;
    const controller = new AbortController();
    setFinancialPosition(null);
    setFinancialPositionProfileId(businessProfileId);
    setFinancialPositionLoading(true);
    setFinancialPositionError(null);

    void (async () => {
      try {
        const next = await getFinancialPosition(
          businessProfileId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (!Number.isFinite(next.availableFunds?.calculatedAmount)) {
          throw new Error("Recorded available funds are unavailable.");
        }
        setFinancialPosition(next);
      } catch (err) {
        if (controller.signal.aborted) return;
        setFinancialPositionError(getErrorMessage(err));
      } finally {
        if (!controller.signal.aborted) setFinancialPositionLoading(false);
      }
    })();

    return () => controller.abort();
    // The provider recreates this method when its profile list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected?.id,
    selected?.availableFunds,
    selected?.availableFundsBaselineAt,
    financialPositionReload,
  ]);

  function applyExpenseOverview(overview: DetailExpenseOverview) {
    setRefreshError(null);
    if (overview.behavior.status === "available") {
      setData(overview.behavior.data);
      setError(null);
    } else {
      setData(null);
      setError("The expense behavior panel is temporarily unavailable.");
    }

    if (overview.opportunities.status === "available") {
      setReductionOpportunities(overview.opportunities.data);
      setReductionError(null);
    } else {
      setReductionOpportunities(null);
      setReductionError("Please try again.");
    }
  }

  /** One owned-context computation supplies the two core panels independently. */
  async function loadExpenseOverview(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected || !periodReady) return;
    const { url, params, scope } = expenseOverviewDetailRequest(selected.id, selection);
    const cached = peekCachedApiData<DetailExpenseOverview>(url, { params }, scope);

    if (cached) {
      applyExpenseOverview(cached.data);
    } else if (!force) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setReductionOpportunities(null);
      setReductionError(null);
    }
    setLoading(!cached || cached.stale || force);
    setReductionLoading(!cached || cached.stale || force);

    try {
      const { data: overview } = await cachedApiGet<DetailExpenseOverview>(
        url,
        { signal, params },
        scope,
        { force },
      );
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      applyExpenseOverview(overview);
    } catch (err) {
      if (
        signal?.aborted ||
        (err as { name?: string })?.name === "AbortError" ||
        activeExpenseScopeRef.current !== requestScopeKey
      ) return;
      const message = getErrorMessage(err);
      if (cached?.data.behavior.status === "available" || (force && data)) {
        setRefreshError(message);
      } else if (!cached) {
        setData(null);
        setError(message);
        setReductionOpportunities(null);
        setReductionError(message);
      }
    } finally {
      if (!signal?.aborted && activeExpenseScopeRef.current === requestScopeKey) {
        setLoading(false);
        setReductionLoading(false);
      }
    }
  }

  async function loadSupplementPanels(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected || !periodReady) return;
    const businessProfileId = selected.id;
    const flaggedParams = { businessProfileId, limit: FLAGGED_PANEL_PAGE_SIZE };
    const flaggedScope = {
      businessProfileId,
      filters: { flagged: true, type: "all" },
      pagination: { cursor: null, limit: FLAGGED_PANEL_PAGE_SIZE },
      tags: ["records", "financial"],
    };
    const flaggedCountParams = { businessProfileId };
    const flaggedCountScope = {
      businessProfileId,
      filters: { flagged: true },
      tags: ["records", "financial"],
    };
    const { params: findingsParams, scope: findingsScope } =
      openFindingsRequest(businessProfileId);
    const applyFlaggedPage = (page: FlaggedRecordPage) =>
      setFlaggedExpenses(
        page.items
          .filter((record) => record.type === "expense")
          .sort((left, right) => (left.date < right.date ? 1 : -1)),
      );

    const cachedFlagged = peekCachedApiData<FlaggedRecordPage>(
      "/records/flagged",
      { params: flaggedParams },
      flaggedScope,
    );
    const cachedFlaggedCount = peekCachedApiData<FlaggedRecordCounts>(
      "/records/flagged/count",
      { params: flaggedCountParams },
      flaggedCountScope,
    );
    const cachedFindings = peekCachedApiData<AnomalyFindingPage>(
      "/insights/findings",
      { params: findingsParams },
      findingsScope,
    );
    if (cachedFlagged) {
      applyFlaggedPage(cachedFlagged.data);
      setFlaggedListState("ready");
    } else if (!force) {
      setFlaggedExpenses([]);
      setFlaggedListState("loading");
    }
    if (cachedFlaggedCount) {
      setFlaggedExpenseCount(cachedFlaggedCount.data.expenses);
      setFlaggedCountState("ready");
    } else if (!force) {
      setFlaggedExpenseCount(null);
      setFlaggedCountState("loading");
    }
    if (cachedFindings) {
      setFindings(cachedFindings.data.items);
      setFindingsState("ready");
    } else if (!force) {
      setFindings([]);
      setFindingsState("loading");
    }

    // Fired together; each supplement still settles independently.
    await Promise.all([
      loadPanel(
        cachedApiGet<FlaggedRecordPage>(
          "/records/flagged",
          { signal, params: flaggedParams },
          flaggedScope,
          { force },
        ),
        (page) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            applyFlaggedPage(page);
            setFlaggedListState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFlaggedListState(failedSupplementState);
          }
        },
        signal,
      ),
      loadPanel(
        cachedApiGet<FlaggedRecordCounts>(
          "/records/flagged/count",
          { signal, params: flaggedCountParams },
          flaggedCountScope,
          { force },
        ),
        (counts) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFlaggedExpenseCount(counts.expenses);
            setFlaggedCountState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFlaggedCountState(failedSupplementState);
          }
        },
        signal,
      ),
      loadPanel(
        cachedApiGet<AnomalyFindingPage>(
          "/insights/findings",
          { signal, params: findingsParams },
          findingsScope,
          { force },
        ),
        (page) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFindings(page.items);
            setFindingsState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setFindingsState(failedSupplementState);
          }
        },
        signal,
      ),
    ]);
  }

  async function load(signal?: AbortSignal, forceOverview = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    /*
     * No business — an owner who chose "Skip for now". Settles instead of
     * bailing: `loading` starts true and `isInitialLoad` is `loading && !data`,
     * so a silent return left this page under its skeleton for good.
     */
    if (!selected) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setLoading(false);
      setReductionOpportunities(null);
      setReductionError(null);
      setReductionLoading(false);
      setFlaggedExpenses([]);
      setFlaggedExpenseCount(null);
      setFindings([]);
      setRecurringPatterns([]);
      setRecurringSchedules(null);
      setFlaggedListState("ready");
      setFlaggedCountState("ready");
      setFindingsState("ready");
      setPatternsState("ready");
      setSchedulesState("ready");
      return;
    }
    // Wait for the period's default so the page loads once, for the right period.
    if (!periodReady) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setLoading(true);
      setReductionOpportunities(null);
      setReductionError(null);
      setReductionLoading(true);
      setFlaggedExpenses([]);
      setFlaggedExpenseCount(null);
      setFindings([]);
      setRecurringPatterns([]);
      setRecurringSchedules(null);
      setFlaggedListState("loading");
      setFlaggedCountState("loading");
      setFindingsState("loading");
      setPatternsState("loading");
      setSchedulesState("loading");
      return;
    }

    await Promise.all([
      loadExpenseOverview(signal, forceOverview),
      loadSupplementPanels(signal, forceOverview),
      loadRecurring(signal, forceOverview),
    ]);
  }

  /**
   * Promotes a detector candidate into an owner-owned schedule.
   *
   * A POST to /confirm, not the old PATCH to `{ status: "CONFIRMED" }`. That
   * PATCH marked the pattern confirmed and nothing else, which made it vanish
   * from this panel with no schedule behind it and nowhere in the app to see it
   * again — the exact defect the agenda below exists to close. The server does
   * both writes in one transaction and seeds the label from the pattern's own
   * description, so nothing is sent in the body.
   */
  async function confirmPattern(id: number) {
    const requestScopeKey = expenseScopeKey;
    setError(null);
    try {
      await watchRecurringPattern(selected!.id, id);
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      // Both lists move: the candidate leaves this panel and a schedule appears
      // in the agenda. Refetched rather than patched in state because the new
      // schedule's `dueState` is server-computed and this page must not guess it.
      await loadRecurring();
    } catch (err) {
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      // 409 when the pattern already has a schedule — which happens if the
      // owner has this page open in two tabs. Said out loud rather than left
      // as an unhandled rejection with a button that appears to do nothing.
      setError(getErrorMessage(err));
    }
  }

  async function dismissPattern(id: number) {
    const requestScopeKey = expenseScopeKey;
    setError(null);
    try {
      await dismissRecurringPattern(selected!.id, id);
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      setRecurringPatterns((current) =>
        current.map((pattern) =>
          pattern.id === id ? { ...pattern, status: "DISMISSED" } : pattern,
        ),
      );
    } catch (err) {
      if (activeExpenseScopeRef.current !== requestScopeKey) return;
      setError(getErrorMessage(err));
    }
  }

  async function loadRecurringSchedules(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected) return;
    const businessProfileId = selected.id;
    const { params: schedulesParams, scope: schedulesScope } =
      recurringSchedulesRequest(businessProfileId);
    const cachedSchedules = peekCachedApiData<RecurringSchedule[]>(
      "/insights/recurring-schedules",
      { params: schedulesParams },
      schedulesScope,
    );
    if (cachedSchedules) {
      setRecurringSchedules(cachedSchedules.data);
      setSchedulesState("ready");
    } else if (!force) {
      setRecurringSchedules(null);
      setSchedulesState("loading");
    }

    await loadPanel(
      cachedApiGet<RecurringSchedule[]>(
        "/insights/recurring-schedules",
        { signal, params: schedulesParams },
        schedulesScope,
        { force },
      ),
      (schedules) => {
        if (activeExpenseScopeRef.current === requestScopeKey) {
          setRecurringSchedules(schedules);
          setSchedulesState("ready");
        }
      },
      (error) => {
        if (activeExpenseScopeRef.current !== requestScopeKey) return;
        if (isDefinitiveScheduleUnavailable(error)) {
          setRecurringSchedules(null);
          setSchedulesState("unavailable");
          return;
        }
        setSchedulesState(failedSupplementState);
      },
      signal,
    );
  }

  /**
   * The two recurring reads settle independently because schedules can be
   * feature-gated while detector patterns remain available.
   */
  async function loadRecurring(signal?: AbortSignal, force = false) {
    const requestScopeKey = expenseScopeKey;
    if (activeExpenseScopeRef.current !== requestScopeKey) return;
    if (!selected) return;
    const businessProfileId = selected.id;
    const { params: patternsParams, scope: patternsScope } =
      recurringPatternsRequest(businessProfileId);
    const cachedPatterns = peekCachedApiData<RecurringPattern[]>(
      "/insights/recurring-patterns",
      { params: patternsParams },
      patternsScope,
    );
    if (cachedPatterns) {
      setRecurringPatterns(cachedPatterns.data);
      setPatternsState("ready");
    } else if (!force) {
      setRecurringPatterns([]);
      setPatternsState("loading");
    }

    await Promise.all([
      loadPanel(
        cachedApiGet<RecurringPattern[]>(
          "/insights/recurring-patterns",
          { signal, params: patternsParams },
          patternsScope,
          { force },
        ),
        (patterns) => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setRecurringPatterns(patterns);
            setPatternsState("ready");
          }
        },
        () => {
          if (activeExpenseScopeRef.current === requestScopeKey) {
            setPatternsState(failedSupplementState);
          }
        },
        signal,
      ),
      loadRecurringSchedules(signal, force),
    ]);
  }

  useLayoutEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, periodKey, periodReady]);

  useServerStateRefresh(
    [{
      resource: "/insights/expense-overview",
      businessProfileId: selected?.id ?? null,
      period: selection,
      tags: ["expense-insight", "financial", "expense-overview"],
    }],
    (signal) => void loadExpenseOverview(signal, true),
  );

  useServerStateRefresh(
    [{
      resource: selected
        ? `/business-profiles/${selected.id}/financial-position`
        : "/business-profiles/financial-position",
      businessProfileId: selected?.id ?? null,
      tags: ["financial"],
    }],
    () => setFinancialPositionReload((version) => version + 1),
  );

  useServerStateRefresh(
    [
      {
        resource: "/records/flagged",
        businessProfileId: selected?.id ?? null,
        tags: ["records", "financial"],
      },
      {
        resource: "/records/flagged/count",
        businessProfileId: selected?.id ?? null,
        tags: ["records", "financial"],
      },
      {
        resource: "/insights/findings",
        businessProfileId: selected?.id ?? null,
        tags: ["insights-findings", "financial"],
      },
    ],
    (signal) => void loadSupplementPanels(signal, true),
  );

  useServerStateRefresh(
    [
      {
        resource: "/insights/recurring-patterns",
        businessProfileId: selected?.id ?? null,
        tags: ["recurring-patterns", "financial"],
      },
      {
        resource: "/insights/recurring-schedules",
        businessProfileId: selected?.id ?? null,
        tags: ["recurring-schedules", "financial"],
      },
    ],
    (signal) => void loadRecurring(signal, true),
  );

  // A refetch with data already on screen is a refresh, not a load — see the
  // note on the skeleton below.
  const isInitialLoad = loading && !data;
  const isRefreshing = loading && !!data;

  const periodCaption = periodCaptionOf(selection);
  const periodText = periodPhrase(selection);
  /** What changes are measured against: "August 2026", or the same days of it. */
  const comparedWith = previousLabelOf(data?.period) ?? "Previous period";
  const currentFinancialPosition =
    financialPositionProfileId === selected?.id ? financialPosition : null;
  const recordedAvailableFunds = Number.isFinite(
    currentFinancialPosition?.availableFunds.calculatedAmount,
  )
    ? currentFinancialPosition!.availableFunds.calculatedAmount
    : null;
  const currentFinancialPositionError =
    financialPositionProfileId === selected?.id
      ? financialPositionError
      : null;
  const availableFundsAreLoading =
    !!selected &&
    (financialPositionProfileId !== selected.id || financialPositionLoading);
  const startingFundsFallback =
    currentFinancialPositionError && Number.isFinite(selected?.availableFunds)
      ? selected!.availableFunds
      : null;
  const availableFundsDenominator =
    recordedAvailableFunds ?? startingFundsFallback;
  const usingStartingFundsFallback =
    recordedAvailableFunds === null && startingFundsFallback !== null;

  /**
   * The schedules read doubles as the availability probe for everything that
   * WRITES a schedule — confirming a candidate creates one, and the server gates
   * both together. So if the agenda could not be read, "Watch this" cannot work
   * either, and it is not offered.
   */
  const canWatchPatterns = recurringSchedules !== null;
  const candidatePatterns = recurringPatterns.filter(
    (pattern) => pattern.status === "CANDIDATE",
  );
  const hasCandidates = candidatePatterns.length > 0;
  const categoryDisclosure = useListDisclosure({
    total: data?.categoryTrends.length ?? 0,
    resetKey: expenseScopeKey,
  });
  // Saving refreshes this page through its server-state subscriptions.
  const addRecord = useAddRecordPopups();
  const flaggedDisclosure = useListDisclosure({
    total: flaggedExpenses.length,
    limit: MAX_FLAGGED_SHOWN,
    resetKey: expenseScopeKey,
  });
  // With no agenda and no candidates the whole block is an empty container.
  const showRecurringBlock =
    recurringSchedules !== null ||
    hasCandidates ||
    patternsState === "stale" ||
    patternsState === "unavailable";

  /*
   * The flags panel counts with the server's number and lists with its own
   * page. `flaggedExpenses.length` used to be both, which was only ever right
   * because the request was unbounded — now the list is one page of at most a
   * hundred and the count is a count, so "3 more — review all" stays honest
   * for a business with three thousand.
   */
  const flaggedTotal = flaggedExpenseCount ?? flaggedExpenses.length;
  const hasFlaggedRecordLink =
    flaggedTotal > Math.min(flaggedExpenses.length, MAX_FLAGGED_SHOWN);
  const flaggedState = combinedSupplementState([flaggedListState, flaggedCountState]);
  const showFlaggedPanel = flaggedState !== "ready" || flaggedTotal > 0;
  const showFindingsPanel = findingsState !== "ready" || findings.length > 0;
  const reductionHasOpportunities =
    (reductionOpportunities?.opportunities.length ?? 0) > 0;
  const showReductionPanel =
    reductionLoading ||
    !!reductionError ||
    !!refreshError ||
    reductionHasOpportunities;
  const showUnusualPanel =
    isRefreshing || !!refreshError || (data?.unusualExpenses.length ?? 0) > 0;

  // ---- headline figures, all from one denominator ----
  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.totals.current;
    const spending = data.categoryTrends.filter((t) => t.current > 0);
    const top = spending[0] ?? null; // already sorted by current, descending

    // Biggest increase by PESO movement, not by percentage — a 300% rise on a
    // PHP 200 category is noise, and percentage ranking puts it first.
    const risen = [...data.categoryTrends]
      .filter((t) => t.change > 0)
      .sort((a, b) => b.change - a.change);

    const periodDelta = total - data.totals.previous;
    // All time has no earlier period; its fourth figure is the monthly average.
    const monthsCovered = data.dailyBucket === "month" ? data.dailyTotals.length : 0;
    const periodPercent =
      data.totals.previous > 0
        ? (periodDelta / data.totals.previous) * 100
        : null;

    return {
      total,
      expenseCount: data.categoryTrends.reduce((sum, trend) => sum + trend.recordCount, 0),
      categoryCount: spending.length,
      top,
      topShare: top && total > 0 ? (top.current / total) * 100 : 0,
      biggestIncrease: risen[0] ?? null,
      periodDelta,
      periodPercent,
      monthlyAverage: monthsCovered > 0 ? total / monthsCovered : null,
      // All-time spending cannot be compared meaningfully with today's balance.
      fundsShare:
        availableFundsDenominator !== null &&
        availableFundsDenominator > 0 &&
        data.dailyBucket !== "month"
          ? (total / availableFundsDenominator) * 100
          : null,
    };
  }, [availableFundsDenominator, data]);

  /*
   * No `if (!selected) return <NoBusinessProfile />` any more. This page only
   * READS, so with no business it renders its own chrome — heading, period
   * picker, insights tabs — around its own empty state, rather than a gate
   * card. The `!selected` branch in the body below both supplies that state
   * and narrows `selected` for everything after it.
   */

  // Findings belong to the period page, so the pointer shows only when that page does.
  const showPeriodFindings =
    !!selected && !!summary && summary.total !== 0 && showFindingsPanel;
  const lowerRowCount =
    Number(showRecurringBlock && recurringSchedules !== null) +
    Number(
      showRecurringBlock &&
        (hasCandidates || patternsState === "stale" || patternsState === "unavailable"),
    );

  function categoryName(categoryId?: number) {
    return categories.find((c) => c.id === categoryId)?.name ?? "—";
  }


  // Names the exact category and figure the card above just named — a much
  // more useful starting point in the drawer than a generic "why did my
  // expenses increase?" that makes the owner retype what's already on screen.
  const expandQuestion = summary?.biggestIncrease && !allTime
    ? `Why did ${summary.biggestIncrease.categoryName} increase by ${formatMoney(summary.biggestIncrease.change)} compared with ${comparedWith}?`
    : summary?.top
      ? `Why is ${summary.top.categoryName} my highest expense category ${periodText}?`
      : undefined;

  return (
    <div>
      <PageHead
        eyebrow="Insights"
        title="Expense insight"
        actions={<PeriodFilter showAllTime={false} />}
      />

      <InsightsTabs />

      {error ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-tint-danger px-3.5 py-3 text-sm text-tone-danger ring-1 ring-edge-danger"
        >
          <div className="min-w-0">
            <p className="font-semibold">Expense insight couldn’t load</p>
            <p className="mt-0.5 text-xs opacity-90">{error}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void load(undefined, true)}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}

      {refreshError ? (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-tint-accent px-3.5 py-3 text-sm text-tone-accent ring-1 ring-edge-accent"
        >
          <div className="min-w-0">
            <p className="font-semibold">Expense insight couldn’t refresh</p>
            <p className="mt-0.5 text-xs opacity-90">
              Showing recently loaded figures. {refreshError}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void loadExpenseOverview(undefined, true)}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry refresh"}
          </Button>
        </div>
      ) : null}

      {/* Skeleton only when this exact business and period have no cached data.
          A scoped cached result stays in place at reduced opacity while it is
          refreshed; data from another business or period is never reused. */}
      {isInitialLoad ? (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading expense insights…</span>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1.35fr_1fr_1fr_1fr]">
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
            <SkeletonStatTile />
          </div>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <SkeletonPanel lines={6} />
            <SkeletonPanel lines={6} />
          </div>
          <SkeletonPanel lines={5} />
        </div>
      ) : !selected ? (
        /*
         * Nothing to analyse, because there is nothing at all yet. Same shape
         * as the "no expenses recorded" state below — this is that state one
         * step earlier, and only the action that closes it differs.
         */
        <EmptyState
          title="No expenses yet"
          icon="◔"
          action={
            <ButtonLink to="/onboarding" variant="primary">
              Finish business setup
            </ButtonLink>
          }
        >
          Set up your business to record expenses.
        </EmptyState>
      ) : !data || !summary ? null : summary.total === 0 ? (
        /*
          TWO DIFFERENT EMPTINESSES. "Never recorded an expense" and "has
          hundreds, none in this period" must not get the same advice: telling
          an owner who just imported 527 expenses to import some is the app
          contradicting what they just did.
        */
        data.latestExpenseDate ? (
          <EmptyState
            title={`No expenses ${periodText}`}
            icon="◔"
          >
            Latest expense:{" "}
            {new Date(data.latestExpenseDate).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
          </EmptyState>
        ) : (
          <EmptyState
            title="No expenses yet"
            icon="◔"
            action={
              <>
                <Button variant="primary" onClick={addRecord.openExpense}>
                  Add an expense
                </Button>
                <ButtonLink to="/records/csv-imports/new" variant="secondary">
                  Import CSV
                </ButtonLink>
              </>
            }
          />
        )
      ) : (
        <div
          className={`space-y-6 transition-opacity duration-200 ${
            isRefreshing ? "pointer-events-none opacity-60" : ""
          }`}
          aria-busy={isRefreshing}
        >
          {/* The total leads on its own dark band; the three tiles beside it
              explain it, each with a small picture of its own figure. */}
          <section
            id="expense-overview"
            aria-label="Expense summary"
            className="grid scroll-mt-6 gap-4 sm:grid-cols-2 sm:[&>*:last-child]:col-span-2 xl:grid-cols-[1.35fr_1fr_1fr_1fr] xl:[&>*:last-child]:col-span-1"
          >
            <h2 className="sr-only">Total expenses</h2>
            <div className="relative isolate flex min-w-0 flex-col overflow-hidden rounded-2xl bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950 p-5 text-white shadow-md sm:col-span-2 xl:col-span-1">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-brand-200">
                Total spent
              </p>
              <p className="figure mt-2 text-3xl font-bold text-white">
                {formatMoney(summary.total)}
              </p>
              <p className="mt-1 text-xs text-brand-100">
                {summary.expenseCount} {summary.expenseCount === 1 ? "expense" : "expenses"} · {summary.categoryCount}{" "}
                {summary.categoryCount === 1 ? "category" : "categories"}
              </p>
              <div className="mt-auto pt-4 text-brand-300">
                <Sparkline
                  points={data.dailyTotals}
                  label={`Spending ${periodText}, ${data.dailyBucket === "month" ? "month" : "day"} by day`}
                />
              </div>
            </div>

            <KpiTile
              icon={ChartPie}
              tone={
                summary.fundsShare !== null && summary.fundsShare > 75
                  ? "danger"
                  : "brand"
              }
              label="Share of recorded available funds"
              order={1}
              visual={
                summary.fundsShare !== null ? (
                  <ShareBar
                    percent={summary.fundsShare}
                    color={
                      summary.fundsShare > 75
                        ? "rgb(var(--tone-danger))"
                        : "rgb(var(--tone-brand))"
                    }
                    trackClassName="bg-paper"
                  />
                ) : undefined
              }
            >
              <p className="figure mt-2 text-2xl font-bold text-ink-900">
                {summary.fundsShare === null
                  ? "—"
                  : summary.fundsShare > 100
                    ? "Over 100%"
                    : `${summary.fundsShare.toFixed(0)}%`}
              </p>
              <p className="mt-1 text-xs text-ink-600">
                {summary.fundsShare === null
                  ? allTime
                    ? "Shown for a week or a month"
                    : availableFundsAreLoading
                      ? "Loading recorded available funds…"
                      : usingStartingFundsFallback
                        ? (startingFundsFallback ?? 0) > 0
                          ? `${formatMoney(summary.total)} of ${formatMoney(startingFundsFallback)} opening balance`
                          : `Opening balance fallback: ${formatMoney(startingFundsFallback ?? 0)}`
                        : `Recorded available funds: ${formatMoney(availableFundsDenominator ?? 0)}`
                  : `${formatMoney(summary.total)} of ${formatMoney(availableFundsDenominator ?? 0)} recorded available funds`}
              </p>
              {usingStartingFundsFallback ? (
                <div
                  role="alert"
                  className="mt-2 text-xs leading-relaxed text-tone-accent"
                >
                  <span title={currentFinancialPositionError ?? undefined}>
                    Recorded balance couldn’t load. Using the opening balance.
                  </span>{" "}
                  <button
                    type="button"
                    className="tap-inline font-semibold underline underline-offset-2"
                    onClick={() =>
                      setFinancialPositionReload((version) => version + 1)
                    }
                  >
                    Retry recorded balance
                  </button>
                </div>
              ) : null}
            </KpiTile>

            <KpiTile
              icon={Boxes}
              tone="info"
              label="Largest category"
              order={2}
              visual={
                summary.top ? (
                  <ShareBar
                    percent={summary.topShare}
                    color={TOP_CATEGORY_COLOR}
                    trackClassName="bg-paper"
                  />
                ) : undefined
              }
            >
              <p className="mt-2 truncate text-xl font-bold text-ink-900">
                {summary.top?.categoryName ?? "—"}
              </p>
              <p className="figure mt-1 text-xs text-ink-600">
                {summary.top
                  ? `${summary.topShare.toFixed(1)}% · ${formatMoney(summary.top.current)}`
                  : "No spending yet"}
              </p>
            </KpiTile>

            {allTime ? (
              <KpiTile icon={TrendingUp} tone="neutral" label="Average per month" order={3}>
                <p className="figure mt-2 text-xl font-bold text-ink-900">
                  {summary.monthlyAverage === null ? "—" : formatMoney(summary.monthlyAverage)}
                </p>
                <p className="mt-1 text-xs text-ink-600">
                  {data.dailyTotals.length} month{data.dailyTotals.length === 1 ? "" : "s"}
                </p>
              </KpiTile>
            ) : (
              <KpiTile
                icon={
                  summary.periodDelta > 0
                    ? ArrowUpRight
                    : summary.periodDelta < 0
                      ? ArrowDownRight
                      : TrendingUp
                }
                tone={
                  summary.periodDelta > 0
                    ? "danger"
                    : summary.periodDelta < 0
                      ? "brand"
                      : "neutral"
                }
                label={`vs ${comparedWith}`}
                order={3}
                visual={
                  <PairBars
                    rows={[
                      {
                        label: periodCaption,
                        value: summary.total,
                        color:
                          summary.periodDelta > 0
                            ? "rgb(var(--tone-danger))"
                            : "rgb(var(--tone-brand))",
                      },
                      {
                        label: comparedWith,
                        value: data.totals.previous,
                        color: "rgb(var(--ink-300))",
                      },
                    ]}
                  />
                }
              >
                {summary.periodDelta !== 0 ? (
                  <>
                    <p
                      className={`figure mt-2 text-xl font-bold ${
                        summary.periodDelta > 0
                          ? "text-tone-danger"
                          : "text-tone-brand"
                      }`}
                    >
                      {summary.periodDelta > 0 ? "+" : "−"}
                      {formatMoney(Math.abs(summary.periodDelta))}
                    </p>
                    <p className="mt-1 text-xs text-ink-600">
                      {summary.periodPercent === null
                        ? "No earlier data"
                        : `${Math.abs(summary.periodPercent).toFixed(0)}% ${
                            summary.periodDelta > 0 ? "more" : "less"
                          }`}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-xl font-bold text-ink-900">
                      No change
                    </p>
                    <p className="mt-1 text-xs text-ink-600">Same total</p>
                  </>
                )}
              </KpiTile>
            )}
          </section>

          <ExpenseSectionNav
            showOpportunities={showReductionPanel}
            showRecurring={showRecurringBlock}
          />

          {/* A plain-language warning, only when it is actually warranted. The
              KPI above states the number; this says what to do about it. */}
          {summary.fundsShare !== null && summary.fundsShare > 75 ? (
            <Callout tone="warn">
              {summary.fundsShare > 100 && availableFundsDenominator ? (
                // Past 100%, a percentage of a balance is hard to read; the two amounts are not.
                <>
                  Spending {periodText} (<b className="figure font-semibold">{formatMoney(summary.total)}</b>) is more than your
                  recorded available funds (<b className="figure font-semibold">{formatMoney(availableFundsDenominator)}</b>).
                </>
              ) : (
                <>
                  Spending {periodText} is{" "}
                  <b className="font-semibold">{summary.fundsShare.toFixed(0)}%</b>{" "}
                  of your recorded available funds.
                </>
              )}
            </Callout>
          ) : null}

          {/* What it means, beside when it happened. The summary is read
              first, so it sits on the left at the top of the page's body. */}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <ExpenseSummaryCard
              summary={summary}
              periodText={periodText}
              comparedWith={comparedWith}
              allTime={allTime}
              categoryColor={TOP_CATEGORY_COLOR}
              flaggedCount={flaggedState === "ready" || flaggedState === "stale" ? flaggedTotal : 0}
              unusualCount={data.unusualExpenses.length}
              expandQuestion={expandQuestion}
              onAsk={askFinSight}
            />
            {/* ===================== WHEN IT LEFT ===================== */}
            <Panel
              title="Spending over time"
              action={<span className="text-xs text-ink-500">{periodCaption}</span>}
              className="min-w-0"
            >
              <DailySpendChart
                key={expenseScopeKey}
                daily={data.dailyTotals}
                bucket={data.dailyBucket ?? "day"}
              />
            </Panel>
          </div>

          <CategorySummary
            data={data}
            summary={summary}
            disclosure={categoryDisclosure}
            businessName={selected.name}
            periodText={periodText}
            periodCaption={periodCaption}
            comparedWith={comparedWith}
            allTime={allTime}
          />

          {/* ============ 4.5 REDUCTION OPPORTUNITIES — the next step ============
              Placed right after "what changed" and before the lower-priority
              analytical detail below (plan §10.1): understanding the numbers
              naturally leads to "so what should I check first?", and this
              panel is the deterministic answer to that question. */}
          {showReductionPanel ? (
            <ReductionOpportunitiesPanel
              reductionOpportunities={reductionOpportunities}
              reductionLoading={reductionLoading}
              reductionError={reductionError}
              reductionHasOpportunities={reductionHasOpportunities}
              refreshError={refreshError}
              onRetry={() => void loadExpenseOverview(undefined, true)}
              businessProfileId={selected.id}
              period={selection}
            />
          ) : null}

          {/* ===================== 5. FLAGS + AI ===================== */}
          {/* ===================== 5. REVIEW ===================== */}
          <section
            id="expense-review"
            aria-label="Expenses to review"
            className="scroll-mt-6 space-y-5"
          >
            {!showFlaggedPanel && !showUnusualPanel && !showFindingsPanel ? (
              <div className="flex items-center gap-3 rounded-2xl border border-paper-200 bg-paper px-5 py-4 shadow-sm">
                <IconTile icon={ShieldCheck} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">All clear</p>
                  <p className="text-xs text-ink-500">
                    No large, unusual or open findings {periodText}.
                  </p>
                </div>
              </div>
            ) : null}
            {showFlaggedPanel || showUnusualPanel ? (
              <div
                className={`grid gap-5 ${showFlaggedPanel && showUnusualPanel ? "lg:grid-cols-2" : ""}`}
              >
              {showFlaggedPanel ? (
                <FlaggedExpensesPanel
                  flaggedState={flaggedState}
                  flaggedTotal={flaggedTotal}
                  flaggedExpenses={flaggedExpenses}
                  disclosure={flaggedDisclosure}
                  categoryName={categoryName}
                  profile={selected}
                  hasFlaggedRecordLink={hasFlaggedRecordLink}
                />
              ) : null}
            {/* ===================== 7. ANYTHING ODD (statistical) ===================== */}
            {showUnusualPanel ? (
              <UnusualExpensesPanel
                data={data}
                isRefreshing={isRefreshing}
                refreshError={refreshError}
              />
            ) : null}

              </div>
            ) : null}
            {/* Findings are reviewed in the Needs review queue; this page only points there. */}
            {showPeriodFindings && findings.length > 0 ? (
              <p className="text-sm text-ink-600">
                {findings.length} open {findings.length === 1 ? "finding" : "findings"} about spending patterns.{" "}
                <Link to="/records/flagged" className="tap-inline link-action">
                  Go to Needs review
                </Link>
              </p>
            ) : null}
          </section>
        </div>
      )}

      {/*
        THE RECURRING BLOCK SITS OUTSIDE THE PERIOD-SCOPED PAGE ABOVE, on
        purpose. Everything above is a reading of one window of expenses; a
        schedule is not — an overdue salary run is overdue whether or not
        anything was recorded in the last thirty days. Nested inside, it
        disappeared for exactly the owner most likely to have forgotten a
        payment: the one with an empty window.

        Agenda first, candidates second. The agenda is what the owner asked
        FinSight to watch; the candidates are FinSight asking a question back.
      */}
      {isInitialLoad || (!showPeriodFindings && !showRecurringBlock) ? null : (
        <div className="mt-6 space-y-5">
          {showRecurringBlock && schedulesState === "stale" ? (
            <Callout tone="warn">
              <div>
                <p role="status">
                  <b className="font-semibold">Recurring payments couldn’t refresh.</b>{" "}
                  Showing recently loaded schedules.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => void loadRecurringSchedules(undefined, true)}
                >
                  Retry schedules
                </Button>
              </div>
            </Callout>
          ) : null}

          {/* One row, equal-height cards: the agenda, then the candidates. */}
          <div
            id={showRecurringBlock ? "expense-recurring" : undefined}
            className={`grid gap-5 scroll-mt-6 ${
              lowerRowCount === 2
                  ? "lg:grid-cols-2"
                  : ""
            }`}
          >
            {/* Hidden when there is no successful snapshot or the server
                definitively reports that schedules are unavailable. */}
            {showRecurringBlock && recurringSchedules !== null ? (
              <RecurringAgenda
                schedules={recurringSchedules}
                resetKey={expenseScopeKey}
                className="h-full min-w-0"
                previewLimit={SCHEDULES_PREVIEW_COUNT}
                seeAllTo={EXPENSE_RECURRING_PATH}
                onEdit={(schedule) => {
                  setEditingSchedule(schedule);
                  setScheduleFormOpen(true);
                }}
                onAdd={() => {
                  setEditingSchedule(null);
                  setScheduleFormOpen(true);
                }}
              />
            ) : null}

            {showRecurringBlock && hasCandidates ? (
              <Panel title="Possible recurring expenses" className="h-full min-w-0">
                <SupplementNotice state={patternsState} label="recurring expense suggestions" />
                <ul className="space-y-2">
                  {candidatePatterns.slice(0, CANDIDATES_PREVIEW_COUNT).map((pattern) => (
                    <CandidateRow
                      key={pattern.id}
                      pattern={pattern}
                      canWatch={canWatchPatterns}
                      onWatch={(id) => void confirmPattern(id)}
                      onDismiss={(id) => void dismissPattern(id)}
                    />
                  ))}
                </ul>
                {candidatePatterns.length > CANDIDATES_PREVIEW_COUNT ? (
                  <SeeAllFooter
                    shown={CANDIDATES_PREVIEW_COUNT}
                    total={candidatePatterns.length}
                    noun="recurring suggestions"
                    to={`${EXPENSE_RECURRING_PATH}#recurring-suggestions`}
                  />
                ) : null}
              </Panel>
            ) : patternsState === "stale" || patternsState === "unavailable" ? (
              <Panel title="Recurring expense suggestions" className="h-full min-w-0">
                <SupplementNotice state={patternsState} label="recurring expense suggestions" />
              </Panel>
            ) : null}
          </div>
        </div>
      )}

      <ScheduleFormModal
        open={scheduleFormOpen}
        schedule={editingSchedule}
        onClose={() => setScheduleFormOpen(false)}
        onSaved={() => void loadRecurring(undefined, true)}
      />

      {addRecord.popups}
      <AskFinSightButton originModule="Expense Insights" />
    </div>
  );
}
