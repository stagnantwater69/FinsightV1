import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect } from "@react-navigation/native";
import { ContentScrollView } from "../components/ContentScrollView";
import { FAB_CLEARANCE } from "../components/AskFinSightFab";
import { InsightHeader } from "../components/InsightsShared";
import { SkeletonCard } from "../components/Skeleton";
import { TAP_FLOOR } from "../components/touchTarget";
import { Button, Callout, Card, ConfirmSheet, EmptyState, ErrorNote, Money, Screen, T } from "../components/ui";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTheme } from "../context/ThemeContext";
import { api, errorMessage } from "../lib/api";
import { businessToday } from "../lib/businessDate";
import * as haptics from "../lib/haptics";
import {
  addDays,
  calendarEntries,
  isClosedDay,
  monthBounds,
  monthGrid,
  shiftMonth,
  type CalendarEntry,
} from "../lib/paymentCalendar";
import { recurringAvailability } from "../lib/recurringAgenda";
import { useInsight } from "../lib/useInsight";
import type {
  OperatingDayOverride,
  OperatingDayOverridePage,
  OperatingScheduleEntry,
  RecurringPattern,
  RecurringSchedule,
} from "../lib/types";
import type { Palette } from "../theme/palette";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { InsightsScreenProps } from "../navigation/types";

/*
 * The payment calendar, the phone version of web's /calendar.
 *
 * Same data and the same date logic (lib/paymentCalendar.ts is a copy of
 * web's): watched payments on their due dates, later dates projected as
 * "Expected", detector suggestions to check, and closed days. Nothing new is
 * stored and no amounts are summed here.
 *
 * A seven-column month is too narrow on a phone for payment names, so each
 * cell carries dots, and the chosen day's payments are listed under the grid
 * with their actions — the place web uses a popup.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Dots a cell draws before the count stops growing. */
const CELL_DOT_LIMIT = 3;
/** Waits between refetches after a payment is recorded; the last only marks the wait slow. */
const SETTLE_POLL_MS = [2_500, 5_000, 10_000, 3_000];

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00.000Z`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function shortDate(key: string): string {
  return new Date(`${key}T00:00:00.000Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function daysBetweenKeys(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The colour that marks an entry, used for its dot and its card's edge. */
function entryColor(entry: CalendarEntry, t: Palette): string {
  if (entry.overdue) return t.statusText.critical;
  if (entry.kind === "due") return t.brandFill;
  if (entry.kind === "suggested") return t.brandText;
  return t.textFaint;
}

/** Filled for a watched payment, a ring for a suggestion, so the two differ by shape and not only colour. */
function Dot({ entry, size = 6 }: { entry: CalendarEntry; size?: number }) {
  const t = useTheme();
  const color = entryColor(entry, t);
  const ring = entry.kind === "suggested";
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: ring ? "transparent" : color,
        borderWidth: ring ? 1.5 : 0,
        borderColor: color,
      }}
    />
  );
}

type Confirming =
  | { kind: "skip"; schedule: RecurringSchedule; nextDue: string }
  | { kind: "again"; schedule: RecurringSchedule; last: string };

