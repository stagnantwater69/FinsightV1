import { useState, type ReactNode } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import { TealPanel } from "./CoachKit";
import { TAP_FLOOR } from "./touchTarget";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum, type ChartSelection } from "./ChartInteraction";
import { KpiWatermark } from "./KpiWatermark";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { deltaPillText, deltaTone, type SummaryDelta } from "../lib/dashboardFigures";
import { HERO } from "../theme/hero";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { RecoveryTargets } from "../lib/types";

/*
 * Home's own pieces in the redesigned style. Every figure is one the summary
 * endpoint already returns; bar lengths are those figures against each other.
 */

function PanelDelta({ delta }: { delta: SummaryDelta | null }) {
  if (!delta) return null;
  const tone = deltaTone(delta);
  const ink = tone === "good" ? HERO.goodInk : tone === "bad" ? HERO.badInk : HERO.muted;
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.full, backgroundColor: HERO.wash }}>
      <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink }}>{deltaPillText(delta)}</T>
    </View>
  );
}

function FlowRow({ label, value, max, color, delta, interaction }: { label: string; value: number; max: number; color: string; delta: SummaryDelta | null; interaction: ReturnType<ChartSelection["bind"]> }) {
  const width = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <Pressable
      {...interaction}
      accessibilityRole="button"
      accessibilityLabel={`${label} values, ${formatMoney(value, { decimals: true })}${delta ? `, ${deltaPillText(delta).replace("▲", "up").replace("▼", "down")}` : ""}`}
      style={({ pressed }) => ({ gap: 4, minHeight: TAP_FLOOR, justifyContent: "center", padding: space.xs, borderWidth: 1, borderColor: interaction.accessibilityState.selected ? HERO.ink : "transparent", borderRadius: radius.sm, opacity: pressed ? 0.8 : 1 })}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <T style={{ fontSize: typeScale.caption, color: HERO.soft, flex: 1 }}>{label}</T>
        <PanelDelta delta={delta} />
        <T style={{ maxWidth: "100%", fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, color: HERO.ink }}>{formatMoney(value)}</T>
      </View>
      <View style={{ height: 14, borderRadius: 6, backgroundColor: HERO.wash, overflow: "hidden" }}>
        <View style={{ width: `${width}%`, height: "100%", borderRadius: 6, backgroundColor: color }} />
      </View>
    </Pressable>
  );
}

/**
 * Money in against money out for the selected period as two bars, the net,
 * then what the business has available. How the balance is worked out stays
 * one tap away.
 */
