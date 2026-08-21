import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../lib/haptics";
import { useFocusEffect } from "@react-navigation/native";
import { Alert as AlertBanner, Button, Callout, Card, DropdownPill, EmptyState, ErrorNote, Money, OptionSheet, Screen, SegmentedControl, T } from "../components/ui";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { SkeletonCard } from "../components/Skeleton";
import { CategoryChange, CategoryComparison, CoverageColumns, SpendTrend } from "../components/charts";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { takeFlash } from "../lib/flash";
import { formatMoney } from "../lib/money";
import {
  agendaGroupOf,
  formatDueDate,
  groupSchedules,
  recurringAvailability,
  type AgendaGroupKey,
} from "../lib/recurringAgenda";
import { SIGNAL_COPY, findingSignalStrength } from "../lib/confidenceBands";
import { feedbackActions, findingCategory, quickActions, type FeedbackAction } from "../lib/findingFeedback";
import { ACCENT, brand, font, ink, paper, radius, space, statusText, TAP, typeScale } from "../theme/tokens";
import type {
  AnomalyFinding,
  AnomalyFindingPage,
  ExpenseBehavior,
  RecoveryInsight,
  RecurringPattern,
  RecurringSchedule,
  SpendingImpact,
} from "../lib/types";

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

/**
 * One declared repeating payment, as a row in the agenda.
 *
 * Same shape as a record row in RecordsScreens — Pressable wrapping a Card,
 * medallion on the left, the figure in `Money` on the right, one caption line
 * of meta joined with " · ". Two lists of money-with-a-date should not be two
 * different objects, and the owner has already learnt this one.
 *
 * The medallion carries the group: an overdue payment is not read, it is
 * spotted. Colour is never the only signal — the row sits under a written
 * "Overdue" heading, and a paused one says so in words.
 */
const AGENDA_LOOK: Record<AgendaGroupKey, { icon: keyof typeof Ionicons.glyphMap; tint: string; surface: string }> = {
  OVERDUE: { icon: "alert-circle-outline", tint: statusText.critical, surface: STATUS_SURFACE.critical },
  DUE_SOON: { icon: "time-outline", tint: statusText.warning, surface: STATUS_SURFACE.warning },
  SCHEDULED: { icon: "repeat-outline", tint: brand[700], surface: brand[50] },
  PAUSED: { icon: "pause-outline", tint: ink[500], surface: paper[100] },
};

