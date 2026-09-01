import { useCallback, useRef, useState } from "react";
import { Dimensions, Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Callout, Card, EmptyState, ErrorNote, Money, Screen, SetupProgress, T } from "../components/ui";
import { HomeHeader } from "../components/HomeHeader";
import { CashflowChart } from "../components/charts";
import { GreetingHero } from "../components/GreetingHero";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { AskFinSight } from "../components/AskFinSight";
import { SpendingBreakdownCard } from "../components/SpendingBreakdownCard";
import { TopReductionOpportunityCard } from "../components/TopReductionOpportunityCard";
import { SkeletonBox, SkeletonDashboard } from "../components/Skeleton";
import { mascotSource } from "../components/MascotState";
import { useAuth } from "../context/AuthContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTourHomeStage } from "../context/TourContext";
import { useTourScrollView, useTourTarget } from "../components/tour/targets";
import { api } from "../lib/api";
import { ConnectionNotice, LastUpdated } from "../components/ConnectionNotice";
import { describeLoadFailure, toLoadFailure, type LoadFailure } from "../lib/connectionState";
import { selectTopOpportunity } from "../lib/topReductionOpportunity";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import type {
  CashflowGranularity,
  DashboardCashflow,
  DashboardSummary,
  ReductionOpportunity,
  ReductionOpportunityResponse,
} from "../lib/types";

const SUMMARY_PERIOD_DAYS = 30;
const ALL_TIME_PERIOD_DAYS = 0;
const PERIOD_OPTIONS = [
  { label: "Today", days: 1 },
  { label: "Week", days: 7 },
  { label: "Month", days: 30 },
  { label: "All time", days: 0 },
] as const;

const GRANULARITY_OPTIONS: { label: string; value: CashflowGranularity }[] = [
  { label: "Daily", value: "daily" },
  { label: "Monthly", value: "monthly" },
];

function PeriodSelector({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 4,
        borderRadius: radius.md,
        backgroundColor: t.surfaceMuted,
        borderWidth: 1,
        borderColor: t.border,
      }}
    >
      {PERIOD_OPTIONS.map((option) => {
        const selected = value === option.days;
        return (
          <Pressable
            key={option.days}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.days)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: TAP_FLOOR,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.sm,
              backgroundColor: selected ? t.surface : pressed ? t.surfaceStrong : "transparent",
            })}
          >
            <T
              variant="caption"
              style={{
                color: selected ? t.brandHeading : t.textMuted,
                fontFamily: selected ? font.sansSemibold : font.sans,
              }}
            >
              {option.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A money-in or money-out figure, sitting in the reference layout's twin-card
 * slot. Colour carries the direction — brand tint for money coming in, a
 * warm/rose tint for money going out — same tint vocabulary `Alert` already
 * uses for its surfaces, so this isn't a new colour idea, just a new place it
 * appears.
 */
function FlowCard({
  label,
  value,
  sublabel,
  direction,
}: {
  label: string;
  value: number;
  sublabel: string;
  direction: "in" | "out";
}) {
  const t = useTheme();
  const { brand, statusText, statusSurface, statusBorder } = t;
  const isIn = direction === "in";
  return (
    <Card
      style={{
        flex: 1,
        minWidth: 150,
        // Outflow uses the themed critical wash/hairline pair — the same
        // opaque `statusSurface`/`statusBorder` tokens ConnectionNotice and
        // ExpenseAlertsSection use for a status panel, rather than an
        // alpha-suffixed hex on top of `statusText`. An alpha-transparent
        // backgroundColor combined with this card's `elevation` renders a
        // stray opaque box under the shadow on Android — statusSurface is
        // already opaque, so the card paints as one surface.
        backgroundColor: isIn ? brand[50] : statusSurface.critical,
        borderColor: isIn ? brand[200] : statusBorder.critical,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <T
          variant="label"
          style={{ textTransform: "uppercase", letterSpacing: 0.4, color: isIn ? brand[700] : statusText.critical }}
        >
          {label}
        </T>
        <Ionicons
          name={isIn ? "arrow-down-circle" : "arrow-up-circle"}
          size={16}
          color={isIn ? brand[600] : statusText.critical}
        />
      </View>
      <Money value={value} size={20} weight="semibold" color={isIn ? brand[900] : statusText.critical} style={{ marginTop: 4 }} />
      <T variant="caption" style={{ marginTop: 2 }}>
        {sublabel}
      </T>
    </Card>
  );
}

function DashboardLinkRow({
  icon,
  title,
  detail,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  onPress?: () => void;
}) {
  const t = useTheme();
  const content = (
    <>
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: radius.md,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.brandSurface,
        }}
      >
        <Ionicons name={icon} size={19} color={t.brandText} />
      </View>
      <View style={{ flex: 1 }}>
        <T style={{ fontFamily: font.sansSemibold, color: t.textPrimary }}>{title}</T>
        <T variant="caption" style={{ marginTop: 2 }}>{detail}</T>
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={18} color={t.textMuted} /> : null}
    </>
  );

  if (!onPress) {
    return <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TAP_FLOOR,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {content}
    </Pressable>
  );
}

