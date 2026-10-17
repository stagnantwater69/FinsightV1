import { useState } from "react";
import { Pressable, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { OptionSheet, T } from "./ui";
import { ConnectionNotice } from "./ConnectionNotice";
import { useReportingPeriod } from "../context/ReportingPeriodContext";
import { describeLoadFailure } from "../lib/connectionState";
import { ALL_TIME, THIS_WEEK, monthLabel, periodLabel, type PeriodSelection } from "../lib/reportingPeriod";
import { font, radius, space, typeScale } from "../theme/tokens";
import { HERO } from "../theme/hero";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";

/**
 * This week | Month | All time — the same three choices web offers.
 *
 * The Month segment opens a sheet listing only the months this business has
 * records in, newest first; once one is chosen the segment reads as that
 * month. Always on screen, so every choice is one tap from every other.
 *
 * Reads and sets the enclosing screen's period without changing other screens.
 */
export function PeriodSelector({ showAllTime = true }: { showAllTime?: boolean } = {}) {
  const t = useTheme();
  const {
    selection,
    setSelection,
    months,
    monthsState,
    monthsFailure,
    monthsUpdatedAt,
    monthsRefreshing,
    refreshMonths,
  } = useReportingPeriod();
  const [picking, setPicking] = useState(false);

  const monthActive = selection.kind === "month";
  const options = monthActive && !months.includes(selection.month) ? [selection.month, ...months] : months;
  const monthText = monthActive ? monthLabel(selection.month) : "Month";
  const monthsNotice = describeLoadFailure(monthsFailure, {
    hasData: months.length > 0,
    lastUpdatedAt: monthsUpdatedAt,
    subject: "the months with records",
  });
  const monthHint = options.length > 0
    ? "Opens the months with records"
    : monthsState === "loading"
      ? "Months with records are loading"
      : monthsState === "error"
        ? "Months couldn't be loaded. Use Try again below"
        : "No months with records yet";

  const segment = (key: string, label: string, checked: boolean, onPress: () => void, extra?: { hint?: string; disabled?: boolean; chevron?: boolean }) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={extra?.hint}
      accessibilityState={{ checked, disabled: extra?.disabled }}
      disabled={extra?.disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: TAP_FLOOR,
        flexDirection: "row",
        gap: 4,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.sm,
        opacity: extra?.disabled ? 0.55 : 1,
        backgroundColor: checked ? t.surface : pressed ? t.surfaceStrong : "transparent",
      })}
    >
      <T
        variant="caption"
        numberOfLines={1}
        style={{
          color: checked ? t.brandHeading : t.textMuted,
          fontFamily: checked ? font.sansSemibold : font.sans,
        }}
      >
        {label}
      </T>
      {extra?.chevron ? <Ionicons name="chevron-down" size={14} color={checked ? t.brandHeading : t.textMuted} /> : null}
    </Pressable>
  );

  return (
    <>
      {/*
        No group role on the wrapper: a `radiogroup` would have to be an
        accessibility element to be announced, which collapses the options
        inside it into one unreachable blob (tests/accessibleElements.test.ts).
        Each option announces its own name and checked state.
      */}
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
        {segment("week", "This week", selection.kind === "week", () => setSelection(THIS_WEEK))}
        {segment("month", monthText, monthActive, () => setPicking(true), {
          hint: monthHint,
          disabled: options.length === 0,
          chevron: true,
        })}
        {/* Recovery targets are per week or month; an all-time target means nothing. */}
        {showAllTime ? segment("all", "All time", selection.kind === "all", () => setSelection(ALL_TIME)) : null}
      </View>
      <ConnectionNotice
        notice={monthsNotice}
        onRetry={refreshMonths}
        busy={monthsRefreshing}
        style={{ marginTop: space.sm }}
      />
      <OptionSheet
        visible={picking}
        title="Month"
        options={options.map((month) => ({ id: month, name: monthLabel(month) }))}
        value={monthActive ? selection.month : null}
        onChoose={(month) => setSelection({ kind: "month", month: String(month) })}
        onClose={() => setPicking(false)}
        emptyText={monthsState === "error" ? "Months couldn't be loaded." : "No months with records yet."}
      />
    </>
  );
}

// ---------------------------------------------------------------- Home: the period as a label

const NOW_DETAIL = "This month";

function currentMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** True when the selection is not "now": a past month, or all time. This week and this month are now. */
function isPastPeriod(selection: PeriodSelection, today: Date = new Date()): boolean {
  if (selection.kind === "all") return true;
  return selection.kind === "month" && selection.month !== currentMonth(today);
}

