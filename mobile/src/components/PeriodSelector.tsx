import { useState } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { OptionSheet, T } from "./ui";
import { ConnectionNotice } from "./ConnectionNotice";
import { useReportingPeriod } from "../context/ReportingPeriodContext";
import { describeLoadFailure } from "../lib/connectionState";
import { ALL_TIME, THIS_WEEK, monthLabel } from "../lib/reportingPeriod";
import { font, radius, space } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";

/**
 * This week | Month | All time — the same three choices web offers.
 *
 * The Month segment opens a sheet listing only the months this business has
 * records in, newest first; once one is chosen the segment reads as that
 * month. Always on screen, so every choice is one tap from every other.
 *
 * Reads and sets the shared period (context/ReportingPeriodContext), so Home,
 * Expense Insights and Spending Impact are always on the same period.
 */
export function PeriodSelector() {
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
      {extra?.chevron ? <Ionicons name="chevron-down" size={13} color={checked ? t.brandHeading : t.textMuted} /> : null}
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
        {segment("all", "All time", selection.kind === "all", () => setSelection(ALL_TIME))}
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
