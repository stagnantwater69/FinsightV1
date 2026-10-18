import { ContentScrollView } from "../components/ContentScrollView";
import { useCallback, useState } from "react";
import { RefreshControl, useWindowDimensions, View } from "react-native";
import { Button, Callout, Card, EmptyState, ErrorNote, Screen, SetupProgress, T } from "../components/ui";
import { HomeHeader } from "../components/HomeHeader";
import { RecentRecords, UpcomingExpenses } from "../components/DashboardFeeds";
import { MoneyFlowPanel, SpendingSplitCard, TodayGoalSummary } from "../components/HomeVisuals";
import { IconRow, SectionTitle } from "../components/CoachKit";
import { GreetingHero } from "../components/GreetingHero";
import { openFlaggedRecords } from "../lib/flaggedRecordsNavigation";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { AskFinSight } from "../components/AskFinSight";
import { SkeletonDashboard } from "../components/Skeleton";
import { PeriodPill, PeriodStatus } from "../components/PeriodSelector";
import { mascotSource } from "../components/MascotState";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTourHomeStage } from "../context/TourContext";
import { useTourScrollView, useTourTarget } from "../components/tour/targets";
import { ConnectionNotice, FreshnessStatus } from "../components/ConnectionNotice";
import { describeLoadFailure, toLoadFailure } from "../lib/connectionState";
import type { DashboardExpenseOverview } from "../lib/expenseOverview";
import { ALL_TIME, periodParams, periodPhrase } from "../lib/reportingPeriod";
import { previousRangeShort, summaryDelta } from "../lib/dashboardFigures";
import { useInsight } from "../lib/useInsight";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { availableFundsProvenance, monthlyExpenseBasisProvenance } from "../lib/financialPosition";
import { font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { DashboardSummary } from "../lib/types";
import type { DashboardScreenProps } from "../navigation/types";


export function DashboardScreen(props: DashboardScreenProps<"DashboardHome">) {
  return (
    <ReportingPeriodScope scope="dashboard">
      <DashboardContent {...props} />
    </ReportingPeriodScope>
  );
}

function DashboardContent({ navigation }: DashboardScreenProps<"DashboardHome">) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stackedActions = width < 390 || fontScale > 1.2;
  const { brand } = t;
  const { preferences } = useAuth();
  const { selected, profiles, categories, error: profilesError, refresh: refreshProfiles, selectProfile } =
    useBusinessProfiles();
  /**
   * The shared period (This week, a month with records, All time). The
   * selector below is always on screen, so every choice is reachable from
   * every other; the same choice holds on Expense Insights and Spending Impact.
   */
  const { selection, setSelection, ready: periodReady } = useReportingPeriod();
  const periodKeyValue = JSON.stringify(selection);

  const summaryState = useInsight<DashboardSummary>(
    "/dashboard/summary",
    { businessProfileId: selected?.id, ...periodParams(selection) },
    [selected?.id, periodKeyValue, periodReady],
    { enabled: Boolean(selected && periodReady) },
  );
  const overviewState = useInsight<DashboardExpenseOverview>(
    "/insights/expense-overview",
    { businessProfileId: selected?.id, ...periodParams(selection), view: "dashboard" },
    [selected?.id, periodKeyValue, periodReady],
    { enabled: Boolean(selected && periodReady && selection.kind !== "all") },
  );

  const summary = summaryState.data;
  const topOpportunity =
    overviewState.data?.topOpportunity.status === "available"
      ? overviewState.data.topOpportunity.data
      : null;
  const loading = summaryState.loading;
  const [refreshing, setRefreshing] = useState(false);
  const failure = summaryState.rawError ? toLoadFailure(summaryState.rawError) : null;
  const overviewFailure = overviewState.rawError ? toLoadFailure(overviewState.rawError) : null;
  const clock = Date.now();
  const [askOpen, setAskOpen] = useState(false);

  /*
   * The product tour's start gate.
   *
   * Both halves are needed and neither is guessable from outside this screen:
   * that Home is the tab being looked at, and that its figures have actually
   * arrived. Starting on focus alone would spotlight a skeleton — see
   * context/TourContext.tsx.
   */
  useTourHomeStage(!loading && !!summary);

  /** The block of figures the "Dashboard overview" step points at. */
  const summaryTourTarget = useTourTarget("dashboard-summary", { scrolls: true });

  /** Lets the tour scroll this page to whatever the current step is about. */
  const tourScroll = useTourScrollView();

  const refreshSummary = summaryState.load;
  const refreshOverview = overviewState.load;
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshSummary(), refreshOverview()]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshOverview, refreshSummary]);

  if (!selected) {
    return (
      <Screen safeTop>
        <View style={{ padding: space.lg }}>
          {/*
            An empty list means one of two very different things, and saying
            the wrong one is costly: telling an owner who already has
            businesses to "set up a business first" reads as though their data
            is gone, and invites them to create a duplicate. So a failed load
            says so, and offers to try again.
          */}
          {profilesError ? (
            <>
              <ErrorNote>{profilesError}</ErrorNote>
              <Button
                title="Try again"
                variant="secondary"
                onPress={() => refreshProfiles().catch(() => undefined)}
                style={{ marginTop: space.md }}
              />
            </>
          ) : (
            <EmptyState
              title="Finish setting up your business"
              image={mascotSource("emptyDashboard")}
              body="FinSight needs your business name and a few figures before it can work out your sales target, track your recovery or flag large expenses. Anything you already typed was kept."
              action={
                <Button
                  title="Continue setup"
                  variant="primary"
                  onPress={() => navigation.navigate("Onboarding")}
                />
              }
            />
          )}
        </View>
      </Screen>
    );
  }

  /*
   * "Has this business ever recorded anything" — NOT "did it record anything
   * in the selected period". These were the same expression, and the
   * difference is not academic: an owner who imported two years of history saw
   * "Record your first expense or sale" still unticked, because none of their
   * records fell inside the last 30 days. The checklist told them the import
   * had failed. It had not.
   */
  const hasRecords = summary?.lifetime
    ? summary.lifetime.recordCount > 0
    : !!summary && (summary.overview.totalExpenses > 0 || summary.overview.totalSalesReference > 0);

  /** Records exist, just none in this window — otherwise indistinguishable from a failed import. */
  const periodIsEmpty =
    !!summary &&
    hasRecords &&
    summary.overview.totalExpenses === 0 &&
    summary.overview.totalSalesReference === 0;
  // The server's total, not the ten alerts it sends; a summary from before
  // that field existed still counts its rows.
  const unreadCount = !summary
    ? 0
    : typeof summary.unreadAlertCount === "number"
      ? summary.unreadAlertCount
      : summary.alerts.filter((a) => !a.readStatus).length;
  /*
   * Named from the window the SERVER actually returns — a rolling lookback
   * ending today — not from a calendar month it does not compute. "This month"
   * over a 22 Jul-20 Aug window is a figure an owner cannot reconcile against
   * their own August books, and nothing on the card says why.
   */
  const allTime = selection.kind === "all";
  const recentRange = summary && !allTime
    ? { dateFrom: summary.periodStart.slice(0, 10), dateTo: summary.periodEnd.slice(0, 10) }
    : null;
  const recoveryStatus = summary?.recoveryStatus;
  const recoveryNeedsSetup = recoveryStatus
    ? recoveryStatus.status
      ? recoveryStatus.status === "needs_setup"
      : (recoveryStatus.needsSetup ?? recoveryStatus.expectedMonthlyExpenses <= 0)
    : false;
  const recoveryLabel = !recoveryStatus
    ? "Not available"
    : recoveryNeedsSetup
      ? "Not set up"
      : recoveryStatus.status === "covered"
        ? "Target reached"
        : recoveryStatus.status === "ahead"
          ? "Ahead of pace"
          : recoveryStatus.status === "on_pace" || recoveryStatus.onTrack
            ? "On track"
            : recoveryStatus.status === "no_current_month_data"
              ? "No sales yet"
              : recoveryStatus.status === "data_incomplete"
                ? "Data incomplete"
                : "Behind pace";
  const recoveryIsPositive = ["Target reached", "Ahead of pace", "On track"].includes(recoveryLabel);
  const recoveryIsCritical = recoveryLabel === "Behind pace";
  const largestCategory = summary
    ? [...summary.expenseCategoryBreakdown].sort((a, b) => b.total - a.total)[0] ?? null
    : null;
  const openRecoveryAction = () => {
    if (!summary) return;
    if (recoveryNeedsSetup) {
      navigation.navigate("More", {
        screen: "BusinessProfileForm",
        params: { profile: selected },
      });
    } else if (summary.recoveryStatus.status === "data_incomplete" || summary.recordsNeedingReview > 0) {
      openFlaggedRecords(navigation, "Dashboard");
    } else if (summary.recoveryStatus.status === "no_current_month_data") {
      navigation.navigate("Records", { screen: "AddSales" });
    } else {
      navigation.navigate("Insights", { screen: "RecoveryTarget" });
    }
  };
  const recoveryActionLabel =
    !summary || recoveryNeedsSetup
      ? "Set starting estimate"
      : summary.recoveryStatus.status === "data_incomplete" || summary.recordsNeedingReview > 0
        ? "Review flagged records"
        : summary.recoveryStatus.status === "no_current_month_data"
          ? "Add a sales record"
          : "View recovery plan";

  /*
   * "Couldn't refresh" and "nothing here" are different sentences.
   *
   * `hasData` is the whole distinction: with figures on screen this is a
   * warning that they are older than they look, and without them it is an
   * explanation for a blank page — which is what Home used to answer with a
   * skeleton that spun for ever.
   */
  const loadNotice = describeLoadFailure(failure, {
    hasData: !!summary,
    lastUpdatedAt: summaryState.lastUpdatedAt,
    now: clock,
    subject: "your figures",
  });
  const overviewNotice = describeLoadFailure(overviewFailure, {
    hasData: overviewState.data !== null,
    lastUpdatedAt: overviewState.lastUpdatedAt,
    now: clock,
    subject: "expense opportunities",
  });

  return (
    <Screen safeTop>
      <ContentScrollView
        // Lets the product tour bring a step's target into view before the
        // step is shown — Home is taller than the phone, and half the tour was
        // describing things that were off screen.
        {...tourScroll}
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE, gap: space.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={brand[600]} />}
      >
        <HomeHeader
          selected={selected}
          profiles={profiles}
          onSwitch={selectProfile}
          unreadCount={unreadCount}
          onBellPress={() => navigation.navigate("Notifications")}
        />

        {/*
          Greets the person, not the business — so it sits under the business
          switcher rather than above it, where it would look like a label for
          whichever profile happens to be selected.

          `summary` is passed even though the screen may still be loading: the
          date, the greeting and Fin all render immediately either way, and only
          Fin's one-line note waits on this — as a skeleton inside the panel, so
          the card does not change height when the figures land.
        */}
        {/*
          OFF IS OFF. "Show Fin's daily message" (Settings → Daily mascot
          message) hides this panel and nothing else — Fin still introduces the
          tour, still sits on the empty-dashboard illustration, and still
          answers in Ask FinSight. This is the one unprompted daily message,
          which is the only thing an owner is turning off.

          `preferences` reads as the defaults until /auth/me answers, and that
          default is ON — so the panel does not blink out of the top of Home
          for a beat on every cold start.
        */}
        {preferences.showDashboardMascotMessage ? (
          <GreetingHero summary={loading ? null : summary} />
        ) : null}

        {!loading && summary ? (
          <SetupProgress
            steps={[
              { label: "Set up your business profile", done: true },
              { label: "Add an expense category", done: categories.length > 0 },
              { label: "Record your first expense or sale", done: hasRecords },
            ]}
          />
        ) : null}

        <PeriodStatus />

        {/*
          One line above the panels rather than a "no data" note inside each of
          them: three empty cards describe the symptom three times, while this
          gives the cause. The date is the whole value — "no records in this
          period" is as opaque as the empty cards, whereas naming the most
          recent record tells the owner their import landed and where it is.
        */}
        {!loading && periodIsEmpty ? (
          <View style={{ marginBottom: space.lg }}>
            <Callout tone="info">
              No records {periodPhrase(selection)}.
              {summary!.lifetime!.latestRecordDate
                ? ` Latest record: ${new Date(summary!.lifetime!.latestRecordDate).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    // Date-only columns stored at midnight UTC — formatting in
                    // local time shows the previous day west of it.
                    timeZone: "UTC",
                  })}.`
                : ""}
            </Callout>
            {/*
              The fix, not a signpost. Telling the owner their data is in
              Records answered "is it there?" and left Home permanently blank
              for them — which is the screen the insights live on.
            */}
            <Button
              title="Show all time"
              variant="secondary"
              onPress={() => setSelection(ALL_TIME)}
              style={{ marginTop: space.sm }}
            />
          </View>
        ) : null}

        <ConnectionNotice
          notice={loadNotice ?? overviewNotice}
          onRetry={onRefresh}
          busy={refreshing || summaryState.refreshing || overviewState.refreshing}
        />

        {/*
          The age of the figures, stated even when nothing is wrong.

          It sits under the banner rather than inside it so that it is still
          there on a good day: a figure with no timestamp is read as current,
          and this screen refetches on focus, which is exactly the pattern that
          makes an owner stop wondering.
        */}
        {summary ? (
          <FreshnessStatus
            at={summaryState.lastUpdatedAt}
            now={clock}
            refreshing={refreshing || summaryState.refreshing}
          />
        ) : null}

        {loading || (!summary && !failure) ? (
          // Shaped like the dashboard rather than a centred spinner, so the
          // layout does not jump when the figures land.
          <SkeletonDashboard />
        ) : !summary ? (
          /*
            Nothing to draw and a banner above already saying why. The skeleton
            used to stay here for ever in this state, which reads as "still
            loading" — a promise the screen had already given up on.
          */
          null
        ) : (
          <>
            <View {...summaryTourTarget}>
              <MoneyFlowPanel
                sales={summary.overview.totalSalesReference}
                expenses={summary.overview.totalExpenses}
                funds={summary.overview.availableFunds}
                periodPhrase={periodPhrase(selection)}
                provenance={
                  summary.overview.availableFundsCalculation
                    ? availableFundsProvenance(summary.overview.availableFundsCalculation)
                    : null
                }
                salesDelta={summaryDelta(summary.periodComparison, "sales")}
                expensesDelta={summaryDelta(summary.periodComparison, "expenses")}
                netDelta={summaryDelta(summary.periodComparison, "net")}
                against={summary.periodComparison ? previousRangeShort(summary.periodComparison) : null}
                periodControl={<PeriodPill />}
              />
            </View>

            {recoveryNeedsSetup ? (
              <Card>
                <SectionTitle question="Monthly target" icon="flag-outline" tone="accent" />
                <T variant="caption" style={{ marginTop: space.sm }}>Add your monthly expenses to get a daily sales target.</T>
                <Button title={recoveryActionLabel} variant="primary" onPress={openRecoveryAction} style={{ marginTop: space.md }} />
              </Card>
            ) : (
              <TodayGoalSummary
                recovery={summary.recoveryStatus}
                statusLabel={recoveryLabel}
                tone={recoveryIsPositive ? "good" : recoveryIsCritical ? "critical" : "warning"}
                basisNote={
                  summary.recoveryStatus.monthlyExpenseBasis
                    ? monthlyExpenseBasisProvenance(summary.recoveryStatus.monthlyExpenseBasis)
                    : null
                }
                onOpenRecovery={() => navigation.navigate("Insights", { screen: "RecoveryTarget" })}
                action={<Button title={recoveryActionLabel} variant="primary" onPress={openRecoveryAction} />}
              />
            )}

            <Card>
              <SectionTitle question="What needs my attention?" icon="notifications-outline" tone="accent" />
              <View style={{ marginTop: space.sm }}>
                <IconRow
                  first
                  icon="flag-outline"
                  tone="critical"
                  title="Records to review"
                  detail={summary.recordsNeedingReview > 0 ? "Flagged or pending review" : "All clear"}
                  right={<T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodyLg, color: t.textPrimary }}>{summary.recordsNeedingReview}</T>}
                  onPress={summary.recordsNeedingReview > 0 ? () => openFlaggedRecords(navigation, "Dashboard") : undefined}
                  accessibilityLabel={`${summary.recordsNeedingReview} to review`}
                />
                {topOpportunity ? (
                  <IconRow
                    icon="bulb-outline"
                    title={topOpportunity.categoryName}
                    detail="Worth a look: a possible saving"
                    onPress={() => navigation.navigate("Insights", { screen: "ExpenseBehavior" })}
                    accessibilityLabel={`Save on ${topOpportunity.categoryName}`}
                  />
                ) : null}
                {largestCategory ? (
                  <IconRow
                    icon="pie-chart-outline"
                    tone="info"
                    title="Largest expense"
                    detail={largestCategory.categoryName}
                    right={<T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodyLg, color: t.textPrimary }}>{`${Math.round(largestCategory.percent)}%`}</T>}
                    onPress={() => navigation.navigate("Insights", { screen: "ExpenseBehavior" })}
                  />
                ) : null}
              </View>
              <View style={{ flexDirection: stackedActions ? "column" : "row", gap: space.sm, marginTop: space.md }}>
                <Button title="Ask FinSight" variant="secondary" onPress={() => setAskOpen(true)} style={{ flex: 1 }} />
                <Button
                  title="Plan a purchase"
                  variant="secondary"
                  onPress={() => navigation.navigate("Insights", { screen: "SpendingImpact" })}
                  style={{ flex: 1 }}
                />
              </View>
            </Card>

            {/*
              One picture of where the money went, and the way to the trends.
              It replaced "More charts", which hid three charts behind an
              expander most owners never opened — see SpendingSplitCard.
            */}
            {hasRecords ? (
              <SpendingSplitCard
                rows={summary.expenseCategoryBreakdown}
                onTrends={() => navigation.navigate("Insights", { screen: "ExpenseBehavior" })}
                onMoneyFlow={() => navigation.navigate("MoneyFlow")}
              />
            ) : null}

            <UpcomingExpenses
              businessProfileId={selected.id}
              onOpen={(schedule) =>
                navigation.navigate("Insights", { screen: "RecurringSchedule", params: { scheduleId: schedule.id } })}
              onManage={() => navigation.navigate("Insights", { screen: "ExpenseBehavior" })}
              onAdd={() => navigation.navigate("Insights", { screen: "RecurringSchedule", params: {} })}
            />

            {hasRecords ? (
              <RecentRecords
                businessProfileId={selected.id}
                range={recentRange}
                periodText={periodPhrase(selection)}
                categories={categories}
                onOpen={(record) => navigation.navigate("Records", { screen: "EditRecord", params: { record } })}
                onViewAll={() => navigation.navigate("Records", { screen: "RecordsList" })}
              />
            ) : null}

            {!hasRecords ? (
              <EmptyState
                title="Nothing recorded yet"
                image={mascotSource("emptyDashboard")}
                body="Your dashboard fills in as soon as you record something. Even one day of expenses gives FinSight enough to start."
                action={
                  <Button
                    title="Add your first expense"
                    variant="primary"
                    onPress={() => navigation.navigate("Records", { screen: "AddExpense" })}
                  />
                }
              />
            ) : null}
          </>
        )}
      </ContentScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it.
        Bottom-right rather than centred: the raised Scan button in the tab bar
        pokes up into this corner of the screen, and two round buttons stacked
        on the same axis would read as one control.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Dashboard" />
    </Screen>
  );
}
