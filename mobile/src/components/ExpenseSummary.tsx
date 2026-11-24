import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
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

/**
 * The one colour a tile surface may carry: a thin bar across its top edge in
 * the critical tone, for the tile that needs acting on. Matches web's
 * `.stat-tile[data-alert]`. It replaced a full status-coloured wash, which
 * made one tile in the grid shout over its neighbours; the tile's own text
 * and icon still say what is wrong.
 */
function AlertBar() {
  const t = useTheme();
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, backgroundColor: t.statusSolid.critical }}
    />
  );
}

function GlanceTile({
  children,
  caption,
  onPress,
  accessibilityLabel,
  tone = "plain",
}: {
  children: ReactNode;
  caption: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  tone?: "plain" | "attention";
}) {
  const t = useTheme();
  const style = {
    flex: 1,
    minHeight: 112,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    overflow: "hidden" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: space.sm,
    padding: space.sm,
  };
  const body = (
    <>
      {tone === "attention" ? <AlertBar /> : null}
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
 * Spending against recorded funds. The largest category's share lives in the
 * category donut's centre, so it is not repeated here.
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
  ];
  const glanceSelection = useChartSelection(glanceData);
  return (
    <View>
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <GlanceTile
        caption={fundsCaption}
       
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
    </View>
    <ChartValueReadout data={glanceData} selection={glanceSelection} chartLabel="Spending at a glance" explore={false} />
    </View>
  );
}

/** The sentence a point stands for. Tiles show the figure; screen readers hear the whole line. */
function spoken(segments: SummarySegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

/**
 * Every Summary tile has the same three layers, top to bottom: what it is (a
 * small label with a quiet icon), the one figure, then a line of context.
 * The tiles used to each pick their own lead (a ring, a big tinted disc, a bare
 * arrow, a red stripe), which read as four widgets rather than one summary.
 * Colour now lives only in the figure and the icon, where it carries meaning.
 */
function SummaryTile({
  point,
  label,
  icon,
  onPress,
  children,
}: {
  point: SummaryPoint;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  children: ReactNode;
}) {
  const t = useTheme();
  const style = {
    flexGrow: 1,
    flexBasis: "46%" as const,
    minWidth: 140,
    minHeight: 124,
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
  };
  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      <Ionicons name={icon} size={15} color={t.textMuted} />
      <T numberOfLines={1} style={{ flex: 1, fontSize: typeScale.caption, fontFamily: font.sansMedium, color: t.textMuted }}>{label}</T>
      {onPress ? <Ionicons name="chevron-forward" size={16} color={t.textMuted} /> : null}
    </View>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={spoken(point.segments)} style={style}>
        {header}
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
      style={({ pressed }) => ({ ...style, backgroundColor: pressed ? t.surfaceMuted : t.surface })}
    >
      {header}
      {children}
    </Pressable>
  );
}

/** The big figure on a tile: mono, because it is a number the eye lands on first. */
function Figure({ children, color }: { children: string; color?: string }) {
  const t = useTheme();
  return (
    <T numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: font.monoSemibold, fontSize: typeScale.subpageTitle, lineHeight: typeScale.subpageTitle + 6, color: color ?? t.textPrimary, fontVariant: ["tabular-nums"] }}>
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
  flaggedCount,
  unusualCount,
  questions,
  onAsk,
  onReviewFlags,
}: {
  points: SummaryPoint[];
  summary: ExpenseSummaryFigures;
  flaggedCount: number;
  unusualCount: number;
  questions: SummaryQuestion[];
  onAsk: (question?: string) => void;
  /** Present when there is something to review; opens the flagged records list. */
  onReviewFlags?: () => void;
}) {
  const t = useTheme();
  // The top share is the donut's centre and the total change is the hero chip; only new points get a tile.
  const shown = points.filter((point) => point.kind === "increase" || point.kind === "flags");
  // Nothing beyond what the charts already show, and nothing to ask: no card.
  if (shown.length === 0 && questions.length === 0) return null;
  return (
    <View style={{ paddingVertical: space.md, borderTopWidth: 1, borderTopColor: t.border }}>
      <T variant="heading" accessibilityRole="header" style={{ color: t.textPrimary }}>Summary</T>
      <T variant="caption">From your records, not AI-written</T>

      {shown.length === 0 ? null : (
        <View style={{ marginTop: space.md, flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {shown.map((point) => {
            if (point.kind === "increase" && summary.biggestIncrease) {
              return (
                <SummaryTile key={point.kind} point={point} label="Biggest rise" icon="trending-up">
                  <Figure color={t.statusText.serious}>{`+${formatMoney(summary.biggestIncrease.change)}`}</Figure>
                  <Caption strong={summary.biggestIncrease.categoryName} rest="went up the most" />
                </SummaryTile>
              );
            }
            if (point.kind === "flags") {
              const reviewable = flaggedCount > 0 && Boolean(onReviewFlags);
              return (
                <SummaryTile key={point.kind} point={point} label={flaggedCount > 0 ? "Needs a check" : "Unusual"} icon="flag-outline" onPress={reviewable ? onReviewFlags : undefined}>
                  <Figure>{String(flaggedCount > 0 ? flaggedCount : unusualCount)}</Figure>
                  <Caption rest={flaggedCount > 0 ? (unusualCount > 0 ? `to review · ${unusualCount} unusual` : "to review") : "unusual for their category"} />
                </SummaryTile>
              );
            }
            return null;
          })}
        </View>
      )}

      {/*
        Follow-up questions as a short list at the foot of the card. They were a
        row of filled pills scrolling sideways, cut off at the screen edge and
        louder than the figures they ask about.
      */}
      {questions.length > 0 ? (
        <View style={{ marginTop: space.md }}>
          <T variant="caption" style={{ marginBottom: space.xs }}>Ask FinSight about this</T>
          {questions.map((q, index) => (
            <Pressable
              key={q.label}
              accessibilityRole="button"
              accessibilityLabel={`Ask FinSight: ${q.label}`}
              onPress={() => onAsk(q.question)}
              style={({ pressed }) => ({
                minHeight: TAP_FLOOR,
                flexDirection: "row",
                alignItems: "center",
                gap: space.sm,
                paddingVertical: space.sm,
                borderTopWidth: index ? 1 : 0,
                borderTopColor: t.border,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="chatbubble-outline" size={16} color={t.brandText} />
              <T style={{ flex: 1, fontSize: typeScale.bodySm, fontFamily: font.sansMedium, color: t.brandText }}>{q.label}</T>
              <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
