import { View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Card, Money, T } from "./ui";
import { Medallion } from "./InsightsShared";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import {
  formatOperatingDays,
  recoveryHighlights,
  recoveryPeriodLabel,
  recoveryPeriodStatusLabel,
  recoverySummaryText,
  todayPercent,
  type HighlightKind,
} from "../lib/recoveryPeriodView";
import type { DailyCoverageRow, RecoveryInsight, RecoveryReportingPeriod } from "../lib/types";
import { font, radius, space, typeScale } from "../theme/tokens";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";

type Tone = "good" | "warning" | "critical" | "neutral";

function periodTone(period: RecoveryReportingPeriod): Tone {
  switch (period.status) {
    case "covered":
    case "ahead":
    case "on_pace":
      return "good";
    case "behind":
      return "critical";
    case "no_data":
      return "warning";
    default:
      return "neutral";
  }
}

function Bar({ percent, color, label, detail }: { percent: number; color: string; label: string; detail: ChartDatum }) {
  const t = useTheme();
  const width = Math.max(0, Math.min(100, percent));
  const barData = [detail];
  const barSelection = useChartSelection(barData);
  return (
    <View>
    <ChartPlotPressArea selection={barSelection} count={1} chartLabel={detail.label}>
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(width) }}
      style={{ height: 10, borderRadius: radius.full, overflow: "hidden", backgroundColor: t.surfaceStrong }}
    >
      <View style={{ width: `${width}%`, height: "100%", borderRadius: radius.full, backgroundColor: color }} />
    </View>
    </ChartPlotPressArea>
    <ChartValueReadout data={barData} selection={barSelection} chartLabel={detail.label} />
    </View>
  );
}

function Figure({ label, value, caption }: { label: string; value: number | string; caption?: string }) {
  return (
    <View style={{ flex: 1, minWidth: 130 }}>
      <T variant="caption">{label}</T>
      {typeof value === "number" ? (
        <Money value={value} size={typeScale.bodyLg} weight="semibold" style={{ marginTop: 2 }} />
      ) : (
        <T style={{ marginTop: 2, fontFamily: font.monoSemibold, fontSize: typeScale.bodyLg }}>{value}</T>
      )}
      {caption ? <T variant="caption" style={{ marginTop: 2 }}>{caption}</T> : null}
    </View>
  );
}

/**
 * The headline for a week or a past month, where the month-to-date meter does
 * not apply: sales against this period's target, and what is left of it.
 */
export function RecoveryPaceCard({ period }: { period: RecoveryReportingPeriod }) {
  const t = useTheme();
  const tone = periodTone(period);
  const ink = tone === "neutral" ? t.textSecondary : t.statusText[tone];
  const surface = tone === "neutral" ? t.surfaceMuted : t.statusSurface[tone];
  const title = period.kind === "week"
    ? "This week's pace"
    : `${recoveryPeriodLabel(period)} ${period.isComplete ? "result" : "so far"}`;
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
        <T variant="heading" accessibilityRole="header" style={{ flex: 1 }}>{title}</T>
        <View style={{ borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 4, backgroundColor: surface }}>
          <T variant="caption" style={{ color: ink, fontFamily: font.sansSemibold }}>{recoveryPeriodStatusLabel(period)}</T>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: space.md }}>
        <Money value={period.sales} size={typeScale.titleLg} weight="semibold" />
        <T variant="caption" style={{ flexShrink: 1 }}>{`of ${formatMoney(period.target)} target`}</T>
      </View>
      <View style={{ marginTop: space.sm }}>
        <Bar
          percent={period.coveragePercent}
          color={tone === "critical" ? t.status.critical : t.status.good}
          label={`${Math.round(period.coveragePercent)}% of this period's target covered`}
          detail={{ key: `${period.start}:${period.end}`, label: "Period sales coverage", values: [{ label: "Sales recorded", value: period.sales }, { label: "Target", value: period.status === "needs_setup" ? null : period.target, unavailableLabel: "Needs setup" }, { label: "Coverage", value: period.status === "needs_setup" ? null : period.coveragePercent, display: `${period.coveragePercent.toFixed(1)}%`, unavailableLabel: "Needs setup" }], note: recoveryPeriodStatusLabel(period) }}
        />
      </View>
      <T variant="caption" style={{ marginTop: space.xs }}>{`${Math.round(period.coveragePercent)}% covered`}</T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.md }}>
        <Figure label="Remaining target" value={period.remainingTarget} />
        <Figure
          label={period.operatingDaysIsApproximated ? "Open-day target" : "Daily needed target"}
          value={period.adjustedDailyTarget ?? period.dailyTarget}
          caption={period.adjustedDailyTarget !== null && !period.isComplete ? "Across remaining operating days" : undefined}
        />
        <Figure
          label="Operating days"
          value={`${formatOperatingDays(period.elapsedOperatingDays, period.operatingDaysIsApproximated)} / ${formatOperatingDays(period.operatingDays, period.operatingDaysIsApproximated)}`}
          caption={period.operatingScheduleConfigured ? "From your operating schedule" : "Estimated from your business profile"}
        />
      </View>
    </Card>
  );
}

