import { CONTENT_WIDTH, ContentScrollView } from "../components/ContentScrollView";
import { useEffect, useRef, useState } from "react";
import { Alert as RNAlert, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useReducedMotion } from "../lib/useReducedMotion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, Disclosure, ErrorNote, Field, Money, Screen, T } from "../components/ui";
import { DateField } from "../components/DateField";
import { RecoveryScenarioSheet } from "../components/RecoveryScenarioSheet";
import { SkeletonCard } from "../components/Skeleton";
import { CumulativeSalesChart } from "../components/charts";
import { PeriodPill, PeriodStatus } from "../components/PeriodSelector";
import { RecoverySummaryCard } from "../components/RecoveryPeriodCards";
import {
  CheckpointFlags,
  DailyTargetBreakdown,
  DayCalendar,
  DayScore,
  RecoveryCoachCard,
  RecoveryNextGoal,
  TodayGoalCard,
} from "../components/RecoveryVisuals";
import { SectionTitle } from "../components/CoachKit";
import { Mascot } from "../components/MascotState";
import { HERO } from "../theme/hero";
import { TAP_FLOOR } from "../components/touchTarget";
import { RecoveryWhatIfCard } from "../components/RecoveryWhatIf";
import { ReportingPeriodScope, useReportingPeriod } from "../context/ReportingPeriodContext";
import { useAiChat } from "../context/AiChatContext";
import { THIS_WEEK, periodKey, periodParams } from "../lib/reportingPeriod";
import {
  buildCumulativeSeries,
  formatOperatingDays,
  recoveryAskQuestion,
  recoveryPeriodLabel,
  reportingPeriodOf,
} from "../lib/recoveryPeriodView";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { ConnectionNotice, FreshnessStatus } from "../components/ConnectionNotice";
import { InsightHeader } from "../components/InsightsShared";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useInsight } from "../lib/useInsight";
import { api, errorMessage } from "../lib/api";
import { useImportOperation } from "../lib/useImportOperation";
import { describeLoadFailure, toLoadFailure } from "../lib/connectionState";
import { monthlyExpenseBasisProvenance } from "../lib/financialPosition";
import { formatMoney } from "../lib/money";
import { bufferPercentError, currentMonthKey, ownerTargetAmountError, parsePlanNumber } from "../lib/recoveryPlanForm";
import { dayStatusTone } from "../lib/recoveryTone";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { openOperatingScheduleFromRecovery } from "../lib/operatingScheduleNavigation";
import { openMonthEndReviewFromRecovery } from "../lib/monthEndReviewNavigation";
import type {
  BusinessProfile,
  RecoveryChangeSincePreviousDay,
  RecoveryCheckpoint,
  RecoveryCheckpointStatus,
  RecoveryInsight,
  RecoveryPlan,
  RecoveryStatus,
} from "../lib/types";
import type { InsightsScreenProps } from "../navigation/types";

// ---------------------------------------------------------------- Recovery target

export function RecoveryTargetScreen(props: InsightsScreenProps<"RecoveryTarget">) {
  return (
    <ReportingPeriodScope scope="recovery-target">
      <RecoveryTargetContent {...props} />
    </ReportingPeriodScope>
  );
}

