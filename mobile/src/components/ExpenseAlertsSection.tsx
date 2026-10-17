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

function FindingReview({ finding, expense, reviewFinding, onOtherAnswers, onExplain }: {
  finding: AnomalyFinding;
  expense?: ExpenseBehavior["unusualExpenses"][number];
  reviewFinding: (id: number, action: FeedbackAction) => void | Promise<void>;
  onOtherAnswers: (finding: AnomalyFinding) => void;
  onExplain?: (finding: AnomalyFinding) => void;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const category = findingCategory(finding.type);
  const signal = SIGNAL_COPY[findingSignalStrength(finding.severity, finding.score)];
  const actions = quickActions(category);
  const { width, fontScale } = useWindowDimensions();
  const sideBySide = width >= 360 && fontScale <= 1.1;
  return (
    <View style={{ padding: space.md, gap: space.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: t.statusBorder.warning, backgroundColor: t.statusSurface.warning }}>
      <View style={{ flexDirection: sideBySide ? "row" : "column", alignItems: sideBySide ? "center" : "stretch", gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: sideBySide ? 1 : undefined }}>
          <Ionicons name={category === "duplicate" ? "copy-outline" : "alert-circle-outline"} size={22} color={t.statusText.warning} />
          <T style={{ fontFamily: font.sansSemibold, color: t.statusText.warning, flex: 1 }}>{category === "duplicate" ? "Possible duplicate" : "Unusual spending"}</T>
        </View>
        <View style={{ alignSelf: "flex-start", borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: signal.tone === "info" ? t.brandSurface : t.statusSurface[signal.tone] }}>
          <T style={{ fontSize: typeScale.caption, lineHeight: 18, fontFamily: font.sansSemibold, color: signal.tone === "info" ? t.brandText : t.statusText[signal.tone] }}>{signal.label}</T>
        </View>
      </View>
      {expense ? <UnusualComparison expense={expense} integrated /> : <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: t.textPrimary }}>{finding.title}</T>}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Evidence for ${finding.title}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ minHeight: TAP_FLOOR, paddingHorizontal: space.md, borderRadius: radius.sm, backgroundColor: t.surface, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}
      >
        <T style={{ color: t.brand[700], flex: 1 }}>{expanded ? "Hide evidence" : "View evidence"}</T>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={t.brand[700]} />
      </Pressable>
      {expanded ? (
        <View style={{ gap: space.sm, paddingBottom: space.sm }}>
          {expense ? <T style={{ fontFamily: font.sansSemibold, color: t.textPrimary }}>{finding.title}</T> : null}
          {finding.reasons.map((reason, index) => <T key={index} style={{ color: t.textSecondary }}>{reason}</T>)}
          <T variant="caption">{signal.detail}</T>
          <T variant="caption">Detected {formatDueDate(finding.detectedAt)} · Finding #{finding.id}{finding.expenseRecordId !== null ? ` · Record #${finding.expenseRecordId}` : ""}</T>
        </View>
      ) : null}
      <View style={{ gap: space.sm, flexDirection: sideBySide ? "row" : "column" }}>
        {actions.map((action, index) => (
          <View key={action.feedback} style={sideBySide ? { flex: 1 } : undefined}>
            <ExpenseActionButton title={index === 0 ? category === "duplicate" ? "Mark duplicate" : "Yes, unusual" : category === "duplicate" ? "Wrong match" : "Expected expense"} accessibilityLabel={action.label} style={sideBySide ? { flexGrow: 1 } : undefined} variant={index === 0 ? "danger" : "secondary"} onPress={() => void reviewFinding(finding.id, action)} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.lg }}>
        <Pressable onPress={() => onOtherAnswers(finding)} accessibilityRole="button" accessibilityLabel={`Other answers for ${finding.title}`} style={{ minHeight: TAP_FLOOR, justifyContent: "center" }}>
          <T style={{ color: t.brand[700] }}>Other answers</T>
        </Pressable>
        {onExplain ? <Pressable onPress={() => onExplain(finding)} accessibilityRole="button" accessibilityLabel={`Explain why FinSight flagged ${finding.title}`} style={{ minHeight: TAP_FLOOR, justifyContent: "center" }}>
          <T style={{ color: t.brand[700] }}>Explain this flag</T>
        </Pressable> : null}
      </View>
    </View>
  );
}