export function PaymentCalendarScreen({ navigation, route }: InsightsScreenProps<"PaymentCalendar">) {
  const t = useTheme();
  const { selected, categories } = useBusinessProfiles();
  const today = businessToday(selected?.timezone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [openDay, setOpenDay] = useState<string | null>(today);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** The watched payment last sent to the expense form, with the due date it had then. */
  const recordingFor = useRef<{ id: number; due: string } | null>(null);
  /** Schedules with a payment just recorded, holding the due date they had then, until the server moves it. */
  const [settling, setSettling] = useState<Record<number, { due: string; slow: boolean }>>({});

  const days = useMemo(() => monthGrid(month), [month]);
  const gridFrom = days[0]!;
  const gridTo = days[days.length - 1]!;
  const { first: monthFirst, last: monthLast } = monthBounds(month);
  const enabled = Boolean(selected);

  const scheduleState = useInsight<RecurringSchedule[]>(
    "/insights/recurring-schedules",
    { businessProfileId: selected?.id },
    [selected?.id],
    { enabled },
  );
  const patternState = useInsight<RecurringPattern[]>(
    "/insights/recurring-patterns",
    { businessProfileId: selected?.id },
    [selected?.id],
    { enabled },
  );
  // Closed days are decoration: if they fail to load, every day shows as open.
  const weeklyState = useInsight<OperatingScheduleEntry[]>(
    `/business-profiles/${selected?.id}/operating-schedule`,
    {},
    [selected?.id],
    { enabled },
  );
  const overrideState = useInsight<OperatingDayOverridePage | OperatingDayOverride[]>(
    `/business-profiles/${selected?.id}/operating-overrides`,
    { from: gridFrom, to: gridTo, pageSize: 50 },
    [selected?.id, gridFrom, gridTo],
    { enabled },
  );

  const availability = recurringAvailability({ data: scheduleState.data, error: scheduleState.rawError });
  const schedules = useMemo(() => availability.schedules ?? [], [availability.schedules]);
  const patterns = useMemo(() => patternState.data ?? [], [patternState.data]);
  const weekly = useMemo(() => weeklyState.data ?? [], [weeklyState.data]);
  const overrides = useMemo(() => {
    const data = overrideState.data;
    if (!data) return [];
    return Array.isArray(data) ? data : data.items;
  }, [overrideState.data]);

  const loadSchedules = scheduleState.load;
  const loadPatterns = patternState.load;
  const reload = useCallback(async () => {
    await Promise.all([loadSchedules(), loadPatterns()]);
  }, [loadSchedules, loadPatterns]);

  // Back from the expense form with a payment saved: watch for the match.
  useEffect(() => {
    if (!route.params?.recorded) return;
    navigation.setParams({ recorded: undefined });
    const sent = recordingFor.current;
    recordingFor.current = null;
    if (sent) setSettling((current) => ({ ...current, [sent.id]: { due: sent.due, slow: false } }));
    void reload();
  }, [route.params?.recorded, navigation, reload]);

  // A schedule is settled once the server has moved its due date on.
  useEffect(() => {
    if (!scheduleState.data) return;
    setSettling((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of Object.keys(current).map(Number)) {
        const schedule = scheduleState.data!.find((s) => s.id === id);
        if (!schedule || schedule.nextDueDate.slice(0, 10) !== current[id]!.due) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [scheduleState.data]);

  // The match runs in the background, so refetch a few times; if it is slow, say so and stop.
  const waiting = Object.values(settling).some((s) => !s.slow);
  useEffect(() => {
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = () => {
      timer = setTimeout(() => {
        if (attempt < SETTLE_POLL_MS.length - 1) {
          void loadSchedules();
          attempt += 1;
          tick();
        } else {
          setSettling((current) => Object.fromEntries(Object.entries(current).map(([id, s]) => [id, { ...s, slow: true }])));
        }
      }, SETTLE_POLL_MS[attempt]);
    };
    tick();
    return () => clearTimeout(timer);
  }, [waiting, loadSchedules]);

  // A different business has its own payments and its own today.
  useEffect(() => {
    setMonth(businessToday(selected?.timezone).slice(0, 7));
    setOpenDay(businessToday(selected?.timezone));
    setSettling({});
    setActionError(null);
  }, [selected?.id, selected?.timezone]);

  useFocusEffect(useCallback(() => () => setConfirming(null), []));

  const entriesByDate = useMemo(
    () => calendarEntries(schedules, patterns, gridFrom, gridTo),
    [schedules, patterns, gridFrom, gridTo],
  );
  const hasAnything = schedules.some((s) => s.isActive) || patterns.some((p) => p.status === "CANDIDATE");
  const loading = enabled && scheduleState.data === null && patternState.data === null && !scheduleState.error && !patternState.error;
  const loadError = availability.failure ? scheduleState.error : patternState.data === null ? patternState.error : null;

  // Two watched payments with the same name and category are almost always one entered twice.
  const duplicateScheduleIds = useMemo(() => {
    const seen = new Map<string, number[]>();
    for (const s of schedules) {
      if (!s.isActive) continue;
      const key = `${s.categoryId}|${s.label.trim().toLowerCase()}`;
      seen.set(key, [...(seen.get(key) ?? []), s.id]);
    }
    return new Set([...seen.values()].filter((ids) => ids.length > 1).flat());
  }, [schedules]);

  // Counts for the month on screen only, never sums: totals are a server calculation.
  const monthStats = useMemo(() => {
    const stats = { due: 0, overdue: 0, expected: 0, suggested: 0, closed: 0 };
    for (const key of days) {
      if (key < monthFirst || key > monthLast) continue;
      if (isClosedDay(key, weekly, overrides)) stats.closed += 1;
      for (const entry of entriesByDate.get(key) ?? []) {
        if (entry.overdue) stats.overdue += 1;
        else stats[entry.kind] += 1;
      }
    }
    return stats;
  }, [days, monthFirst, monthLast, weekly, overrides, entriesByDate]);

  function goToMonth(next: string) {
    haptics.tapped();
    setMonth(next);
    setOpenDay(next === today.slice(0, 7) ? today : null);
  }

  function openSchedule(scheduleId?: number) {
    haptics.tapped();
    navigation.navigate("RecurringSchedule", scheduleId ? { scheduleId } : {});
  }

  function openExpenseForm(prefill: { description: string; vendor: string; categoryId: number | null; amount: number }) {
    navigation.navigate("Records", {
      screen: "AddExpense",
      initial: false,
      params: { prefill, from: "PaymentCalendar" },
    });
  }

  function recordSchedulePayment(schedule: RecurringSchedule) {
    recordingFor.current = { id: schedule.id, due: schedule.nextDueDate.slice(0, 10) };
    openExpenseForm({
      description: schedule.label,
      vendor: schedule.vendor ?? "",
      categoryId: schedule.categoryId,
      amount: schedule.expectedAmount,
    });
  }

  /**
   * A watched payment's fields are copied from its schedule, so the expense
   * matches it by construction. Paying twice in one cycle is the easy mistake,
   * so a recent match asks first.
   */
  function startRecording(entry: CalendarEntry) {
    haptics.tapped();
    setActionError(null);
    if (entry.scheduleId !== undefined) {
      const schedule = schedules.find((s) => s.id === entry.scheduleId);
      if (!schedule) return;
      const last = schedule.lastRecordedDate?.slice(0, 10);
      if (last && daysBetweenKeys(last, today) < schedule.intervalDays / 2) {
        setConfirming({ kind: "again", schedule, last });
        return;
      }
      recordSchedulePayment(schedule);
      return;
    }
    const pattern = patterns.find((p) => p.id === entry.patternId);
    if (!pattern) return;
    recordingFor.current = null;
    openExpenseForm({
      description: pattern.description,
      vendor: pattern.vendor ?? "",
      // A suggestion carries its category by name only; left blank if it no longer matches.
      categoryId: categories.find((c) => c.name === pattern.category.name)?.id ?? null,
      amount: pattern.expectedAmount,
    });
  }

  function askSkip(scheduleId: number) {
    haptics.tapped();
    const schedule = schedules.find((s) => s.id === scheduleId);
    if (!schedule) return;
    setActionError(null);
    setConfirming({ kind: "skip", schedule, nextDue: addDays(schedule.nextDueDate.slice(0, 10), schedule.intervalDays) });
  }

  async function confirmSheet() {
    if (!confirming || !selected) return;
    if (confirming.kind === "again") {
      const { schedule } = confirming;
      setConfirming(null);
      recordSchedulePayment(schedule);
      return;
    }
    setBusy(true);
    try {
      await api.patch(
        `/insights/recurring-schedules/${confirming.schedule.id}`,
        { nextDueDate: confirming.nextDue },
        { cacheScope: { businessProfileId: selected.id } },
      );
      haptics.succeeded();
      setConfirming(null);
      await loadSchedules();
    } catch (err) {
      setConfirming(null);
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function answerSuggestion(patternId: number, answer: "watch" | "dismiss") {
    if (!selected) return;
    haptics.tapped();
    setActionError(null);
    try {
      if (answer === "watch") {
        await api.post(`/insights/recurring-patterns/${patternId}/confirm`, undefined, { cacheScope: { businessProfileId: selected.id } });
        haptics.succeeded();
      } else {
        await api.patch(`/insights/recurring-patterns/${patternId}`, { status: "DISMISSED" }, { cacheScope: { businessProfileId: selected.id } });
      }
      // Refetched, not patched: a new schedule's due state is server-computed.
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([reload(), weeklyState.load(), overrideState.load()]);
    } finally {
      setRefreshing(false);
    }
  }

  const openEntries = openDay ? (entriesByDate.get(openDay) ?? []) : [];
  const openClosed = openDay ? isClosedDay(openDay, weekly, overrides) : false;

  return (
    <Screen safeTop>
      <ContentScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={t.brandFill} />}
      >
        <InsightHeader
          navigation={navigation}
          active="PaymentCalendar"
          title="Payment calendar"
          right={
            hasAnything ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add a recurring payment"
                onPress={() => openSchedule()}
                style={({ pressed }) => ({
                  width: TAP_FLOOR,
                  height: TAP_FLOOR,
                  borderRadius: radius.full,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed ? t.surfaceStrong : t.surfaceRaised,
                  borderWidth: 1,
                  borderColor: t.border,
                })}
              >
                <Ionicons name="add" size={22} color={t.brandHeading} />
              </Pressable>
            ) : undefined
          }
        />

        {loadError ? (
          <Callout tone="warn">
            <T variant="body" accessibilityRole="alert">Some payments couldn’t load. {loadError}</T>
          </Callout>
        ) : null}
        {actionError ? <ErrorNote>That didn’t save. {actionError}</ErrorNote> : null}

        {!selected ? (
          <EmptyState title="No business selected" icon="↻" body="Choose a business to see its payment calendar." />
        ) : loading ? (
          <View accessible accessibilityLabel="Loading payment calendar" accessibilityState={{ busy: true }} style={{ gap: space.md }}>
            <SkeletonCard style={{ height: 340 }} />
            <SkeletonCard style={{ height: 120 }} />
          </View>
        ) : !hasAnything && !loadError ? (
          <EmptyState
            title="No payments to show yet"
            icon="↻"
            body="Add rent, salaries or bills you pay on a schedule. FinSight will also suggest ones it notices in your expenses for you to check."
            action={<Button title="Add a recurring payment" variant="primary" onPress={() => openSchedule()} />}
          />
        ) : (
          <>
            <Card style={{ padding: space.md, gap: space.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <MonthArrow direction="back" label="Previous month" onPress={() => goToMonth(shiftMonth(month, -1))} />
                <T
                  variant="title"
                  accessibilityRole="header"
                  accessibilityLiveRegion="polite"
                  style={{ flex: 1, textAlign: "center" }}
                >
                  {monthLabel(month)}
                </T>
                <MonthArrow direction="forward" label="Next month" onPress={() => goToMonth(shiftMonth(month, 1))} />
              </View>
              {month !== today.slice(0, 7) ? (
                <Button title="Back to this month" variant="ghost" onPress={() => goToMonth(today.slice(0, 7))} />
              ) : null}

              <MonthSummary stats={monthStats} />

              <View>
                <View style={{ flexDirection: "row" }}>
                  {WEEKDAYS.map((weekday) => (
                    <T
                      key={weekday}
                      importantForAccessibility="no"
                      style={{ flex: 1, textAlign: "center", fontFamily: font.sansSemibold, fontSize: typeScale.micro, color: t.textMuted, paddingVertical: space.xs }}
                    >
                      {weekday.slice(0, 1)}
                    </T>
                  ))}
                </View>
                {Array.from({ length: days.length / 7 }, (_, week) => (
                  <View key={week} style={{ flexDirection: "row" }}>
                    {days.slice(week * 7, week * 7 + 7).map((day) => (
                      <DayCell
                        key={day}
                        day={day}
                        inMonth={day >= monthFirst && day <= monthLast}
                        isToday={day === today}
                        isSelected={day === openDay}
                        closed={isClosedDay(day, weekly, overrides)}
                        entries={entriesByDate.get(day) ?? []}
                        onSelect={() => {
                          haptics.tapped();
                          setActionError(null);
                          setOpenDay(day);
                        }}
                      />
                    ))}
                  </View>
                ))}
              </View>
              <Legend />
            </Card>

            {openDay ? (
              <View style={{ gap: space.md }}>
                <View>
                  <T variant="title" accessibilityRole="header">{dayLabel(openDay)}</T>
                  <T variant="caption">
                    {openDay === today ? "Today · " : ""}
                    {openClosed ? "Business closed" : openEntries.length === 0 ? "Nothing due" : plural(openEntries.length, "payment")}
                  </T>
                </View>
                {openEntries.length === 0 ? (
                  <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: t.borderStrong, borderRadius: radius.lg, padding: space.lg }}>
                    <T variant="body" style={{ textAlign: "center", color: t.textMuted }}>
                      {openClosed ? "Closed, and nothing due this day." : "Nothing due this day."}
                    </T>
                  </View>
                ) : (
                  openEntries.map((entry) => (
                    <DayEntry
                      key={entry.key}
                      entry={entry}
                      canWatch={availability.canConfirm}
                      settling={entry.scheduleId !== undefined ? settling[entry.scheduleId] : undefined}
                      currentDue={entry.kind === "expected" ? currentDueOf(schedules, entry.scheduleId!) : undefined}
                      duplicate={entry.scheduleId !== undefined && duplicateScheduleIds.has(entry.scheduleId)}
                      onRecord={() => startRecording(entry)}
                      onSkip={() => askSkip(entry.scheduleId!)}
                      onAnswer={(answer) => void answerSuggestion(entry.patternId!, answer)}
                      onEdit={() => openSchedule(entry.scheduleId)}
                    />
                  ))
                )}
              </View>
            ) : (
              <T variant="caption" style={{ textAlign: "center" }}>Tap a day to see its payments.</T>
            )}
          </>
        )}
      </ContentScrollView>

      <ConfirmSheet
        visible={confirming !== null}
        title={confirming?.kind === "skip" ? "Skip this payment?" : "Already paid?"}
        body={
          confirming?.kind === "skip"
            ? `${confirming.schedule.label} moves to ${dayLabel(confirming.nextDue)}. No expense is recorded.`
            : confirming
              ? `FinSight matched a ${confirming.schedule.label} payment on ${dayLabel(confirming.last)}. Record another one?`
              : undefined
        }
        confirmLabel={confirming?.kind === "skip" ? "Skip" : "Record another"}
        busy={busy}
        onConfirm={() => void confirmSheet()}
        onCancel={() => setConfirming(null)}
      />
    </Screen>
  );
}

/** Where a schedule's payment that is due now sits on the calendar. */
function currentDueOf(schedules: RecurringSchedule[], scheduleId: number): { date: string; overdue: boolean } | undefined {
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (!schedule) return undefined;
  return { date: schedule.nextDueDate.slice(0, 10), overdue: schedule.dueState === "OVERDUE" };
}

function MonthArrow({ direction, label, onPress }: { direction: "back" | "forward"; label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: TAP_FLOOR,
        height: TAP_FLOOR,
        borderRadius: radius.full,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? t.surfaceStrong : t.surfaceMuted,
      })}
    >
      <Ionicons name={direction === "back" ? "chevron-back" : "chevron-forward"} size={20} color={t.brandHeading} />
    </Pressable>
  );
}

/** The month at a glance, in counts. Zero counts are left out so the row stays short. */
function MonthSummary({ stats }: { stats: { due: number; overdue: number; expected: number; suggested: number; closed: number } }) {
  const t = useTheme();
  const items = [
    { label: "due", value: stats.due, color: t.brandFill },
    { label: "overdue", value: stats.overdue, color: t.statusText.critical },
    { label: "expected", value: stats.expected, color: t.textFaint },
    { label: "to check", value: stats.suggested, color: t.brandText },
    { label: stats.closed === 1 ? "closed day" : "closed days", value: stats.closed, color: t.borderStrong },
  ].filter((item) => item.value > 0);
  if (items.length === 0) {
    return <T variant="caption" style={{ textAlign: "center" }}>Nothing due this month.</T>;
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "center" }}>
      {items.map((item) => (
        <View
          key={item.label}
          accessible
          accessibilityLabel={`${item.value} ${item.label}`}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.full, backgroundColor: t.surfaceMuted }}
        >
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.color }} />
          <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.caption, color: t.textPrimary }}>{item.value}</T>
          <T variant="caption">{item.label}</T>
        </View>
      ))}
    </View>
  );
}