/**
 * Home's period control: a small pill that names the period and opens one
 * sheet with every choice in it.
 *
 * The three-way bar this replaces sat at full width under the greeting and
 * was the loudest thing on Home after the figures, for a choice most owners
 * make once. Here the period IS the money panel's label, so the screen says
 * it once instead of twice. Same shared selection as the bar, so Expense
 * insights and Spending impact still follow it; the hint says so.
 */
export function PeriodPill({ showAllTime = true }: { showAllTime?: boolean } = {}) {
  const { selection, setSelection, months, monthsState } = useReportingPeriod();
  const [picking, setPicking] = useState(false);
  const now = currentMonth();
  const monthOptions = selection.kind === "month" && !months.includes(selection.month) ? [selection.month, ...months] : months;
  const options = [
    // The two fixed choices first: a business with years of records would
    // otherwise bury All time under every month it has.
    { id: "week", name: "This week", detail: null },
    ...(showAllTime ? [{ id: "all", name: "All time", detail: "Since your first record" }] : []),
    ...monthOptions.map((month) => ({ id: month, name: monthLabel(month), detail: month === now ? NOW_DETAIL : null })),
  ];
  const value = selection.kind === "month" ? selection.month : selection.kind;
  const label = periodLabel(selection);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Period: ${label}. Change period`}
        accessibilityHint="Other insight screens follow this too"
        onPress={() => setPicking(true)}
        hitSlop={4}
        style={({ pressed }) => ({
          minHeight: 36,
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingLeft: space.md,
          paddingRight: space.sm,
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: HERO.hairline,
          backgroundColor: pressed ? HERO.washStrong : HERO.wash,
        })}
      >
        <Ionicons name="calendar-outline" size={15} color={HERO.soft} />
        <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: HERO.ink }}>{label}</T>
        <Ionicons name="chevron-down" size={14} color={HERO.ink} />
      </Pressable>
      <OptionSheet
        visible={picking}
        title="Show numbers for"
        options={options}
        value={value}
        onChoose={(id) => {
          const chosen = String(id);
          setSelection(chosen === "week" ? THIS_WEEK : chosen === "all" ? ALL_TIME : { kind: "month", month: chosen });
        }}
        onClose={() => setPicking(false)}
        emptyText={monthsState === "error" ? "Months couldn't be loaded." : "No months with records yet."}
      />
    </>
  );
}

/**
 * What sits where the bar used to: the months-load notice, and — only when
 * Home is not showing now — a reminder of which period it is showing, with
 * the way back. Without it, an owner who looked at September last week opens
 * Home and reads September's figures as today's.
 */
export function PeriodStatus() {
  const t = useTheme();
  const { selection, setSelection, months, monthsFailure, monthsUpdatedAt, monthsRefreshing, refreshMonths } = useReportingPeriod();
  const monthsNotice = describeLoadFailure(monthsFailure, {
    hasData: months.length > 0,
    lastUpdatedAt: monthsUpdatedAt,
    subject: "the months with records",
  });
  const past = isPastPeriod(selection);
  return (
    <>
      <ConnectionNotice notice={monthsNotice} onRetry={refreshMonths} busy={monthsRefreshing} />
      {past ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingLeft: space.md,
            paddingRight: space.xs,
            paddingVertical: space.xs,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: t.statusBorder.warning,
            backgroundColor: t.statusSurface.warning,
          }}
        >
          <Ionicons name="time-outline" size={16} color={t.statusText.warning} />
          <T style={{ flex: 1, fontSize: typeScale.label, color: t.statusText.warning }}>
            {"Viewing "}
            <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.statusText.warning }}>{selection.kind === "all" ? "all time" : periodLabel(selection)}</T>
          </T>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Back to now: ${months.includes(currentMonth()) ? monthLabel(currentMonth()) : "this week"}`}
            // The shared period only keeps months that have records, so a month
            // with none yet would bounce straight back here; this week is now too.
            onPress={() => setSelection(months.includes(currentMonth()) ? { kind: "month", month: currentMonth() } : THIS_WEEK)}
            style={({ pressed }) => ({
              minHeight: TAP_FLOOR,
              justifyContent: "center",
              paddingHorizontal: space.md,
              borderRadius: radius.sm,
              backgroundColor: pressed ? t.surfaceMuted : t.surface,
            })}
          >
            <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>Back to now</T>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}