function RecoveryTargetContent({ navigation }: InsightsScreenProps<"RecoveryTarget">) {
  const t = useTheme();
  const { selected } = useBusinessProfiles();
  const chat = useAiChat();
  /*
   * Recovery is measured per week or per month. All time has no target, so
   * an unsupported choice falls back to This week within this screen.
   */
  const { selection: sharedSelection, setSelection, ready: periodReady } = useReportingPeriod();
  const selection = sharedSelection.kind === "all" ? THIS_WEEK : sharedSelection;
  useEffect(() => {
    if (sharedSelection.kind === "all") setSelection(THIS_WEEK);
  }, [setSelection, sharedSelection]);
  const [askOpen, setAskOpen] = useState(false);
  const [showDefinition, setShowDefinition] = useState(false);
  /** The full what-if sheet, for a typed amount. */
  const [scenarioOpen, setScenarioOpen] = useState(false);
  // In-page jumps for the primary action: "View today's plan" and "Review month summary".
  const scrollRef = useRef<ScrollView>(null);
  const planY = useRef<number | null>(null);
  const daysY = useRef<number | null>(null);
  // 31 days so a month view carries every day it has had; the server bounds
  // it to the selected week or month.
  const { data, loading, error, load } = useInsight<RecoveryInsight>(
    "/insights/recovery",
    { businessProfileId: selected?.id, coverageDays: 31, ...periodParams(selection) },
    [selected?.id, periodKey(selection), periodReady],
    { enabled: Boolean(selected && periodReady) },
  );
  const period = data ? reportingPeriodOf(data) : null;
  /** Today's figures, the saved plan and the scenario only describe the current month. */
  const isCurrentMonthView = Boolean(period && period.kind === "month" && period.isCurrent);
  const planMonth = currentMonthKey();
  const planState = useInsight<RecoveryPlan[]>(
    `/business-profiles/${selected?.id ?? "none"}/recovery-plans`,
    { month: planMonth },
    [selected?.id, planMonth],
    { enabled: Boolean(selected && isCurrentMonthView) },
  );
  const [planOverride, setPlanOverride] = useState<{
    businessProfileId: number;
    plan: RecoveryPlan | null;
  } | null>(null);
  useEffect(() => {
    if (planState.data !== null) setPlanOverride(null);
  }, [planState.data]);
  const plan =
    selected && planOverride?.businessProfileId === selected.id
      ? planOverride.plan
      : planState.data?.[0] ?? null;
  const planNotice = describeLoadFailure(
    planState.rawError ? toLoadFailure(planState.rawError) : null,
    {
      hasData: planState.data !== null,
      lastUpdatedAt: planState.lastUpdatedAt,
      subject: "your saved recovery plan",
    },
  );
  const monthlyBasis = data?.monthlyExpenseBasis ?? null;

  if (!selected) return null;

  const jumpTo = (y: number | null) => {
    if (y === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - space.md), animated: true });
  };

  const needsSetup = period?.status === "needs_setup";
  /** The question the Ask card leads with: the one a behind owner is actually asking. */
  const askPrompt =
    period?.status === "behind" && !period.isComplete
      ? `Why am I behind ${period.kind === "week" ? "this week" : "this month"}?`
      : "Ask about this period";
  const provisional = isCurrentMonthView ? data?.provisionalSalesThisMonth ?? 0 : period?.provisionalSales ?? 0;
  const warnings = isCurrentMonthView ? data?.dataWarnings ?? [] : period?.dataWarnings ?? [];
  const scheduleConfigured = isCurrentMonthView ? data?.operatingScheduleConfigured : period?.operatingScheduleConfigured;
  const daysApproximated = isCurrentMonthView
    ? data?.remainingOperatingDaysIsApproximated
    : period?.operatingDaysIsApproximated;

  return (
    <Screen safeTop>
      <ContentScrollView
        ref={scrollRef}
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader
          navigation={navigation}
          active="RecoveryTarget"
          title="Recovery target"
          titleAccessory={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="About the recovery target"
              onPress={() => setShowDefinition(true)}
              style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name="information-circle-outline" size={20} color={t.brandText} />
            </Pressable>
          }
          right={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Manage recovery target notification settings"
              onPress={() => navigation.navigate("More", { screen: "RecoveryNotificationPreferences", initial: false })}
              style={({ pressed }) => ({
                width: TAP_FLOOR,
                height: TAP_FLOOR,
                borderRadius: TAP_FLOOR / 2,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? t.surfaceMuted : t.surface,
              })}
            >
              <Ionicons name="notifications-outline" size={20} color={t.brandText} />
            </Pressable>
          }
        />

        {/* Recovery has no all-time view, so its "now" reminder only ever names a past week or month. */}
        <View style={{ marginBottom: space.md }}>
          <PeriodStatus />
        </View>

        {/* A refresh failure with data already on screen keeps showing that
            data, labeled stale, rather than replacing it with an error. */}
        {error && data ? (
          <View style={{ marginBottom: space.md }}>
            <ErrorNote>Showing the last successful result. Refreshing failed: {error}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={load} style={{ marginTop: space.sm }} />
          </View>
        ) : null}

        {loading && !data ? (
          <View style={{ gap: space.lg }}>
            <SkeletonCard style={{ height: 300, borderRadius: 28 }} />
            <SkeletonCard style={{ height: 150 }} />
            <SkeletonCard style={{ height: 260 }} />
          </View>
        ) : error && !data ? (
          <View style={{ gap: space.md }}>
            <ErrorNote>{error}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={load} />
          </View>
        ) : data && period ? (
          <View style={{ gap: space.lg }}>
            <RecoveryCoachCard
              data={data}
              period={period}
              isCurrentMonth={isCurrentMonthView}
              header={
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <PeriodPill showAllTime={false} />
                  {data.asOfDate ? (
                    <T style={{ fontSize: typeScale.caption, color: HERO.muted }}>
                      {`As of ${new Date(data.asOfDate).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`}
                    </T>
                  ) : null}
                </View>
              }
            />
            <RecoveryNextGoal period={period} />

            {isCurrentMonthView ? (
              <RecoveryPrimaryAction
                status={data.status}
                navigation={navigation}
                businessProfile={selected}
                onViewPlan={() => jumpTo(planY.current)}
                onReviewMonth={() => jumpTo(daysY.current)}
              />
            ) : null}

            {isCurrentMonthView && !needsSetup ? (
              <TodayGoalCard data={data}>
                {data.changeSincePreviousDay && data.changeSincePreviousDay.primaryReason !== "no_material_change" ? (
                  <View style={{ marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.accent[100] }}>
                    <RecoveryChangeExplanation change={data.changeSincePreviousDay} />
                  </View>
                ) : null}
              </TodayGoalCard>
            ) : null}

            <View onLayout={(e) => (daysY.current = e.nativeEvent.layout.y)}>
              <Card>
                <SectionTitle eyebrow="Daily coverage" question="How did each day go?" icon="calendar-outline" />
                <DayCalendar period={period} rows={data.dailyCoverage} />
                <DayScore rows={data.dailyCoverage} />
                <View style={{ borderTopWidth: 1, borderTopColor: t.border, marginTop: space.md }}>
                  <Disclosure
                    title="Day-by-day list"
                    summary={`${data.dailyCoverage.length} days · sales and target status`}
                    defaultOpen={data.dailyCoverage.length <= 4}
                  >
                    <DailyCoverageRows days={data.dailyCoverage} />
                  </Disclosure>
                </View>
              </Card>
            </View>

            <Card>
              <CumulativeSalesChart
                points={buildCumulativeSeries(
                  data.dailyCoverage,
                  period,
                  period.kind === "month" ? data.weeklyCheckpoints ?? [] : [],
                )}
                subtitle={`Running totals, ${recoveryPeriodLabel(period)}`}
              />
            </Card>

            {period.kind === "month" && data.weeklyCheckpoints && data.weeklyCheckpoints.length > 0 ? (
              <Card>
                <T accessibilityRole="header" variant="heading" style={{ marginBottom: 2 }}>
                  Weekly checkpoints
                </T>
                <T variant="caption">How much you should have sold by each date</T>
                <CheckpointFlags checkpoints={data.weeklyCheckpoints} today={data.today} />
                <RecoveryCheckpointsCard checkpoints={data.weeklyCheckpoints} today={data.today} salesSoFar={period.sales} />
              </Card>
            ) : null}

            {!period.isComplete && !needsSetup ? (
              <View onLayout={(e) => (planY.current = e.nativeEvent.layout.y)}>
                <Card>
                  <SectionTitle
                    eyebrow={period.kind === "month" ? "Remaining recovery target" : "Remaining weekly target"}
                    question={
                      period.adjustedDailyTarget !== null
                        ? `Why ${formatMoney(period.adjustedDailyTarget)} a day?`
                        : "What's left to cover?"
                    }
                    icon="help-circle-outline"
                  />
                  <DailyTargetBreakdown period={period} />
                  <View style={{ marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: t.border, gap: 4 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                      <T variant="caption" style={{ flex: 1 }}>
                        {`Started at ${formatMoney(period.dailyTarget)} × ${formatOperatingDays(
                          period.operatingDays,
                          period.operatingDaysIsApproximated,
                        )} days`}
                      </T>
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => openOperatingScheduleFromRecovery(navigation)}
                        hitSlop={8}
                        style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: 2 }}
                      >
                        <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>
                          {daysApproximated && !scheduleConfigured ? "Edit operating schedule" : "Edit schedule"}
                        </T>
                        <Ionicons name="chevron-forward" size={14} color={t.brandText} />
                      </Pressable>
                    </View>
                    {daysApproximated && !scheduleConfigured ? (
                      <T variant="caption">Estimated from the operating days in your profile.</T>
                    ) : null}
                    {isCurrentMonthView && monthlyBasis ? (
                      <T variant="caption">{monthlyExpenseBasisProvenance(monthlyBasis)}</T>
                    ) : null}
                    {/* Purely additive: the sales figure is never hidden or changed by this. */}
                    {warnings.length > 0 ? (
                      <T variant="caption">
                        Includes {formatMoney(provisional)} pending review or flagged as a possible duplicate.
                      </T>
                    ) : null}
                  </View>
                </Card>
              </View>
            ) : null}

            {/*
              The saved plan: an owner-visible reference note only. Absent when
              nothing has been saved for the current month.
            */}
            {isCurrentMonthView ? (
              <>
                {planState.loading && planState.data === null ? <SkeletonCard style={{ height: 96 }} /> : null}
                <ConnectionNotice notice={planNotice} onRetry={() => void planState.load()} busy={planState.refreshing} />
                {plan ? <FreshnessStatus at={planState.lastUpdatedAt} now={Date.now()} refreshing={planState.refreshing} /> : null}
                {plan ? (
                  <SavedPlanCard
                    businessProfileId={selected.id}
                    plan={plan}
                    onChanged={(next) => setPlanOverride({ businessProfileId: selected.id, plan: next })}
                  />
                ) : null}
              </>
            ) : null}

            {isCurrentMonthView && !needsSetup ? (
              <RecoveryWhatIfCard
                businessProfileId={selected.id}
                basis={data.expectedMonthlyExpenses}
                plan={plan}
                onTypeAmount={() => setScenarioOpen(true)}
                onPlanSaved={(next) => setPlanOverride({ businessProfileId: selected.id, plan: next })}
              />
            ) : null}

            <RecoverySummaryCard period={period} />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${askPrompt}${askPrompt.endsWith("?") ? "" : "."} Ask FinSight`}
              onPress={() => {
                chat.prepareQuestion(recoveryAskQuestion(period));
                setAskOpen(true);
              }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space.md,
                padding: space.md,
                borderRadius: 20,
                backgroundColor: HERO.to,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Mascot state="recoveryGuide" size={44} />
              <View style={{ flex: 1 }}>
                <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: HERO.ink }}>{askPrompt}</T>
                <T style={{ fontSize: typeScale.caption, color: HERO.muted }}>Ask FinSight</T>
              </View>
              <Ionicons name="arrow-forward" size={18} color={HERO.ink} />
            </Pressable>

            {isCurrentMonthView ? (
              <Button
                title="View last month's summary"
                variant="secondary"
                onPress={() => openMonthEndReviewFromRecovery(navigation)}
              />
            ) : null}
          </View>
        ) : null}
      </ContentScrollView>

      {/* Outside the ScrollView so it stays put while the page moves under it. */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      {/*
        "Sales Coverage Target" is the explanatory name; "Recovery target"
        stays as the nav label. The definition used to sit, cut to two lines,
        above the first status; it is one tap away now, whole, so the figures
        are still never more than a tap from "this is a planning guide".
      */}
      <RecoveryAboutSheet
        visible={showDefinition}
        onClose={() => setShowDefinition(false)}
        asOf={data?.asOfDate
          ? `As of ${new Date(data.asOfDate).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}${data.timezone ? ` · ${data.timezone} time` : ""}`
          : null}
      />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Recovery Target" />

      {selected && data ? (
        <RecoveryScenarioSheet
          // Forces a remount on profile switch so the scenario's local state
          // (input, result) can't leak from one business into another.
          key={selected.id}
          visible={scenarioOpen}
          businessProfileId={selected.id}
          currentExpectedMonthlyExpenses={data.expectedMonthlyExpenses}
          onClose={() => setScenarioOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/** Exact daily figures stay available without making a long month dominate the screen. */
function DailyCoverageRows({ days }: { days: RecoveryInsight["dailyCoverage"] }) {
  const t = useTheme();
  const { paper, statusText } = t;
  return (
    <View>
      {days.map((day, index) => {
        const closed = day.status === "closed";
        const toneKey = dayStatusTone(day.status);
        const tone = toneKey === "muted" ? t.textMuted : statusText[toneKey];
        return (
          <View
            key={day.date}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              paddingVertical: space.sm,
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: paper[200],
            }}
          >
            <T variant="caption" style={{ width: 48, fontFamily: font.monoMedium }}>
              {day.date.slice(5)}
            </T>
            <Money value={day.sales} size={typeScale.caption} weight="medium" />
            <T style={{ flex: 1, textAlign: "right", fontSize: typeScale.caption, color: tone }}>
              {closed
                ? "Closed"
                : day.status === "at"
                  ? "Target reached"
                  : `${formatMoney(Math.abs(day.gap ?? 0))} ${day.status} target`}
            </T>
          </View>
        );
      })}
    </View>
  );
}

/**
 * §10.1/§10.2 primary action: one prominent, state-driven control per the
 * plan's state/action table. `behind` and `covered` jump to the card that
 * answers them on this same screen (the daily plan, the day calendar), the
 * way web's anchors do. `ahead` has no destination, so it stays plain text.
 *
 * Renders nothing when `status` is undefined: an older/cached response that
 * predates the `status` field.
 */
function RecoveryPrimaryAction({
  status,
  navigation,
  businessProfile,
  onViewPlan,
  onReviewMonth,
}: {
  status: RecoveryStatus | undefined;
  navigation: InsightsScreenProps<"RecoveryTarget">["navigation"];
  businessProfile: BusinessProfile | null;
  onViewPlan: () => void;
  onReviewMonth: () => void;
}) {
  if (!status) return null;

  const goToRecords = () => navigation.navigate("Records", { screen: "RecordsList", params: { type: "sales" } });

  switch (status) {
    case "needs_setup":
      return (
        <Button
          title="Complete setup"
          variant="primary"
          onPress={() =>
            navigation.navigate("More", { screen: "BusinessProfileForm", params: { profile: businessProfile ?? undefined } })
          }
        />
      );
    case "no_current_month_data":
      return <Button title="Record or import sales" variant="primary" onPress={goToRecords} />;
    case "data_incomplete":
      // Not yet emitted by the server (plan §10.2 table); wired ahead of time.
      return <Button title="Review sales" variant="primary" onPress={goToRecords} />;
    case "on_pace":
      return (
        <Button
          title="Record today's sales"
          variant="primary"
          onPress={() => navigation.navigate("Records", { screen: "AddSales" })}
        />
      );
    case "behind":
      return <Button title="View today's plan" variant="primary" onPress={onViewPlan} />;
    case "ahead":
      return (
        <T variant="label" style={{ textAlign: "center" }}>
          Maintain current pace
        </T>
      );
    case "covered":
      return <Button title="Review month summary" variant="secondary" onPress={onReviewMonth} />;
    default:
      return null;
  }
}

/**
 * §8.2/§10.3 "Why your target changed" — the server's own deterministic
 * day-over-day diff, plain-language mapped by `primaryReason`. Callers
 * already filter out `null` and `no_material_change` before rendering this.
 */
function RecoveryChangeExplanation({ change }: { change: RecoveryChangeSincePreviousDay }) {
  const { statusText } = useTheme();
  const { adjustedDailyTargetDelta, salesAdded, primaryReason } = change;
  const increased = adjustedDailyTargetDelta > 0;
  const direction = increased ? "increased" : "decreased";
  const reasonCopy =
    primaryReason === "sales_added"
      ? "Recorded sales are helping close the gap."
      : primaryReason === "open_day_elapsed"
        ? "A day has passed, and the remaining amount is now spread across fewer days."
        : "Your setup or schedule changed.";

  return (
    <View>
      <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
        Why your target changed
      </T>
      <T style={{ marginBottom: space.xs }}>
        Your adjusted daily target {direction} by{" "}
        {formatMoney(Math.abs(adjustedDailyTargetDelta), { decimals: true })}.{" "}
        <T style={{ color: increased ? statusText.critical : statusText.good }}>{reasonCopy}</T>
      </T>
      {salesAdded !== 0 ? (
        <T variant="caption" style={{ marginBottom: space.sm }}>
          {/* salesAdded is server-derived as a sum of positive-validated sales
              amounts, so it's currently always non-negative; this would need
              distinct phrasing if refunds/negative adjustments ever feed it. */}
          You recorded {formatMoney(salesAdded, { decimals: true })} in sales since yesterday.
        </T>
      ) : null}
      {/*
        This section is server-computed arithmetic, not AI-generated text —
        same disclosure convention AskFinSight already uses for its own
        computed figures (see AskFinSight.tsx's "calculated by FinSight, not
        by AI").
      */}
      <T variant="caption">This explanation is calculated by FinSight, not written by AI.</T>
    </View>
  );
}

/**
 * §10.4 weekly checkpoints — the LAST checkpoint that has passed and the NEXT
 * one still ahead, shown prominently, with the full month's list secondary
 * behind this app's existing `Disclosure` pattern (the shared "closed until
 * wanted" primitive — see ui.tsx — rather than a bespoke expand/collapse
 * control). Early in the month no checkpoint has passed yet, so only the
 * next one shows; on the final stretch there is no next one.
 */
function RecoveryCheckpointsCard({
  checkpoints,
  today,
  salesSoFar,
}: {
  checkpoints: RecoveryCheckpoint[];
  today: string;
  salesSoFar: number;
}) {
  const past = checkpoints.filter((c) => c.endDate <= today);
  const last = past.length > 0 ? past[past.length - 1] : null;
  const next = checkpoints.find((c) => c.endDate > today) ?? null;

  return (
    <View style={{ marginTop: space.lg, gap: space.sm }}>
      {last ? <LastCheckpointCard checkpoint={last} /> : null}
      {next ? <NextCheckpointCard checkpoint={next} today={today} salesSoFar={salesSoFar} /> : null}

      <Disclosure title="All checkpoints this month" defaultOpen={false}>
        {checkpoints.map((c, i) => (
          <CheckpointListRow key={c.endDate} checkpoint={c} first={i === 0} />
        ))}
      </Disclosure>
    </View>
  );
}

/** Tone mapping shared by both checkpoint renderings below — same status palette RecoveryMeter and the "Day by day" list already use. */
function checkpointTone(status: RecoveryCheckpointStatus, statusText: Record<"good" | "warning" | "critical", string>, muted: string) {
  switch (status) {
    case "ahead":
      return statusText.good;
    case "on_pace":
      return statusText.warning;
    case "behind":
      return statusText.critical;
    case "pending":
    default:
      return muted;
  }
}

const checkpointStatusLabel: Record<RecoveryCheckpointStatus, string> = {
  ahead: "Ahead",
  on_pace: "On pace",
  behind: "Behind",
  pending: "Pending",
};

function formatCheckpointDate(date: string): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Whole days between two dates. `today` arrives as a full ISO timestamp, so only the date part is used. */
function daysUntil(from: string, to: string): number {
  const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Math.round((day(to) - day(from)) / 86_400_000);
}

type CheckpointFamily = "good" | "warning" | "critical";

/** A tinted checkpoint card: a header strip carrying the date and status, then three figures. */
function CheckpointSummaryCard({
  family,
  title,
  badge,
  stats,
}: {
  family: CheckpointFamily;
  title: string;
  badge: string;
  stats: Array<{ label: string; value: number; emphasis?: boolean }>;
}) {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${title}, ${badge}. ${stats.map((s) => `${s.label} ${formatMoney(s.value)}`).join(", ")}`}
      style={{
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: t.statusBorder[family],
        backgroundColor: t.surface,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          backgroundColor: t.statusSurface[family],
        }}
      >
        <T style={{ flex: 1, fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.textPrimary }}>{title}</T>
        <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.statusText[family] }}>{badge}</T>
      </View>
      <View style={{ flexDirection: "row", paddingHorizontal: space.md, paddingVertical: space.md, gap: space.sm }}>
        {stats.map((s) => (
          <View key={s.label} style={{ flex: 1, gap: 2 }}>
            <T variant="caption">{s.label}</T>
            <Money
              value={s.value}
              bare
              size={typeScale.bodyLg}
              weight="semibold"
              color={s.emphasis ? t.statusText[family] : t.textPrimary}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/** The most recent checkpoint that has passed: goal, what was sold by then, and the gap either way. */
function LastCheckpointCard({ checkpoint }: { checkpoint: RecoveryCheckpoint }) {
  const sold = checkpoint.recordedAmount ?? 0;
  const variance = checkpoint.variance ?? sold - checkpoint.cumulativeTarget;
  const missed = checkpoint.status === "behind";
  return (
    <CheckpointSummaryCard
      family={missed ? "critical" : "good"}
      title={`By ${formatCheckpointDate(checkpoint.endDate)} · last checkpoint`}
      badge={missed ? "Missed" : "Met"}
      stats={[
        { label: "Goal", value: checkpoint.cumulativeTarget },
        { label: "You sold", value: sold },
        { label: missed ? "Short by" : "Ahead by", value: Math.abs(variance), emphasis: true },
      ]}
    />
  );
}

/** The next checkpoint still ahead: goal, sales so far this month, and what is still needed to reach it. */
function NextCheckpointCard({ checkpoint, today, salesSoFar }: { checkpoint: RecoveryCheckpoint; today: string; salesSoFar: number }) {
  const days = daysUntil(today, checkpoint.endDate);
  const stillNeeded = Math.max(0, checkpoint.cumulativeTarget - salesSoFar);
  const reached = stillNeeded === 0;
  return (
    <CheckpointSummaryCard
      family={reached ? "good" : "warning"}
      title={`By ${formatCheckpointDate(checkpoint.endDate)} · next checkpoint`}
      badge={days <= 1 ? "Tomorrow" : `${days} days away`}
      stats={[
        { label: "Goal", value: checkpoint.cumulativeTarget },
        { label: "Sold so far", value: salesSoFar },
        { label: "Still needed", value: stillNeeded, emphasis: true },
      ]}
    />
  );
}

/** The compact secondary row used inside the "All checkpoints" disclosure. */
function CheckpointListRow({ checkpoint, first }: { checkpoint: RecoveryCheckpoint; first?: boolean }) {
  const t = useTheme();
  const { statusText, paper } = t;
  const tone = checkpointTone(checkpoint.status, statusText, t.textMuted);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: space.sm,
        gap: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
      }}
    >
      <T variant="caption" style={{ width: 56, fontFamily: font.monoMedium }}>
        {formatCheckpointDate(checkpoint.endDate)}
      </T>
      <T variant="caption" style={{ flex: 1 }}>
        Target {formatMoney(checkpoint.cumulativeTarget)}
      </T>
      <View style={{ alignItems: "flex-end" }}>
        {checkpoint.recordedAmount === null ? (
          <T variant="caption">Not yet reached</T>
        ) : (
          <Money value={checkpoint.recordedAmount} size={13} weight="medium" />
        )}
        <T style={{ fontSize: typeScale.micro, color: tone }}>{checkpointStatusLabel[checkpoint.status]}</T>
      </View>
    </View>
  );
}

