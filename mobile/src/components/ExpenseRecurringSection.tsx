import { ActivityIndicator, Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { ConnectionNotice } from "./ConnectionNotice";
import { ExpenseActionButton } from "./ExpenseActionButton";
import { Button, Card, ErrorNote, T } from "./ui";
import { formatDueDate, groupSchedules, overdueScheduleCount } from "../lib/recurringAgenda";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";
import type { RecurringPattern, RecurringSchedule } from "../lib/types";
import type { LoadNotice } from "../lib/connectionState";

export function ExpenseRecurringSection({ patternActionError, scheduleState, schedules, candidates, canConfirm, scheduleNotice, refreshSchedules, scheduleRefreshing, openSchedule, confirmPattern, dismissPattern, visibleScheduleIds, visibleCandidateIds }: {
  visibleScheduleIds?: number[];
  visibleCandidateIds?: number[];
  patternActionError: string | null;
  scheduleState: { data: RecurringSchedule[] | null; loading: boolean };
  schedules: RecurringSchedule[] | null;
  candidates: RecurringPattern[];
  canConfirm: boolean;
  scheduleNotice: LoadNotice | null;
  refreshSchedules: () => void | Promise<void>;
  scheduleRefreshing: boolean;
  openSchedule: (scheduleId?: number) => void;
  confirmPattern: (id: number) => void | Promise<void>;
  dismissPattern: (id: number) => void | Promise<void>;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const compact = width >= 360 && fontScale <= 1.1;
  const overdue = overdueScheduleCount(schedules ?? []);
  const visibleCandidates = visibleCandidateIds ? candidates.filter((pattern) => visibleCandidateIds.includes(pattern.id)) : candidates;
  const groups = groupSchedules(schedules ?? []).map((group) => ({ ...group, total: group.items.length, items: visibleScheduleIds ? group.items.filter((schedule) => visibleScheduleIds.includes(schedule.id)) : group.items })).filter((group) => group.items.length > 0);
  const empty = schedules !== null && schedules.length === 0 && candidates.length === 0 && !scheduleState.loading;
  return (
    <>
      <ConnectionNotice notice={scheduleNotice} onRetry={() => void refreshSchedules()} busy={scheduleRefreshing} />
      {patternActionError ? <ErrorNote>{patternActionError}</ErrorNote> : null}
      {schedules === null && !scheduleNotice ? (
        <View style={{ borderWidth: 1, borderColor: t.brandBorder, borderRadius: radius.lg, backgroundColor: t.brandSurface, padding: space.md, gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons name="repeat-outline" size={24} color={t.brandText} accessible={false} importantForAccessibility="no" />
            <T variant="heading" accessibilityRole="header" style={{ flex: 1 }}>Repeating payments unavailable</T>
          </View>
          <T style={{ color: t.textSecondary }}>Your payment agenda is unavailable right now. Retry before adding or confirming a repeating payment.</T>
          <Button title="Retry repeating payments" variant="secondary" loading={scheduleRefreshing} onPress={() => void refreshSchedules()} />
        </View>
      ) : null}
      {scheduleState.loading && scheduleState.data === null && schedules !== null ? <ActivityIndicator accessibilityLabel="Loading repeating payments" color={t.brand[600]} /> : null}
      {schedules !== null && schedules.length > 0 ? (
        <View style={{ gap: space.md }}>
          {groups.length > 0 ? <View style={{ gap: space.xs }}>
            <T accessibilityRole="header" style={{ fontSize: typeScale.title, lineHeight: 26, fontFamily: font.sansSemibold, color: t.textPrimary }}>Repeating payments</T>
            <T style={{ color: overdue > 0 ? t.statusText.serious : t.textSecondary }}>{overdue > 0 ? `${overdue} ${overdue === 1 ? "payment is" : "payments are"} overdue` : "Stay on top of your regular expenses."}</T>
          </View> : null}
          {groups.map((group) => {
            const warning = group.key === "OVERDUE";
            const paused = group.key === "PAUSED";
            const color = warning ? t.statusText.serious : paused ? t.textSecondary : t.brandText;
            const surface = warning ? t.statusSurface.serious : paused ? t.surfaceMuted : t.brandSurface;
            return (
              <View key={group.key} style={{ borderWidth: 1, borderColor: warning ? t.statusBorder.serious : paused ? t.border : t.brandBorder, borderRadius: radius.lg, overflow: "hidden", backgroundColor: t.surface }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: surface, paddingHorizontal: space.md, paddingVertical: space.sm }}>
                  <Ionicons name={warning ? "alert-circle-outline" : paused ? "pause-circle-outline" : "time-outline"} size={22} color={color} />
                  <T accessibilityRole="header" style={{ fontFamily: font.sansSemibold, color, flex: 1 }}>{group.title} · {group.total}</T>
                </View>
                {group.items.map((schedule, index) => (
                  <Pressable
                    key={schedule.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${schedule.label}, ${formatMoney(schedule.expectedAmount, { decimals: true })}, due ${formatDueDate(schedule.nextDueDate)}, ${schedule.isActive ? group.title : "paused"}. Edit this payment.`}
                    onPress={() => openSchedule(schedule.id)}
                    style={({ pressed }) => ({ padding: space.md, minHeight: TAP_FLOOR, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: t.border, gap: space.sm, backgroundColor: pressed ? t.surfaceMuted : t.surface })}
                  >
                    <View style={{ flexDirection: compact ? "row" : "column", alignItems: compact ? "center" : "stretch", gap: space.sm }}>
                      <View style={{ flex: compact ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: space.sm }}>
                        <Ionicons name="receipt-outline" size={24} color={t.brandText} accessible={false} importantForAccessibility="no" />
                        <T style={{ flex: 1, fontFamily: font.sansSemibold, color: t.textPrimary }}>{schedule.label}</T>
                      </View>
                      <View style={{ flex: compact ? 1 : undefined, alignItems: compact ? "flex-end" : "flex-start", gap: space.xs }}>
                        <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, lineHeight: 24, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(schedule.expectedAmount, { decimals: true })}</T>
                        <T style={{ fontSize: typeScale.bodySm, color }}>{paused ? "Paused" : `Due ${formatDueDate(schedule.nextDueDate)}`}</T>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={t.textMuted} style={compact ? undefined : { position: "absolute", right: 0, top: 0 }} />
                    </View>
                    <T variant="caption">{[schedule.categoryName, schedule.vendor, `Every ${schedule.intervalDays} days`, paused ? `Next date ${formatDueDate(schedule.nextDueDate)}` : null].filter(Boolean).join(" · ")}</T>
                  </Pressable>
                ))}
              </View>
            );
          })}
          <ExpenseActionButton title="Add a repeating payment" variant="secondary" onPress={() => openSchedule()} />
        </View>
      ) : null}
      {empty ? (
        <Card style={{ gap: space.md }}>
          <T variant="heading" accessibilityRole="header">No repeating payments yet</T>
          <T style={{ color: t.textSecondary }}>Add rent, wages or another regular expense. FinSight will watch its due date.</T>
          <ExpenseActionButton title="Add a repeating payment" variant="primary" onPress={() => openSchedule()} />
        </Card>
      ) : null}
      {schedules !== null && schedules.length === 0 && candidates.length > 0 && !scheduleState.loading ? (
        <View style={{ gap: space.md }}>
          <T variant="heading" accessibilityRole="header">No confirmed payments yet</T>
          <ExpenseActionButton title="Add a repeating payment" variant="secondary" onPress={() => openSchedule()} />
        </View>
      ) : null}
      {visibleCandidates.length > 0 ? (
        <View style={{ gap: space.md, marginTop: space.sm }}>
          <View style={{ gap: space.xs }}>
            <T variant="heading" accessibilityRole="header" style={{ color: t.textPrimary }}>Possible repeating payments</T>
            <T style={{ color: t.textSecondary }}>{canConfirm ? "Based on your recent expenses. Confirm a pattern to watch its due date." : "Patterns found in your records. You can dismiss a wrong match."}</T>
          </View>
          {visibleCandidates.map((pattern) => (
            <View key={pattern.id} style={{ borderWidth: 1, borderColor: t.brandBorder, borderRadius: radius.lg, backgroundColor: t.brandSurface, padding: space.md, gap: space.md }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
                <Ionicons name="repeat-outline" size={24} color={t.brandText} />
                <View style={{ flex: 1, gap: space.xs }}>
                  <T style={{ fontFamily: font.sansSemibold, color: t.textPrimary }}>{pattern.description}</T>
                  <T style={{ fontSize: typeScale.bodyLg, lineHeight: 24, fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(pattern.expectedAmount, { decimals: true })}</T>
                  <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>Expected {formatDueDate(pattern.nextExpectedDate)} · About every {pattern.intervalDays} days</T>
                  <T variant="caption">{[pattern.category.name, pattern.vendor].filter(Boolean).join(" · ")}</T>
                </View>
              </View>
              <View style={{ gap: space.sm, flexDirection: compact ? "row" : "column" }}>
                {canConfirm ? <View style={compact ? { flex: 1 } : undefined}><ExpenseActionButton title="Confirm" style={compact ? { flexGrow: 1 } : undefined} variant="brand" onPress={() => void confirmPattern(pattern.id)} /></View> : null}
                <View style={compact ? { flex: 1 } : undefined}><ExpenseActionButton title="Not recurring" style={compact ? { flexGrow: 1 } : undefined} variant="secondary" onPress={() => void dismissPattern(pattern.id)} /></View>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {schedules !== null && (schedules.length > 0 || candidates.length > 0) ? (
        <T variant="caption">FinSight notifies you when a watched payment is due or overdue. Changed amounts and extra early payments appear in expense review.</T>
      ) : null}
    </>
  );
}