export function MoneyFlowPanel({
  sales,
  expenses,
  funds,
  periodPhrase,
  provenance,
  salesDelta,
  expensesDelta,
  netDelta,
  against,
  periodControl,
}: {
  sales: number;
  expenses: number;
  funds: number;
  periodPhrase: string;
  provenance: string | null;
  salesDelta: SummaryDelta | null;
  expensesDelta: SummaryDelta | null;
  netDelta: SummaryDelta | null;
  /** The earlier window the changes are measured against, or null. */
  against: string | null;
  /** The period picker, drawn as the panel's own label so the period is named once. */
  periodControl?: ReactNode;
}) {
  const [showHow, setShowHow] = useState(false);
  const net = sales - expenses;
  const max = Math.max(sales, expenses, 1);
  const flowData: ChartDatum[] = [
    { key: "in", label: "Money in", values: [{ label: "Recorded sales", value: sales, color: HERO.inFill }], note: salesDelta ? `${formatMoney(salesDelta.amount, { decimals: true, signed: true })} vs ${salesDelta.against}` : periodPhrase },
    { key: "out", label: "Money out", values: [{ label: "Recorded expenses", value: expenses, color: HERO.outFill }], note: expensesDelta ? `${formatMoney(expensesDelta.amount, { decimals: true, signed: true })} vs ${expensesDelta.against}` : periodPhrase },
  ];
  const flowSelection = useChartSelection(flowData, `${periodPhrase}:${against}`);
  return (
    <TealPanel watermarkIcon="wallet-outline">
      {periodControl}
      <View style={{ gap: space.sm }}>
        <FlowRow label="Money in" value={sales} max={max} color={HERO.inFill} delta={salesDelta} interaction={flowSelection.bind(0)} />
        <FlowRow label="Money out" value={expenses} max={max} color={HERO.outFill} delta={expensesDelta} interaction={flowSelection.bind(1)} />
      </View>
      <ChartValueReadout data={flowData} selection={flowSelection} chartLabel="Money flow" />
      <View
        accessible
        accessibilityLabel={`Net ${periodPhrase} ${net < 0 ? "minus " : ""}${formatMoney(Math.abs(net))}`}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center", justifyContent: "space-between", paddingTop: space.md, borderTopWidth: 1, borderTopColor: HERO.hairline }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <T style={{ fontSize: typeScale.caption, color: HERO.muted }}>{periodControl ? "Net" : `Net ${periodPhrase}`}</T>
          <PanelDelta delta={netDelta} />
        </View>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.title, color: net < 0 ? HERO.badInk : HERO.goodInk }}>
          {`${net < 0 ? "−" : "+"}${formatMoney(Math.abs(net))}`}
        </T>
      </View>
      {against ? <T style={{ fontSize: typeScale.micro, color: HERO.muted }}>{`Changes vs ${against}`}</T> : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: HERO.wash }}>
        <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: HERO.amberWash, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="wallet-outline" size={19} color={HERO.amber} />
        </View>
        <View style={{ flex: 1 }}>
          <T style={{ fontSize: typeScale.caption, color: HERO.muted }}>Available funds</T>
          <T
            accessibilityRole="header"
            style={{ fontFamily: font.monoSemibold, fontSize: typeScale.titleLg, color: HERO.ink, fontVariant: ["tabular-nums"] }}
          >
            {formatMoney(funds)}
          </T>
        </View>
        {provenance ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showHow ? "Hide how available funds are worked out" : "How available funds are worked out"}
            accessibilityState={{ expanded: showHow }}
            onPress={() => setShowHow((v) => !v)}
            hitSlop={8}
            style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, alignItems: "flex-end", justifyContent: "center" }}
          >
            <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: HERO.amber }}>{showHow ? "Hide" : "How?"}</T>
          </Pressable>
        ) : null}
      </View>
      {showHow && provenance ? (
        <T style={{ fontSize: typeScale.caption, lineHeight: 18, color: HERO.soft }}>{provenance}</T>
      ) : null}
    </TealPanel>
  );
}

/**
 * Today's sales goal from the month's recovery target, with the month's
 * coverage under it. The same numbers as the Recovery screen's top, in brief.
 */