/**
 * The cashflow chart's own range control — a small "Daily ⌄" chip that opens
 * a two-option picker, rather than a full picker screen. Lives next to the
 * chart's title (via `ChartFrame`'s `action` slot) rather than in the
 * screen's own header, because it belongs to this one chart and nothing else
 * on Home reads differently for it.
 *
 * Anchored, not centred: the menu is measured off the chip itself with
 * `measureInWindow` and appears directly under it, and the backdrop carries
 * no dim tint. `Modal` is used only for the layer it renders on and the
 * outside-tap-to-close it gives for free — visually this reads as a regular
 * dropdown attached to its trigger, not a dialog.
 */
function GranularityDropdown({
  value,
  onChange,
}: {
  value: CashflowGranularity;
  onChange: (v: CashflowGranularity) => void;
}) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<View>(null);
  const current = GRANULARITY_OPTIONS.find((o) => o.value === value)!;

  return (
    <View ref={anchorRef} collapsable={false}>
      <Pressable
        onPress={() => {
          anchorRef.current?.measureInWindow((x, y, width, height) => {
            setAnchor({ top: y + height + 4, right: Math.max(Dimensions.get("window").width - (x + width), 0) });
            setOpen(true);
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={`${current.label} view. Change cashflow range.`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: space.sm,
          paddingVertical: 6,
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: ink[200],
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <T style={{ fontSize: typeScale.caption, color: ink[700] }}>{current.label}</T>
        <Ionicons name="chevron-down" size={14} color={ink[500]} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1 }}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          {anchor ? (
            <View
              style={{
                position: "absolute",
                top: anchor.top,
                right: anchor.right,
                backgroundColor: paper.DEFAULT,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: paper[200],
                overflow: "hidden",
                minWidth: 130,
                shadowColor: ink[900],
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.12,
                shadowRadius: 8,
                elevation: 6,
              }}
            >
              {GRANULARITY_OPTIONS.map((o) => (
                <Pressable
                  key={o.value}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: o.value === value }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: space.md,
                    paddingHorizontal: space.md,
                    // Full height, not a hitSlop: these rows stack vertically
                    // in a popup that is sized by its contents, so slop on one
                    // row would reach into the row above it and the two-option
                    // menu simply grows eight points instead.
                    minHeight: TAP_FLOOR,
                    backgroundColor: pressed ? paper[100] : "transparent",
                  })}
                >
                  <T style={{ fontSize: typeScale.bodySm, color: ink[900] }}>{o.label}</T>
                  {o.value === value ? <Ionicons name="checkmark" size={16} color={brand[600]} /> : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

export function DashboardScreen({ navigation }: any) {
  const t = useTheme();
  const { brand } = t;
  const { preferences } = useAuth();
  const { selected, profiles, categories, error: profilesError, refresh: refreshProfiles, selectProfile } =
    useBusinessProfiles();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  /** Stays at the fixed month unless the empty-period notice widens it. */
  const [summaryPeriodDays, setSummaryPeriodDays] = useState(SUMMARY_PERIOD_DAYS);
  const [cashflow, setCashflow] = useState<DashboardCashflow | null>(null);
  const [cashflowGranularity, setCashflowGranularity] = useState<CashflowGranularity>("daily");
  /**
   * The single top-ranked reduction opportunity, for the Dashboard's one
   * compact link-out card — plan §13.1/§15 Phase 5. Reuses the same endpoint
   * Expense Insight's full section calls; this screen only ever looks at
   * `opportunities[0]`, never the whole list (plan §13.1: "do not fetch or
   * render the complete opportunity list on the Dashboard").
   */
  const [topOpportunity, setTopOpportunity] = useState<ReductionOpportunity | null>(null);
  const [loading, setLoading] = useState(true);
  const [cashflowLoading, setCashflowLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /*
   * The last failed attempt, kept as a descriptor rather than a sentence.
   *
   * A string could not answer the two questions the banner asks — did the
   * request reach FinSight at all, and is there anything on screen to fall
   * back on — so the words are composed at render time from this plus
   * `summary`. See lib/connectionState.ts.
   */
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  /**
   * When the figures on screen arrived, and the clock the caption is measured
   * against.
   *
   * TWO VALUES, NOT ONE. `loadedAt` only moves on a SUCCESSFUL load, which is
   * what makes it the age of the data rather than the age of the last attempt.
   * `clock` moves on every attempt, so a refresh that fails still advances
   * "Updated 2 minutes ago" to "Updated 12 minutes ago" — the caption has to
   * get older when the refresh does not work, or it is reassuring about the
   * exact case it exists to expose.
   */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [askOpen, setAskOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

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

  /*
   * Split from the cashflow fetch on purpose. They used to be one
   * Promise.all, which meant toggling the Daily/Monthly dropdown re-fetched
   * the summary too and dropped the whole screen back to the full skeleton
   * for a control that only the cashflow card owns.
   */
  const loadSummary = useCallback(async () => {
    if (!selected) return;
    setClock(Date.now());
    try {
      const next = await api.get<DashboardSummary>("/dashboard/summary", {
        businessProfileId: selected.id,
        periodDays: summaryPeriodDays,
      });
      setSummary(next);
      setLoadedAt(Date.now());
      // Cleared only on success. Clearing it up front, as this did, blanked
      // the explanation for the whole duration of the retry — so a failing
      // refresh flashed the banner off and back on every pull.
      setFailure(null);
    } catch (err) {
      setFailure(toLoadFailure(err));
    } finally {
      setLoading(false);
    }
  }, [selected, summaryPeriodDays]);

  const loadCashflow = useCallback(async () => {
    if (!selected) return;
    setCashflowLoading(true);
    try {
      setCashflow(
        await api.get<DashboardCashflow>("/dashboard/cashflow", {
          businessProfileId: selected.id,
          granularity: cashflowGranularity,
        })
      );
    } catch {
      // The cashflow card falls back to its own empty state below; a second
      // error banner next to the page-level one for the summary would say
      // the same thing twice for what is, from here, a minor degradation.
    } finally {
      setCashflowLoading(false);
    }
  }, [selected, cashflowGranularity]);

  /**
   * Plan §13.1's confidence/emptiness gate lives here rather than inside the
   * card component: `topOpportunity` is null whenever nothing should be
   * shown, so the render below stays a plain truthiness check exactly like
   * every other optional Dashboard panel.
   */
  const loadTopOpportunity = useCallback(async () => {
    if (!selected) return;
    try {
      const response = await api.get<ReductionOpportunityResponse>("/insights/reduction-opportunities", {
        businessProfileId: selected.id,
        periodDays: SUMMARY_PERIOD_DAYS,
      });
      setTopOpportunity(selectTopOpportunity(response));
    } catch {
      // Same reasoning as loadCashflow: this is an optional Dashboard panel,
      // not the page's own data, so a failed fetch just means the card is
      // absent rather than a page-level error banner.
      setTopOpportunity(null);
    }
  }, [selected]);

  // Refetch on focus so a record added on another tab is reflected when the
  // user comes back, rather than showing a stale figure. Separate effects so
  // a granularity change (which only recreates `loadCashflow`) reloads just
  // the chart, not the whole screen — same reasoning extends to the
  // opportunity card, which has nothing to do with either of the other two.
  useFocusEffect(useCallback(() => { loadSummary(); }, [loadSummary]));
  useFocusEffect(useCallback(() => { loadCashflow(); }, [loadCashflow]));
  useFocusEffect(useCallback(() => { loadTopOpportunity(); }, [loadTopOpportunity]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadSummary(), loadCashflow(), loadTopOpportunity()]);
    setRefreshing(false);
  }, [loadSummary, loadCashflow, loadTopOpportunity]);

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
  const unreadCount = summary ? summary.alerts.filter((a) => !a.readStatus).length : 0;
  const periodLabel =
    summaryPeriodDays === 0
      ? "Across all records"
      : summaryPeriodDays === 1
        ? "Today"
        : summaryPeriodDays === 7
          ? "This week"
          : "This month";
  const topCategory = summary?.expenseCategoryBreakdown?.length
    ? [...summary.expenseCategoryBreakdown].sort((a, b) => b.total - a.total)[0]
    : null;
  const recoveryStatus = summary?.recoveryStatus;
  const recoveryLabel = !recoveryStatus
    ? "Not available"
    : recoveryStatus.status === "needs_setup" || recoveryStatus.expectedMonthlyExpenses <= 0
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
  const recoveryCoverage = Math.max(0, Math.min(100, recoveryStatus?.monthCoveragePercent ?? 0));
  const openRecoveryAction = () => {
    if (!summary) return;
    if (summary.recoveryStatus.expectedMonthlyExpenses <= 0 || summary.recoveryStatus.status === "needs_setup") {
      navigation.navigate("More", {
        screen: "BusinessProfileForm",
        params: { profile: selected },
      });
    } else if (summary.recoveryStatus.status === "data_incomplete" || summary.recordsNeedingReview > 0) {
      navigation.navigate("Records", { screen: "FlaggedRecords" });
    } else if (summary.recoveryStatus.status === "no_current_month_data") {
      navigation.navigate("Records", { screen: "AddSales" });
    } else {
      navigation.navigate("Insights", { screen: "RecoveryTarget" });
    }
  };
  const recoveryActionLabel =
    !summary || summary.recoveryStatus.expectedMonthlyExpenses <= 0 || summary.recoveryStatus.status === "needs_setup"
      ? "Set monthly expenses"
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
    lastUpdatedAt: loadedAt,
    now: clock,
    subject: "your figures",
  });

  return (
    <Screen safeTop>
      <ScrollView
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

        <PeriodSelector value={summaryPeriodDays} onChange={setSummaryPeriodDays} />

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
              No records in {periodLabel.toLowerCase()}, but this business has{" "}
              {summary!.lifetime!.recordCount.toLocaleString()} in total
              {summary!.lifetime!.latestRecordDate
                ? `, the most recent dated ${new Date(
                    summary!.lifetime!.latestRecordDate,
                  ).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    // Date-only columns stored at midnight UTC — formatting in
                    // local time shows the previous day west of it.
                    timeZone: "UTC",
                  })}`
                : ""}
              . Your history is safe — this screen is only looking at the selected period.
            </Callout>
            {/*
              The fix, not a signpost. Telling the owner their data is in
              Records answered "is it there?" and left Home permanently blank
              for them — which is the screen the insights live on.
            */}
            <Button
              title="Show all time"
              variant="secondary"
              onPress={() => setSummaryPeriodDays(ALL_TIME_PERIOD_DAYS)}
              style={{ marginTop: space.sm }}
            />
          </View>
        ) : null}

        <ConnectionNotice notice={loadNotice} onRetry={onRefresh} busy={refreshing} />

        {/*
          The age of the figures, stated even when nothing is wrong.

          It sits under the banner rather than inside it so that it is still
          there on a good day: a figure with no timestamp is read as current,
          and this screen refetches on focus, which is exactly the pattern that
          makes an owner stop wondering.
        */}
        {summary ? <LastUpdated at={loadedAt} now={clock} /> : null}

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
            <View {...summaryTourTarget} style={{ gap: space.lg }}>
              <Card style={{ backgroundColor: t.brandSurface, borderColor: t.brandBorder }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <T variant="heading" accessibilityRole="header" style={{ color: t.brandHeading }}>
                    Your recovery position
                  </T>
                  <View
                    style={{
                      borderRadius: radius.full,
                      paddingHorizontal: space.sm,
                      paddingVertical: 5,
                      backgroundColor: recoveryIsPositive
                        ? t.statusSurface.good
                        : recoveryIsCritical
                          ? t.statusSurface.critical
                          : t.statusSurface.warning,
                    }}
                  >
                    <T
                      variant="caption"
                      style={{
                        color: recoveryIsPositive
                          ? t.statusText.good
                          : recoveryIsCritical
                            ? t.statusText.critical
                            : t.statusText.warning,
                        fontFamily: font.sansSemibold,
                      }}
                    >
                      {recoveryLabel}
                    </T>
                  </View>
                </View>

                <T variant="caption" style={{ marginTop: space.md }}>
                  Available business funds
                </T>
                <Money
                  value={summary.overview.availableFunds}
                  size={28}
                  weight="semibold"
                  style={{ marginTop: 2 }}
                />

                {summary.recoveryStatus.expectedMonthlyExpenses > 0 ? (
                  <View style={{ marginTop: space.xl }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
                      <T variant="caption">Monthly expense coverage</T>
                      <T style={{ fontFamily: font.sansSemibold, color: t.textPrimary }}>
                        {recoveryCoverage.toFixed(0)}%
                      </T>
                    </View>
                    <View
                      accessible
                      accessibilityRole="progressbar"
                      accessibilityLabel="Monthly expense coverage"
                      accessibilityValue={{ min: 0, max: 100, now: Math.round(recoveryCoverage) }}
                      style={{
                        height: 10,
                        marginTop: space.sm,
                        borderRadius: radius.full,
                        overflow: "hidden",
                        backgroundColor: t.surfaceStrong,
                      }}
                    >
                      <View
                        style={{
                          width: `${recoveryCoverage}%`,
                          height: "100%",
                          borderRadius: radius.full,
                          backgroundColor: recoveryIsCritical ? t.status.critical : t.status.good,
                        }}
                      />
                    </View>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: space.md }}>
                      <View>
                        <T variant="caption">Recorded sales</T>
                        <Money value={summary.recoveryStatus.salesThisMonth} size={typeScale.bodySm} style={{ marginTop: 2 }} />
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <T variant="caption">Still needed</T>
                        <Money value={summary.recoveryStatus.remainingTarget} size={typeScale.bodySm} style={{ marginTop: 2 }} />
                      </View>
                    </View>
                  </View>
                ) : (
                  <T variant="caption" style={{ marginTop: space.lg }}>
                    Add expected monthly expenses to calculate a daily sales target and recovery pace.
                  </T>
                )}
                <Button
                  title={recoveryActionLabel}
                  variant="primary"
                  onPress={openRecoveryAction}
                  style={{ marginTop: space.lg }}
                />
              </Card>

              <View style={{ flexDirection: "row", gap: space.md }}>
                <FlowCard label="Sales" value={summary.overview.totalSalesReference} sublabel={periodLabel} direction="in" />
                <FlowCard label="Expenses" value={summary.overview.totalExpenses} sublabel={periodLabel} direction="out" />
              </View>
            </View>

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.lg }}>
                {periodLabel}
              </T>
              <DashboardLinkRow
                icon="pie-chart-outline"
                title="Largest expense"
                detail={
                  topCategory
                    ? `${topCategory.categoryName} · ${formatMoney(topCategory.total)}`
                    : "No expenses recorded in this period"
                }
                onPress={topCategory ? () => setAskOpen(true) : undefined}
              />
              <View style={{ height: 1, backgroundColor: t.border, marginVertical: space.lg }} />
              <DashboardLinkRow
                icon={summary.recordsNeedingReview > 0 ? "alert-circle-outline" : "checkmark-circle-outline"}
                title="Things to review"
                detail={
                  summary.recordsNeedingReview > 0
                    ? `${summary.recordsNeedingReview} flagged item${summary.recordsNeedingReview === 1 ? "" : "s"}`
                    : "Everything is clear"
                }
                onPress={
                  summary.recordsNeedingReview > 0
                    ? () => navigation.navigate("Records", { screen: "FlaggedRecords" })
                    : undefined
                }
              />
              {topCategory ? (
                <Button
                  title="Ask FinSight about this period"
                  variant="ghost"
                  onPress={() => setAskOpen(true)}
                  style={{ marginTop: space.md }}
                />
              ) : null}
            </Card>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={showDetails ? "Hide detailed charts" : "View detailed charts"}
              accessibilityState={{ expanded: showDetails }}
              onPress={() => setShowDetails((value) => !value)}
              style={({ pressed }) => ({
                minHeight: TAP_FLOOR,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: t.borderStrong,
                backgroundColor: pressed ? t.surfaceMuted : t.surface,
                paddingHorizontal: space.md,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              })}
            >
              <T style={{ fontFamily: font.sansSemibold, color: t.textSecondary }}>
                {showDetails ? "Hide detailed charts" : "View detailed charts"}
              </T>
              <Ionicons
                name={showDetails ? "chevron-up" : "chevron-down"}
                size={18}
                color={t.textMuted}
              />
            </Pressable>

            {showDetails ? (
              <>
                <Card>
                  {cashflowLoading && !cashflow ? (
                    <SkeletonBox height={200} />
                  ) : (
                    <CashflowChart
                      data={cashflow?.points ?? []}
                      granularity={cashflowGranularity}
                      subtitle={cashflowGranularity === "monthly" ? "Last 6 months" : "Last 7 days"}
                      action={<GranularityDropdown value={cashflowGranularity} onChange={setCashflowGranularity} />}
                    />
                  )}
                </Card>

                <SpendingBreakdownCard data={summary.expenseCategoryBreakdown} />
              </>
            ) : null}

            {topOpportunity ? (
              <TopReductionOpportunityCard
                opportunity={topOpportunity}
                onPress={() => navigation.navigate("Insights", { screen: "ExpenseBehavior" })}
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
      </ScrollView>

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
