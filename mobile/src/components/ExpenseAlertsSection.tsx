import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, ErrorNote, T } from "./ui";
import { SIGNAL_COPY, findingSignalStrength } from "../lib/confidenceBands";
import { findingCategory, quickActions, type FeedbackAction } from "../lib/findingFeedback";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { ExpenseActionButton } from "./ExpenseActionButton";
import { formatDueDate } from "../lib/recurringAgenda";
import type { AnomalyFinding, AnomalyFindingPage, ExpenseBehavior } from "../lib/types";
import { ConnectionNotice, FreshnessStatus } from "./ConnectionNotice";
import type { LoadNotice } from "../lib/connectionState";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";
import { GrowFill } from "./GrowFill";

export function FindingReview({ finding, expense, reviewFinding, onOtherAnswers, onExplain, initiallyExpanded = false, showEvidence = true }: {
  finding: AnomalyFinding;
  expense?: ExpenseBehavior["unusualExpenses"][number];
  reviewFinding: (id: number, action: FeedbackAction) => void | Promise<void>;
  onOtherAnswers: (finding: AnomalyFinding) => void;
  onExplain?: (finding: AnomalyFinding) => void;
  initiallyExpanded?: boolean;
  /** False where the page explains the flag itself (FindingDetailScreen). */
  showEvidence?: boolean;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const category = findingCategory(finding.type);
  const signal = SIGNAL_COPY[findingSignalStrength(finding.severity, finding.score)];
  const actions = quickActions(category);
  const { width, fontScale } = useWindowDimensions();
  const sideBySide = width >= 360 && fontScale <= 1.1;
  const link = { fontSize: typeScale.bodySm, fontFamily: font.sansMedium, color: t.brandText };
  return (
    // White card, amber only on the type label: a page of all-amber cards reads as one alarm, not a list.
    <View style={{ padding: space.md, gap: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Ionicons name={category === "duplicate" ? "copy-outline" : "alert-circle-outline"} size={16} color={t.statusText.warning} />
        <T style={{ flex: 1, fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.statusText.warning }}>{category === "duplicate" ? "Possible duplicate" : "Unusual spending"}</T>
        <View style={{ borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 2, backgroundColor: signal.tone === "info" ? t.brandSurface : t.statusSurface[signal.tone] }}>
          <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: signal.tone === "info" ? t.brandText : t.statusText[signal.tone] }}>{signal.label}</T>
        </View>
      </View>
      {expense ? <UnusualComparison expense={expense} integrated /> : <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.body, color: t.textPrimary }}>{finding.title}</T>}
      <View style={{ gap: space.sm, flexDirection: sideBySide ? "row" : "column" }}>
        {actions.map((action, index) => (
          <View key={action.feedback} style={sideBySide ? { flex: 1 } : undefined}>
            <ExpenseActionButton title={index === 0 ? category === "duplicate" ? "Mark duplicate" : "Yes, unusual" : category === "duplicate" ? "Wrong match" : "Expected expense"} accessibilityLabel={action.label} style={sideBySide ? { flexGrow: 1 } : undefined} variant={index === 0 ? "danger" : "secondary"} onPress={() => void reviewFinding(finding.id, action)} />
          </View>
        ))}
      </View>
      {/* The secondary ways in, on one line under the decision instead of a stack of bars. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.lg, marginTop: -space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
        {showEvidence ? <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Evidence for ${finding.title}`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={{ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <T style={link}>{expanded ? "Hide evidence" : "View evidence"}</T>
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={14} color={t.brandText} />
        </Pressable> : null}
        <Pressable onPress={() => onOtherAnswers(finding)} accessibilityRole="button" accessibilityLabel={`Other answers for ${finding.title}`} style={{ minHeight: TAP_FLOOR, justifyContent: "center" }}>
          <T style={link}>Other answers</T>
        </Pressable>
        {onExplain ? <Pressable onPress={() => onExplain(finding)} accessibilityRole="button" accessibilityLabel={`Explain why FinSight flagged ${finding.title}`} style={{ minHeight: TAP_FLOOR, justifyContent: "center" }}>
          <T style={link}>Explain this flag</T>
        </Pressable> : null}
      </View>
      {expanded && showEvidence ? (
        <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: t.surfaceSunken }}>
          {expense ? <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>{finding.title}</T> : null}
          {finding.reasons.map((reason, index) => <T key={index} style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>{reason}</T>)}
          <T variant="caption">{signal.detail}</T>
          <T variant="caption">Detected {formatDueDate(finding.detectedAt)} · Finding #{finding.id}{finding.expenseRecordId !== null ? ` · Record #${finding.expenseRecordId}` : ""}</T>
        </View>
      ) : null}
    </View>
  );
}

export function UnusualComparison({ expense, integrated = false }: { expense: ExpenseBehavior["unusualExpenses"][number]; integrated?: boolean }) {
  const t = useTheme();
  const maximum = Math.max(expense.amount, expense.categoryMean);
  const multiple = expense.categoryMean > 0 ? expense.amount / expense.categoryMean : null;
  const comparisonData: ChartDatum[] = [{ key: String(expense.id), label: expense.description, values: [{ label: "This expense", value: expense.amount, color: t.statusSolid.critical }, { label: "Category average", value: expense.categoryMean, color: t.brandFill }], note: `${expense.categoryName}. ${formatDueDate(expense.date)}.${multiple === null ? " No positive category average to compare." : ` ${multiple.toFixed(1)} times the category average.`}` }];
  const comparisonSelection = useChartSelection(comparisonData);
  return (
    <View style={{ gap: space.sm, ...(integrated ? {} : { padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }) }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <T numberOfLines={2} style={{ flex: 1, fontFamily: font.sansSemibold, fontSize: typeScale.body, color: t.textPrimary }}>{expense.description}</T>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.body, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(expense.amount, { decimals: true })}</T>
      </View>
      <T variant="caption">{expense.categoryName} · {formatDueDate(expense.date)}{multiple !== null && multiple >= 1.5 ? ` · ${multiple.toFixed(1)}× the category average` : ""}</T>
      {[
        { label: "This expense", amount: expense.amount, color: t.statusSolid.critical },
        { label: "Category average", amount: expense.categoryMean, color: t.brand[600] },
      ].map((row) => (
        <View key={row.label} style={{ gap: space.xs }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}>
            <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>{row.label}</T>
            {row.label === "Category average" ? <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, fontVariant: ["tabular-nums"] }}>{formatMoney(row.amount, { decimals: true })}</T> : null}
          </View>
          <ChartPlotPressArea selection={comparisonSelection} count={1} chartLabel={`${expense.description} comparison`}>
          <View accessible={false} style={{ height: 8, borderRadius: radius.sm, overflow: "hidden", backgroundColor: t.surfaceMuted }}>
            <GrowFill percent={maximum > 0 ? Math.max(0, row.amount / maximum * 100) : 0} style={{ height: 8, borderRadius: radius.sm, backgroundColor: row.color }} />
          </View>
          </ChartPlotPressArea>
        </View>
      ))}
      <ChartValueReadout data={comparisonData} selection={comparisonSelection} chartLabel={`${expense.description} comparison`} />
    </View>
  );
}

type UnusualExpenseRow = ExpenseBehavior["unusualExpenses"][number];

/** The finding and unmatched unusual-expense rows of the Review tab. Each row opens FindingDetailScreen. */
export function ExpenseAlertsSection({ unusualExpenses, openFindings, findingState, findingNotice, refreshFindings, findingsRefreshing, findingsUpdatedAt, onOpen, visibleFindingIds, visibleUnusualIds, hasOtherReviewItems = false, findingsComplete = true, pagination }: {
  pagination?: ReactNode;
  visibleFindingIds?: number[];
  visibleUnusualIds?: number[];
  hasOtherReviewItems?: boolean;
  findingsComplete?: boolean;
  unusualExpenses: ExpenseBehavior["unusualExpenses"];
  openFindings: number;
  findingState: { data: AnomalyFindingPage | null; loading: boolean; error: string | null };
  findingNotice: LoadNotice | null;
  refreshFindings: () => void | Promise<void>;
  findingsRefreshing: boolean;
  findingsUpdatedAt: number | null;
  onOpen: (target: { finding?: AnomalyFinding; expense?: UnusualExpenseRow }) => void;
}) {
  const t = useTheme();
  const items = findingState.data?.items ?? [];
  const matchedIds = new Set(items.filter((finding) => finding.expenseRecordId !== null).map((finding) => finding.expenseRecordId));
  const unmatchedExpenses = unusualExpenses.filter((expense) => !matchedIds.has(expense.id));
  const visibleFindings = visibleFindingIds ? items.filter((finding) => visibleFindingIds.includes(finding.id)) : items;
  const visibleExpenses = visibleUnusualIds ? unmatchedExpenses.filter((expense) => visibleUnusualIds.includes(expense.id)) : unmatchedExpenses;
  const clean = !hasOtherReviewItems && findingsComplete && openFindings === 0 && items.length === 0 && unusualExpenses.length === 0 && !findingState.loading && !findingState.error;
  const toReview = openFindings + unmatchedExpenses.length;
  const allUnusual = visibleFindings.every((finding) => findingCategory(finding.type) !== "duplicate");
  const rows = [
    ...visibleFindings.map((finding) => {
      const expense = unusualExpenses.find((e) => e.id === finding.expenseRecordId);
      const duplicate = findingCategory(finding.type) === "duplicate";
      const signal = SIGNAL_COPY[findingSignalStrength(finding.severity, finding.score)];
      return {
        key: `f${finding.id}`,
        icon: duplicate ? "copy-outline" as const : "alert-circle-outline" as const,
        title: expense?.description ?? finding.title,
        amount: expense?.amount ?? null,
        meta: expense ? `${expense.categoryName} · ${formatDueDate(expense.date)}` : `Detected ${formatDueDate(finding.detectedAt)}`,
        note: `${duplicate ? "Possible duplicate" : "Unusual spending"} · ${signal.label}`,
        open: () => onOpen({ finding, expense }),
      };
    }),
    ...visibleExpenses.map((expense) => {
      const multiple = expense.categoryMean > 0 ? expense.amount / expense.categoryMean : null;
      return {
        key: `u${expense.id}`,
        icon: "alert-circle-outline" as const,
        title: expense.description,
        amount: expense.amount as number | null,
        meta: `${expense.categoryName} · ${formatDueDate(expense.date)}`,
        note: multiple !== null && multiple >= 1.5 ? `${multiple.toFixed(1)}× the category average` : "Above the category average",
        open: () => onOpen({ expense }),
      };
    }),
  ];
  return (
    <>
      <ConnectionNotice notice={findingNotice} onRetry={() => void refreshFindings()} busy={findingsRefreshing} />
      {findingState.data ? <FreshnessStatus at={findingsUpdatedAt} now={Date.now()} refreshing={findingsRefreshing} /> : null}
      {findingState.error && !findingNotice ? <ErrorNote>{findingState.error}</ErrorNote> : null}
      {findingState.loading ? <ActivityIndicator accessibilityLabel="Loading findings" color={t.brand[600]} /> : null}
      {clean ? (
        <Card style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Ionicons name="checkmark-circle-outline" size={24} color={t.statusText.good} />
            <T variant="heading" accessibilityRole="header" style={{ flex: 1 }}>Nothing needs review</T>
          </View>
          <T style={{ color: t.textSecondary }}>No open findings or unusual expenses in these results.</T>
        </Card>
      ) : null}
      {rows.length > 0 ? (
        <View style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <T accessibilityRole="header" style={{ flex: 1, fontSize: typeScale.subpageTitle, fontFamily: font.sansSemibold, color: t.textPrimary }}>{allUnusual ? "Unusual spending" : "Spending flags"}</T>
            {toReview > 0 ? (
              <View style={{ borderRadius: radius.full, paddingHorizontal: space.md, paddingVertical: space.xs, backgroundColor: t.statusSurface.warning }}>
                <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.statusText.warning }}>{`${toReview}${findingsComplete ? "" : "+"} to review`}</T>
              </View>
            ) : null}
          </View>
          <Card style={{ paddingVertical: space.xs }}>
            {rows.map((row, index) => (
              <Pressable
                key={row.key}
                accessibilityRole="button"
                accessibilityLabel={`${row.title}${row.amount !== null ? `, ${formatMoney(row.amount)}` : ""}, ${row.meta}, ${row.note}. Check this.`}
                onPress={row.open}
                style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: t.border, opacity: pressed ? 0.7 : 1 })}
              >
                {/* Coloured because it says why the row is here. */}
                <Ionicons name={row.icon} size={22} color={t.statusText.warning} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                    <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.body, fontFamily: font.sansSemibold, color: t.textPrimary }}>{row.title}</T>
                    {row.amount !== null ? <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.body, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(row.amount)}</T> : null}
                  </View>
                  <T numberOfLines={1} style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>{row.meta}</T>
                  <T numberOfLines={1} style={{ fontSize: typeScale.bodySm, color: t.statusText.warning }}>{row.note}</T>
                </View>
                <Ionicons name="chevron-forward" size={18} color={t.textMuted} />
              </Pressable>
            ))}
          </Card>
        </View>
      ) : null}
      {pagination}
    </>
  );
}
