import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import Ionicons from "@expo/vector-icons/Ionicons";
import { T } from "./ui";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import type {
  ExpenseSummaryFigures,
  SummaryPoint,
  SummaryQuestion,
  SummarySegment,
} from "../lib/expenseSummary";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "./touchTarget";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";
import { KpiWatermark, type KpiWatermarkIcon } from "./KpiWatermark";

/** Above this share of recorded funds, spending is drawn as a warning. */
export const FUNDS_SHARE_WARNING = 75;

/** A ring with a figure in the middle: how much of the recorded funds this spending is. */
function FundsRing({ percent, warn }: { percent: number; warn: boolean }) {
  const t = useTheme();
  const size = 56;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, percent));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Spending as a share of recorded available funds"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown) }}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.surfaceStrong} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={warn ? t.status.critical : t.brandFill}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(shown / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.label, color: warn ? t.statusText.critical : t.textPrimary }}>
        {`${percent.toFixed(0)}%`}
      </T>
    </View>
  );
}

function GlanceTile({
  children,
  caption,
  onPress,
  accessibilityLabel,
  tone = "plain",
  watermarkIcon,
}: {
  children: ReactNode;
  caption: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  tone?: "plain" | "attention";
  watermarkIcon?: KpiWatermarkIcon;
}) {
  const t = useTheme();
  const style = {
    flex: 1,
    minHeight: 112,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tone === "attention" ? t.statusBorder.serious : t.border,
    backgroundColor: tone === "attention" ? t.statusSurface.serious : t.surface,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: space.sm,
    padding: space.sm,
  };
  const body = (
    <>
      {watermarkIcon ? <KpiWatermark name={watermarkIcon} size={80} /> : null}
      {children}
      <T style={{ fontSize: typeScale.caption, fontFamily: font.sansMedium, color: t.textSecondary, textAlign: "center" }}>{caption}</T>
    </>
  );
  if (!onPress) {
    return (
      <View style={style} accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? caption}
      onPress={onPress}
      style={({ pressed }) => ({ ...style, opacity: pressed ? 0.75 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/**
 * Spending against recorded funds and the largest category's share.
 * Each tile's spoken label includes its exact figures.
 */
export function ExpenseGlance({
  summary,
  availableFunds,
  fundsLoading,
}: {
  summary: ExpenseSummaryFigures;
  availableFunds: number | null;
  fundsLoading: boolean;
}) {
  const t = useTheme();
  const fundsWarn = summary.fundsShare !== null && summary.fundsShare > FUNDS_SHARE_WARNING;
  const fundsKnown = summary.fundsShare !== null && availableFunds !== null;
  const fundsCaption = fundsKnown
    ? "of your funds"
    : fundsLoading
      ? "Loading funds…"
      : availableFunds === null
        ? "Funds unavailable"
        : "No balance";
  const glanceData: ChartDatum[] = [
    { key: "funds", label: "Spending as a share of recorded funds", values: [{ label: "Spending", value: summary.total }, { label: "Recorded available funds", value: availableFunds, unavailableLabel: fundsLoading ? "Loading funds" : "Funds unavailable" }, { label: "Share of funds", value: summary.fundsShare, display: summary.fundsShare === null ? undefined : `${summary.fundsShare.toFixed(1)}%`, unavailableLabel: fundsCaption }], note: fundsWarn ? "Spending is above 75% of recorded funds" : undefined },
    ...(summary.top ? [{ key: "top", label: summary.top.categoryName, values: [{ label: "Spending", value: summary.top.current }, { label: "Share of spending", value: summary.topShare, display: `${summary.topShare.toFixed(1)}%` }] }] : []),
  ];
  const glanceSelection = useChartSelection(glanceData);
  return (
    <View>
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <GlanceTile
        caption={fundsCaption}
        watermarkIcon="pie-chart-outline"
        tone={fundsWarn ? "attention" : "plain"}
        accessibilityLabel={
          fundsKnown
            ? `${formatMoney(summary.total, { decimals: true })} spent, ${summary.fundsShare!.toFixed(0)}% of ${formatMoney(availableFunds!, { decimals: true })} recorded available funds`
            : fundsCaption
        }
      >
        {fundsKnown ? (
          <ChartPlotPressArea selection={glanceSelection} count={glanceData.length} chartLabel="Share of recorded funds" indexAtPoint={() => 0}>
          <FundsRing percent={summary.fundsShare!} warn={fundsWarn} />
          </ChartPlotPressArea>
        ) : (
          <View style={{ width: 56, height: 56, borderRadius: 28, borderWidth: 7, borderColor: t.surfaceStrong }} />
        )}
      </GlanceTile>
      {summary.top ? (
        <GlanceTile
          caption={summary.top.categoryName}
          watermarkIcon="cube-outline"
          accessibilityLabel={`Largest category ${summary.top.categoryName}, ${summary.topShare.toFixed(1)}% of spending, ${formatMoney(summary.top.current)}`}
        >
          <ChartPlotPressArea selection={glanceSelection} count={glanceData.length} chartLabel="Largest spending category" indexAtPoint={() => 1}>
          <View style={{ alignItems: "center", minHeight: 56, justifyContent: "center" }}>
            <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.title, color: t.textPrimary }}>{`${summary.topShare.toFixed(0)}%`}</T>
            <T style={{ fontSize: typeScale.micro, color: t.textMuted }}>largest</T>
          </View>
          </ChartPlotPressArea>
        </GlanceTile>
      ) : null}

    </View>
    <ChartValueReadout data={glanceData} selection={glanceSelection} chartLabel="Spending at a glance" />
    </View>
  );
}

export function ExpenseCloserLook({ flaggedCount, flaggedLoading, flaggedStale, overdueCount, recurringLoading, recurringStale, onReview, onRecurring }: {
  flaggedCount: number | null; flaggedLoading: boolean; flaggedStale: boolean;
  overdueCount: number | null; recurringLoading: boolean; recurringStale: boolean;
  onReview: () => void; onRecurring: () => void;
}) {
  const t = useTheme();
  const rows = [
    { label: "Review flagged expenses", icon: "document-text-outline" as const, count: flaggedCount, loading: flaggedLoading, stale: flaggedStale, onPress: onReview, detail: "Business-wide expense flags" },
    { label: "Recurring expenses", icon: "repeat-outline" as const, count: overdueCount, loading: recurringLoading, stale: recurringStale, onPress: onRecurring, detail: overdueCount === null ? "" : `${overdueCount} overdue` },
  ];
  return (
    <View style={{ gap: space.sm }}>
      <T variant="heading" accessibilityRole="header">Take a closer look</T>
      <View style={{ borderWidth: 1, borderColor: t.border, borderRadius: radius.md, backgroundColor: t.surface, paddingHorizontal: space.md }}>
        {rows.map((row, index) => {
          const status = row.count === null ? row.loading ? "Loading…" : "Unavailable" : row.stale ? "Saved data" : "";
          return <Pressable key={row.label} accessibilityRole="button" accessibilityLabel={[row.label, row.detail, row.count !== null && index === 0 ? `${row.count} flags` : "", status].filter(Boolean).join(". ")} onPress={row.onPress} style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingVertical: space.md, flexDirection: "row", alignItems: "center", gap: space.sm, borderTopWidth: index ? 1 : 0, borderTopColor: t.border, opacity: pressed ? 0.7 : 1 })}>
            <Ionicons name={row.icon} size={24} color={t.brandText} />
            <View style={{ flex: 1, gap: space.xs }}>
              <T style={{ fontFamily: font.sansMedium, fontSize: typeScale.bodySm }}>{row.label}</T>
              <T variant="caption">{[row.detail, status].filter(Boolean).join(" · ")}</T>
            </View>
            {row.count !== null ? <View style={{ paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.sm, backgroundColor: t.brandSurface }}><T style={{ fontFamily: font.sansSemibold, color: t.brandText, fontVariant: ["tabular-nums"] }}>{row.count}</T></View> : null}
            <Ionicons name="chevron-forward" size={18} color={t.textSecondary} />
          </Pressable>;
        })}
      </View>
    </View>
  );
}

