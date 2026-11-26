import { ContentScrollView } from "../components/ContentScrollView";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExpensePagination } from "../components/ExpensePagination";
import { useCursorCollection } from "../lib/useCursorCollection";
import { LargeExpenseFlags } from "../components/LargeExpenseFlags";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { type ScrollViewInstance, Pressable, RefreshControl, useWindowDimensions, View } from "react-native";
import * as haptics from "../lib/haptics";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, ErrorNote, Screen, SegmentedControl, T } from "../components/ui";
import { CategoryBars, DailySpending, SpendHero, SpendingComparison } from "../components/ExpenseVisuals";
import { ExpenseGlance, ExpenseSummaryCard } from "../components/ExpenseSummary";
import { expenseSummaryFigures, expenseSummaryPoints, expenseSummaryQuestions } from "../lib/expenseSummary";
import { AskFinSight } from "../components/AskFinSight";
import { InsightHeader } from "../components/InsightsShared";
import { PeriodPill, PeriodStatus } from "../components/PeriodSelector";
import { TAP_FLOOR } from "../components/touchTarget";
import { ExpenseAlertsSection } from "../components/ExpenseAlertsSection";
import { ReductionOpportunitiesSection } from "../components/ReductionOpportunitiesSection";
import { ReductionSimulationSheet } from "../components/ReductionSimulationSheet";
import { ExpenseRecurringSection } from "../components/ExpenseRecurringSection";
import { SkeletonBox, SkeletonCard } from "../components/Skeleton";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useAiChat } from "../context/AiChatContext";
import { api, errorMessage } from "../lib/api";
import { openFlagDetail } from "../lib/flaggedRecordsNavigation";
import { ImportDuplicateCards } from "../components/ImportDuplicateCards";
import { takeFlash } from "../lib/flash";
import { groupSchedules, recurringAvailability } from "../lib/recurringAgenda";
import { findingCategory } from "../lib/findingFeedback";
import { REDUCTION_OPPORTUNITY_QUESTION } from "../lib/reductionOpportunityAsk";
import { useInsight } from "../lib/useInsight";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { ConnectionNotice, FreshnessStatus } from "../components/ConnectionNotice";
import { describeLoadFailure, toLoadFailure } from "../lib/connectionState";
import type { DetailExpenseOverview } from "../lib/expenseOverview";
import type { FinancialPosition } from "../lib/types";
import {
  THIS_WEEK,
  monthLabel,
  periodLabel,
  periodParams,
  periodPhrase,
  previousLabel as describePrevious,
} from "../lib/reportingPeriod";
import type {
  AnomalyFinding,
  AnomalyFindingPage,
  FlaggedRecordPage,
  RecordItem,
  ExpenseBehavior,
  ReductionOpportunity,
  RecurringPattern,
  RecurringSchedule,
} from "../lib/types";
import type { InsightsScreenProps } from "../navigation/types";
import { Reveal } from "../components/Reveal";

const EMPTY_EXPENSE_BEHAVIOR: ExpenseBehavior = {
  periodDays: 0,
  periodStart: "",
  periodEnd: "",
  previousPeriodStart: null,
  previousPeriodEnd: null,
  dailyTotals: [],
  totals: { current: 0, previous: 0 },
  categoryTrends: [],
  unusualExpenses: [],
  insufficientHistoryCategories: [],
};


// ---------------------------------------------------------------- Expense insight

/** Mirrors the overview's summary, actions, and charts to prevent a large layout jump. */
function ExpenseInsightSkeleton() {
  return (
    <View
      accessible
      accessibilityLabel="Loading expense insight"
      accessibilityState={{ busy: true }}
      style={{ gap: space.lg }}
    >
      <SkeletonCard style={{ height: 190 }} />

      <SkeletonCard style={{ height: 112 }} />

      <View style={{ gap: space.md }}>
        <SkeletonBox width="48%" height={18} />
        <SkeletonCard style={{ height: 168 }} />
      </View>

      <View style={{ gap: space.md }}>
        <SkeletonBox width="58%" height={18} />
        <SkeletonCard style={{ height: 280 }} />
      </View>
    </View>
  );
}

export function ExpenseBehaviorScreen(props: InsightsScreenProps<"ExpenseBehavior">) {
  return (
    <ReportingPeriodScope scope="expense-insight">
      <ExpenseBehaviorGate {...props} />
    </ReportingPeriodScope>
  );
}

/**
 * Waits for the period's default (the newest month with records) so the
 * screen loads once, for the right period, instead of once for a placeholder.
 */
function ExpenseBehaviorGate(props: any) {
  const { ready } = useReportingPeriod();
  if (ready) return <ExpenseBehaviorContent {...props} />;
  return (
    <Screen safeTop>
      <ExpenseInsightSkeleton />
    </Screen>
  );
}

