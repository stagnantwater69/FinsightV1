import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as haptics from "../lib/haptics";
import { useFocusEffect } from "@react-navigation/native";
import { Callout, Card, DropdownPill, ErrorNote, Money, OptionSheet, Screen, T } from "../components/ui";
import { CategoryChange, CategoryComparison, SpendTrend } from "../components/charts";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { DeltaPill, InsightHeader, Medallion, SubTabs } from "../components/InsightsShared";
import { ExpenseAlertsSection } from "../components/ExpenseAlertsSection";
import { ExpenseRecurringSection } from "../components/ExpenseRecurringSection";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { takeFlash } from "../lib/flash";
import { formatMoney } from "../lib/money";
import { recurringAvailability } from "../lib/recurringAgenda";
import { findingCategory, feedbackActions, type FeedbackAction } from "../lib/findingFeedback";
import { useInsight } from "../lib/useInsight";
import { TAP, font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type {
  AnomalyFinding,
  AnomalyFindingPage,
  ExpenseBehavior,
  RecurringPattern,
  RecurringSchedule,
} from "../lib/types";

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
  const t = useTheme();
  const { brand, ink, paper, statusText } = t;
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
                        backgroundColor: periodDelta >= 0 ? t.statusSurface.serious : t.statusSurface.good,
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
            {activeSection === "alerts" ? (
              <ExpenseAlertsSection
                unusualExpenses={data.unusualExpenses}
                insufficientHistoryCategories={data.insufficientHistoryCategories}
                openFindings={openFindings}
                findingState={findingState}
                feedbackError={feedbackError}
                reviewFinding={reviewFinding}
                onOtherAnswers={setFeedbackFor}
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
                patternActionError={patternActionError}
                scheduleState={scheduleState}
                schedules={schedules}
                candidates={candidates}
                canConfirm={canConfirm}
                openSchedule={openSchedule}
                confirmPattern={confirmPattern}
                dismissPattern={dismissPattern}
              />
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

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Expense Insights" />

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