function ScheduleRow({ schedule, onPress }: { schedule: RecurringSchedule; onPress: () => void }) {
  const look = AGENDA_LOOK[agendaGroupOf(schedule)];
  const due = formatDueDate(schedule.nextDueDate);
  const meta = [
    schedule.categoryName,
    schedule.vendor,
    `Every ${schedule.intervalDays} days`,
    `Due ${due}`,
  ]
    .filter(Boolean)
    .join(" · ");

  /*
   * Composed rather than left to the layout, for the same reason the record
   * card composes its own: read in layout order this announces the label, then
   * a caption full of middle dots, then the amount. What matters is what it is,
   * what it costs, and when — in that order, without the separators.
   */
  const spoken = [
    schedule.label,
    formatMoney(schedule.expectedAmount),
    `due ${due}`,
    schedule.categoryName,
    schedule.isActive ? null : "paused",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${spoken}. Edit this payment.`}>
      <Card style={{ marginBottom: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
          <Medallion icon={look.icon} tint={look.tint} surface={look.surface} size={38} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <T style={{ flex: 1, fontFamily: font.sansMedium, color: ink[900] }} numberOfLines={2}>
                {schedule.label}
              </T>
              <Money value={schedule.expectedAmount} size={15} weight="semibold" decimals />
            </View>
            <T variant="caption" style={{ marginTop: 2 }}>
              {meta}
            </T>
            {schedule.isActive ? null : (
              <View
                style={{
                  alignSelf: "flex-start",
                  marginTop: space.sm,
                  paddingHorizontal: space.sm,
                  paddingVertical: 2,
                  borderRadius: radius.full,
                  backgroundColor: paper[100],
                }}
              >
                <T style={{ fontSize: typeScale.micro, color: ink[500] }}>Paused</T>
              </View>
            )}
          </View>
          <Ionicons name="chevron-forward" size={16} color={ink[300]} style={{ alignSelf: "center" }} />
        </View>
      </Card>
    </Pressable>
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
  /*
   * The owner's own declared schedules — what the Recurring tab is actually
   * about. The patterns above are only the candidates FinSight offers.
   */
  const scheduleState = useInsight<RecurringSchedule[]>(
    "/insights/recurring-schedules", { businessProfileId: selected?.id }, [selected?.id]
  );
  /**
   * Why a confirm or dismiss failed.
   *
   * Kept apart from the two fetch errors: confirming can come back 409 when
   * the same candidate was already promoted in another session, and that is a
   * sentence about the button just pressed, not about the list.
   */
  const [patternActionError, setPatternActionError] = useState<string | null>(null);
  /** Why recording an answer to a finding failed. Same reasoning as above. */
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  /**
   * The finding whose full answer list is open.
   *
   * A phone card carries the two most likely answers as buttons; the other
   * three live behind "Something else…" in a sheet. Five buttons on a card is
   * a wall, and dropping the three least likely would put the app back where
   * it was — with three of five feedback values unreachable.
   */
  const [feedbackFor, setFeedbackFor] = useState<AnomalyFinding | null>(null);

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

  /**
   * Records what the owner actually said about a finding.
   *
   * ONE FUNCTION, FIVE ANSWERS. It used to take two booleans and derive the
   * feedback from them, which is why only two of the five values were ever
   * written from a phone: `confirmed ? (duplicate ? "DUPLICATE" :
   * "CONFIRMED_UNUSUAL") : "EXPECTED_TRANSACTION"`. INCORRECT_MATCH — the most
   * valuable signal the duplicate detector can get, and a different fact from
   * "this is normal for me" — had no path at all. The status is not a separate
   * decision either; it follows from the answer (lib/findingFeedback.ts).
   */
  async function reviewFinding(id: number, action: FeedbackAction) {
    setFeedbackError(null);
    try {
      await api.patch(`/insights/findings/${id}/review`, {
        status: action.status,
        feedback: action.feedback,
      });
      haptics.succeeded();
      // Echoes what they said rather than "Saved" — the list is about to lose
      // the card, and a confirmation that does not name the answer leaves them
      // unsure which button they hit.
      setNotice(action.toast);
      await findingState.load();
    } catch (err) {
      setFeedbackError(errorMessage(err));
    }
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
      await api.post(`/insights/recurring-patterns/${id}/confirm`);
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
      await api.patch(`/insights/recurring-patterns/${id}`, { status: "DISMISSED" });
      await patternState.load();
    } catch (err) {
      setPatternActionError(errorMessage(err));
    }
  }

  function openSchedule(scheduleId?: number) {
    haptics.tapped();
    navigation.navigate("RecurringSchedule", scheduleId ? { scheduleId } : {});
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
  const openFindings = findingState.data?.items.length ?? 0;
  const candidates = patternState.data?.filter((pattern) => pattern.status === "CANDIDATE") ?? [];
  /*
   * `schedules` IS NULLABLE HERE, and every use of it below has to say what it
   * does when the agenda could not be read — see recurringAvailability. The
   * short version: the schedules endpoint is dark unless the server's
   * ANOMALY_RECURRING_ENABLED flag is on, so a 404 is its ordinary answer
   * today, and the agenda, its add buttons, its empty state and its badge all
   * come off rather than any of them being drawn from nothing.
   */
  const { schedules, canConfirm, overdueCount } = recurringAvailability(scheduleState);

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

  /*
   * THE RECURRING TAB COMES OFF WHEN IT WOULD OPEN ON NOTHING.
   *
   * With the agenda unavailable, all that tab can still hold is the candidate
   * list — ungated detector output, which is often empty. A tab that opens on
   * blank space reads as a screen that failed to load, which is the same
   * misreading the empty state was causing one level down. Overview and Alerts
   * are untouched by any of this: they are separate reads and a dark schedules
   * endpoint has nothing to say about them.
   */
  const sections = [
    { label: "Overview", value: "overview" as const },
    { label: "Alerts", value: "alerts" as const, count: openFindings },
    ...(schedules !== null || candidates.length > 0
      ? [{ label: "Recurring", value: "recurring" as const, count: overdueCount }]
      : []),
  ];

  /*
   * Derived rather than corrected in an effect: the tab an owner is standing on
   * can vanish under them when a refetch comes back 404, and `setSection` from
   * a render would be a second render pass to reach the same place.
   */
  const activeSection = sections.some((tab) => tab.value === section) ? section : "overview";

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
          value={activeSection}
          onChange={setSection}
          accessibilityLabel="Expense insight sections"
        />

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
                      {/* Money in prose still wears the mono figure face — the one hard typographic rule this app has for currency. */}
                      <T variant="caption" style={{ fontFamily: font.mono }}>
                        {formatMoney(Math.abs(data.totals.current - data.totals.previous))}
                      </T>
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
            {activeSection === "alerts" && openFindings === 0 && data.unusualExpenses.length === 0 ? (
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

            {activeSection === "alerts" && (openFindings > 0 || data.unusualExpenses.length > 0) ? (
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
                {feedbackError ? <ErrorNote>{feedbackError}</ErrorNote> : null}
                <View style={{ gap: space.sm }}>
                  {findingState.data?.items.map((finding) => {
                    /*
                      A duplicate and an unusual amount are different questions
                      with different answers, so they are told apart before they
                      are read — colour, glyph and the wording of the buttons.
                    */
                    const category = findingCategory(finding.type);
                    const duplicate = category === "duplicate";
                    /*
                      How much attention the finding is asking for, in words.
                      ADR-4: the detector's severity grade and its raw score
                      are internal, and "HIGH" reads as an accusation — the
                      band says what the owner should do instead. The score
                      only ever breaks a tie inside the mapping.
                    */
                    const signal = SIGNAL_COPY[findingSignalStrength(finding.severity, finding.score)];
                    const quick = quickActions(category);
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
                            {/*
                              The band, in words — never colour alone, and
                              never the raw score.
                            */}
                            <T
                              style={{
                                marginTop: 2,
                                fontSize: typeScale.micro,
                                fontFamily: font.sansSemibold,
                                color: signal.tone === "info" ? brand[700] : statusText[signal.tone],
                              }}
                            >
                              {signal.label}
                            </T>
                            {/*
                              WHY, capped at three. The detectors write these
                              in the owner's own figures; a fourth line is
                              where a card stops being read.
                            */}
                            {finding.reasons.slice(0, 3).map((reason) => (
                              <T key={reason} variant="caption" style={{ marginTop: 2, color: ink[700] }}>
                                • {reason}
                              </T>
                            ))}
                            <T variant="caption" style={{ marginTop: 4 }}>
                              {signal.detail}
                            </T>
                          </View>
                        </View>
                        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                          {quick.map((action, i) => (
                            <View key={action.feedback} style={{ flex: 1 }}>
                              <Button
                                title={action.label}
                                variant={i === 0 ? "brand" : "secondary"}
                                onPress={() => void reviewFinding(finding.id, action)}
                              />
                            </View>
                          ))}
                        </View>
                        <Pressable
                          onPress={() => setFeedbackFor(finding)}
                          accessibilityRole="button"
                          accessibilityLabel={`Other answers for ${finding.title}`}
                          style={{ minHeight: TAP, justifyContent: "center" }}
                        >
                          <T variant="caption" style={{ color: brand[700] }}>
                            Something else…
                          </T>
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              </Card>
              </>
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
              <>
                {/*
                  NO ERROR NOTE FOR THE SCHEDULES READ. It used to print the
                  server's own "Not found" here, which is the 404 the feature
                  flag returns by design — an owner was being shown the
                  plumbing of a feature that has not shipped. The agenda's
                  absence IS the message; see recurringAvailability.

                  `patternActionError` stays: that one is about a button the
                  owner just pressed, and it is still reachable through
                  "Not recurring", which is ungated.
                */}
                {patternActionError ? <ErrorNote>{patternActionError}</ErrorNote> : null}
                {scheduleState.loading && scheduleState.data === null && schedules !== null ? (
                  <ActivityIndicator color={brand[600]} />
                ) : null}

                {/*
                  THE ONLY STATE THAT MAY SAY "NOTHING HERE".

                  Both lists empty — nothing declared and nothing offered. The
                  old condition tested candidates alone, which told an owner
                  with schedules on file that none had been found.

                  `schedules !== null` is the second half of that same rule and
                  the more important one: an unread agenda is not an empty one.
                */}
                {schedules !== null && schedules.length === 0 && candidates.length === 0 && !scheduleState.loading ? (
                  <EmptyState
                    title="No repeating payments yet"
                    // `icon`, not a mascot: docs/mascot-scenario-library.md maps
                    // this state to a pose, but 04-empty-states/ ships no files
                    // on either client, and require()-ing a path that is not
                    // there is a build error rather than a missing picture.
                    icon="↻"
                    body="Rent, wages, a delivery you pay every week — add one and FinSight will tell you when it's late. It also offers them here once it notices the same expense a few times."
                    action={
                      <Button
                        title="Add a repeating payment"
                        variant="primary"
                        onPress={() => openSchedule()}
                      />
                    }
                  />
                ) : null}

                {/*
                  THE AGENDA. Grouped on the server's own `dueState` — see
                  lib/recurringAgenda.ts for why none of this is worked out
                  from the date here.
                */}
                {groupSchedules(schedules ?? []).map((group) => (
                  <View key={group.key}>
                    <T
                      variant="heading"
                      accessibilityRole="header"
                      style={{ color: brand[900], marginBottom: 2 }}
                    >
                      {group.title}
                    </T>
                    <T variant="caption" style={{ marginBottom: space.sm }}>
                      {group.caption}
                    </T>
                    {group.items.map((schedule) => (
                      <ScheduleRow
                        key={schedule.id}
                        schedule={schedule}
                        onPress={() => openSchedule(schedule.id)}
                      />
                    ))}
                  </View>
                ))}

                {/*
                  The add button goes with the agenda, not beside it: creating
                  a schedule is POST /insights/recurring-schedules, behind the
                  same gate as the read, so offering it while the agenda is
                  unavailable would walk the owner into a form that cannot save.
                */}
                {schedules !== null && schedules.length > 0 ? (
                  <Button
                    title="Add a repeating payment"
                    variant="secondary"
                    onPress={() => openSchedule()}
                  />
                ) : null}

                {/*
                  CANDIDATES, kept but demoted. They are FinSight's suggestions,
                  not the owner's list, and a suggestion should not outrank a
                  commitment.
                */}
                {candidates.length > 0 ? (
                  <Card>
                    <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", marginBottom: space.md }}>
                      <Medallion icon="sparkles-outline" tint={brand[700]} surface={brand[50]} />
                      <View style={{ flex: 1 }}>
                        <T variant="heading" accessibilityRole="header">FinSight noticed these repeat</T>
                        {/*
                          The caption promises what the buttons below can
                          actually do. With confirming unavailable there is no
                          "list above" to join, and repeating the promise
                          anyway would send the owner looking for a button
                          that is deliberately not there.
                        */}
                        <T variant="caption" style={{ marginTop: 2 }}>
                          {canConfirm
                            ? "Confirm one and it joins the list above, where you can edit or pause it."
                            : "Spotted in your records. Tell FinSight which of these aren't worth a second look."}
                        </T>
                      </View>
                    </View>
                    <View style={{ gap: space.sm }}>
                      {candidates.map((pattern) => (
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
                          {/*
                            CONFIRM IS HIDDEN, NOT DISABLED, when the agenda is
                            unavailable. POST .../confirm creates a schedule, so
                            it is behind the same server gate as the read and
                            can only 404 — and a greyed-out button still
                            advertises a capability, sending the owner hunting
                            for whatever would switch it back on. Web hides it
                            the same way, for the same reason
                            (web/src/pages/ExpenseInsight.tsx).

                            "Not recurring" stays either way: PATCH
                            /insights/recurring-patterns/:id is ungated, so
                            dismissing a bad guess still works.
                          */}
                          <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                            {canConfirm ? (
                              <View style={{ flex: 1 }}>
                                <Button
                                  title="Confirm"
                                  variant="brand"
                                  onPress={() => void confirmPattern(pattern.id)}
                                />
                              </View>
                            ) : null}
                            <View style={{ flex: 1 }}>
                              <Button
                                title="Not recurring"
                                variant="secondary"
                                onPress={() => void dismissPattern(pattern.id)}
                              />
                            </View>
                          </View>
                        </View>
                      ))}
                    </View>
                  </Card>
                ) : null}

                {/*
                  WHAT WATCHING ACTUALLY BUYS, and only what it buys.

                  This used to promise a notification for late, early AND
                  changed amounts. Only the first is delivered: the backend
                  emits a notification when a scheduled payment goes unrecorded
                  past its date, and when one is coming up. An early repeat or
                  a changed amount is raised as a finding on the Alerts tab and
                  nothing is sent. Said accurately here rather than generously,
                  because a promise of an alert that never arrives is worse
                  than no promise — the owner stops watching for it themselves.
                */}
                {schedules !== null && (schedules.length > 0 || candidates.length > 0) ? (
                  <Callout tone="info">
                    You'll be notified when a payment on this list is due or goes unrecorded past its date.
                    A different amount, or an extra payment sooner than expected, shows up under Alerts
                    rather than as a notification.
                  </Callout>
                ) : null}
              </>
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

      {/*
        All five answers, in one sheet, reached from any finding card. The
        card's two buttons are the likely ones; this is what makes the other
        three sayable at all on a phone — and one of them, "Wrong match", is
        the single most useful thing the duplicate detector can be told.

        The existing OptionSheet rather than a new surface: the app already has
        one bottom sheet and a second, slightly different one is exactly the
        drift the chip consolidation exists to prevent.
      */}
      <OptionSheet
        visible={feedbackFor !== null}
        title="What was this, really?"
        options={
          feedbackFor
            ? feedbackActions(findingCategory(feedbackFor.type)).map((a) => ({ id: a.feedback, name: a.label }))
            : []
        }
        value={feedbackFor?.feedback ?? null}
        onChoose={(id) => {
          if (!feedbackFor) return;
          const action = feedbackActions(findingCategory(feedbackFor.type)).find((a) => a.feedback === id);
          if (action) void reviewFinding(feedbackFor.id, action);
        }}
        onClose={() => setFeedbackFor(null)}
        emptyText="No answers available."
      />
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