function DayCell({
  day,
  inMonth,
  isToday,
  isSelected,
  closed,
  entries,
  onSelect,
}: {
  day: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  closed: boolean;
  entries: CalendarEntry[];
  onSelect: () => void;
}) {
  const t = useTheme();
  const summary = [
    closed ? "closed" : null,
    entries.some((e) => e.overdue) ? "overdue" : null,
    entries.length > 0 ? plural(entries.length, "payment") : "nothing due",
  ].filter(Boolean).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${dayLabel(day)}${isToday ? ", today" : ""}, ${summary}`}
      accessibilityState={{ selected: isSelected }}
      onPress={onSelect}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 52,
        alignItems: "center",
        paddingTop: space.xs,
        gap: 3,
        margin: 1,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        borderColor: isSelected ? t.brandBorder : "transparent",
        backgroundColor: pressed ? t.surfaceStrong : isSelected ? t.brandSurface : closed ? t.surfaceMuted : "transparent",
      })}
    >
      <View
        style={{
          minWidth: 26,
          height: 26,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isToday ? t.brandSolid : "transparent",
        }}
      >
        <T
          style={{
            fontFamily: font.monoMedium,
            fontSize: typeScale.label,
            color: isToday ? t.onBrandSolid : inMonth ? t.textPrimary : t.textFaint,
            textDecorationLine: closed && !isToday ? "line-through" : "none",
          }}
        >
          {Number(day.slice(8))}
        </T>
      </View>
      {entries.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 2, opacity: inMonth ? 1 : 0.6 }}>
          {entries.slice(0, CELL_DOT_LIMIT).map((entry) => (
            <Dot key={entry.key} entry={entry} />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

function Legend() {
  const t = useTheme();
  const sample = (kind: CalendarEntry["kind"], overdue = false) => ({ key: kind, kind, overdue }) as CalendarEntry;
  const items: { label: string; mark: ReactNode }[] = [
    { label: "Due", mark: <Dot entry={sample("due")} size={8} /> },
    { label: "Overdue", mark: <Dot entry={sample("due", true)} size={8} /> },
    { label: "Expected", mark: <Dot entry={sample("expected")} size={8} /> },
    { label: "Suggested — check it", mark: <Dot entry={sample("suggested")} size={8} /> },
    { label: "Closed day", mark: <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surfaceMuted, borderWidth: 1, borderColor: t.border }} /> },
  ];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs }}>
      {items.map((item) => (
        <View key={item.label} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          {item.mark}
          <T variant="caption">{item.label}</T>
        </View>
      ))}
    </View>
  );
}

const KIND_LABEL: Record<CalendarEntry["kind"], string> = { due: "Due", expected: "Expected", suggested: "Suggested by FinSight" };

function DayEntry({
  entry,
  canWatch,
  settling,
  currentDue,
  duplicate,
  onRecord,
  onSkip,
  onAnswer,
  onEdit,
}: {
  entry: CalendarEntry;
  canWatch: boolean;
  settling?: { slow: boolean };
  currentDue?: { date: string; overdue: boolean };
  duplicate: boolean;
  onRecord: () => void;
  onSkip: () => void;
  onAnswer: (answer: "watch" | "dismiss") => void;
  onEdit: () => void;
}) {
  const t = useTheme();
  const suggested = entry.kind === "suggested";
  const color = entryColor(entry, t);
  const pill = entry.overdue
    ? { text: "Overdue", ink: t.statusText.critical, surface: t.statusSurface.critical }
    : entry.kind === "due"
      ? { text: KIND_LABEL.due, ink: t.brandText, surface: t.brandSurface }
      : { text: KIND_LABEL[entry.kind], ink: t.textSecondary, surface: t.surfaceMuted };

  let note: string | null = null;
  let noteColor = t.textMuted;
  if (settling) {
    note = settling.slow ? "Payment recorded. It can take a few minutes to show here." : "Payment recorded. Updating…";
    noteColor = t.brandText;
  } else if (suggested) {
    note = "FinSight noticed this repeating. Is it a regular payment?";
  } else if (entry.kind === "expected" && currentDue && currentDue.date !== entry.date) {
    // A payment recorded now always clears the oldest unpaid one first.
    note = `Pays the ${currentDue.overdue ? "overdue " : ""}${shortDate(currentDue.date)} payment first.`;
    if (currentDue.overdue) noteColor = t.statusText.critical;
  }

  return (
    <Card
      style={{
        padding: space.md,
        gap: space.sm,
        borderLeftWidth: 4,
        borderLeftColor: color,
        ...(suggested ? { borderStyle: "dashed" as const, borderColor: t.brandBorder, borderLeftColor: color } : null),
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <View style={{ flex: 1, gap: space.xs }}>
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.body, color: t.textPrimary }}>{entry.label}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <View style={{ paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.full, backgroundColor: pill.surface }}>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.micro, color: pill.ink }}>{pill.text}</T>
            </View>
            <T variant="caption">{entry.categoryName ?? "No category"} · every {entry.intervalDays} days</T>
          </View>
        </View>
        <Money value={entry.amount} weight="semibold" />
      </View>

      {note ? (
        <T variant="caption" accessibilityLiveRegion={settling ? "polite" : "none"} style={{ color: noteColor }}>
          {note}
        </T>
      ) : null}
      {duplicate ? (
        <Callout tone="info">
          <T variant="caption" style={{ color: t.brandText }}>Another watched payment has this name. If it is a copy, delete one in Edit schedule.</T>
        </Callout>
      ) : null}

      <View style={{ gap: space.sm, borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.sm }}>
        {suggested ? (
          <>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button title="Not recurring" variant="secondary" onPress={() => onAnswer("dismiss")} accessibilityLabel={`Not recurring: ${entry.label}`} style={{ flex: 1 }} />
              {canWatch ? (
                <Button title="Watch this" variant="brand" onPress={() => onAnswer("watch")} accessibilityLabel={`Watch ${entry.label}`} style={{ flex: 1 }} />
              ) : null}
            </View>
            <Button title="Record payment" variant="ghost" onPress={onRecord} accessibilityLabel={`Record payment for ${entry.label}`} />
          </>
        ) : (
          <>
            {!settling ? (
              <Button
                title="Record payment"
                // Brand fill on the payment due now; outlined on a later one.
                variant={entry.kind === "due" ? "brand" : "secondary"}
                onPress={onRecord}
                accessibilityLabel={`Record payment for ${entry.label}`}
              />
            ) : null}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {entry.kind === "due" && !settling ? (
                <Button title="Skip this time" variant="ghost" onPress={onSkip} accessibilityLabel={`Skip this time: ${entry.label}`} style={{ flex: 1 }} />
              ) : null}
              <Button title="Edit schedule" variant="ghost" onPress={onEdit} accessibilityLabel={`Edit schedule for ${entry.label}`} style={{ flex: 1 }} />
            </View>
          </>
        )}
      </View>
    </Card>
  );
}
