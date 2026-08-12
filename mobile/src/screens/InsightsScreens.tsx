import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../lib/haptics";
import { useFocusEffect } from "@react-navigation/native";
import { Alert as AlertBanner, Button, Callout, Card, DropdownPill, EmptyState, ErrorNote, Money, Screen, SegmentedControl, T } from "../components/ui";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { SkeletonCard } from "../components/Skeleton";
import { CategoryChange, CategoryComparison, CoverageColumns, SpendTrend } from "../components/charts";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { formatMoney } from "../lib/money";
import { ACCENT, brand, font, ink, paper, radius, space, status, statusText, TAP, typeScale } from "../theme/tokens";
import type { AnomalyFindingPage, ExpenseBehavior, RecoveryInsight, RecurringPattern, SpendingImpact } from "../lib/types";

/**
 * The soft surfaces a status pill sits on.
 *
 * Literals rather than tokens because `theme/tokens.ts` carries the status
 * FILLS and the darkened TEXT steps but no tinted backgrounds, and that file
 * is a hand-kept mirror of web's Tailwind config — adding a scale here alone
 * would put the two out of step for the sake of one screen. These are the
 * same three values RecordsScreens already uses for the same purpose; naming
 * them once beats a fourth copy appearing next to a fifth.
 */
const STATUS_SURFACE = {
  good: "#eafaf1",
  warning: "#fffbeb",
  serious: "#fdf0ea",
  critical: "#fdecec",
} as const;

/*
 * The tab values are screen names. Selection here is derived from the route
 * rather than from state, so the route↔value mapping stays at this call site
 * and SegmentedControl remains a plain controlled component.
 */
const INSIGHT_TABS = [
  { label: "Expenses", value: "ExpenseBehavior", icon: "wallet-outline" },
  { label: "Spending", value: "SpendingImpact", icon: "bar-chart-outline" },
  { label: "Recovery", value: "RecoveryTarget", icon: "refresh-circle-outline" },
] as const;

/**
 * The header every insight screen shares: where you are, and the three places
 * you can go.
 *
 * "Insights" above the section name rather than the section name alone. The
 * three screens are one destination with three views of it, and titling them
 * "Expense insight" / "Spending impact" / "Recovery target" with no common
 * line made each read as a separate place the tab bar happened to reach.
 *
 * Icons on the segments because these are returned to repeatedly — an owner
 * learns the shape of the one they want and stops reading the words. The
 * period switcher below keeps plain labels, which is why the icon is optional
 * on SegmentedControl rather than required.
 */
function InsightHeader({
  navigation,
  active,
  title,
}: {
  navigation: any;
  active: string;
  title: string;
}) {
  return (
    <View style={{ marginBottom: space.lg }}>
      {/*
        "Insights" names the tab; the line under it names which of the three
        views is showing.
        
        That order, and not the reverse, because the big word should be the
        one true of all three screens — an owner arriving from the tab bar
        wants confirmation they landed where they meant to, and the segmented
        control below already says which view they are on. The native stack
        header that used to carry this word, above a back arrow with nowhere
        to go, is gone; see InsightsStack.

        No size override on it: `variant="title"` is what ScreenHeader gives
        the Records tab, and two tab roots whose names are set in different
        sizes read as two different levels of the app.
      */}
      <T variant="title" accessibilityRole="header">
        Insights
      </T>
      <T variant="heading" style={{ color: ink[600], marginTop: 2, marginBottom: space.md }}>
        {title}
      </T>
      <SegmentedControl
        options={INSIGHT_TABS}
        value={active}
        onChange={(key) => navigation.navigate(key)}
        accessibilityLabel="Insight sections"
      />
    </View>
  );
}

/**
 * A round tinted glyph, used wherever a list row needs to be identifiable at
 * a glance rather than read.
 *
 * The insight screens are dense lists of near-identical rows — nine
 * categories, six findings, fourteen days — and in that setting a medallion
 * is not decoration: it is the thing that lets someone find the row they were
 * looking at before they scrolled.
 */
function Medallion({
  icon,
  tint,
  surface,
  size = 34,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  surface: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name={icon} size={Math.round(size * 0.5)} color={tint} />
    </View>
  );
}

/**
 * A change against the previous period, as a pill.
 *
 * Direction is carried by an arrow and a sign as well as by colour — the same
 * rule the rest of the app follows, and it matters most here because up is
 * not universally bad: an owner reading a rise in Inventory may be pleased.
 */
function DeltaPill({ percentChange, direction }: { percentChange: number | null; direction: string }) {
  if (percentChange === null) {
    return (
      <View style={{ paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.full, backgroundColor: paper[100] }}>
        <T style={{ fontSize: typeScale.micro, color: ink[500] }}>new</T>
      </View>
    );
  }

  const up = direction === "up";
  const flat = direction !== "up" && direction !== "down";
  const tone = flat ? ink[500] : up ? statusText.serious : statusText.good;
  const surface = flat ? paper[100] : up ? STATUS_SURFACE.serious : STATUS_SURFACE.good;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: radius.full,
        backgroundColor: surface,
      }}
    >
      <T style={{ fontSize: typeScale.micro, color: tone }}>{flat ? "—" : up ? "▲" : "▼"}</T>
      <T style={{ fontSize: typeScale.micro, color: tone }}>{Math.abs(percentChange).toFixed(0)}%</T>
    </View>
  );
}