function UnusualComparison({ expense, integrated = false }: { expense: ExpenseBehavior["unusualExpenses"][number]; integrated?: boolean }) {
  const t = useTheme();
  const maximum = Math.max(expense.amount, expense.categoryMean);
  const multiple = expense.categoryMean > 0 ? expense.amount / expense.categoryMean : null;
  const comparisonData: ChartDatum[] = [{ key: String(expense.id), label: expense.description, values: [{ label: "This expense", value: expense.amount, color: t.statusSolid.critical }, { label: "Category average", value: expense.categoryMean, color: t.brandFill }], note: `${expense.categoryName}. ${formatDueDate(expense.date)}.${multiple === null ? " No positive category average to compare." : ` ${multiple.toFixed(1)} times the category average.`}` }];
  const comparisonSelection = useChartSelection(comparisonData);
  return (
    <View style={{ gap: space.sm, ...(integrated ? {} : { padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: t.statusBorder.warning, backgroundColor: t.statusSurface.warning }) }}>
      <T style={{ fontFamily: font.sansSemibold, color: t.textPrimary }}>{expense.description}</T>
      <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.titleLg, lineHeight: 32, fontVariant: ["tabular-nums"], color: t.textPrimary }}>{formatMoney(expense.amount, { decimals: true })}</T>
      <T variant="caption">{expense.categoryName} · {formatDueDate(expense.date)}{multiple !== null && multiple >= 1.5 ? ` · ${multiple.toFixed(1)}× the category average` : ""}</T>
      {[
        { label: "This expense", amount: expense.amount, color: t.statusSolid.critical },
        { label: "Category average", amount: expense.categoryMean, color: t.brand[600] },
      ].map((row) => (
        <View key={row.label} style={{ gap: space.xs }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}>
            <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>{row.label}</T>
            {row.label === "Category average" ? <T style={{ fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{formatMoney(row.amount, { decimals: true })}</T> : null}
          </View>
          <ChartPlotPressArea selection={comparisonSelection} count={1} chartLabel={`${expense.description} comparison`}>
          <View accessible={false} style={{ height: 8, borderRadius: radius.sm, overflow: "hidden", backgroundColor: t.surfaceMuted }}>
            <View style={{ height: 8, borderRadius: radius.sm, width: `${maximum > 0 ? Math.max(0, row.amount / maximum * 100) : 0}%`, backgroundColor: row.color }} />
          </View>
          </ChartPlotPressArea>
        </View>
      ))}
      <ChartValueReadout data={comparisonData} selection={comparisonSelection} chartLabel={`${expense.description} comparison`} />
    </View>
  );
}

export function ExpenseAlertsSection({ unusualExpenses, insufficientHistoryCategories, openFindings, findingState, findingNotice, refreshFindings, findingsRefreshing, findingsUpdatedAt, feedbackError, reviewFinding, onOtherAnswers, onExplain, visibleFindingIds, visibleUnusualIds, hasOtherReviewItems = false, findingsComplete = true, pagination }: {
  pagination?: ReactNode;
  visibleFindingIds?: number[];
  visibleUnusualIds?: number[];
  hasOtherReviewItems?: boolean;
  findingsComplete?: boolean;
  unusualExpenses: ExpenseBehavior["unusualExpenses"];
  insufficientHistoryCategories: ExpenseBehavior["insufficientHistoryCategories"];
  openFindings: number;
  findingState: { data: AnomalyFindingPage | null; loading: boolean; error: string | null };
  findingNotice: LoadNotice | null;
  refreshFindings: () => void | Promise<void>;
  findingsRefreshing: boolean;
  findingsUpdatedAt: number | null;
  feedbackError: string | null;
  reviewFinding: (id: number, action: FeedbackAction) => void | Promise<void>;
  onOtherAnswers: (finding: AnomalyFinding) => void;
  onExplain?: (finding: AnomalyFinding) => void;
}) {
  const t = useTheme();
  const items = findingState.data?.items ?? [];
  const matchedIds = new Set(items.filter((finding) => finding.expenseRecordId !== null).map((finding) => finding.expenseRecordId));
  const unmatchedExpenses = unusualExpenses.filter((expense) => !matchedIds.has(expense.id));
  const visibleFindings = visibleFindingIds ? items.filter((finding) => visibleFindingIds.includes(finding.id)) : items;
  const visibleExpenses = visibleUnusualIds ? unmatchedExpenses.filter((expense) => visibleUnusualIds.includes(expense.id)) : unmatchedExpenses;
  const clean = !hasOtherReviewItems && findingsComplete && openFindings === 0 && items.length === 0 && unusualExpenses.length === 0 && !findingState.loading && !findingState.error;
  return (
    <>
      <ConnectionNotice notice={findingNotice} onRetry={() => void refreshFindings()} busy={findingsRefreshing} />
      {findingState.data ? <FreshnessStatus at={findingsUpdatedAt} now={Date.now()} refreshing={findingsRefreshing} /> : null}
      {feedbackError ? <ErrorNote>{feedbackError}</ErrorNote> : null}
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
      {visibleFindings.length > 0 ? (
        <View style={{ gap: space.md }}>
          <View style={{ gap: space.xs }}>
            <T accessibilityRole="header" style={{ fontSize: typeScale.title, lineHeight: 26, fontFamily: font.sansSemibold, color: t.textPrimary }}>{openFindings}{findingsComplete ? "" : " loaded"} {openFindings === 1 ? "item needs" : "items need"} your review</T>
            <T style={{ color: t.textSecondary }}>Review the evidence before deciding.</T>
          </View>
          {visibleFindings.map((finding) => <FindingReview key={finding.id} finding={finding} expense={unusualExpenses.find((expense) => expense.id === finding.expenseRecordId)} reviewFinding={reviewFinding} onOtherAnswers={onOtherAnswers} onExplain={onExplain} />)}
        </View>
      ) : null}
      {visibleExpenses.length > 0 ? (
        <View style={{ gap: space.md }}>
          <T variant="heading" accessibilityRole="header">Unusual expenses</T>
          {visibleExpenses.map((expense) => <UnusualComparison key={expense.id} expense={expense} />)}
        </View>
      ) : null}
      {pagination}
      {insufficientHistoryCategories.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <T accessibilityRole="header" style={{ fontFamily: font.sansSemibold }}>More history needed</T>
          <T style={{ color: t.textSecondary }}>Unusual spending checks need more records in: {insufficientHistoryCategories.map((category) => category.categoryName).join(", ")}.</T>
        </View>
      ) : null}
    </>
  );
}