function ExpenseBehaviorContent({ navigation, route }: InsightsScreenProps<"ExpenseBehavior">) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const { brand } = t;
  const { selected, categories } = useBusinessProfiles();
  const { selection: sharedSelection, setSelection } = useReportingPeriod();
  const selection = sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  useFocusEffect(useCallback(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [sharedSelection.kind, setSelection]));
  const periodKeyValue = JSON.stringify(selection);
  const [askOpen, setAskOpen] = useState(false);
  const chat = useAiChat();
  /**
   * The reduction opportunity "Simulate reduction" is currently open for, or
   * null when the sheet is closed — plan §12.4, Phase 4.
   *
   * A single value rather than a boolean beside the opportunity list index:
   * it carries the opportunity itself, so the sheet stays correct even if
   * the underlying list refetches or reorders while it is open.
   */
  const [simulateFor, setSimulateFor] = useState<ReductionOpportunity | null>(null);
  /**
   * Which sub-section is showing.
   *
   * Defaults to Overview even when there are alerts waiting. Opening on a
   * list of things that need deciding would make the screen an inbox, and
   * this one is mostly consulted rather than worked through — the badge is
   * what carries the urgency, and it does so without taking the choice away.
   */
  const [section, setSection] = useState<"overview" | "alerts" | "recurring">(route?.params?.section ?? "overview");
  // Links from Home, Records, a CSV import or Ask FinSight open straight on Review.
  const requestedSection = route?.params?.section;
  useEffect(() => {
    if (!requestedSection) return;
    setSection(requestedSection);
    navigation.setParams({ section: undefined });
  }, [requestedSection, navigation]);
  const scrollRef = useRef<ScrollViewInstance>(null);
  // Where each overview part sits inside the overview container, for the jump chips.
  const overviewState = useInsight<DetailExpenseOverview>(
    "/insights/expense-overview",
    { businessProfileId: selected?.id, ...periodParams(selection), view: "detail" },
    [selected?.id, periodKeyValue],
    { enabled: Boolean(selected) },
  );
  const behaviorPanel = overviewState.data?.behavior;
  const behaviorData = behaviorPanel?.status === "available" ? behaviorPanel.data : null;
  const data = behaviorData ?? EMPTY_EXPENSE_BEHAVIOR;
  const loading = overviewState.loading && overviewState.data === null;
  const error = behaviorPanel?.status === "unavailable"
    ? "Expense analysis is unavailable right now."
    : null;
  const opportunityPanel = overviewState.data?.opportunities;
  const reductionState = {
    data: opportunityPanel?.status === "available" ? opportunityPanel.data : null,
    loading,
    error:
      opportunityPanel?.status === "unavailable"
        ? "Reduction opportunities are unavailable right now."
        : overviewState.data === null
          ? overviewState.error
          : null,
    load: overviewState.load,
  };
  const findingState = useInsight<AnomalyFindingPage>(
    "/insights/findings",
    { businessProfileId: selected?.id, status: "OPEN", take: 20 },
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  const flaggedState = useInsight<FlaggedRecordPage>(
    "/records/flagged",
    { businessProfileId: selected?.id, limit: 20 },
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  const reviewScope = `${selected?.id}:${periodKeyValue}`;
  const flagPages = useCursorCollection(flaggedState, "/records/flagged", { businessProfileId: selected?.id, limit: 20 }, reviewScope, "cursor", (item) => `${item.type}:${item.id}`);
  const findingPages = useCursorCollection(findingState, "/insights/findings", { businessProfileId: selected?.id, status: "OPEN", take: 20 }, reviewScope, "cursorId", (item) => String(item.id));
  const reviewSize = 5;
  const [reviewPage, setReviewPage] = useState(0);
  /** Which kind of review item the Review tab lists. Duplicates are the keep-or-discard ones. */
  const [reviewFilter, setReviewFilter] = useState<"all" | "duplicates" | "large" | "unusual">("all");
  const recurringSize = 5;
  const [recurringPage, setRecurringPage] = useState(0);
  const [reviewPaging, setReviewPaging] = useState(false);
  const [reviewPageError, setReviewPageError] = useState<string | null>(null);
  const reviewRequest = useRef(0);
  const pageRetry = useRef<{ page: number; size: number } | null>(null);
  const patternState = useInsight<RecurringPattern[]>(
    "/insights/recurring-patterns",
    { businessProfileId: selected?.id },
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  /*
   * The owner's own declared schedules — what the Recurring tab is actually
   * about. The patterns above are only the candidates FinSight offers.
   */
  const scheduleState = useInsight<RecurringSchedule[]>(
    "/insights/recurring-schedules",
    { businessProfileId: selected?.id },
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  // The summary's denominator and its review count. Both are optional context:
  // a failure leaves the share blank and the count at zero, never the screen.
  const positionState = useInsight<FinancialPosition>(
    `/business-profiles/${selected?.id}/financial-position`,
    {},
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  const flaggedCountState = useInsight<{ expenses: number; sales: number; total: number }>(
    "/records/flagged/count",
    { businessProfileId: selected?.id },
    [selected?.id],
    { enabled: Boolean(selected) },
  );
  const overviewNotice = describeLoadFailure(
    overviewState.rawError ? toLoadFailure(overviewState.rawError) : null,
    {
      hasData: overviewState.data !== null,
      lastUpdatedAt: overviewState.lastUpdatedAt,
      subject: "expense insights",
    },
  );
  const patternNotice = describeLoadFailure(
    patternState.rawError ? toLoadFailure(patternState.rawError) : null,
    {
      hasData: patternState.data !== null,
      lastUpdatedAt: patternState.lastUpdatedAt,
      subject: "recurring suggestions",
    },
  );
  const findingNotice = describeLoadFailure(
    findingState.rawError ? toLoadFailure(findingState.rawError) : null,
    {
      hasData: findingState.data !== null,
      lastUpdatedAt: findingState.lastUpdatedAt,
      subject: "the findings to review",
    },
  );
  const [refreshing, setRefreshing] = useState(false);
  const refreshOverview = overviewState.load;
  const refreshFindings = findingState.load;
  const refreshPatterns = patternState.load;
  const refreshSchedules = scheduleState.load;
  const refreshPosition = positionState.load;
  const refreshFlaggedCount = flaggedCountState.load;
  const refreshFlaggedRecords = flaggedState.load;
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshOverview(),
        refreshFindings(),
        refreshPatterns(),
        refreshSchedules(),
        refreshPosition(),
        refreshFlaggedCount(),
        refreshFlaggedRecords(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshFindings, refreshFlaggedCount, refreshFlaggedRecords, refreshOverview, refreshPatterns, refreshPosition, refreshSchedules]);
  /**
   * Why a confirm or dismiss failed.
   *
   * Kept apart from the two fetch errors: confirming can come back 409 when
   * the same candidate was already promoted in another session, and that is a
   * sentence about the button just pressed, not about the list.
   */
  const [patternActionError, setPatternActionError] = useState<string | null>(null);

  /*
   * The confirmation handed back by the recurring-payment form.
   *
   * Collected here rather than left for whichever screen asks next: `takeFlash`
   * is app-wide and clears as it reads, so a message set by a form that
   * returns to THIS screen would otherwise surface days later on the records
   * list. Same shape as RecordsScreen's own notice, including dropping it on
   * blur so a confirmation never outlives the visit it belongs to.
   */
  const [notice, setNotice] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      const handed = takeFlash();
      if (handed) setNotice(handed);
      return () => setNotice(null);
    }, []),
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const comparedWith = describePrevious(data?.period) ?? "the period before";
  const recordedFunds = Number.isFinite(positionState.data?.availableFunds.calculatedAmount)
    ? positionState.data!.availableFunds.calculatedAmount
    : null;
  const summaryFigures = expenseSummaryFigures(data, recordedFunds);
  const flaggedExpenses = flaggedCountState.data?.expenses ?? 0;
  const summaryContext = {
    periodText: periodPhrase(selection),
    comparedWith,
    allTime: false,
    flaggedCount: flaggedExpenses,
    unusualCount: data.unusualExpenses.length,
  };
  function askSummaryQuestion(question?: string) {
    haptics.tapped();
    if (question) chat.prepareQuestion(question);
    setAskOpen(true);
  }

  /**
   * Promotes a candidate into a schedule the owner owns.
   *
   * POST .../confirm, not the old PATCH { status: "CONFIRMED" }. The PATCH
   * only marked the pattern and left nothing behind that could be seen or
   * edited — the confirmed row vanished from every screen, which is the defect
   * this whole section was rebuilt to fix. The endpoint creates the schedule
   * and marks the pattern in one transaction, and seeds the label server-side
   * from the pattern's description, so nothing is sent in the body.
   *
   * Both lists are refetched because one write changed both of them.
   */
  async function confirmPattern(id: number) {
    setPatternActionError(null);
    try {
      await api.post(
        `/insights/recurring-patterns/${id}/confirm`,
        undefined,
        { cacheScope: { businessProfileId: selected!.id } },
      );
      haptics.succeeded();
      await Promise.all([patternState.load(), scheduleState.load()]);
    } catch (err) {
      setPatternActionError(errorMessage(err));
    }
  }

  /** "Not recurring". Still the PATCH — dismissing creates nothing. */
  async function dismissPattern(id: number) {
    setPatternActionError(null);
    try {
      await api.patch(
        `/insights/recurring-patterns/${id}`,
        { status: "DISMISSED" },
        { cacheScope: { businessProfileId: selected!.id } },
      );
      await patternState.load();
    } catch (err) {
      setPatternActionError(errorMessage(err));
    }
  }

  function openSchedule(scheduleId?: number) {
    haptics.tapped();
    navigation.navigate("RecurringSchedule", scheduleId ? { scheduleId } : {});
  }

  /**
   * Opens the records list filtered to one category.
   *
   * THE NESTED-PARAMS FORM, and it has to be. A bare
   * `dispatch(navigate("RecordsList", …))` from here looks tidier and does
   * nothing: `useOnAction` only forwards an action DOWN into child
   * navigators when the action carries a `target`, so a targetless one
   * bubbles up, finds no navigator that owns "RecordsList", and is dropped
   * with "The action was not handled by any navigator" — which is exactly
   * what tapping a category row did.
   *
   * The cost is that `{ screen, params }` sticks to the Records TAB route and
   * bottom-tabs replays a tab's params on every later press. RecordsScreen
   * clears the tab's params once it has consumed the filter, so the replay
   * has nothing left to re-apply.
   */
  function openCategoryRecords(categoryId: number) {
    haptics.tapped();
    navigation.navigate("Records", {
      screen: "RecordsList",
      params: { categoryId, type: "expense" },
    });
  }

  /**
   * "Ask FinSight about this" on a reduction-opportunity card — plan §11.1.
   *
   * `prepareQuestion` primes the composer AND queues the selected
   * opportunity's own structured object — the same one this screen already
   * fetched from `GET /insights/reduction-opportunities` — in a single
   * atomic update. See lib/reductionOpportunityAsk.ts and lib/chatStore.ts.
   * Nothing is sent here: opening the sheet only shows the owner what would
   * be asked, same as every other deep-link in this app.
   */
  function askAboutOpportunity(opportunity: ReductionOpportunity) {
    haptics.tapped();
    chat.prepareQuestion(REDUCTION_OPPORTUNITY_QUESTION, opportunity);
    setAskOpen(true);
  }

  /**
   * "Simulate reduction" on a reduction-opportunity card — plan §12.4.
   *
   * Just opens the sheet on the selected opportunity; the sheet itself owns
   * the form, the request and the result. The period is handed down as it
   * stands right now, which is the same period the opportunity
   * list was fetched for — the category baseline the sheet simulates against
   * is then the same one the card's own evidence figure describes.
   */
  function simulateOpportunity(opportunity: ReductionOpportunity) {
    haptics.tapped();
    setSimulateFor(opportunity);
  }

  /*
   * The badges count things that need a DECISION, not things worth reading.
   *
   * Findings end in two buttons; unusual expenses are shown for context and
   * ask nothing, so they live under Alerts without inflating its number. A
   * badge that counts reading material is a badge nobody clears, and then it
   * stops meaning anything.
   *
   * RECURRING NOW COUNTS OVERDUE SCHEDULES RATHER THAN CANDIDATES, which is a
   * narrowing of that same rule rather than a departure from it. A candidate
   * does end in two buttons, but the decision it asks for costs nothing to
   * defer — FinSight is offering to watch something, and next week is as good
   * as today. A payment that was due and has not been recorded is the opposite:
   * every day it sits there is a day the owner may be about to be surprised by
   * it. So the badge is spent on the one that has a deadline. The candidates
   * are still on the tab, listed under the agenda.
   */
  const openFindings = findingPages.read().items.length;
  const candidates = patternState.data?.filter((pattern) => pattern.status === "CANDIDATE") ?? [];
  /*
   * A 404 removes the gated agenda and its controls. A transient refresh keeps
   * the last verified rows and pairs them with a retry notice.
   */
  const recurring = recurringAvailability({
    data: scheduleState.data,
    error: scheduleState.rawError,
  });
  const { schedules, overdueCount } = recurring;
  const canConfirm = recurring.canConfirm && scheduleState.data !== null;
  const scheduleNotice = recurring.failure
    ? describeLoadFailure(toLoadFailure(scheduleState.rawError), {
        hasData: recurring.failure === "refresh",
        lastUpdatedAt: scheduleState.lastUpdatedAt,
        subject: "your repeating payments",
      })
    : null;

  const flagSnapshot = flagPages.read();
  const findingSnapshot = findingPages.read();
  const flagsFinished = flagSnapshot.ready && (flaggedCountState.data?.total === 0 || flagSnapshot.cursor === null);
  const findingsFinished = findingSnapshot.ready && findingSnapshot.cursor === null;
  const findingsWanted = reviewFilter !== "large";
  const reviewComplete = flagsFinished && (findingsFinished || !findingsWanted) && behaviorData !== null;
  const unmatchedUnusual = data.unusualExpenses.filter((expense) => !findingSnapshot.items.some((finding) => finding.expenseRecordId === expense.id));
  const flaggedExpenseCount = flaggedCountState.data?.total;
  const reliableReviewCount = findingsFinished && behaviorData !== null && flagSnapshot.ready
    && !flagSnapshot.error && !findingSnapshot.error
    && !flaggedCountState.error && !flaggedCountState.refreshing && !flaggedCountState.isStale
    && !findingState.error && !findingState.refreshing && !findingState.isStale
    && !flaggedState.error && !flaggedState.refreshing && !flaggedState.isStale
    && !overviewState.error && !overviewState.refreshing && !overviewState.isStale
    && flaggedExpenseCount !== undefined && Number.isInteger(flaggedExpenseCount)
    && flaggedExpenseCount >= flagSnapshot.items.length
    && (!flagsFinished || flaggedExpenseCount === flagSnapshot.items.length);
  const flagMatches = (item: RecordItem) => reviewFilter === "all"
    || (reviewFilter === "duplicates" && item.duplicateStatus === "Flagged")
    || (reviewFilter === "large" && item.largeExpenseFlag === true);
  const findingMatches = (item: AnomalyFinding) => reviewFilter === "all" || (findingsWanted && findingCategory(item.type) === (reviewFilter === "duplicates" ? "duplicate" : "unusual"));
  const unusualMatches = reviewFilter === "all" || reviewFilter === "unusual";
  const reviewTotalCount = reviewFilter === "all"
    ? (reliableReviewCount ? flaggedExpenseCount + findingSnapshot.items.length + unmatchedUnusual.length : undefined)
    : undefined;
  const reviewRows = [
    ...flagSnapshot.items.filter(flagMatches).map((item) => ({ kind: "flag" as const, id: item.id })),
    ...(flagsFinished ? findingSnapshot.items.filter(findingMatches).map((item) => ({ kind: "finding" as const, id: item.id })) : []),
    ...(flagsFinished && findingsFinished && unusualMatches ? unmatchedUnusual.map((item) => ({ kind: "unusual" as const, id: item.id })) : []),
  ];
  const reviewVisible = reviewRows.slice(reviewPage * reviewSize, (reviewPage + 1) * reviewSize);
  const recurringRows = [
    ...groupSchedules(schedules ?? []).flatMap((group) => group.items.map((item) => ({ kind: "schedule" as const, id: item.id }))),
    ...candidates.map((item) => ({ kind: "candidate" as const, id: item.id })),
  ];
  const recurringVisible = recurringRows.slice(recurringPage * recurringSize, (recurringPage + 1) * recurringSize);

  async function ensureReviewPage(targetPage: number, size: number) {
    const version = ++reviewRequest.current;
    const flagSession = flagPages.session;
    const findingSession = findingPages.session;
    const end = (targetPage + 1) * size;
    setReviewPaging(true);
    setReviewPageError(null);
    pageRetry.current = { page: targetPage, size };
    try {
      if (!flagPages.read().ready) return;
      // Counts only the rows the current filter shows, so a filtered page still fills.
      while (flagPages.read().items.filter(flagMatches).length < end && flagPages.read().cursor !== null && flaggedCountState.data?.total !== 0) {
        if (!await flagPages.loadNext()) {
          if (version === reviewRequest.current && flagPages.read().error) setReviewPageError(flagPages.read().error);
          return;
        }
        if (version !== reviewRequest.current) return;
      }
      const flags = flagPages.read();
      if (flags.cursor === null || flaggedCountState.data?.total === 0) {
        const needed = findingsWanted ? end - flags.items.filter(flagMatches).length : 0;
        if (needed > 0 && !findingPages.read().ready) return;
        while (findingPages.read().items.filter(findingMatches).length < needed && findingPages.read().cursor !== null) {
          if (!await findingPages.loadNext()) {
            if (version === reviewRequest.current && findingPages.read().error) setReviewPageError(findingPages.read().error);
            return;
          }
          if (version !== reviewRequest.current) return;
        }
      }
      if (version !== reviewRequest.current || flagSession !== flagPages.session || findingSession !== findingPages.session) return;
      const findings = findingPages.read();
      const previousSourcesDone = (flags.cursor === null || flaggedCountState.data?.total === 0) && findings.ready && findings.cursor === null;
      const unmatched = previousSourcesDone && unusualMatches ? data.unusualExpenses.filter((expense) => !findings.items.some((finding) => finding.expenseRecordId === expense.id)).length : 0;
      const count = flags.items.filter(flagMatches).length + ((flags.cursor === null || flaggedCountState.data?.total === 0) ? findings.items.filter(findingMatches).length + unmatched : 0);
      setReviewPage(Math.min(targetPage, Math.max(0, Math.ceil(count / size) - 1)));
      pageRetry.current = null;
    } finally {
      if (version === reviewRequest.current) setReviewPaging(false);
    }
  }

  useEffect(() => {
    reviewRequest.current += 1;
    setReviewPage(0);
    setReviewPageError(null);
    setReviewPaging(false);
    pageRetry.current = null;
  }, [flagPages.session, findingPages.session, reviewFilter]);
  useEffect(() => {
    const needsFill = reviewRows.length < (reviewPage + 1) * reviewSize && !reviewComplete;
    const canFill = flagSnapshot.ready && (flagSnapshot.cursor !== null || (findingsWanted && flagsFinished && findingSnapshot.ready && findingSnapshot.cursor !== null));
    if (section === "alerts" && needsFill && canFill && !reviewPaging && !reviewPageError && !flagSnapshot.loading && !findingSnapshot.loading && !flagSnapshot.error && !findingSnapshot.error && !flaggedState.refreshing && !findingState.refreshing) void ensureReviewPage(reviewPage, reviewSize);
    // Each automatic request fills only the current page; failures wait for retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, reviewFilter, flagPages.session, findingPages.session, flagSnapshot.loading, findingSnapshot.loading, reviewPaging, reviewPageError, reviewRows.length, reviewPage, reviewSize]);
  useEffect(() => {
    setRecurringPage(0);
  }, [selected?.id]);
  useEffect(() => {
    setRecurringPage((page) => Math.min(page, Math.max(0, Math.ceil(recurringRows.length / recurringSize) - 1)));
  }, [recurringRows.length, recurringSize]);
  useEffect(() => () => { reviewRequest.current += 1; }, []);

  /*
   * The period-on-period change, or null when there is nothing to compare
   * against. Dividing by a previous total of zero yields Infinity, which
   * renders as "Infinity%" — a first month of trading is exactly when an
   * owner is least able to tell a real figure from a broken one, so it says
   * so in words instead.
   */
  const periodDelta =
    data && data.totals.previous > 0
      ? ((data.totals.current - data.totals.previous) / data.totals.previous) * 100
      : null;

  const sections = [
    { label: "Overview", value: "overview" as const },
    { label: "Review", value: "alerts" as const, count: openFindings },
    { label: "Recurring", value: "recurring" as const, count: overdueCount },
  ];

  const activeSection = section;
  useEffect(() => {
    const frame = requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: false }));
    return () => cancelAnimationFrame(frame);
  }, [activeSection]);

  if (!selected) return null;

  return (
    <Screen safeTop>
      <ContentScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={brand[600]}
          />
        }
      >
        <InsightHeader navigation={navigation} active="ExpenseBehavior" title="Expenses" />

        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: t.border, marginBottom: space.xs }}>
            {sections.map((tab) => (
              <Pressable
                key={tab.value}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab.value === activeSection }}
                accessibilityLabel={tab.count ? `${tab.label}, ${tab.count}${tab.value === "alerts" && !findingsFinished ? " loaded" : ""} needing review` : tab.label}
                onPress={() => { haptics.tapped(); setSection(tab.value); }}
                style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center", flexDirection: fontScale > 1.15 ? "column" : "row", paddingHorizontal: space.xs, paddingVertical: fontScale > 1.15 ? space.sm : 0, gap: space.xs, borderBottomWidth: 2, borderBottomColor: tab.value === activeSection ? t.brandText : "transparent", opacity: pressed ? 0.7 : 1 })}
              >
                <T style={{ fontSize: typeScale.label, fontFamily: tab.value === activeSection ? font.sansSemibold : font.sans, color: tab.value === activeSection ? t.brandText : t.textSecondary, textAlign: "center", flexShrink: 1 }}>{tab.label}</T>
                {fontScale > 1.15 || tab.count ? <View style={{ minHeight: 22, minWidth: tab.count ? 20 : 0, alignItems: "center", justifyContent: "center", paddingHorizontal: tab.count ? space.xs : 0, borderRadius: radius.sm, backgroundColor: tab.count ? t.brandSurface : "transparent" }}>
                  {tab.count ? <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: tab.value === activeSection ? t.brandText : t.textSecondary }}>{tab.count}</T> : null}
                </View> : null}
              </Pressable>
            ))}
        </View>

        {notice ? (
          <View style={{ marginBottom: space.md }}>
            <Callout tone="info">{notice}</Callout>
          </View>
        ) : null}

        {/*
          The period governs the figures on Overview and nothing else — the
          findings and recurring patterns are fetched without it. Showing it
          on those tabs would imply it filtered them.
        */}
        {activeSection === "overview" ? (
          <View style={{ marginBottom: space.sm }}>
            {/* The period itself is the pill on the card below, as on Home and Recovery. */}
            <PeriodStatus />
          </View>
        ) : null}

        {activeSection !== "recurring" ? (
          <ConnectionNotice
            notice={overviewNotice}
            onRetry={() => void refreshOverview()}
            busy={overviewState.refreshing}
            style={{ marginBottom: space.md }}
          />
        ) : (
          <ConnectionNotice
            notice={patternNotice}
            onRetry={() => void refreshPatterns()}
            busy={patternState.refreshing}
            style={{ marginBottom: space.md }}
          />
        )}



        {activeSection === "overview" && error ? <ErrorNote>{error}</ErrorNote> : null}
        {activeSection === "overview" && loading ? (
          <ExpenseInsightSkeleton />
        ) : activeSection === "overview" && !behaviorData ? (
          <View style={{ gap: space.lg }}>
            {!overviewNotice ? <View style={{ alignSelf: "flex-start" }}>
              <Button
                title={refreshing ? "Trying again…" : "Try again"}
                variant="secondary"
                loading={refreshing}
                onPress={() => void refresh()}
              />
            </View> : null}
            {overviewState.data ? (
              <ReductionOpportunitiesSection
                state={reductionState}
                businessProfileId={selected.id}
                onViewRecords={openCategoryRecords}
                onAskAboutThis={askAboutOpportunity}
                onSimulate={simulateOpportunity}
                historical={false}
              />
            ) : null}
          </View>
        ) : (
          <Reveal style={{ gap: space.xl }}>
            {/*
              OVERVIEW — the figures, in the order the question is asked.
              The shape first, the figures second: the chart answers "is this
              period unusual"; the list below answers "by how much, and where".
            */}
            {activeSection === "overview" ? (
              <>
              {/*
                THE WINDOW IS EMPTY BUT THE BUSINESS IS NOT.

                Every window here ends today, so imported history that stops
                months ago puts all of them in a gap and the screen reports
                nothing recorded — to an owner holding hundreds of records.
                Said here, with the month named, and with the option that fixes
                it one tap away in the period picker above.
              */}
              {data.totals.current === 0 && data.latestExpenseDate ? (
                <Callout tone="info">
                  No expenses {periodPhrase(selection)}. Latest expense:{" "}
                  {new Date(data.latestExpenseDate).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                  .
                </Callout>
              ) : null}
              {data.totals.current === 0 && data.latestExpenseDate ? (
                <Button
                  title={`View ${monthLabel(data.latestExpenseDate.slice(0, 7))}`}
                  variant="secondary"
                  onPress={() => setSelection({ kind: "month", month: data.latestExpenseDate!.slice(0, 7) })}
                />
              ) : null}
              <SpendHero
                total={data.totals.current}
                recordCount={data.categoryTrends.every((trend) => trend.recordCount !== undefined) ? summaryFigures.recordCount : null}
                categoryCount={summaryFigures.categoryCount}
                changePercent={periodDelta}
                changeAmount={data.totals.current - data.totals.previous}
                comparedWith={comparedWith}
                header={<PeriodPill showAllTime={false} />}
              />
              <SpendingComparison
                total={data.totals.current}
                previousTotal={data.totals.previous}
                period={periodLabel(selection)}
                comparedWith={comparedWith}
              />
              <ExpenseGlance
                summary={summaryFigures}
                availableFunds={recordedFunds}
                fundsLoading={positionState.loading}
              />

              <View>
                <ExpenseSummaryCard
                  points={expenseSummaryPoints(summaryFigures, summaryContext)}
                  summary={summaryFigures}
                  flaggedCount={flaggedExpenses}
                  unusualCount={data.unusualExpenses.length}
                  questions={expenseSummaryQuestions(summaryFigures, summaryContext)}
                  onAsk={askSummaryQuestion}
                  onReviewFlags={flaggedExpenses > 0 ? () => setSection("alerts") : undefined}
                />
              </View>

              <View>
                <DailySpending
                  key={`daily:${selected.id}:${periodKeyValue}`}
                  days={data.dailyTotals ?? []}
                />
              </View>

              <View>
                <CategoryBars
                  key={`categories:${selected.id}:${periodKeyValue}`}
                  trends={data.categoryTrends}
                  total={data.totals.current}
                  previousTotal={data.totals.previous}
                  comparedWith={comparedWith}
                  onOpen={openCategoryRecords}
                />
              </View>

              <View>
                <ReductionOpportunitiesSection
                  state={reductionState}
                  businessProfileId={selected.id}
                  onViewRecords={openCategoryRecords}
                  onAskAboutThis={askAboutOpportunity}
                  onSimulate={simulateOpportunity}
                  historical={false}
                />
              </View>

              {/* Repeating payments live on the Recurring tab only; its badge carries any overdue count. */}

              <FreshnessStatus at={overviewState.lastUpdatedAt} now={Date.now()} refreshing={refreshing || overviewState.refreshing} />
              </>
            ) : null}

            {/*
              ALERTS — everything that wants the owner's attention, with the
              things that need a DECISION first and the things that are merely
              worth knowing under them.
            */}
            {/*
              NOTHING FLAGGED is a result, not an absence.

              With no findings and no unusual expenses this rendered two cards
              containing one grey sentence each — the layout of a screen that
              had failed to load. A clean month is the outcome an owner wants,
              and it should look like one rather than like a blank.
            */}
            {activeSection === "alerts" ? (
              <SegmentedControl
                accessibilityLabel="Show"
                options={[
                  { label: "All", value: "all" },
                  { label: "Duplicates", value: "duplicates" },
                  { label: "Large", value: "large" },
                  { label: "Unusual", value: "unusual" },
                ] as const}
                value={reviewFilter}
                onChange={setReviewFilter}
              />
            ) : null}

            {activeSection === "alerts" && reviewFilter !== "all" && reviewComplete && reviewRows.length === 0 && (flagSnapshot.items.length > 0 || findingSnapshot.items.length > 0 || data.unusualExpenses.length > 0) ? (
              <Card style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <Ionicons name="checkmark-circle-outline" size={22} color={t.statusText.good} />
                <T style={{ flex: 1, fontSize: typeScale.bodySm, color: t.textSecondary }}>
                  {reviewFilter === "duplicates" ? "No possible duplicates to review." : reviewFilter === "large" ? "No large expenses to review." : "No unusual spending to review."}
                </T>
              </Card>
            ) : null}

            {activeSection === "alerts" && reviewPage === 0 && selected && (reviewFilter === "all" || reviewFilter === "duplicates") ? (
              <ImportDuplicateCards
                records={flagSnapshot.items}
                hasMore={flagSnapshot.cursor !== null}
                businessProfileId={selected.id}
                onChanged={() => Promise.all([refreshFlaggedRecords(), refreshFlaggedCount(), refreshOverview(), refreshPosition()])}
                onOpen={(group) => navigation.navigate("ImportDuplicates", { records: group, hasMore: flagSnapshot.cursor !== null })}
              />
            ) : null}

            {activeSection === "alerts" ? (
              <LargeExpenseFlags
                items={flagSnapshot.items.filter((item) => reviewVisible.some((row) => row.kind === "flag" && row.id === item.id))}
                loading={flaggedState.loading}
                error={flaggedState.error}
                onRetry={() => void flaggedState.load()}
                profile={selected}
                categories={categories}
                flaggedTotal={flaggedCountState.data ? flaggedCountState.data.total : null}
                onOpen={(record) => openFlagDetail(navigation, record)}
              />
            ) : null}

            {activeSection === "alerts" ? (
              <ExpenseAlertsSection
                unusualExpenses={data.unusualExpenses}
                openFindings={openFindings}
                findingState={{ ...findingState, data: findingState.data ? { items: findingSnapshot.items, nextCursor: findingSnapshot.cursor } : null }}
                visibleFindingIds={reviewVisible.filter((row) => row.kind === "finding").map((row) => row.id)}
                visibleUnusualIds={reviewVisible.filter((row) => row.kind === "unusual").map((row) => row.id)}
                hasOtherReviewItems={!flagSnapshot.ready || flagSnapshot.items.length > 0 || flagSnapshot.cursor !== null || (flaggedCountState.data?.total ?? 0) > 0}
                findingsComplete={findingsFinished}
                findingNotice={findingNotice}
                refreshFindings={findingState.load}
                findingsRefreshing={findingState.refreshing}
                findingsUpdatedAt={findingState.lastUpdatedAt}
                onOpen={(target) => navigation.navigate("FindingDetail", target)}
                pagination={reviewComplete && reviewRows.length === 0 ? null : (
                  <ExpensePagination label="Review" page={reviewPage} size={reviewSize} count={reviewRows.length} totalCount={reviewTotalCount} complete={reviewComplete} available={flagSnapshot.ready} busy={reviewPaging || flaggedState.refreshing || findingState.refreshing} hasNext={(reviewPage + 1) * reviewSize < reviewRows.length || !flagsFinished || (findingsWanted && !findingsFinished)} error={reviewPageError} onPage={(page) => void ensureReviewPage(page, reviewSize)} onNext={() => void ensureReviewPage(reviewPage + 1, reviewSize)} onRetry={() => {
                    if (flagSnapshot.blocked || findingSnapshot.blocked) { void Promise.all([flaggedState.load(), findingState.load()]); return; }
                    const retry = pageRetry.current ?? { page: reviewPage + 1, size: reviewSize };
                    void ensureReviewPage(retry.page, retry.size);
                  }} />
                )
                }
              />
            ) : null}

            {/*
              RECURRING — the payments the owner has told FinSight to watch,
              and under them the ones FinSight is offering to watch.

              THAT ORDER IS THE POINT OF THIS SECTION. It used to show only
              candidates, so a schedule disappeared the moment it was confirmed
              and there was no screen anywhere that listed what FinSight was
              actually watching. An owner who had confirmed five payments saw
              the same "none found yet" empty state as one who had never seen
              a candidate at all.
            */}
            {activeSection === "recurring" ? (
              <ExpenseRecurringSection
                visibleScheduleIds={recurringVisible.filter((row) => row.kind === "schedule").map((row) => row.id)}
                visibleCandidateIds={recurringVisible.filter((row) => row.kind === "candidate").map((row) => row.id)}
                patternActionError={patternActionError}
                scheduleState={scheduleState}
                schedules={schedules}
                candidates={candidates}
                canConfirm={canConfirm}
                scheduleNotice={scheduleNotice}
                refreshSchedules={scheduleState.load}
                scheduleRefreshing={scheduleState.refreshing}
                openSchedule={openSchedule}
                confirmPattern={confirmPattern}
                dismissPattern={dismissPattern}
              />
            ) : null}
            {activeSection === "recurring" ? <ExpensePagination label="Recurring" page={recurringPage} size={recurringSize} count={recurringRows.length} complete={schedules !== null && patternState.data !== null} available={schedules !== null || patternState.data !== null} busy={false} hasNext={(recurringPage + 1) * recurringSize < recurringRows.length} onPage={setRecurringPage} onNext={() => setRecurringPage((page) => page + 1)} /> : null}
          </Reveal>
        )}
      </ContentScrollView>

      {/* Outside the ScrollView so it stays put while the page moves under it, as on Home and Recovery. */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Expense Insights" />

      <ReductionSimulationSheet
        visible={simulateFor !== null}
        opportunity={simulateFor}
        businessProfileId={selected.id}
        period={selection}
        onClose={() => setSimulateFor(null)}
      />

    </Screen>
  );
}