/** Today's sales reference against today's target. Current month only. */
export function RecoveryTodayCard({ data }: { data: RecoveryInsight }) {
  const t = useTheme();
  const percent = todayPercent(data);
  const below = data.todaysStatus === "below";
  const gapColor = below ? t.statusText.critical : data.todaysStatus === "at" ? t.statusText.warning : t.statusText.good;
  return (
    <Card>
      <T variant="heading" accessibilityRole="header">Today</T>
      <View style={{ marginTop: space.md }}>
        <Bar
          percent={percent}
          color={below ? t.status.critical : t.status.good}
          label={`${Math.round(percent)}% of today's target recorded`}
          detail={{ key: data.asOfDate ?? data.today, label: "Today's sales coverage", values: [{ label: "Sales recorded", value: data.todaysSales }, { label: "Today's target", value: data.todaysTarget }, { label: "Gap", value: data.todaysGap }, { label: "Coverage", value: percent, display: `${percent.toFixed(1)}%` }], note: data.todaysStatus === "at" ? "Reached target" : `${data.todaysStatus === "below" ? "Below" : "Above"} target` }}
        />
      </View>
      <T variant="caption" style={{ marginTop: space.xs }}>{`${Math.round(percent)}% of today's target recorded`}</T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.md }}>
        <Figure label="Sales reference today" value={data.todaysSales} />
        <Figure label="Today's target" value={data.todaysTarget} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
        <T variant="caption">Today's gap</T>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodySm, color: gapColor }}>
          {data.todaysStatus === "at" ? "Reached" : `${formatMoney(Math.abs(data.todaysGap))} ${data.todaysStatus}`}
        </T>
      </View>
    </Card>
  );
}

/** Where the period's target stands: covered by sales, and still to cover. */
export function RecoveryTargetBreakdown({ sales, target }: { sales: number; target: number }) {
  const t = useTheme();
  const covered = Math.min(sales, target);
  const remaining = Math.max(0, target - sales);
  const over = Math.max(0, sales - target);
  const share = target > 0 ? (covered / target) * 100 : 0;
  return (
    <Card>
      <T variant="heading" accessibilityRole="header">Target breakdown</T>
      <View style={{ marginTop: space.md }}>
        <Bar percent={share} color={t.brandFill} label={`${Math.round(share)}% of the target covered by recorded sales`} detail={{ key: "breakdown", label: "Target breakdown", values: [{ label: "Sales recorded", value: sales }, { label: "Target", value: target }, { label: "Covered by sales", value: covered }, { label: "Still to cover", value: remaining }, { label: "Above target", value: over }] }} />
      </View>
      <View style={{ marginTop: space.md, gap: space.sm }}>
        <BreakdownRow color={t.brandFill} label="Covered by sales" value={covered} />
        <BreakdownRow color={t.surfaceStrong} label="Still to cover" value={remaining} />
        {over > 0 ? <BreakdownRow color={t.status.good} label="Above target" value={over} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: space.sm, borderTopWidth: 1, borderTopColor: t.border }}>
          <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>Target</T>
          <Money value={target} size={typeScale.bodySm} weight="semibold" />
        </View>
      </View>
    </Card>
  );
}

function BreakdownRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />
      <T style={{ flex: 1, fontSize: typeScale.bodySm }}>{label}</T>
      <Money value={value} size={typeScale.bodySm} />
    </View>
  );
}

/** Remaining figures for a week (or a month that is not the current one). */
export function RecoveryRemainingPeriodCard({ period }: { period: RecoveryReportingPeriod }) {
  return (
    <Card>
      <T variant="heading" accessibilityRole="header">
        {period.kind === "month" ? "Remaining recovery target" : "Remaining weekly target"}
      </T>
      <T variant="caption" style={{ marginBottom: space.md }}>Recalculated across your remaining operating days</T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <Figure label={period.kind === "month" ? "Monthly expense basis" : "This week's target"} value={period.target} />
        <Figure label={period.kind === "month" ? "Sales reference so far" : "Sales reference this week"} value={period.sales} />
        <Figure label="Remaining target" value={period.remainingTarget} />
        <Figure
          label="Remaining operating days"
          value={formatOperatingDays(period.remainingOperatingDays, period.operatingDaysIsApproximated)}
        />
      </View>
    </Card>
  );
}

const HIGHLIGHT_ICONS: Record<HighlightKind, keyof typeof Ionicons.glyphMap> = {
  "on-target": "calendar-outline",
  "best-day": "trending-up-outline",
  closed: "moon-outline",
};

/** Plain facts read off the daily rows, so nothing here needs an AI disclaimer. */
export function RecoveryHighlights({ rows }: { rows: readonly DailyCoverageRow[] }) {
  const t = useTheme();
  const items = recoveryHighlights(rows);
  return (
    <Card>
      <T variant="heading" accessibilityRole="header">Highlights</T>
      <T variant="caption" style={{ marginBottom: space.md }}>From your daily records</T>
      {items.length === 0 ? (
        <T variant="caption">Highlights appear once this period has recorded days.</T>
      ) : (
        <View style={{ gap: space.md }}>
          {items.map((item) => (
            <View key={item.kind} style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start" }}>
              <Medallion icon={HIGHLIGHT_ICONS[item.kind]} tint={t.brandText} surface={t.brandSurface} size={30} />
              <View style={{ flex: 1 }}>
                <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>{item.title}</T>
                <T variant="caption" style={{ marginTop: 2 }}>{item.body}</T>
              </View>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

/** The composed reading of the period, and a question that names its figures. */
export function RecoverySummaryCard({ period, onAsk }: { period: RecoveryReportingPeriod; onAsk?: () => void }) {
  const t = useTheme();
  return (
    <Card style={{ backgroundColor: t.brandSurface, borderColor: t.brandBorder }}>
      <T variant="heading" accessibilityRole="header" style={{ color: t.brandHeading }}>Summary</T>
      <T variant="caption" style={{ marginTop: 2 }}>Composed from your records, not AI-written</T>
      <T style={{ marginTop: space.md, fontSize: typeScale.bodySm, lineHeight: 20, color: t.textPrimary }}>
        {recoverySummaryText(period)}
      </T>
      {onAsk ? <Button title="Ask about this period" variant="ghost" onPress={onAsk} style={{ marginTop: space.sm }} /> : null}
    </Card>
  );
}