/**
 * "This month's saved plan" — plan §7.5/§10.7/§11 Phase 6. A view of the
 * reference note the owner saved from the scenario sheet, with edit/delete
 * in place. Never reads or writes anything the real Recovery Target
 * calculation touches — see RecoveryPlan's own type-level warning.
 */
function SavedPlanCard({
  businessProfileId,
  plan,
  onChanged,
}: {
  businessProfileId: number;
  plan: RecoveryPlan;
  onChanged: (plan: RecoveryPlan | null) => void;
}) {
  const t = useTheme();
  const [editing, setEditing] = useState(false);
  const [amountRaw, setAmountRaw] = useState(plan.ownerTargetAmount !== null ? String(plan.ownerTargetAmount) : "");
  const [deadline, setDeadline] = useState(plan.deadline ?? "");
  const [bufferRaw, setBufferRaw] = useState(plan.bufferPercent !== null ? String(plan.bufferPercent) : "");
  const [amountFieldError, setAmountFieldError] = useState<string | null>(null);
  const [bufferFieldError, setBufferFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const operation = useImportOperation(businessProfileId);
  const activeRef = useRef(true);
  useEffect(() => () => {
    activeRef.current = false;
  }, []);

  function startEditing() {
    setAmountRaw(plan.ownerTargetAmount !== null ? String(plan.ownerTargetAmount) : "");
    setDeadline(plan.deadline ?? "");
    setBufferRaw(plan.bufferPercent !== null ? String(plan.bufferPercent) : "");
    setAmountFieldError(null);
    setBufferFieldError(null);
    setSaveError(null);
    setEditing(true);
  }

  async function saveEdits() {
    const amountErr = ownerTargetAmountError(amountRaw);
    const bufferErr = bufferPercentError(bufferRaw);
    if (amountErr || bufferErr) {
      setAmountFieldError(amountErr);
      setBufferFieldError(bufferErr);
      return;
    }
    const task = operation.begin();
    if (!task) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.put<RecoveryPlan>(`/business-profiles/${businessProfileId}/recovery-plans/${plan.month}`, {
        ownerTargetAmount: amountRaw.trim() === "" ? null : parsePlanNumber(amountRaw),
        deadline: deadline.trim() === "" ? null : deadline,
        bufferPercent: bufferRaw.trim() === "" ? null : parsePlanNumber(bufferRaw),
      }, { signal: task.controller.signal });
      if (!operation.current(task)) return;
      onChanged(updated);
      setEditing(false);
    } catch (err) {
      if (operation.current(task)) setSaveError(errorMessage(err));
    } finally {
      if (operation.current(task)) setSaving(false);
      operation.finish(task);
    }
  }

  function confirmDelete() {
    if (saving) return;
    RNAlert.alert(
      "Remove this saved plan?",
      "This only removes your own reference note for this month. Your business profile and recorded sales stay the same.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            // Native alerts outlive the React subtree that opened them. A
            // business switch unmounts this card, so a delayed tap must not
            // delete the plan from the business that is no longer selected.
            if (!activeRef.current) return;
            const task = operation.begin();
            if (!task) return;
            setSaving(true);
            try {
              await api.delete(`/business-profiles/${businessProfileId}/recovery-plans/${plan.month}`, undefined, { signal: task.controller.signal });
              if (!operation.current(task)) return;
              onChanged(null);
            } catch (err) {
              if (operation.current(task)) setSaveError(errorMessage(err));
            } finally {
              if (operation.current(task)) setSaving(false);
              operation.finish(task);
            }
          },
        },
      ],
    );
  }

  if (editing) {
    return (
      <Card style={{ gap: space.sm }}>
        <T variant="heading" accessibilityRole="header">
          Edit this month&apos;s saved plan
        </T>
        <Field
          label="Owner target amount (optional)"
          value={amountRaw}
          onChangeText={(v) => {
            setAmountRaw(v);
            setAmountFieldError(null);
          }}
          keyboardType="decimal-pad"
          error={amountFieldError}
        />
        <DateField label="Deadline (optional)" value={deadline} onChange={setDeadline} allowFuture optional onClear={() => setDeadline("")} />
        <Field
          label="Buffer percent (optional)"
          value={bufferRaw}
          onChangeText={(v) => {
            setBufferRaw(v);
            setBufferFieldError(null);
          }}
          keyboardType="decimal-pad"
          error={bufferFieldError}
        />
        {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button title="Save changes" variant="primary" onPress={saveEdits} loading={saving} style={{ flex: 1 }} />
          <Button title="Cancel" variant="secondary" disabled={saving} onPress={() => setEditing(false)} style={{ flex: 1 }} />
        </View>
        <Button title="Delete" variant="danger" disabled={saving} onPress={confirmDelete} />
      </Card>
    );
  }

  const deadlineText = plan.deadline
    ? new Date(`${plan.deadline.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
    : null;

  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          padding: space.md,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: t.brandSurface, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="bookmark-outline" size={18} color={t.brandText} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="caption" accessibilityRole="header">My saved plan · for reference only</T>
          <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.textPrimary }}>
            {plan.ownerTargetAmount !== null ? (
              <Money value={plan.ownerTargetAmount} size={typeScale.bodySm} weight="semibold" />
            ) : (
              "No amount"
            )}
            {deadlineText ? ` by ${deadlineText}` : ""}
            {plan.bufferPercent !== null ? ` · ${plan.bufferPercent}% buffer` : ""}
          </T>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit"
          onPress={startEditing}
          hitSlop={8}
          style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, alignItems: "flex-end", justifyContent: "center" }}
        >
          <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>Edit</T>
        </Pressable>
      </View>
      {saveError ? <View style={{ marginTop: space.sm }}><ErrorNote>{saveError}</ErrorNote></View> : null}
    </View>
  );
}

/*
 * The required definition (docs/RECOVERY-TARGET-IMPROVEMENT-PLAN.md §6.1),
 * word for word, one sentence per point. It must be reachable before the
 * first status; the info button beside the title is that place.
 */
const ABOUT_POINTS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: "bar-chart-outline",
    title: "What it compares",
    body: "Your Sales Coverage Target compares recorded sales references with your expected monthly expense amount.",
  },
  {
    icon: "bulb-outline",
    title: "What it is",
    body: "It is a planning guide and does not calculate profit, cash flow, or formal break-even.",
  },
];

/** The Sales Coverage Target explained in three short parts, with the as-of date and time zone. */
function RecoveryAboutSheet({ visible, onClose, asOf }: { visible: boolean; onClose: () => void; asOf: string | null }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? "none" : "slide"} statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.scrim, justifyContent: "flex-end", paddingTop: insets.top + space.md }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={StyleSheet.absoluteFill} />
        <ContentScrollView
          accessibilityViewIsModal
          onStartShouldSetResponder={() => true}
          style={{ maxHeight: "90%", flexGrow: 0, width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", backgroundColor: t.surfaceRaised, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}
          contentContainerStyle={{
            backgroundColor: t.surfaceRaised,
            paddingTop: space.md,
            paddingHorizontal: space.lg,
            paddingBottom: insets.bottom + space.lg,
            gap: space.md,
          }}
        >
          <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: t.borderStrong }} />
          <T variant="title" accessibilityRole="header">About this target</T>
          {ABOUT_POINTS.map((point) => (
            <View key={point.title} style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start" }}>
              <View style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: t.brandSurface, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name={point.icon} size={18} color={t.brandText} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>{point.title}</T>
                <T style={{ fontSize: typeScale.label, lineHeight: 19, color: t.textSecondary }}>{point.body}</T>
              </View>
            </View>
          ))}
          {asOf ? (
            <T variant="caption" style={{ paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>{asOf}</T>
          ) : null}
          <Button title="Got it" variant="brand" onPress={onClose} />
        </ContentScrollView>
      </View>
    </Modal>
  );
}
