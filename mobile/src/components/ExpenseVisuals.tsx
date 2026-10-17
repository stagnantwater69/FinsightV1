import { useState, type ReactNode } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import Svg, { Circle, Line, Polyline, Rect } from "react-native-svg";
import { T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";
import { SectionTitle as CoachSectionTitle, TealPanel } from "./CoachKit";
import { HERO } from "../theme/hero";
import { lightPalette, type Palette } from "../theme/palette";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { font, radius, space, typeScale } from "../theme/tokens";
import type { CategoryTrend, DailyExpenseTotal } from "../lib/types";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(value: string): string {
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return `${MONTH_ABBR[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}
const exact = (value: number) => formatMoney(value, { decimals: true });

function expenseColors(t: Palette) {
  return {
    hero: lightPalette.brandHeading,
    primary: t.mode === "dark" ? t.brandHeading : lightPalette.brandHeading,
    mint: lightPalette.brand[300],
    amber: t.ACCENT.fill,
    other: t.chartOther,
  };
}

export function SpendHero({ total, recordCount, categoryCount, changePercent, changeAmount, comparedWith, header }: {
  total: number; recordCount: number | null; categoryCount: number;
  changePercent: number | null; changeAmount: number; comparedWith: string | null;
  /** The card's first line: the period pill, as on Home and Recovery. */
  header?: ReactNode;
}) {
  const up = changeAmount > 0;
  const changeLabel = changeAmount === 0 ? "No change" : `${Math.abs(changePercent ?? 0).toFixed(0)}% ${up ? "higher" : "lower"}`;
  return (
    <TealPanel style={{ borderRadius: radius.xl }} watermarkIcon="wallet-outline">
      {header}
      <T accessibilityRole="header" style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: HERO.ink }}>Recorded expenses</T>
      <View style={{ gap: space.xs }}>
        <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.display, lineHeight: typeScale.display + space.sm, color: HERO.ink, fontVariant: ["tabular-nums"] }}>{formatMoney(total)}</T>
        <T variant="caption" style={{ color: HERO.muted }}>{`${recordCount === null ? "" : `${recordCount} expense${recordCount === 1 ? "" : "s"} · `}${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}`}</T>
      </View>
      {changePercent !== null ? (
        <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.xs, backgroundColor: up ? HERO.badInk : HERO.soft, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm }}>
          <Ionicons name={up ? "arrow-up" : changeAmount < 0 ? "arrow-down" : "remove"} size={18} color={HERO.to} />
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: HERO.to }}>{changeLabel}</T>
        </View>
      ) : null}
      <T style={{ fontSize: typeScale.bodySm, color: HERO.ink, fontVariant: ["tabular-nums"] }}>{changePercent === null ? `No expenses in ${comparedWith ?? "the previous period"} to compare.` : changeAmount === 0 ? "Same total as the previous period" : `${exact(Math.abs(changeAmount))} ${up ? "more" : "less"} than ${comparedWith ?? "the previous period"}`}</T>
    </TealPanel>
  );
}

export function SpendingComparison({ total, previousTotal, period, comparedWith }: {
  total: number; previousTotal: number; period: string; comparedWith: string | null;
}) {
  const t = useTheme();
  const max = Math.max(total, previousTotal, 1);
  const comparisonRows = [{ label: period, amount: total, color: t.brandFill }, { label: comparedWith ?? "Previous period", amount: previousTotal, color: t.brand[300] }];
  const comparisonData: ChartDatum[] = comparisonRows.map((row, index) => ({ key: String(index), label: row.label, values: [{ label: "Recorded expenses", value: row.amount, color: row.color }] }));
  const comparisonSelection = useChartSelection(comparisonData, `${period}:${comparedWith}`);
  return (
    <View style={{ gap: space.md }}>
      <T variant="heading" accessibilityRole="header">Spending comparison</T>
      {comparisonRows.map((row, index) => (
        <Pressable key={index} {...comparisonSelection.bind(index)} accessibilityRole="button" accessibilityLabel={`${row.label}, ${exact(row.amount)}`} accessibilityHint="Shows exact spending values" style={({ pressed }) => ({ gap: space.sm, minHeight: TAP_FLOOR, justifyContent: "center", padding: space.xs, borderWidth: 1, borderColor: comparisonSelection.selectedIndex === index ? t.brandText : "transparent", borderRadius: radius.sm, opacity: pressed ? 0.8 : 1 })}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}>
            <T style={{ fontSize: typeScale.bodySm, flexShrink: 1 }}>{row.label}</T>
            <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{exact(row.amount)}</T>
          </View>
          <View style={{ height: 10, backgroundColor: t.surfaceStrong, borderRadius: radius.sm }}>
            <View style={{ width: `${Math.max(0, Math.min(100, row.amount / max * 100))}%`, height: 10, backgroundColor: row.color, borderRadius: radius.sm }} />
          </View>
        </Pressable>
      ))}
      <ChartValueReadout data={comparisonData} selection={comparisonSelection} chartLabel="Spending comparison" />
    </View>
  );
}

export function DailySpending({ days }: { days: DailyExpenseTotal[] }) {
  const t = useTheme();
  const expense = expenseColors(t);
  const [showAmounts, setShowAmounts] = useState(false);
  const [mode, setMode] = useState<"daily" | "running">("daily");
  const peakIndex = days.reduce((best, day, i) => day.total > (days[best]?.total ?? 0) ? i : best, 0);
  const peak = days[peakIndex];
  let running = 0;
  const values = days.map((day) => { running += day.total; return mode === "running" ? running : day.total; });
  let accumulated = 0;
  const dayData: ChartDatum[] = days.map((day) => { accumulated += day.total; return { key: day.date, label: shortDate(day.date), values: [{ label: "Daily spending", value: day.total }, { label: "Running total", value: accumulated }] }; });
  const daySelection = useChartSelection(dayData, undefined, peakIndex);
  const activeIndex = daySelection.selectedIndex ?? peakIndex;
  const selected = days[activeIndex];
  const max = Math.max(1, ...values);
  const average = days.length ? running / days.length : 0;
  const W = 280, H = 110, slot = W / Math.max(days.length, 1);
  const axisAmount = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(Math.round(value));
  const buttonStyle = { minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, alignItems: "center" as const, justifyContent: "center" as const };
  return (
    <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
      {!peak || peak.total <= 0 ? <View style={{ gap: space.sm }}><CoachSectionTitle eyebrow="Daily spending" question="When did I spend?" icon="bar-chart-outline" /><T variant="caption">No daily spending in this period.</T></View> : <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
          <CoachSectionTitle eyebrow="Daily spending" question="When did I spend?" icon="bar-chart-outline" />
          <View style={{ flexDirection: "row", gap: space.xs }}>
          {[{ value: "daily" as const, label: "Daily" }, { value: "running" as const, label: "Running" }].map((option) => (
            <Pressable key={option.value} accessibilityRole="button" accessibilityLabel={option.value === "running" ? "Running total" : "Daily"} accessibilityState={{ selected: mode === option.value }} onPress={() => setMode(option.value)} style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingHorizontal: space.sm, justifyContent: "center", backgroundColor: mode === option.value ? t.brandSurface : t.surfaceMuted, borderRadius: radius.sm, opacity: pressed ? 0.7 : 1 })}>
              <T style={{ fontSize: typeScale.bodySm, fontFamily: mode === option.value ? font.sansSemibold : font.sans, color: mode === option.value ? t.brandText : t.textSecondary }}>{option.label}</T>
            </Pressable>
          ))}
          </View>
        </View>
        {showAmounts ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, justifyContent: "space-between" }}>
          <View style={{ gap: space.xs }}><T variant="caption">Daily average</T><T style={{ fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{exact(average)}</T></View>
          <View style={{ gap: space.xs }}><T variant="caption">{`Highest day · ${shortDate(peak.date)}`}</T><T style={{ fontFamily: font.sansSemibold, fontVariant: ["tabular-nums"] }}>{exact(peak.total)}</T></View>
        </View> : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View accessible={false} style={{ width: 40, height: H, justifyContent: "space-between" }}><T variant="caption">{axisAmount(max)}</T><T variant="caption">{axisAmount(max / 2)}</T><T variant="caption">0</T></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <ChartPlotPressArea selection={daySelection} count={days.length} accessiblePlot chartLabel={`${mode === "daily" ? "Daily spending" : "Running spending total"} chart in PHP across ${days.length} days. Highest: ${exact(peak.total)} on ${shortDate(peak.date)}. Tap a day or use previous and next day controls to read exact values.`} mode="bands" style={{ height: H }}>
              <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                {[0, 0.5, 1].map((level) => <Line key={level} x1={0} x2={W} y1={H * level} y2={H * level} stroke={t.border} strokeWidth={1} />)}
                {mode === "daily" ? <Line x1={0} x2={W} y1={H - average / max * (H - 8)} y2={H - average / max * (H - 8)} stroke={t.textSecondary} strokeDasharray="4 4" /> : null}
                {mode === "daily" ? values.map((value, i) => <Rect key={days[i]!.date} x={i * slot + slot * 0.18} y={H - value / max * (H - 8)} width={slot * 0.64} height={value / max * (H - 8)} rx={2} fill={i === activeIndex ? expense.primary : expense.mint} stroke={expense.primary} strokeWidth={0.7} opacity={1} />) : <Polyline points={values.map((value, i) => `${(i + 0.5) * slot},${H - value / max * (H - 8)}`).join(" ")} stroke={t.brandHeading} strokeWidth={3} fill="none" />}
                <Line x1={(activeIndex + 0.5) * slot} x2={(activeIndex + 0.5) * slot} y1={0} y2={H} stroke={t.brandText} strokeDasharray="2 3" />
              </Svg>
            </ChartPlotPressArea>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: space.sm }}><T variant="caption">{shortDate(days[0]!.date)}</T><T variant="caption">{shortDate(days[days.length - 1]!.date)}</T></View>
          </View>
        </View>
        <T variant="caption">{mode === "daily" ? "PHP · Dashed line: daily average · Tap a day" : "PHP · Total accumulated by each day · Tap a day"}</T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: t.brandSurface, borderRadius: radius.md, paddingHorizontal: space.xs, paddingVertical: space.sm }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous day" accessibilityState={{ disabled: activeIndex === 0 }} disabled={activeIndex === 0} onPress={() => daySelection.select(activeIndex - 1)} style={({ pressed }) => ({ ...buttonStyle, opacity: activeIndex === 0 ? 0.4 : pressed ? 0.6 : 1 })}><Ionicons name="chevron-back" size={20} color={t.brandText} /></Pressable>
          <View accessibilityLiveRegion="polite" style={{ flex: 1, gap: space.xs }}><T style={{ fontSize: typeScale.bodySm, color: t.brandText }}>{`${selected ? shortDate(selected.date) : ""} · ${mode === "daily" ? "Daily spending" : "Running total"}`}</T><T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: t.brandHeading, fontVariant: ["tabular-nums"] }}>{exact(values[activeIndex] ?? 0)}</T></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Next day" accessibilityState={{ disabled: activeIndex === days.length - 1 }} disabled={activeIndex === days.length - 1} onPress={() => daySelection.select(activeIndex + 1)} style={({ pressed }) => ({ ...buttonStyle, opacity: activeIndex === days.length - 1 ? 0.4 : pressed ? 0.6 : 1 })}><Ionicons name="chevron-forward" size={20} color={t.brandText} /></Pressable>
        </View>
        <T variant="caption">{`Spent on ${days.filter((day) => day.total > 0).length} of ${days.length} days · average ${formatMoney(average)} a day · highest ${shortDate(peak.date)} ${formatMoney(peak.total)}`}</T>
        <Pressable accessibilityRole="button" accessibilityLabel={showAmounts ? (mode === "daily" ? "Hide daily amounts" : "Hide running totals") : (mode === "daily" ? "View daily amounts" : "View running totals")} accessibilityState={{ expanded: showAmounts }} onPress={() => setShowAmounts(!showAmounts)} style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", opacity: pressed ? 0.7 : 1 })}><T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.brandText }}>{showAmounts ? (mode === "daily" ? "Hide daily amounts" : "Hide running totals") : (mode === "daily" ? "View daily amounts" : "View running totals")}</T><Ionicons name={showAmounts ? "chevron-up" : "chevron-down"} size={18} color={t.brandText} /></Pressable>
        {showAmounts ? days.map((day, i) => <View key={day.date} style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: t.border }}><T variant="caption">{shortDate(day.date)}</T><T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansMedium, fontVariant: ["tabular-nums"] }}>{exact(mode === "daily" ? day.total : values[i]!)}</T></View>) : null}
      </>}
    </View>
  );
}

const PREVIEW = 3;
export function CategoryBars({ trends, total, previousTotal, comparedWith, onOpen }: {
  trends: CategoryTrend[]; total: number; previousTotal: number; comparedWith: string | null; onOpen: (categoryId: number) => void;
}) {
  const t = useTheme();
  const expense = expenseColors(t);
  const categoryColors = [expense.primary, expense.mint, expense.amber];
  const [showAll, setShowAll] = useState(false);
  const ranked = [...trends].filter((c) => c.current > 0 || c.previous > 0).sort((a, b) => b.current - a.current);
  const rows = showAll ? ranked : [];
  const positive = ranked.filter((c) => c.current > 0);
  const slices = positive.slice(0, PREVIEW).map((c, i) => ({ name: c.categoryName, amount: c.current, categoryId: c.categoryId, color: categoryColors[i]! }));
  const other = positive.slice(PREVIEW).reduce((sum, c) => sum + c.current, 0);
  if (other > 0) slices.push({ name: "Other", amount: other, categoryId: -1, color: expense.other });
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 360 && fontScale > 1.15;
  const comparisonMax = Math.max(1, ...ranked.flatMap((c) => [c.current, c.previous]));
  const categoryData: ChartDatum[] = slices.map((slice) => {
    const trend = ranked.find((row) => row.categoryId === slice.categoryId);
    return { key: String(slice.categoryId), label: slice.name, values: [{ label: "Current spending", value: slice.amount, color: slice.color }, { label: "Share of spending", value: total > 0 ? slice.amount / total * 100 : 0, display: `${total > 0 ? (slice.amount / total * 100).toFixed(1) : "0.0"}%` }, ...(trend ? [{ label: comparedWith ?? "Previous period", value: trend.previous }, { label: "Change", value: trend.change ?? trend.current - trend.previous, display: formatMoney(trend.change ?? trend.current - trend.previous, { decimals: true, signed: true }) }] : [])], note: slice.categoryId === -1 ? `${Math.max(0, positive.length - PREVIEW)} categories combined` : trend?.recordCount !== undefined ? `${trend.recordCount} expense${trend.recordCount === 1 ? "" : "s"}` : undefined };
  });
  const categorySelection = useChartSelection(categoryData, comparedWith);
  const rankedData: ChartDatum[] = ranked.map((row) => ({ key: String(row.categoryId), label: row.categoryName, values: [{ label: "Current period", value: row.current, color: t.brandFill }, { label: comparedWith ?? "Previous period", value: row.previous, color: t.textSecondary }, { label: "Change", value: row.change ?? row.current - row.previous, display: formatMoney(row.change ?? row.current - row.previous, { decimals: true, signed: true }) }], note: row.percentChange === null ? row.current > 0 && row.previous === 0 ? "New this period" : "Percentage change unavailable" : `${Math.abs(row.percentChange).toFixed(1)}% ${row.percentChange > 0 ? "higher" : row.percentChange < 0 ? "lower" : "change"}` }));
  const rankedSelection = useChartSelection(rankedData, comparedWith);
  const circumference = 2 * Math.PI * 44;
  let offset = 0;
  return (
    <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
      <CoachSectionTitle
        eyebrow="Categories"
        question="Where does the money go?"
        icon="pie-chart-outline"
        right={<T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoSemibold, color: t.textPrimary, fontVariant: ["tabular-nums"] }}>{formatMoney(total)}</T>}
      />
      {ranked.length === 0 ? <T variant="caption">No expense records in this period yet.</T> : <>
        <View style={{ flexDirection: stacked ? "column" : "row", alignItems: "center", gap: space.md }}>
          <ChartPlotPressArea selection={categorySelection} count={slices.length} chartLabel="Category distribution" style={{ width: 112, height: 112 }} indexAtPoint={({ x, y, width: plotWidth, height: plotHeight }) => {
            const dx = x - plotWidth / 2, dy = y - plotHeight / 2;
            const distance = Math.hypot(dx, dy);
            if (distance < Math.min(plotWidth, plotHeight) * 0.29 || distance > Math.min(plotWidth, plotHeight) * 0.5) return null;
            const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
            const amount = angle / (Math.PI * 2) * total;
            let cumulative = 0;
            const hit = slices.findIndex((slice) => { cumulative += slice.amount; return amount <= cumulative; });
            return hit < 0 ? null : hit;
          }}>
          <View accessible accessibilityRole="image" accessibilityLabel={`Category distribution. ${slices.map((slice) => `${slice.name}, ${exact(slice.amount)}, ${total > 0 ? (slice.amount / total * 100).toFixed(1) : 0} percent`).join(". ")}`} style={{ width: 112, height: 112 }}>
            <Svg width={112} height={112} viewBox="0 0 112 112">
              <Circle cx={56} cy={56} r={44} stroke={t.surfaceStrong} strokeWidth={20} fill="none" />
              {slices.map((slice, index) => {
                const length = total > 0 ? Math.max(0, Math.min(1, slice.amount / total)) * circumference : 0;
                const start = offset;
                offset += length;
                return <Circle key={slice.categoryId} cx={56} cy={56} r={44} stroke={slice.color} strokeWidth={categorySelection.selectedIndex === index ? 23 : 20} strokeDasharray={`${length} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 56 56)" fill="none" />;
              })}
            </Svg>
            <View accessible={false} style={{ position: "absolute", top: 32, left: 19, right: 19, alignItems: "center", gap: space.xs }}>
              <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.title, color: t.textPrimary }}>{`${positive[0] && total > 0 ? (positive[0].current / total * 100).toFixed(0) : 0}%`}</T>
              <T variant="caption">Largest</T>
            </View>
          </View>
          </ChartPlotPressArea>
          <View style={{ flex: stacked ? undefined : 1, alignSelf: "stretch", justifyContent: "center", minWidth: 0 }}>
            {slices.map((slice, index) => <Pressable key={slice.categoryId} {...categorySelection.bind(index)} accessibilityRole="button" accessibilityLabel={`${slice.name}, ${exact(slice.amount)}, ${total > 0 ? (slice.amount / total * 100).toFixed(1) : 0} percent of spending. ${slice.categoryId === -1 ? "View all category comparisons" : "View these records"}.`} onPress={() => slice.categoryId === -1 ? setShowAll(true) : onOpen(slice.categoryId)} style={({ pressed }) => ({ minHeight: TAP_FLOOR, justifyContent: "center", paddingVertical: space.xs, opacity: pressed ? 0.7 : 1 })}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: slice.color }} /><T style={{ flex: 1, fontSize: typeScale.bodySm, color: t.textSecondary }}>{slice.name}</T></View>
              <T style={{ marginLeft: 17, fontSize: typeScale.caption, color: t.textSecondary, fontVariant: ["tabular-nums"] }}>{`${exact(slice.amount)} · ${total > 0 ? (slice.amount / total * 100).toFixed(1) : "0.0"}%`}</T>
            </Pressable>)}
          </View>
        </View>
        <ChartValueReadout data={categoryData} selection={categorySelection} chartLabel="Category distribution" />
        {ranked.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel={showAll ? "Show fewer" : `All ${ranked.length} categor${ranked.length === 1 ? "y" : "ies"}`} accessibilityState={{ expanded: showAll }} aria-expanded={showAll} onPress={() => setShowAll(!showAll)} style={({ pressed }) => ({ minHeight: TAP_FLOOR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", opacity: pressed ? 0.7 : 1 })}><T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.brandText }}>{showAll ? "Show fewer" : `All ${ranked.length} categor${ranked.length === 1 ? "y" : "ies"}`}</T><Ionicons name={showAll ? "chevron-up" : "chevron-down"} size={18} color={t.brandText} /></Pressable> : null}
        {showAll ? <>
          <T variant="caption">{`Current spending by category · comparison with ${comparedWith ?? "the previous period"}`}</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}><T variant="caption" style={{ color: t.brandText }}>Current period</T><T variant="caption">Previous period (gray bar)</T></View>
        </> : null}
        {rows.map((c, i) => {
          const share = total > 0 ? c.current / total * 100 : 0;
          const change = c.change ?? c.current - c.previous;
          const pct = c.percentChange;
          const changeText = pct === null ? "New this period" : change === 0 ? "No change" : `${exact(Math.abs(change))} ${change > 0 ? "more" : "less"} (${Math.abs(pct).toFixed(0)}%)`;
          return <Pressable key={c.categoryId} {...rankedSelection.bind(i)} accessibilityRole="button" accessibilityLabel={`${c.categoryName}, ${exact(c.current)}, ${share.toFixed(1)} percent of spending${c.recordCount === undefined ? "" : `, ${c.recordCount} expenses`}. Previous ${exact(c.previous)} in ${comparedWith ?? "the previous period"}. ${changeText}. View these records.`} onPress={() => onOpen(c.categoryId)} style={({ pressed }) => ({ minHeight: TAP_FLOOR, gap: space.sm, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: t.border, opacity: pressed ? 0.7 : 1 })}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: i < PREVIEW ? categoryColors[i] : expense.other }} /><T style={{ flex: 1, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>{c.categoryName}</T><Ionicons name="chevron-forward" size={18} color={t.textSecondary} /></View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.xs }}><T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, fontVariant: ["tabular-nums"] }}>{exact(c.current)}</T><T variant="caption">{`${share.toFixed(1)}%${c.recordCount === undefined ? "" : ` · ${c.recordCount} expense${c.recordCount === 1 ? "" : "s"}`}`}</T></View>
            <ChartPlotPressArea selection={rankedSelection} count={rankedData.length} chartLabel={`${c.categoryName} comparison`} indexAtPoint={() => i}><View accessible={false} style={{ gap: space.xs }}><View style={{ height: 6, backgroundColor: t.surfaceStrong, borderRadius: 2 }}><View style={{ height: 6, width: `${c.current / comparisonMax * 100}%`, backgroundColor: t.brandFill, borderRadius: 2 }} /></View><View style={{ height: 6, backgroundColor: t.surfaceStrong, borderRadius: 2 }}><View style={{ height: 6, width: `${c.previous / comparisonMax * 100}%`, backgroundColor: t.textSecondary, borderRadius: 2 }} /></View></View></ChartPlotPressArea>
            <T variant="caption">{`Previous: ${exact(c.previous)} · ${comparedWith ?? "previous period"}`}</T>
            <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansMedium, color: change === 0 || pct === null ? t.textSecondary : change > 0 ? t.statusText.serious : t.statusText.good }}>{previousTotal === 0 && c.previous === 0 ? "No earlier expenses to compare" : changeText}</T>
          </Pressable>;
        })}
        {showAll ? <ChartValueReadout data={rankedData} selection={rankedSelection} chartLabel="Category comparison" /> : null}
        {showAll ? (() => {
          const change = total - previousTotal;
          const pct = previousTotal > 0 ? (change / previousTotal) * 100 : null;
          const count = ranked.every((c) => c.recordCount !== undefined) ? ranked.reduce((sum, c) => sum + (c.recordCount ?? 0), 0) : null;
          return <View accessible accessibilityLabel={`Total ${exact(total)}${count === null ? "" : `, ${count} expenses`}. Previous ${exact(previousTotal)}.${pct === null ? "" : ` ${exact(Math.abs(change))} ${change > 0 ? "more" : "less"} (${Math.abs(pct).toFixed(0)}%).`}`} style={{ paddingVertical: space.md, gap: space.xs }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}><T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg, color: t.textPrimary }}>Total</T><T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodyLg, color: t.textPrimary }}>{exact(total)}</T></View>
            <T variant="caption">{`Previous ${exact(previousTotal)}${count === null ? "" : ` · ${count} expense${count === 1 ? "" : "s"}`}`}</T>
            {pct !== null ? <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansMedium, color: change === 0 ? t.textSecondary : change > 0 ? t.statusText.serious : t.statusText.good }}>{change === 0 ? "No change" : `${exact(Math.abs(change))} ${change > 0 ? "more" : "less"} (${Math.abs(pct).toFixed(0)}%)`}</T> : null}
          </View>;
        })() : null}
      </>}
    </View>
  );
}