/**
 * The sub-sections of one insight screen.
 *
 * WHY THESE ARE UNDERLINE TABS AND THE ROW ABOVE IS A PILL CONTROL. They are
 * different KINDS of move and should not look alike. The pills switch between
 * three separate screens — a change of subject. These switch views of the one
 * screen you are already on, and the underline is the convention for that
 * everywhere else a phone does it.
 *
 * The counts are the point of splitting at all. Expenses had grown to seven
 * stacked cards, and the two that ask the owner to DECIDE something —
 * findings and recurring candidates — sat at the bottom under four they only
 * read. A number on the tab says there is work here without making anyone
 * scroll to find out.
 */
/** Height of a sub-tab's count badge; its radius follows from it. */
const BADGE_HEIGHT = 17;

function SubTabs<Value extends string>({
  tabs,
  value,
  onChange,
  accessibilityLabel,
}: {
  tabs: readonly { label: string; value: Value; count?: number }[];
  value: Value;
  onChange: (v: Value) => void;
  accessibilityLabel?: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={{
        flexDirection: "row",
        // One hairline under the whole row, with the active tab's own rule
        // drawn over it — so the tabs read as a set rather than as three
        // separate underlined words.
        borderBottomWidth: 1,
        borderBottomColor: paper[200],
        marginBottom: space.lg,
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              tab.count ? `${tab.label}, ${tab.count} needing review` : tab.label
            }
            onPress={() => {
              haptics.tapped();
              onChange(tab.value);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              flex: 1,
              minHeight: TAP,
              paddingHorizontal: space.xs,
              borderBottomWidth: 2,
              borderBottomColor: selected ? brand[600] : "transparent",
              // Sits on the row's own hairline rather than beside it.
              marginBottom: -1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <T
              style={{
                fontSize: 13.5,
                color: selected ? brand[700] : ink[500],
                fontFamily: selected ? font.sansSemibold : font.sans,
              }}
            >
              {tab.label}
            </T>
            {/*
              Only when there is something to count. A zero badge is a badge
              that trains people to ignore badges.
            */}
            {/*
              A soft counter, not an alarm.

              It was a filled red disc, which is the badge language for "an
              error is waiting" — and what it actually counts is how many
              things are ready for a routine yes/no. Two recurring payments to
              confirm is housekeeping, not a fault, and painting it as one
              teaches people to dread the tab. It also sat taller than the
              label it followed, so the row's baseline moved as counts
              appeared and vanished.

              Tinted in the tab's own colour instead: present when selected,
              recessive when not, and never louder than the word it belongs to.
            */}
            {tab.count ? (
              <View
                style={{
                  minWidth: BADGE_HEIGHT + 1,
                  height: BADGE_HEIGHT,
                  paddingHorizontal: 5,
                  // Radius derived from the height rather than the pill token
                  // — a brand-filled pill with that token is the marker
                  // chipConsistency looks for, and this is a counter, not a
                  // chip. (The check reads source text, so naming the token
                  // in this comment would trip it too.)
                  borderRadius: BADGE_HEIGHT / 2,
                  backgroundColor: selected ? brand[600] : paper[200],
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <T
                  style={{
                    fontSize: 10.5,
                    lineHeight: 14,
                    color: selected ? "#fff" : ink[600],
                    fontFamily: font.sansSemibold,
                  }}
                >
                  {tab.count}
                </T>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function useInsight<T>(path: string, query: Record<string, any>, deps: any[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(path, query));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  return { data, loading, error, load };
}

// ---------------------------------------------------------------- Expense insight

const PERIODS = [
  { label: "This week", value: 7 },
  { label: "This month", value: 30 },
];

/**
 * The "most recent month with records" option's value.
 *
 * Negative because DropdownPill keys options by value and every real period is
 * a positive day count — this can never collide with one. It is not a length;
 * it means "anchor the 30-day window to the last expense instead of to today".
 */
const ANCHOR_PERIOD = -1;

/**
 * How many category rows "What changed" shows before offering the rest.
 *
 * Four fills the card without pushing the flags below the fold on a small
 * phone, and a business with more than four categories is exactly the one
 * whose top few are the story.
 */
const TREND_PREVIEW_COUNT = 4;

export function ExpenseBehaviorScreen({ navigation }: any) {
  const { selected } = useBusinessProfiles();
  const [periodDays, setPeriodDays] = useState(30);
  /**
   * The day the window ends on, or null for today.
   *
   * Every window here is measured back from today, so a business whose history
   * was imported can have its last expense a year ago — putting all of them in
   * a gap and making this screen report "nothing recorded" to an owner with
   * hundreds of records. Selecting the anchor option moves the window to where
   * the data actually is, and says which month that was.
   */
  const [endDate, setEndDate] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  /**
   * Which sub-section is showing.
   *
   * Defaults to Overview even when there are alerts waiting. Opening on a
   * list of things that need deciding would make the screen an inbox, and
   * this one is mostly consulted rather than worked through — the badge is
   * what carries the urgency, and it does so without taking the choice away.
   */
  const [section, setSection] = useState<"overview" | "alerts" | "recurring">("overview");
  const [showAllTrends, setShowAllTrends] = useState(false);
  const { data, loading, error } = useInsight<ExpenseBehavior>(
    "/insights/expense-behavior",
    { businessProfileId: selected?.id, periodDays, ...(endDate ? { endDate } : {}) },
    [selected?.id, periodDays, endDate]
  );
  const findingState = useInsight<AnomalyFindingPage>(
    "/insights/findings",
    { businessProfileId: selected?.id, status: "OPEN", take: 20 },
    [selected?.id]
  );
  const patternState = useInsight<RecurringPattern[]>(
    "/insights/recurring-patterns", { businessProfileId: selected?.id }, [selected?.id]
  );

  /**
   * The month this business's expenses actually end in, when the ordinary
   * windows cannot reach it.
   *
   * Null for a business recording daily — its latest expense is already inside
   * "This month", so a second option covering the same window under a stranger
   * name would be worse than none.
   */
  const anchorMonth = (() => {
    const latest = data?.latestExpenseDate;
    if (!latest) return null;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (new Date(latest).getTime() >= thirtyDaysAgo) return null;
    return {
      endDate: latest.slice(0, 10),
      label: new Date(latest).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    };
  })();

  const periodOptions = anchorMonth
    ? [...PERIODS, { label: anchorMonth.label, value: ANCHOR_PERIOD }]
    : PERIODS;

  async function reviewFinding(id: number, confirmed: boolean, duplicate: boolean) {
    await api.patch(`/insights/findings/${id}/review`, {
      status: confirmed ? "CONFIRMED" : "DISMISSED",
      feedback: confirmed ? (duplicate ? "DUPLICATE" : "CONFIRMED_UNUSUAL") : "EXPECTED_TRANSACTION",
    });
    await findingState.load();
  }

  async function reviewPattern(id: number, status: "CONFIRMED" | "DISMISSED") {
    await api.patch(`/insights/recurring-patterns/${id}`, { status });
    await patternState.load();
  }

  if (!selected) return null;

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

  /*
   * The badges count things that need a DECISION, not things worth reading.
   *
   * Findings and recurring candidates both end in two buttons; unusual
   * expenses are shown for context and ask nothing, so they live under Alerts
   * without inflating its number. A badge that counts reading material is a
   * badge nobody clears, and then it stops meaning anything.
   */
  const openFindings = findingState.data?.items.length ?? 0;
  const recurringCandidates =
    patternState.data?.filter((pattern) => pattern.status === "CANDIDATE").length ?? 0;

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

  /*
   * Ranked by what they came to, so the preview shows the categories that
   * moved the most money rather than whichever the server listed first.
   */
  const rankedTrends = [...(data?.categoryTrends ?? [])].sort((a, b) => b.current - a.current);
  const visibleTrends = showAllTrends ? rankedTrends : rankedTrends.slice(0, TREND_PREVIEW_COUNT);

  const sections = [
    { label: "Overview", value: "overview" as const },
    { label: "Alerts", value: "alerts" as const, count: openFindings },
    { label: "Recurring", value: "recurring" as const, count: recurringCandidates },
  ];

  return (
    <Screen safeTop>
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="ExpenseBehavior" title="Expense insight" />

        <SubTabs
          tabs={sections}
          value={section}
          onChange={setSection}
          accessibilityLabel="Expense insight sections"
        />

        {/*
          The period governs the figures on Overview and nothing else — the
          findings and recurring patterns are fetched without it. Showing it
          on those tabs would imply it filtered them.
        */}
        {section === "overview" ? (
          <View style={{ marginBottom: space.lg }}>
            <DropdownPill
              options={periodOptions}
              value={endDate ? ANCHOR_PERIOD : periodDays}
              onChange={(value) => {
                if (value === ANCHOR_PERIOD) {
                  setPeriodDays(30);
                  setEndDate(anchorMonth!.endDate);
                } else {
                  setPeriodDays(value);
                  setEndDate(null);
                }
              }}
              icon="calendar-outline"
              sheetTitle="Show which period"
              accessibilityLabel="Period"
            />
          </View>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {loading || !data ? (
          <ActivityIndicator color={brand[600]} style={{ marginTop: space.xl }} />
        ) : (
          <View style={{ gap: space.lg }}>
            {/*
              OVERVIEW — the figures, in the order the question is asked.
              The shape first, the figures second: the chart answers "is this
              period unusual"; the list below answers "by how much, and where".
            */}
            {section === "overview" ? (
              <>
              {/*
                THE WINDOW IS EMPTY BUT THE BUSINESS IS NOT.

                Every window here ends today, so imported history that stops
                months ago puts all of them in a gap and the screen reports
                nothing recorded — to an owner holding hundreds of records.
                Said here, with the month named, and with the option that fixes
                it one tap away in the period picker above.
              */}
              {data.totals.current === 0 && anchorMonth ? (
                <Callout tone="info">
                  No expenses in this window — your records are here, the most recent is{" "}
                  {new Date(data.latestExpenseDate!).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    timeZone: "UTC",
                  })}
                  . Choose "{anchorMonth.label}" in the period picker above to see it.
                </Callout>
              ) : null}
              <Card>
                {/*
                  THE HEADLINE FIGURE, and the reason this card leads.
                  Everything under it — the curve, the category list, the
                  flags — is an answer to "why". Opening on a chart made the
                  owner assemble the total themselves from a shape.

                  Both figures come from `totals`, summed server-side, so this
                  cannot drift from what web reports for the same period.
                */}
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                  <Money value={data.totals.current} size={28} weight="semibold" />
                  <T style={{ fontSize: typeScale.body, color: ink[600] }}>spent</T>
                </View>
                {/*
                  THE COMPARISON, SAID IN FULL.

                  It read "↑ 12% vs last month", which needs the reader to
                  supply what rose and against what — and 12% of an unstated
                  base is not a figure anyone can act on. It now names the
                  direction in a word, carries the actual amount of the
                  change, and states the period it is measured against.

                  A rise is drawn in the "serious" tone rather than the alarm
                  one: spending more is worth noticing and is not by itself
                  wrong — a month with more stock bought is a month with more
                  to sell.
                */}
                {periodDelta === null ? (
                  <T variant="caption" style={{ marginTop: 4 }}>
                    Nothing was recorded in the {periodDays === 7 ? "week" : "month"} before this one, so
                    there is nothing to compare against yet.
                  </T>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 3,
                        paddingHorizontal: space.sm,
                        paddingVertical: 2,
                        borderRadius: 11,
                        backgroundColor: periodDelta >= 0 ? STATUS_SURFACE.serious : STATUS_SURFACE.good,
                      }}
                    >
                      <Ionicons
                        name={periodDelta >= 0 ? "arrow-up" : "arrow-down"}
                        size={12}
                        color={periodDelta >= 0 ? statusText.serious : statusText.good}
                      />
                      <T
                        style={{
                          fontSize: typeScale.caption,
                          fontFamily: font.sansSemibold,
                          color: periodDelta >= 0 ? statusText.serious : statusText.good,
                        }}
                      >
                        {Math.abs(periodDelta).toFixed(0)}%
                      </T>
                    </View>
                    <T variant="caption" style={{ flexShrink: 1 }}>
                      {periodDelta >= 0 ? "more" : "less"} than the {periodDays === 7 ? "week" : "month"} before
                      {" ("}
                      {formatMoney(Math.abs(data.totals.current - data.totals.previous))}
                      {")"}
                    </T>
                  </View>
                )}

                <View style={{ marginTop: space.lg }}>
                  <SpendTrend
                    data={data.dailyTotals ?? []}
                    title="Spending so far"
                    // The axis ticks are bare numbers so they cannot overflow
                    // their gutter, which means the unit has to be said here.
                    subtitle={`Running total in PHP · ${data.periodStart.slice(5, 10)} to ${data.periodEnd.slice(5, 10)}`}
                  />
                </View>
              </Card>

              <Card>
                <CategoryComparison
                  data={data.categoryTrends.map((t) => ({
                    categoryName: t.categoryName,
                    current: t.current,
                    previous: t.previous,
                    percentChange: t.percentChange,
                  }))}
                  subtitle={`${data.previousPeriodStart.slice(5, 10)}–${data.previousPeriodEnd.slice(5, 10)} vs ${data.periodStart.slice(5, 10)}–${data.periodEnd.slice(5, 10)}`}
                  previousLabel="Last period"
                  currentLabel="This period"
                />
              </Card>

              <Card>
                <CategoryChange
                  data={data.categoryTrends
                    .filter((t) => t.percentChange !== null)
                    .map((t) => ({
                      categoryName: t.categoryName,
                      percentChange: t.percentChange!,
                      direction: t.direction,
                    }))}
                  subtitle="Against the period before"
                />
              </Card>

              {/*
                The heading sits OUTSIDE its card, which is the one structural
                borrowing from the reference worth taking. Inside, it read as a
                title for a table; outside, it labels a group — and it is what
                lets "View all" be a sibling row rather than a link buried at
                the bottom of a list.
              */}
              <View>
                <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm, color: brand[900] }}>
                  What changed
                </T>

                <Card>
                  {data.categoryTrends.length === 0 ? (
                    <T variant="caption">No expense records in this period yet.</T>
                  ) : (
                    visibleTrends.map((t, i) => (
                      /*
                        Tappable, and the chevron is not decoration: it opens
                        the records list already filtered to this category, so
                        "Inventory is up 18%" leads straight to the eleven
                        records that made it so. RecordsList has accepted a
                        categoryId param all along; nothing on this screen was
                        using it.
                      */
                      <Pressable
                        key={t.categoryId}
                        onPress={() => openCategoryRecords(t.categoryId)}
                        accessibilityRole="button"
                        accessibilityLabel={`${t.categoryName}, ${formatMoney(t.current)}${
                          t.percentChange === null
                            ? ", new this period"
                            : `, ${t.direction} ${Math.abs(t.percentChange).toFixed(0)} percent`
                        }. View these records.`}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: space.sm,
                          paddingVertical: space.sm,
                          minHeight: TAP,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: paper[200],
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <Medallion icon="pricetag-outline" tint={brand[700]} surface={brand[50]} />
                        <T style={{ flex: 1, fontSize: typeScale.bodySm, color: ink[900] }} numberOfLines={1}>
                          {t.categoryName}
                        </T>
                        <Money value={t.current} size={14} weight="medium" />
                        <DeltaPill percentChange={t.percentChange} direction={t.direction} />
                        <Ionicons name="chevron-forward" size={16} color={ink[400]} />
                      </Pressable>
                    ))
                  )}
                </Card>

                {/*
                  Only when there is more to see. A "View all" that reveals
                  nothing is a control that teaches people not to press
                  controls.
                */}
                {data.categoryTrends.length > TREND_PREVIEW_COUNT ? (
                  <Pressable
                    onPress={() => {
                      haptics.tapped();
                      setShowAllTrends((v) => !v);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: showAllTrends }}
                    style={({ pressed }) => ({ marginTop: space.sm, opacity: pressed ? 0.7 : 1 })}
                  >
                    <Card>
                      <View style={{ flexDirection: "row", alignItems: "center", minHeight: TAP - 12 }}>
                        <T style={{ flex: 1, fontSize: typeScale.body, color: ink[900] }}>
                          {showAllTrends
                            ? "Show fewer categories"
                            : `View all ${data.categoryTrends.length} category trends`}
                        </T>
                        <Ionicons
                          name={showAllTrends ? "chevron-up" : "chevron-forward"}
                          size={18}
                          color={ink[400]}
                        />
                      </View>
                    </Card>
                  </Pressable>
                ) : null}
              </View>
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
            {section === "alerts" && openFindings === 0 && data.unusualExpenses.length === 0 ? (
              <Card>
                <View style={{ alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
                  <View
                    style={{
                      width: 84,
                      height: 84,
                      borderRadius: 42,
                      backgroundColor: STATUS_SURFACE.good,
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: space.lg,
                    }}
                  >
                    <Ionicons name="checkmark-circle-outline" size={40} color={statusText.good} />
                  </View>
                  <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>
                    Nothing needs a look
                  </T>
                  <T variant="caption" style={{ textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 260 }}>
                    No duplicates, no unusual amounts. FinSight checks every record as it is added and will
                    put anything worth reviewing here.
                  </T>
                </View>
              </Card>
            ) : null}

            {section === "alerts" && (openFindings > 0 || data.unusualExpenses.length > 0) ? (
              <>
              <Card>
                <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.md }}>Unusual expenses</T>
                {data.unusualExpenses.length === 0 ? (
                  <T variant="caption">Nothing flagged as unusual right now.</T>
                ) : (
                  <View style={{ gap: space.sm }}>
                    {data.unusualExpenses.map((u) => (
                      <AlertBanner
                        key={u.id}
                        kind="large-expense"
                        label="Unusual for this category"
                        meta={`${u.categoryName} · ${u.date.slice(0, 10)}`}
                      >
                        {u.description} — usually around {Math.round(u.categoryMean).toLocaleString("en-PH")}
                      </AlertBanner>
                    ))}
                  </View>
                )}
                {data.insufficientHistoryCategories.length > 0 ? (
                  <T variant="caption" style={{ marginTop: space.md }}>
                    Not enough history yet to check:{" "}
                    {data.insufficientHistoryCategories.map((c) => c.categoryName).join(", ")}
                  </T>
                ) : null}
              </Card>

              <Card>
                <T variant="heading" accessibilityRole="header" style={{ marginBottom: 2 }}>
                  {openFindings > 0
                    ? `${openFindings} ${openFindings === 1 ? "item needs" : "items need"} your review`
                    : "FinSight findings"}
                </T>
                <T variant="caption" style={{ marginBottom: space.sm }}>
                  Each one is a question, not a verdict — you decide what it was.
                </T>
                {findingState.error ? <ErrorNote>{findingState.error}</ErrorNote> : null}
                {findingState.loading ? <ActivityIndicator color={brand[600]} /> : null}
                {!findingState.loading && (findingState.data?.items.length ?? 0) === 0 ? (
                  <T variant="caption">No findings need review.</T>
                ) : null}
                <View style={{ gap: space.sm }}>
                  {findingState.data?.items.map((finding) => {
                    /*
                      A duplicate and an unusual amount are different questions
                      with different answers, so they are told apart before they
                      are read — colour, glyph and the wording of both buttons.
                    */
                    const duplicate = finding.type === "POSSIBLE_DUPLICATE";
                    return (
                      <View
                        key={finding.id}
                        style={{
                          borderWidth: 1,
                          borderColor: paper[200],
                          borderRadius: radius.md,
                          padding: space.md,
                        }}
                      >
                        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
                          <Medallion
                            icon={duplicate ? "copy-outline" : "alert-circle-outline"}
                            tint={duplicate ? statusText.warning : statusText.critical}
                            surface={duplicate ? STATUS_SURFACE.warning : STATUS_SURFACE.critical}
                          />
                          <View style={{ flex: 1 }}>
                            <T style={{ fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansSemibold }}>
                              {finding.title}
                            </T>
                            {finding.reasons.map((reason) => (
                              <T
                                key={reason}
                                variant="caption"
                                style={{ marginTop: 2, color: duplicate ? statusText.warning : statusText.critical }}
                              >
                                {reason}
                              </T>
                            ))}
                          </View>
                        </View>
                        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                          <View style={{ flex: 1 }}>
                            <Button
                              title={duplicate ? "Duplicate" : "Unusual"}
                              variant="brand"
                              onPress={() => void reviewFinding(finding.id, true, duplicate)}
                            />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Button
                              title={duplicate ? "Not duplicate" : "Expected"}
                              variant="secondary"
                              onPress={() => void reviewFinding(finding.id, false, false)}
                            />
                          </View>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </Card>
              </>
            ) : null}

            {/* RECURRING — payments FinSight thinks repeat. */}
            {section === "recurring" ? (
              patternState.data?.some((pattern) => pattern.status === "CANDIDATE") ? (
              <Card>
                <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", marginBottom: space.md }}>
                  <Medallion icon="repeat-outline" tint={brand[700]} surface={brand[50]} />
                  <View style={{ flex: 1 }}>
                    <T variant="heading" accessibilityRole="header">Expected payments</T>
                    <T variant="caption" style={{ marginTop: 2 }}>
                      Confirm repeating expenses so FinSight can spot changes.
                    </T>
                  </View>
                </View>
                <View style={{ gap: space.sm }}>
                  {patternState.data.filter((pattern) => pattern.status === "CANDIDATE").map((pattern) => (
                    <View
                      key={pattern.id}
                      style={{
                        borderWidth: 1,
                        borderColor: paper[200],
                        borderRadius: radius.md,
                        padding: space.md,
                      }}
                    >
                      <T style={{ fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansSemibold }}>
                        {pattern.description}
                      </T>
                      <T variant="caption" style={{ marginTop: 2 }}>
                        {pattern.category.name} · About every {pattern.intervalDays} days
                      </T>
                      {/*
                        "Confirm recurring" and "Not recurring" in two
                        half-width buttons wrapped to two lines each on a
                        normal phone, which made a routine yes/no look like a
                        paragraph. The question is already asked by the card
                        above them, so the answers can be the one word that
                        differs: Confirm, and Not recurring.
                      */}
                      <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                        <View style={{ flex: 1 }}>
                          <Button
                            title="Confirm"
                            variant="brand"
                            onPress={() => void reviewPattern(pattern.id, "CONFIRMED")}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Button
                            title="Not recurring"
                            variant="secondary"
                            onPress={() => void reviewPattern(pattern.id, "DISMISSED")}
                          />
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
                {/*
                  What confirming actually buys, said once at the bottom
                  rather than on every card — it is the same promise for all
                  of them, and repeating it per row would crowd out the
                  figures the decision rests on.
                */}
                <View style={{ marginTop: space.md }}>
                  <Callout tone="info">
                    You'll be notified if a confirmed payment is late, early, or changes amount.
                  </Callout>
                </View>
              </Card>
              ) : (
                <EmptyState
                  title="No repeating payments found yet"
                  icon="↻"
                  body="Once the same expense shows up a few times, FinSight will offer it here so you can confirm it repeats."
                />
              )
            ) : null}
          </View>
        )}
      </ScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} businessProfileId={selected.id} module="Expense Insights" />
    </Screen>
  );
}

// ---------------------------------------------------------------- Spending impact

export function SpendingImpactScreen({ navigation }: any) {
  const { selected } = useBusinessProfiles();
  const [amount, setAmount] = useState("");
  const [data, setData] = useState<SpendingImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  // This input is drawn by hand rather than through `Field` — it shares a row
  // with the Check button, which `Field`'s own label-above-input layout cannot
  // express. It gets `Field`'s focus border anyway so the app has one focus
  // treatment, not two.
  const [amountFocused, setAmountFocused] = useState(false);

  async function run() {
    const value = Number(amount);
    if (!selected || !Number.isFinite(value) || value <= 0) {
      setData(null);
      return;
    }
    try {
      setData(await api.get<SpendingImpact>("/insights/spending-impact", {
        businessProfileId: selected.id,
        plannedAmount: value,
        periodDays: 30,
      }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!selected) return null;

  const bandColor = data
    ? data.impactBand === "High Impact"
      ? statusText.critical
      : data.impactBand === "Noticeable Impact"
        ? statusText.warning
        : statusText.good
    : ink[400];
  /*
    The band as a tinted pill rather than a solid fill. Solid critical red on
    a white card reads as an error the owner has made; "High Impact" is a
    description of size, and the purchase may still be the right call. The
    text keeps the full-strength colour, so contrast is unchanged.
  */
  const bandSurface = data
    ? data.impactBand === "High Impact"
      ? STATUS_SURFACE.critical
      : data.impactBand === "Noticeable Impact"
        ? STATUS_SURFACE.warning
        : STATUS_SURFACE.good
    : paper[100];

  return (
    <Screen safeTop>
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="SpendingImpact" title="Spending impact" />

        <View style={{ marginBottom: space.lg }}>
          <Callout tone="info">
            A what-if check — nothing is saved, and FinSight won't tell you whether to buy it.
          </Callout>
        </View>

        <Card style={{ marginBottom: space.lg }}>
          <T variant="label" style={{ marginBottom: 4 }}>Planned amount (PHP)</T>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              onSubmitEditing={run}
              onFocus={() => setAmountFocused(true)}
              onBlur={() => setAmountFocused(false)}
              keyboardType="decimal-pad"
              placeholder="e.g. 11000"
              placeholderTextColor={ink[400]}
              style={{
                flex: 1,
                minHeight: TAP,
                // Width held at 1 on both states so the row does not reflow
                // and shove the Check button sideways when focus lands.
                borderWidth: 1,
                borderColor: amountFocused ? brand[600] : ink[200],
                borderRadius: radius.md,
                paddingHorizontal: space.md,
                fontSize: typeScale.body,
                color: ink[900],
              }}
            />
            <Pressable
              onPress={run}
              accessibilityRole="button"
              // "Check" alone says nothing about what is being checked once
              // the amount field beside it is out of view, which is exactly
              // the situation of anyone reading this one control at a time.
              accessibilityLabel="Check this planned amount"
              style={{
                minHeight: TAP,
                paddingHorizontal: space.lg,
                borderRadius: radius.md,
                backgroundColor: ACCENT.fill,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <T style={{ color: ACCENT.onFill, fontFamily: font.sansSemibold }}>Check</T>
            </Pressable>
          </View>
          {error ? <View style={{ marginTop: space.md }}><ErrorNote>{error}</ErrorNote></View> : null}
        </Card>

        {data ? (
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.md }}>
              <T variant="heading" accessibilityRole="header">Estimated impact</T>
              <View
                style={{
                  backgroundColor: bandSurface,
                  borderRadius: radius.full,
                  paddingHorizontal: space.md,
                  paddingVertical: 4,
                }}
              >
                <T style={{ color: bandColor, fontSize: typeScale.caption }}>{data.impactBand}</T>
              </View>
            </View>

            <BeforeAfter label="Available business funds" before={data.funds.before} after={data.funds.after} />
            <BeforeAfter
              label={`Recorded expenses (last ${data.periodDays} days)`}
              before={data.periodExpenses.before}
              after={data.periodExpenses.after}
            />

            <T variant="caption" style={{ marginTop: space.md }}>
              That uses {data.percentOfFunds >= 999999 ? "more than 100%" : `${data.percentOfFunds.toFixed(1)}%`} of your
              available funds. You treat anything above {data.thresholdPercent}% as high impact.
            </T>
            {data.exceedsFunds ? (
              <View style={{ marginTop: space.md }}>
                <AlertBanner kind="needs-review" label="Exceeds your funds">
                  This is more than the available business funds you have on record.
                </AlertBanner>
              </View>
            ) : null}
          </Card>
        ) : (
          <Card>
            {/*
              A real illustration rather than EmptyState's text glyph. This is
              the whole screen until an amount is typed, and "◎" rendered at
              whatever weight the system font happened to give it — the one
              place the app asks someone to start, drawn in a character that
              varies by device.
            */}
            <View style={{ alignItems: "center", paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
              <View
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 48,
                  backgroundColor: brand[50],
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: space.lg,
                }}
              >
                <Ionicons name="locate-outline" size={44} color={brand[600]} />
              </View>
              <T variant="title" accessibilityRole="header" style={{ textAlign: "center" }}>
                Enter an amount to check
              </T>
              <T variant="caption" style={{ textAlign: "center", marginTop: 6, lineHeight: 18, maxWidth: 260 }}>
                See what a planned purchase would do to your funds before you spend it.
              </T>
            </View>
          </Card>
        )}
      </ScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} businessProfileId={selected.id} module="Spending Impact" />
    </Screen>
  );
}

/**
 * One figure before a planned purchase and after it.
 *
 * ONE BAR, NOT TWO. It was drawn as two stacked bars, one per state, which
 * made the reader compare two lengths in two places to answer a question that
 * is really about a single quantity moving. Here the bar IS the "after"
 * value, drawn against the "before" as its full extent, so the remaining
 * light section is exactly what the purchase would consume — the shape people
 * already read from a battery or a fuel gauge.
 *
 * The two figures sit on one line above it, labelled and at opposite ends,
 * which is also how the numbers are spoken: "forty-eight five, down to
 * thirty-seven five".
 */
/**
 * One figure before a planned purchase and after it.
 *
 * ONE BAR, NOT TWO. It was drawn as two stacked bars, one per state, which
 * made the reader compare two lengths in two places to answer a question
 * about a single quantity moving.
 *
 * WHAT THE BAR ENCODES: the solid part is the SMALLER of the two figures and
 * the tinted remainder is the change between them. That one rule reads
 * correctly in both directions without the caller having to say which way is
 * good — funds fall, so the solid part is what would be left and the
 * remainder is what the purchase eats; expenses rise, so the solid part is
 * what is already spent and the remainder is what would be added. Either
 * way, the light section is the purchase.
 *
 * The fill stays the brand colour rather than tracking the impact band. The
 * band already has a pill of its own, and colouring the "what remains"
 * section by severity would say the remaining funds were themselves alarming.
 * Only the REMAINDER turns red, and only when the purchase cannot be covered.
 */
/** Height of the before/after bar; its corner radius is derived from this. */
const BAR_HEIGHT = 10;

function BeforeAfter({
  label,
  before,
  after,
}: {
  label: string;
  before: number;
  after: number;
}) {
  /*
   * Overspending is the case this has to get right. A negative `after` means
   * the purchase consumed everything and more, so the solid part is what
   * existed and the whole remainder is red — there is no such thing as a
   * negative length, and clamping to zero would draw "nothing left"
   * identically to "exactly nothing left".
   */
  const overspent = after < 0;
  const span = overspent ? before + Math.abs(after) : Math.max(Math.abs(before), Math.abs(after), 1);
  const solid = overspent ? before : Math.min(Math.abs(before), Math.abs(after));
  const ratio = Math.max(0, Math.min(solid / span, 1));

  return (
    <View style={{ marginBottom: space.lg }}>
      <T variant="label" style={{ color: ink[700], marginBottom: space.sm }}>
        {label}
      </T>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: space.sm }}>
        <View>
          <T variant="caption">Before</T>
          <Money value={before} size={14} weight="medium" style={{ marginTop: 1 }} />
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <T variant="caption">After</T>
          <Money
            value={after}
            size={14}
            weight="semibold"
            color={overspent ? statusText.critical : ink[900]}
            style={{ marginTop: 1 }}
          />
        </View>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
        style={{
          height: BAR_HEIGHT,
          // The track IS the change: soft brand normally, alarm red when the
          // purchase runs past what there is.
          backgroundColor: overspent ? STATUS_SURFACE.critical : brand[100],
          // Radius from the height, matching RecoveryMeter's own Bar. A bar
          // is not a chip, and `radius.full` on a brand-filled pill is the
          // marker chipConsistency looks for.
          borderRadius: BAR_HEIGHT / 2,
          overflow: "hidden",
          marginTop: space.sm,
          flexDirection: "row",
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            borderRadius: BAR_HEIGHT / 2,
            backgroundColor: brand[600],
          }}
        />
        {/*
          A hairline at the boundary. Where the two tints are close in value
          the join is hard to place exactly, and this is a chart whose whole
          point is where that join falls.
        */}
        {ratio > 0.02 && ratio < 0.98 ? (
          <View style={{ width: 1.5, height: "100%", backgroundColor: paper.DEFAULT, opacity: 0.9 }} />
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Recovery target

export function RecoveryTargetScreen({ navigation }: any) {
  const { selected } = useBusinessProfiles();
  const [askOpen, setAskOpen] = useState(false);
  const { data, loading, error } = useInsight<RecoveryInsight>(
    "/insights/recovery",
    { businessProfileId: selected?.id, coverageDays: 14 },
    [selected?.id]
  );

  if (!selected) return null;

  return (
    <Screen safeTop>
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="RecoveryTarget" title="Recovery target" />

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {loading || !data ? (
          <View style={{ gap: space.lg }}>
            <SkeletonCard style={{ height: 120 }} />
            <SkeletonCard style={{ height: 150 }} />
            <SkeletonCard style={{ height: 140 }} />
            <SkeletonCard style={{ height: 180 }} />
          </View>
        ) : (
          <View style={{ gap: space.lg }}>
            {/*
              SAID BEFORE THE FIGURES, because without it the figures are a
              false accusation.

              Recovery is month-to-date and has no period to select, so imported
              history that stops months ago shows zero sales against the full
              monthly target — a screen confidently reporting that the owner
              missed everything, in a month they never traded in. The arithmetic
              is right; this is the sentence that makes it honest.
            */}
            {data.monthHasNoRecords ? (
              <Callout tone="warn">
                No sales are recorded for this month yet, so every figure below compares your target
                against zero. It isn't a shortfall you've made — there's simply nothing in this month
                to measure.
                {data.latestSaleDate
                  ? ` Your most recent sale is dated ${new Date(data.latestSaleDate).toLocaleDateString(
                      undefined,
                      { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" },
                    )}.`
                  : ""}
              </Callout>
            ) : null}

            <Card>
              <RecoveryMeter data={data} />
            </Card>

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>Remaining recovery target</T>
              <T variant="caption" style={{ marginBottom: space.md }}>
                Recalculated across your remaining operating days. This is an estimate — your profile records how many
                days a month you operate, not which days.
              </T>
              {/*
                Four lines that are read as a calculation, so each one is
                given a glyph: the eye can then follow expenses → sales →
                what is left → over how many days, without re-reading the
                labels every time it returns to the card.
              */}
              <Row
                icon="wallet-outline"
                label="Expected monthly expenses"
                value={data.expectedMonthlyExpenses}
                first
              />
              <Row icon="bar-chart-outline" label="Sales reference so far" value={data.salesThisMonth} />
              <Row
                icon="flag-outline"
                label="Remaining target"
                value={data.remainingTarget}
                tint={statusText.critical}
              />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingVertical: space.sm,
                  borderTopWidth: 1,
                  borderTopColor: paper[200],
                }}
              >
                <Medallion icon="calendar-outline" tint={brand[700]} surface={brand[50]} size={28} />
                <T style={{ flex: 1, fontSize: typeScale.bodySm }}>Remaining operating days</T>
                <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoMedium }}>≈ {data.remainingOperatingDays}</T>
              </View>
            </Card>

            {/*
              The columns show the run of days at a glance and where the
              target line sits; the rows below keep the exact figure and the
              gap for each day, which a 110px chart cannot carry.
            */}
            <Card>
              <CoverageColumns
                data={data.dailyCoverage.map((d) => ({ date: d.date, amount: d.sales }))}
                target={data.dailyNeededTarget}
                subtitle="Sales each day against the target, in PHP"
              />
            </Card>

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.md }}>Day by day</T>
              {data.dailyCoverage.map((d, i) => {
                const c =
                  d.status === "below" ? statusText.critical : d.status === "at" ? statusText.warning : statusText.good;
                return (
                  <View
                    key={d.date}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      paddingVertical: space.sm,
                      gap: space.sm,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: paper[200],
                    }}
                  >
                    <T variant="caption" style={{ width: 56, fontFamily: font.monoMedium }}>{d.date.slice(5)}</T>
                    <Money value={d.sales} size={13} weight="medium" />
                    <View style={{ flex: 1, alignItems: "flex-end" }}>
                      <T style={{ fontSize: typeScale.caption, color: c }}>
                        {d.status === "at"
                          ? "Reached"
                          : `${Math.round(Math.abs(d.gap)).toLocaleString("en-PH")} ${d.status}`}
                      </T>
                    </View>
                  </View>
                );
              })}
            </Card>
          </View>
        )}
      </ScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} businessProfileId={selected.id} module="Recovery Target" />
    </Screen>
  );
}

function Row({
  icon,
  label,
  value,
  tint,
  first,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: number;
  /** Colours the FIGURE only — the label stays neutral so the row still scans. */
  tint?: string;
  /** Drops the top rule, so the list does not open with one under a caption. */
  first?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingVertical: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
      }}
    >
      <Medallion icon={icon} tint={brand[700]} surface={brand[50]} size={28} />
      <T style={{ fontSize: typeScale.bodySm, flex: 1 }}>{label}</T>
      <Money value={value} size={14} weight="medium" color={tint} />
    </View>
  );
}