export function TodayGoalSummary({
  recovery,
  statusLabel,
  tone,
  basisNote,
  onOpenRecovery,
  action,
}: {
  recovery: RecoveryTargets;
  statusLabel: string;
  tone: "good" | "warning" | "critical";
  basisNote: string | null;
  onOpenRecovery: () => void;
  action: ReactNode;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 390 || fontScale > 1.2;
  const [showBasis, setShowBasis] = useState(false);
  const todayPct =
    recovery.todaysTarget > 0 ? (recovery.todaysSales / recovery.todaysTarget) * 100 : recovery.todaysSales > 0 ? 100 : 0;
  const coverage = Math.max(0, Math.min(100, recovery.monthCoveragePercent));
  const goalData: ChartDatum[] = [
    { key: "today", label: "Today's sales goal", values: [{ label: "Sales recorded", value: recovery.todaysSales }, { label: "Today's target", value: recovery.todaysTarget }, { label: "Coverage", value: todayPct, display: `${todayPct.toFixed(1)}%` }, { label: "Gap", value: recovery.todaysGap, display: formatMoney(recovery.todaysGap, { decimals: true, signed: true }) }], note: statusLabel },
    { key: "month", label: "Monthly expenses covered by sales", values: [{ label: "Sales this month", value: recovery.salesThisMonth }, { label: "Expense basis", value: recovery.expectedMonthlyExpenses }, { label: "Coverage", value: recovery.monthCoveragePercent, display: `${recovery.monthCoveragePercent.toFixed(1)}%` }], note: basisNote ?? "Based on recorded sales" },
  ];
  const goalSelection = useChartSelection(goalData, recovery.asOfDate);
  return (
    <View style={{ borderRadius: 24, borderWidth: 1, borderColor: t.accent[100], backgroundColor: t.ACCENT.surface, padding: space.lg }}>
      <KpiWatermark name="calendar-outline" borderRadius={24} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <T accessibilityRole="header" style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.ACCENT.text }}>
          Today's sales goal
        </T>
        <Pressable accessibilityRole="link" accessibilityLabel="Open Recovery" onPress={onOpenRecovery} hitSlop={8} style={{ minHeight: TAP_FLOOR, justifyContent: "center" }}>
          <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>Recovery ›</T>
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.titleLg, color: t.textPrimary }}>{formatMoney(recovery.todaysTarget)}</T>
        <View style={{ paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.full, backgroundColor: t.statusSurface[tone] }}>
          <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: t.statusText[tone] }}>{statusLabel}</T>
        </View>
      </View>
      <ChartPlotPressArea selection={goalSelection} count={goalData.length} chartLabel="Today's sales goal" indexAtPoint={() => 0}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Today's sales goal"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.min(100, todayPct)) }}
        style={{ height: 14, borderRadius: 7, backgroundColor: t.surfaceStrong, overflow: "hidden", marginTop: space.md }}
      >
        <View style={{ width: `${Math.max(0, Math.min(100, todayPct))}%`, height: "100%", borderRadius: 7, backgroundColor: t.ACCENT.fill }} />
      </View>
      </ChartPlotPressArea>
      <View style={{ flexDirection: stacked ? "column" : "row", gap: space.xs, justifyContent: "space-between", marginTop: 6 }}>
        <T variant="caption" style={{ color: t.textSecondary }}>{`${formatMoney(recovery.todaysSales)} sold today`}</T>
        <T variant="caption" style={{ color: t.textSecondary }}>{`${recovery.remainingOperatingDays} days left`}</T>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginTop: space.md }}>
        <ChartPlotPressArea selection={goalSelection} count={goalData.length} chartLabel="Monthly expenses covered by sales" indexAtPoint={() => 1} style={{ flex: 1 }}>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Monthly expenses covered by sales"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(coverage) }}
          style={{ height: 6, borderRadius: 3, backgroundColor: t.surfaceStrong, overflow: "hidden" }}
        >
          <View style={{ width: `${coverage}%`, height: "100%", backgroundColor: t.status[tone] }} />
        </View>
        </ChartPlotPressArea>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.caption, color: t.textPrimary }}>{`${Math.round(coverage)}%`}</T>
        <T variant="caption">of the month</T>
        {basisNote ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showBasis ? "Hide how the monthly target is worked out" : "How the monthly target is worked out"}
            accessibilityState={{ expanded: showBasis }}
            onPress={() => setShowBasis((v) => !v)}
            hitSlop={12}
            style={{ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name={showBasis ? "close-circle-outline" : "information-circle-outline"} size={18} color={t.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <ChartValueReadout data={goalData} selection={goalSelection} chartLabel="Sales goals" />
      {showBasis && basisNote ? <T variant="caption" style={{ marginTop: space.sm, lineHeight: 18 }}>{basisNote}</T> : null}
      <View style={{ marginTop: space.md }}>{action}</View>
    </View>
  );
}

/** How many categories get their own colour before the rest become "Other". */
const SPLIT_SHOWN = 3;

/**
 * "Where it went": the period's spending as one bar split by category, with
 * the way to the trend charts beside it.
 *
 * This replaced "More charts" — a donut that flipped to a list, a cashflow
 * line and a category comparison, all closed by default and so unseen by most
 * owners. One bar answers the question Home is for (where is my money going
 * right now?) without asking anyone to read a chart, and the detail is one
 * tap away: the category trends on Expense insights, money in and out on its
 * own screen.
 */
export function SpendingSplitCard({
  rows,
  onTrends,
  onMoneyFlow,
}: {
  rows: readonly { categoryId: number; categoryName: string; total: number }[];
  onTrends: () => void;
  onMoneyFlow: () => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 390 || fontScale > 1.2;
  const ranked = [...rows].filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const total = ranked.reduce((sum, r) => sum + r.total, 0);
  const parts = ranked.slice(0, SPLIT_SHOWN).map((r, i) => ({ key: String(r.categoryId), name: r.categoryName, amount: r.total, color: t.categorical[i] ?? t.chartOther }));
  const other = ranked.slice(SPLIT_SHOWN).reduce((sum, r) => sum + r.total, 0);
  if (other > 0) parts.push({ key: "other", name: "Other", amount: other, color: t.chartOther });
  const pct = (amount: number) => (total > 0 ? Math.round((amount / total) * 100) : 0);
  const splitData: ChartDatum[] = parts.map((part) => ({ key: part.key, label: part.name, values: [{ label: "Spending", value: part.amount, color: part.color }, { label: "Share of spending", value: total > 0 ? part.amount / total * 100 : 0, display: `${total > 0 ? (part.amount / total * 100).toFixed(1) : "0.0"}%` }], note: part.key === "other" ? `${Math.max(0, ranked.length - SPLIT_SHOWN)} categories combined` : undefined }));
  const splitSelection = useChartSelection(splitData);

  const link = (label: string, shown: string, icon: keyof typeof Ionicons.glyphMap, onPress: () => void) => (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: TAP_FLOOR + 4,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: space.sm,
        borderRadius: radius.lg,
        backgroundColor: pressed ? t.brandBorder : t.brandSurface,
      })}
    >
      <Ionicons name={icon} size={16} color={t.brandText} />
      <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText, flexShrink: 1, textAlign: "center" }}>{`${shown} ›`}</T>
    </Pressable>
  );

  return (
    <View style={{ gap: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm }}>
        <T variant="heading" accessibilityRole="header">Where it went</T>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.label, color: t.textPrimary }}>{formatMoney(total)}</T>
      </View>
      {total > 0 ? (
        <>
          <ChartPlotPressArea selection={splitSelection} count={parts.length} chartLabel="Spending split" indexAtPoint={({ x, width: plotWidth }) => {
            if (plotWidth <= 0) return null;
            const drawableWidth = Math.max(0, plotWidth - Math.max(0, parts.length - 1) * 2);
            const position = Math.max(0, Math.min(plotWidth, x));
            let cumulative = 0;
            return parts.findIndex((part, index) => { cumulative += part.amount / total * drawableWidth; const hit = position <= cumulative + 1 || index === parts.length - 1; cumulative += 2; return hit; });
          }}>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Spending split. ${parts.map((p) => `${p.name} ${pct(p.amount)} percent, ${formatMoney(p.amount)}`).join(". ")}`}
            style={{ flexDirection: "row", height: 22, gap: 2, borderRadius: 11, overflow: "hidden" }}
          >
            {parts.map((p, index) => (
              <View key={p.key} style={{ flex: p.amount, backgroundColor: p.color, borderTopWidth: splitSelection.selectedIndex === index ? 2 : 0, borderBottomWidth: splitSelection.selectedIndex === index ? 2 : 0, borderColor: t.textPrimary }} />
            ))}
          </View>
          </ChartPlotPressArea>
          <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs }}>
            {parts.map((p, index) => (
              <Pressable key={p.key} {...splitSelection.bind(index)} accessibilityRole="button" accessibilityLabel={`${p.name} spending values`} style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }}>
                <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: p.color }} />
                <T style={{ fontSize: typeScale.caption, color: t.textSecondary, flexShrink: 1, textDecorationLine: splitSelection.selectedIndex === index ? "underline" : "none" }}>{`${p.name} ${pct(p.amount)}%`}</T>
              </Pressable>
            ))}
          </View>
          <ChartValueReadout data={splitData} selection={splitSelection} chartLabel="Spending split" />
        </>
      ) : (
        <T variant="caption">No spending recorded in this period.</T>
      )}
      <View style={{ flexDirection: stacked ? "column" : "row", gap: space.sm }}>
        {link("Spending trends", "Spending trends", "bar-chart-outline", onTrends)}
        {/* Shortened on screen so it fits half a phone's width; read out in full. */}
        {link("Money in and out", "Money in & out", "trending-up-outline", onMoneyFlow)}
      </View>
    </View>
  );
}