/** The sentence a point stands for. Tiles show the figure; screen readers hear the whole line. */
function spoken(segments: SummarySegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/** A small ring with the share in the middle, for the largest category. */
function ShareRing({ percent }: { percent: number }) {
  const t = useTheme();
  const size = 52;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, percent));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.surfaceStrong} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={t.brandFill}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(shown / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.label, color: t.textPrimary }}>{`${shown.toFixed(0)}%`}</T>
    </View>
  );
}

/** A round icon badge, the visual anchor of a tile that has no chart. */
function Badge({ icon, color, surface }: { icon: keyof typeof Ionicons.glyphMap; color: string; surface: string }) {
  return (
    <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: surface, alignItems: "center", justifyContent: "center" }}>
      <Ionicons name={icon} size={24} color={color} />
    </View>
  );
}

function SummaryTile({
  point,
  onPress,
  tone = "plain",
  children,
  watermarkIcon,
}: {
  point: SummaryPoint;
  onPress?: () => void;
  tone?: "plain" | "attention";
  children: ReactNode;
  watermarkIcon?: KpiWatermarkIcon;
}) {
  const t = useTheme();
  const style = {
    flexGrow: 1,
    flexBasis: "46%" as const,
    minWidth: 140,
    minHeight: 132,
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tone === "attention" ? t.statusBorder.critical : t.border,
    backgroundColor: tone === "attention" ? t.statusSurface.critical : t.surfaceSunken,
  };
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={spoken(point.segments)} style={style}>
        {watermarkIcon ? <KpiWatermark name={watermarkIcon} size={80} /> : null}
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken(point.segments)}
      accessibilityHint="Opens the flagged records"
      onPress={onPress}
      style={({ pressed }) => ({ ...style, opacity: pressed ? 0.75 : 1 })}
    >
      {watermarkIcon ? <KpiWatermark name={watermarkIcon} size={80} /> : null}
      {children}
    </Pressable>
  );
}

/** The big figure on a tile: mono, because it is a number the eye lands on first. */
function Figure({ children, color }: { children: string; color?: string }) {
  const t = useTheme();
  return (
    <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: font.monoSemibold, fontSize: typeScale.title, color: color ?? t.textPrimary, fontVariant: ["tabular-nums"] }}>
      {children}
    </T>
  );
}

function Caption({ strong, rest }: { strong?: string; rest: string }) {
  const t = useTheme();
  return (
    <T style={{ fontSize: typeScale.caption, lineHeight: 16, color: t.textSecondary }}>
      {strong ? <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.textPrimary }}>{strong} </T> : null}
      {rest}
    </T>
  );
}

/**
 * "Summary": the screen's reading, composed from the figures on it and never
 * generated, which the subtitle says outright. Each point is a tile led by a
 * shape or a figure; the full sentence it stands for is its spoken label, so
 * nothing is lost to a screen reader. Each chip only opens Ask FinSight with
 * the question typed in; nothing is sent for the owner.
 */
export function ExpenseSummaryCard({
  points,
  summary,
  comparedWith,
  flaggedCount,
  unusualCount,
  questions,
  onAsk,
  onReviewFlags,
}: {
  points: SummaryPoint[];
  summary: ExpenseSummaryFigures;
  comparedWith: string | null;
  flaggedCount: number;
  unusualCount: number;
  questions: SummaryQuestion[];
  onAsk: (question?: string) => void;
  /** Present when there is something to review; opens the flagged records list. */
  onReviewFlags?: () => void;
}) {
  const t = useTheme();
  const summaryData: ChartDatum[] = [
    ...(summary.top ? [{ key: "top", label: summary.top.categoryName, values: [{ label: "Category spending", value: summary.top.current }, { label: "Share of spending", value: summary.topShare, display: `${summary.topShare.toFixed(1)}%` }] }] : []),
    { key: "total", label: "Spending comparison", values: [{ label: "Current period", value: summary.total }, { label: comparedWith ?? "Previous period", value: summary.total - summary.periodDelta }, { label: "Change", value: summary.periodDelta, display: formatMoney(summary.periodDelta, { decimals: true, signed: true }) }] },
  ];
  const summarySelection = useChartSelection(summaryData, comparedWith);
  // Nothing beyond what the charts already show, and nothing to ask: no card.
  if (points.length === 0 && questions.length === 0) return null;
  const previous = summary.total - summary.periodDelta;
  const barMax = Math.max(summary.total, previous, 1);
  return (
    <View style={{ paddingVertical: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
      <T variant="heading" accessibilityRole="header" style={{ color: t.textPrimary }}>Summary</T>
      <T variant="caption">From your records, not AI-written</T>

      {points.length === 0 ? null : (
        <View style={{ marginTop: space.md, flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {points.map((point) => {
            if (point.kind === "top" && summary.top) {
              return (
                <SummaryTile key={point.kind} point={point} watermarkIcon="cube-outline">
                  <ChartPlotPressArea selection={summarySelection} count={summaryData.length} chartLabel="Largest category share" indexAtPoint={() => summaryData.findIndex((row) => row.key === "top")} style={{ alignSelf: "flex-start" }}><ShareRing percent={summary.topShare} /></ChartPlotPressArea>
                  <Caption strong={summary.top.categoryName} rest="is your biggest cost" />
                </SummaryTile>
              );
            }
            if (point.kind === "increase" && summary.biggestIncrease) {
              return (
                <SummaryTile key={point.kind} point={point} watermarkIcon="trending-up-outline">
                  <Badge icon="trending-up" color={t.statusText.serious} surface={t.statusSurface.serious} />
                  <Figure color={t.statusText.serious}>{`+${formatMoney(summary.biggestIncrease.change)}`}</Figure>
                  <Caption strong={summary.biggestIncrease.categoryName} rest="went up the most" />
                </SummaryTile>
              );
            }
            if (point.kind === "total" && summary.periodPercent !== null) {
              const up = summary.periodDelta > 0;
              const color = up ? t.statusText.serious : t.statusText.good;
              return (
                <SummaryTile key={point.kind} point={point} watermarkIcon="stats-chart-outline">
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    <Ionicons name={up ? "arrow-up" : "arrow-down"} size={22} color={color} />
                    <Figure color={color}>{`${Math.abs(summary.periodPercent).toFixed(0)}%`}</Figure>
                  </View>
                  {/* Now against before: the same two lengths the hero draws, small. */}
                  <ChartPlotPressArea selection={summarySelection} count={summaryData.length} chartLabel="Summary spending comparison" indexAtPoint={() => summaryData.findIndex((row) => row.key === "total")}>
                  <View style={{ gap: 4 }}>
                    {[{ value: summary.total, fill: color }, { value: previous, fill: t.textMuted }].map((bar, i) => (
                      <View key={i} style={{ height: 8, borderRadius: 4, backgroundColor: t.surfaceStrong }}>
                        <View style={{ width: `${Math.max(2, (bar.value / barMax) * 100)}%`, height: 8, borderRadius: 4, backgroundColor: bar.fill }} />
                      </View>
                    ))}
                  </View>
                  </ChartPlotPressArea>
                  <Caption rest={`${up ? "more" : "less"} than ${comparedWith ?? "before"}`} />
                </SummaryTile>
              );
            }
            if (point.kind === "flags") {
              return (
                <SummaryTile key={point.kind} point={point} tone="attention" onPress={flaggedCount > 0 ? onReviewFlags : undefined}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    <Badge icon="flag" color={t.statusText.critical} surface={t.surface} />
                    {flaggedCount > 0 && onReviewFlags ? <Ionicons name="chevron-forward" size={18} color={t.statusText.critical} style={{ marginLeft: "auto" }} /> : null}
                  </View>
                  <Figure>{String(flaggedCount > 0 ? flaggedCount : unusualCount)}</Figure>
                  <Caption rest={flaggedCount > 0 ? (unusualCount > 0 ? `to review · ${unusualCount} unusual` : "to review") : "unusual for their category"} />
                </SummaryTile>
              );
            }
            return null;
          })}
        </View>
      )}

      {points.some((point) => point.kind === "top" || point.kind === "total") ? <ChartValueReadout data={summaryData} selection={summarySelection} chartLabel="Expense summary" /> : null}
      {questions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, marginTop: space.md }}
          contentContainerStyle={{ alignItems: "center", gap: space.sm }}
        >
          {questions.map((q) => (
            <Pressable
              key={q.label}
              accessibilityRole="button"
              accessibilityLabel={`Ask FinSight: ${q.label}`}
              onPress={() => onAsk(q.question)}
              style={({ pressed }) => ({
                minHeight: TAP_FLOOR,
                flexShrink: 0,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: space.md,
                borderRadius: radius.full,
                borderWidth: 1,
                borderColor: t.brandBorder,
                backgroundColor: pressed ? t.brandBorder : t.brandSurface,
              })}
            >
              <Ionicons name="chatbubble-outline" size={14} color={t.brandText} />
              <T style={{ fontSize: typeScale.label, fontFamily: font.sansSemibold, color: t.brandText }}>{q.label}</T>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
