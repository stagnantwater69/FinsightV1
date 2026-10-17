import { ReactNode, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { CONTENT_WIDTH, ContentScrollView } from "./ContentScrollView";
import { useReducedMotion } from "../lib/useReducedMotion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Money, T } from "./ui";
import { resolveMonthStatus } from "../lib/recoveryStatus";
import { TAP_FLOOR } from "./touchTarget";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";
import { KpiWatermark } from "./KpiWatermark";
import * as haptics from "../lib/haptics";
import { compactAmount, formatMoney } from "../lib/money";
import { formatOperatingDays, recoveryPeriodLabel, recoveryPeriodStatusLabel } from "../lib/recoveryPeriodView";
import { useTheme } from "../context/ThemeContext";
import { HERO } from "../theme/hero";
import { PanelStatus, TealPanel } from "./CoachKit";
import { font, radius, space, typeScale } from "../theme/tokens";
import type {
  DailyCoverageRow,
  RecoveryCheckpoint,
  RecoveryInsight,
  RecoveryReportingPeriod,
} from "../lib/types";

/*
 * The Recovery Target screen's visual pieces. Every figure drawn here is a
 * server value (or a count of server rows); nothing in this file computes a
 * target. The progress fill is `coveragePercent`, the pace marker is
 * `expectedSalesToDate`, and day colours are each row's `status`.
 */

/*
 * The coach card sits on a fixed deep teal in both themes, for the same reason
 * web's RecoveryHero does: brand surfaces that flip with the theme stop reading
 * as the brand. Its text colours are therefore fixed too.
 */
const HERO_INK = HERO.ink;
const HERO_MUTED = HERO.muted;
const HERO_AMBER = HERO.amber;

type Tone = "good" | "warning" | "critical";

function periodTone(period: RecoveryReportingPeriod): Tone {
  switch (period.status) {
    case "covered":
    case "ahead":
    case "on_pace":
      return "good";
    case "behind":
      return "critical";
    default:
      return "warning";
  }
}

function shortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function longDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function periodCoverageDatum(period: RecoveryReportingPeriod): ChartDatum {
  return {
    key: `${period.start}:${period.end}`,
    label: `${recoveryPeriodLabel(period)} sales coverage`,
    values: [
      { label: "Sales recorded", value: period.sales },
      { label: "Sales coverage target", value: period.status === "needs_setup" ? null : period.target, unavailableLabel: "Needs setup" },
      { label: "Coverage", value: period.status === "needs_setup" ? null : period.coveragePercent, display: `${period.coveragePercent.toFixed(1)}%`, unavailableLabel: "Needs setup" },
      { label: "Expected sales to date", value: period.expectedSalesToDate },
      { label: "Remaining target", value: period.remainingTarget },
    ],
    note: `${recoveryPeriodStatusLabel(period)}. ${period.operatingDaysIsApproximated ? "Operating days are estimated." : "Based on your operating schedule."}`,
  };
}

function todayGoalDatum(data: RecoveryInsight): ChartDatum {
  const percent = data.todaysTarget > 0 ? data.todaysSales / data.todaysTarget * 100 : data.todaysSales > 0 ? 100 : 0;
  return { key: data.reportingPeriod?.asOfDate ?? data.asOfDate ?? data.today, label: "Today's goal", values: [{ label: "Sales recorded", value: data.todaysSales }, { label: "Today's target", value: data.todaysTarget }, { label: "Coverage", value: percent, display: `${percent.toFixed(1)}%` }, { label: "Gap", value: data.todaysGap, display: formatMoney(data.todaysGap, { decimals: true, signed: true }) }], note: data.todaysStatus === "at" ? "Reached target" : `${data.todaysStatus === "below" ? "Below" : "Above"} target` };
}

/** Recorded sales and their coverage of the server's selected-period target. */
export function RecoveryCoachCard({ data, period, isCurrentMonth, header }: {
  data: RecoveryInsight; period: RecoveryReportingPeriod; isCurrentMonth: boolean;
  /** The card's first line: the period pill and the as-of date. */
  header?: ReactNode;
}) {
  const status = isCurrentMonth
    ? resolveMonthStatus(data)
    : { tone: periodTone(period), glyph: periodTone(period) === "critical" ? "!" : periodTone(period) === "good" ? "✓" : "i", copy: recoveryPeriodStatusLabel(period) };
  const noSales = period.status !== "needs_setup" && ((isCurrentMonth && data.monthHasNoRecords) || period.status === "no_data");
  const targetReady = period.status !== "needs_setup" && period.target > 0;
  const filled = Math.max(0, Math.min(100, period.coveragePercent));
  const expectedPercent = !period.isComplete && !noSales && period.expectedSalesToDate > 0 && targetReady
    ? Math.max(0, Math.min(100, period.expectedSalesToDate / period.target * 100))
    : null;
  const latestSale = noSales && data.latestSaleDate
    ? new Date(data.latestSaleDate).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  const coverageData = [periodCoverageDatum(period)];
  const coverageSelection = useChartSelection(coverageData);
  return (
    <TealPanel style={{ borderRadius: radius.xl }} watermarkIcon="stats-chart-outline">
      {header}
      <PanelStatus tone={noSales ? "warning" : status.tone} glyph={noSales ? "i" : status.glyph} copy={noSales ? isCurrentMonth ? "No sales recorded yet this month" : recoveryPeriodStatusLabel({ ...period, status: "no_data" }) : status.copy} />
      <View style={{ gap: space.xs }}>
        <T style={{ color: HERO_MUTED, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>Sales recorded</T>
        <T style={{ color: HERO_INK, fontFamily: font.sansSemibold, fontSize: typeScale.display, lineHeight: typeScale.display + space.sm, fontVariant: ["tabular-nums"] }}>{formatMoney(period.sales)}</T>
        <T style={{ color: HERO_MUTED, fontSize: typeScale.bodySm }}>{targetReady ? `of ${formatMoney(period.target)} sales coverage target` : "Add a monthly expense estimate to calculate your target."}</T>
      </View>
      {noSales ? <T style={{ color: HERO_MUTED, fontSize: typeScale.bodySm }}>{`Add a sale to start tracking.${latestSale ? ` Your latest sale was ${latestSale}.` : ""}`}</T> : null}
      {targetReady ? (
        <>
          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm }}>
              <T style={{ color: HERO_INK, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>{`${Math.round(period.coveragePercent)}% reached`}</T>
              <T style={{ color: HERO_MUTED, fontSize: typeScale.bodySm }}>{formatMoney(period.target)}</T>
            </View>
            <ChartPlotPressArea selection={coverageSelection} count={1} chartLabel="Sales coverage">
            <View accessible accessibilityRole="progressbar" accessibilityLabel={`Sales coverage: ${formatMoney(period.sales)} recorded against ${formatMoney(period.target)} target${expectedPercent === null ? "" : `. Today's pace: ${formatMoney(period.expectedSalesToDate)}`}`} accessibilityValue={{ min: 0, max: 100, now: Math.round(filled) }} style={{ gap: space.sm }}>
              <View style={{ height: 12, borderRadius: radius.sm, backgroundColor: HERO.washStrong }}>
                <View style={{ height: 12, width: `${filled}%`, borderRadius: radius.sm, backgroundColor: HERO.goodInk }} />
                {expectedPercent !== null ? <View style={{ position: "absolute", left: `${expectedPercent}%`, top: -5, bottom: -5, width: 3, marginLeft: -1.5, borderRadius: 2, backgroundColor: HERO_AMBER }} /> : null}
              </View>
              {expectedPercent !== null ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}><View style={{ width: 3, height: 12, backgroundColor: HERO_AMBER }} /><T style={{ color: HERO_AMBER, fontSize: typeScale.caption }}>Today's pace · {formatMoney(period.expectedSalesToDate)}</T></View> : null}
            </View>
            </ChartPlotPressArea>
          </View>
          <ChartValueReadout data={coverageData} selection={coverageSelection} chartLabel="Sales coverage" />
          <View style={{ borderTopWidth: 1, borderTopColor: HERO.hairline, paddingTop: space.md, flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <View style={{ flex: 1, minWidth: 120, gap: space.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}><Ionicons name="arrow-up" size={18} color={HERO_AMBER} /><T style={{ color: HERO_MUTED, fontSize: typeScale.caption }}>{period.isComplete ? "Period result" : "Still to sell"}</T></View>
              <T style={{ color: HERO_INK, fontFamily: font.sansSemibold, fontSize: typeScale.title, fontVariant: ["tabular-nums"] }}>{formatMoney(period.isComplete ? Math.abs(period.sales - period.target) : Math.max(0, period.remainingTarget))}</T>
              {period.isComplete ? <T style={{ color: HERO_MUTED, fontSize: typeScale.caption }}>{period.sales >= period.target ? "above target" : "short of target"}</T> : null}
            </View>
            <View style={{ flex: 1, minWidth: 120, gap: space.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}><Ionicons name="calendar-outline" size={18} color={HERO_INK} /><T style={{ color: HERO_MUTED, fontSize: typeScale.caption }}>{period.isComplete ? "Selected period" : "Time remaining"}</T></View>
              <T style={{ color: HERO_INK, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>{period.isComplete ? recoveryPeriodLabel(period) : `${formatOperatingDays(period.remainingOperatingDays, period.operatingDaysIsApproximated)} operating days`}</T>
            </View>
          </View>
        </>
      ) : null}
      <T style={{ color: HERO_MUTED, fontSize: typeScale.caption }}>Based on your recorded sales</T>
    </TealPanel>
  );
}

/** The server's adjusted target for each remaining operating day. */
export function RecoveryNextGoal({ period }: { period: RecoveryReportingPeriod }) {
  const t = useTheme();
  if (period.isComplete || period.status === "needs_setup" || period.target <= 0) return null;
  const reached = period.remainingTarget <= 0 || period.status === "covered";
  const dailyTarget = !reached && period.remainingOperatingDays > 0 ? period.adjustedDailyTarget : null;
  const behind = period.isCurrent && !reached && period.status === "behind" && period.expectedSalesToDate > 0 && period.paceVarianceAmount < 0 && period.remainingOperatingDays > 0;
  return (
    <View style={{ gap: space.md }}>
      <T variant="heading" accessibilityRole="header">What to aim for next</T>
      <View style={{ backgroundColor: t.brandSurface, borderRadius: radius.md, padding: space.lg, gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Ionicons name={reached ? "checkmark-circle-outline" : "locate-outline"} size={30} color={t.brandText} />
          <T style={{ flex: 1, color: t.brandHeading, fontFamily: font.sansSemibold, fontSize: typeScale.title, fontVariant: ["tabular-nums"] }}>{reached ? "Sales coverage target reached" : dailyTarget !== null ? `${formatMoney(dailyTarget)} / day` : period.remainingOperatingDays <= 0 ? "No operating days remaining" : "Daily target unavailable"}</T>
        </View>
        <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>{reached ? "Recorded sales cover this period's expense basis." : dailyTarget !== null ? `Sales needed per remaining operating day to reach the ${period.kind === "week" ? "weekly" : "monthly"} target.` : "Review your operating schedule and the remaining target below."}</T>
      </View>
      {behind ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderColor: t.statusBorder.warning, backgroundColor: t.statusSurface.warning, borderRadius: radius.md, padding: space.md }}>
        <Ionicons name="alert-circle" size={22} color={t.statusText.warning} />
        <T style={{ flex: 1, color: t.statusText.warning, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>{formatMoney(Math.abs(period.paceVarianceAmount))} behind today's pace</T>
      </View> : null}
    </View>
  );
}

// ---------------------------------------------------------------- today

/** A thick progress bar used for today's goal and the day sheet. */
export function ProgressBar({ percent, color, label, height = 16, detail }: { percent: number; color: string; label: string; height?: number; detail?: ChartDatum }) {
  const t = useTheme();
  const width = Math.max(0, Math.min(100, percent));
  const progressData: ChartDatum[] = [detail ?? { key: label, label, values: [{ label: "Progress", value: percent, display: `${percent.toFixed(1)}%` }] }];
  const progressSelection = useChartSelection(progressData);
  return (
    <View>
    <ChartPlotPressArea selection={progressSelection} count={1} chartLabel={detail?.label ?? label}>
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(width) }}
      style={{ height, borderRadius: height / 2, backgroundColor: t.surfaceStrong, overflow: "hidden" }}
    >
      <View style={{ width: `${width}%`, height: "100%", borderRadius: height / 2, backgroundColor: color }} />
    </View>
    </ChartPlotPressArea>
    <ChartValueReadout data={progressData} selection={progressSelection} chartLabel={detail?.label ?? label} />
    </View>
  );
}

/** Today's allocated target and how much of it is recorded. Current month only. */
export function TodayGoalCard({ data, children }: { data: RecoveryInsight; children?: ReactNode }) {
  const t = useTheme();
  const percent =
    data.todaysTarget > 0 ? (data.todaysSales / data.todaysTarget) * 100 : data.todaysSales > 0 ? 100 : 0;
  const reached = data.todaysStatus !== "below";
  return (
    <View
      style={{
        borderRadius: 24,
        borderWidth: 1,
        borderColor: t.accent[100],
        backgroundColor: t.ACCENT.surface,
        padding: space.lg,
      }}
    >
      <KpiWatermark name="calendar-outline" borderRadius={24} />
      <T accessibilityRole="header" style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: t.ACCENT.text }}>
        {`Today's goal · ${longDate(data.reportingPeriod?.asOfDate ?? data.asOfDate ?? data.today)}`}
      </T>
      <Money value={data.todaysTarget} size={typeScale.display} weight="semibold" style={{ marginTop: space.xs }} />
      <View style={{ marginTop: space.md }}>
        <ProgressBar
          percent={percent}
          color={reached ? t.status.good : t.ACCENT.fill}
          label={`${Math.round(percent)}% of today's target recorded`}
          detail={todayGoalDatum(data)}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "space-between", marginTop: space.sm }}>
        <T variant="caption" style={{ color: t.textSecondary }}>
          <Money value={data.todaysSales} size={typeScale.caption} weight="semibold" /> sold · {Math.round(percent)}%
        </T>
        <T variant="caption" style={{ color: reached ? t.statusText.good : t.textSecondary }}>
          {data.todaysStatus === "at" ? (
            "Target reached"
          ) : (
            <>
              <Money
                value={Math.abs(data.todaysGap)}
                size={typeScale.caption}
                weight="semibold"
                color={reached ? t.statusText.good : undefined}
              />
              {reached ? " above target" : " to go"}
            </>
          )}
        </T>
      </View>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- calendar

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type CellKind = "hit" | "miss" | "closed" | "today" | "future" | "empty";

/** One square per day of the period, coloured by the server's status for that day. */
export function DayCalendar({
  period,
  rows,
}: {
  period: RecoveryReportingPeriod;
  rows: readonly DailyCoverageRow[];
}) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const [calendarWidth, setCalendarWidth] = useState(0);
  const gridWidth = Math.max(calendarWidth, 7 * (TAP_FLOOR + 4));
  const cellHeight = Math.max(TAP_FLOOR + 4, (TAP_FLOOR + 4) * fontScale);
  const byDate = new Map(rows.map((r) => [r.date.slice(0, 10), r]));
  const start = period.start.slice(0, 10);
  const end = period.end.slice(0, 10);
  const asOf = period.asOfDate.slice(0, 10);
  // Monday-first, the way the operating week is set up.
  const lead = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7;
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 31; d = addDays(d, 1)) days.push(d);

  function kindOf(date: string): CellKind {
    const row = byDate.get(date);
    if (row?.status === "closed") return "closed";
    if (date === asOf && !period.isComplete) return "today";
    if (date > asOf) return "future";
    if (!row) return "empty";
    return row.status === "below" ? "miss" : "hit";
  }

  const cells: (string | null)[] = [...Array(lead).fill(null), ...days];
  const calendarData: ChartDatum[] = days.map((date) => {
    const row = byDate.get(date);
    const future = date > asOf;
    const closed = row?.status === "closed";
    return { key: date, label: longDate(date), values: [{ label: "Sales recorded", value: future ? null : row?.sales ?? null, unavailableLabel: future ? "Not yet recorded" : "No record" }, { label: "Daily target", value: row?.neededTarget ?? null, unavailableLabel: closed ? "Closed day" : "Unavailable" }, { label: "Gap", value: future ? null : row?.gap ?? null, display: row?.gap == null ? undefined : formatMoney(row.gap, { decimals: true, signed: true }), unavailableLabel: future ? "Not yet recorded" : closed ? "No target" : "Unavailable" }], note: future ? "Future day. Sales are not recorded yet." : closed ? "Closed day on your schedule" : !row ? "No record for this day" : row.status === "at" ? "Reached target" : row.status === "above" ? "Above target" : "Below target" };
  });
  const calendarSelection = useChartSelection(calendarData, `${start}:${end}:${asOf}`);
  const sheetSelection = useChartSelection(calendarData, `${start}:${end}:${asOf}`);
  const selected = sheetSelection.selected?.key ?? null;
  const selectedRow = selected ? byDate.get(selected) ?? null : null;

  return (
    <View onLayout={(event) => setCalendarWidth(event.nativeEvent.layout.width)}>
      <ScrollView horizontal showsHorizontalScrollIndicator={gridWidth > calendarWidth}>
        <View style={{ width: gridWidth }}>
          <View style={{ flexDirection: "row", marginTop: space.md }}>
            {WEEKDAYS.map((d, i) => (
              <T key={i} style={{ flex: 1, textAlign: "center", fontSize: typeScale.micro, color: t.textMuted, fontFamily: font.sansSemibold }}>
                {d}
              </T>
            ))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: space.xs }}>
            {cells.map((date, i) => {
              if (!date) return <View key={`b${i}`} style={{ width: `${100 / 7}%`, height: cellHeight }} />;
              const kind = kindOf(date);
              const row = byDate.get(date);
              const calendarIndex = days.indexOf(date);
              const style =
                kind === "hit"
                  ? { backgroundColor: t.brandFill, borderColor: t.brandFill }
                  : kind === "miss"
                    ? { backgroundColor: t.statusSurface.critical, borderColor: t.statusBorder.critical }
                    : kind === "today"
                      ? { backgroundColor: t.brandSurface, borderColor: t.brandFill, borderWidth: 2 }
                      : kind === "closed"
                        ? { backgroundColor: t.surfaceMuted, borderColor: t.surfaceMuted }
                        : { backgroundColor: "transparent", borderColor: t.border };
              const ink =
                kind === "hit" ? t.onBrandFill : kind === "miss" ? t.statusText.critical : kind === "future" || kind === "closed" ? t.textFaint : t.textPrimary;
              const day = Number(date.slice(8, 10));
              const pressable = kind !== "future";
              const statusWord =
                kind === "hit" ? "reached target" : kind === "miss" ? "below target" : kind === "closed" ? "closed" : kind === "today" ? "today" : kind === "future" ? "not yet recorded" : "no record";
              return (
                <View key={date} style={{ width: `${100 / 7}%`, minHeight: cellHeight, padding: 2 }}
                  onPointerEnter={(event) => {
                    if (kind === "future" && (event.nativeEvent.pointerType === "mouse" || event.nativeEvent.pointerType === "pen") && !event.nativeEvent.buttons) calendarSelection.hover(calendarIndex);
                  }}
                  onPointerLeave={(event) => {
                    if (kind === "future" && (event.nativeEvent.pointerType === "mouse" || event.nativeEvent.pointerType === "pen")) calendarSelection.clearHover(calendarIndex);
                  }}
                >
                  <Pressable
                    {...calendarSelection.bind(calendarIndex)}
                    disabled={!pressable}
                    onPress={() => {
                      haptics.tapped();
                      sheetSelection.select(calendarIndex);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !pressable }}
                    accessibilityLabel={`${longDate(date)}, ${row && date <= asOf ? `sold ${formatMoney(row.sales)}, ` : ""}${statusWord}`}
                    style={({ pressed }) => ({
                      flex: 1,
                      borderRadius: radius.sm,
                      borderWidth: 1,
                      paddingHorizontal: 4,
                      paddingVertical: 3,
                      justifyContent: "space-between",
                      opacity: pressed ? 0.75 : 1,
                      ...style,
                      ...(calendarSelection.selected?.key === date ? { borderWidth: 2, borderColor: t.textPrimary } : {}),
                    })}
                  >
                    <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: ink }}>{day}</T>
                    {row && kind !== "closed" && kind !== "future" && row.sales > 0 ? (
                      <T style={{ fontSize: typeScale.micro, fontFamily: font.monoMedium, color: ink }}>
                        {compactAmount(row.sales)}
                      </T>
                    ) : kind === "closed" ? (
                      <Ionicons name="moon-outline" size={11} color={t.textFaint} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, marginTop: space.sm }}>
        <LegendSwatch color={t.brandFill} label="Hit target" />
        <LegendSwatch color={t.statusSurface.critical} border={t.statusBorder.critical} label="Missed" />
        <LegendSwatch color={t.surfaceMuted} label="Closed day" />
        {!period.isComplete ? <LegendSwatch color={t.brandSurface} border={t.brandFill} label="Today" /> : null}
      </View>
      <ChartValueReadout data={calendarData} selection={calendarSelection} chartLabel="Daily coverage" />
      <DaySheet row={selectedRow} date={selected} onClose={sheetSelection.clear} />
    </View>
  );
}

function LegendSwatch({ color, border, label }: { color: string; border?: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: color, borderWidth: border ? 1.5 : 0, borderColor: border }} />
      <T variant="caption">{label}</T>
    </View>
  );
}

/** Plain counts read off the daily rows: same three facts as web's Highlights panel. */
export function DayScore({ rows }: { rows: readonly DailyCoverageRow[] }) {
  const t = useTheme();
  const open = rows.filter((r) => r.status !== "closed");
  const hit = open.filter((r) => r.status === "at" || r.status === "above");
  const best = rows.reduce<DailyCoverageRow | null>((top, r) => (r.sales > 0 && (!top || r.sales > top.sales) ? r : top), null);
  const closed = rows.length - open.length;
  if (rows.length === 0) {
    return <T variant="caption" style={{ marginTop: space.md }}>Highlights appear once this period has recorded days.</T>;
  }
  const tiles: { value: ReactNode; label: string }[] = [
    { value: `${hit.length}/${open.length}`, label: open.length === 1 ? "open day hit target" : "open days hit target" },
    ...(best ? [{ value: <Money value={best.sales} size={typeScale.bodyLg} weight="semibold" />, label: `best day · ${shortDate(best.date)}` }] : []),
    ...(closed > 0 ? [{ value: String(closed), label: closed === 1 ? "closed day" : "closed days" }] : []),
  ];
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md }}>
      {tiles.map((tile) => (
        <View key={tile.label} style={{ flex: 1, minWidth: 120, borderRadius: radius.md, backgroundColor: t.surfaceSunken, padding: space.sm + 2 }}>
          {typeof tile.value === "string" ? (
            <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.bodyLg, color: t.textPrimary }}>{tile.value}</T>
          ) : (
            tile.value
          )}
          <T variant="caption" style={{ marginTop: 2 }}>{tile.label}</T>
        </View>
      ))}
    </View>
  );
}

/** The detail of one tapped day: what was sold against what that day was allocated. */
function DaySheet({ row, date, onClose }: { row: DailyCoverageRow | null; date: string | null; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const visible = date !== null;
  const closed = row?.status === "closed";
  const target = row?.neededTarget ?? null;
  const max = Math.max(row?.sales ?? 0, target ?? 0, 1);
  const below = row?.status === "below";
  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? "none" : "slide"} statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.scrim, justifyContent: "flex-end", paddingTop: insets.top + space.md }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close day details" style={StyleSheet.absoluteFill} />
        <ContentScrollView
          accessibilityViewIsModal
          onStartShouldSetResponder={() => true}
          style={{ maxHeight: "90%", flexGrow: 0, width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", backgroundColor: t.surfaceRaised, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}
          contentContainerStyle={{
            backgroundColor: t.surfaceRaised,
            padding: space.lg,
            paddingBottom: space.lg + insets.bottom,
            gap: space.md,
          }}
        >
          <View style={{ alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: t.surfaceStrong }} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center", justifyContent: "space-between" }}>
            <T variant="title" accessibilityRole="header" style={{ color: t.textPrimary }}>
              {date ? longDate(date) : ""}
            </T>
            {row ? (
              <View
                style={{
                  borderRadius: radius.full,
                  paddingHorizontal: space.sm + 2,
                  paddingVertical: 4,
                  backgroundColor: closed ? t.surfaceMuted : below ? t.statusSurface.critical : t.statusSurface.good,
                }}
              >
                <T style={{ fontSize: typeScale.caption, fontFamily: font.sansSemibold, color: closed ? t.textMuted : below ? t.statusText.critical : t.statusText.good }}>
                  {closed ? "Closed" : below ? "Below target" : row.status === "at" ? "Reached target" : "Above target"}
                </T>
              </View>
            ) : null}
          </View>

          {!row ? (
            <T variant="caption">No record for this day.</T>
          ) : closed || target === null ? (
            <T style={{ fontSize: typeScale.bodySm, color: t.textSecondary }}>
              {closed ? "A closed day on your schedule, so it carries no target." : "The target for this day is unavailable."}{row.sales > 0 ? ` You still recorded ${formatMoney(row.sales, { decimals: true })}.` : ""}
            </T>
          ) : (
            <>
              <DayBar label="Sold" value={row.sales} max={max} color={below ? t.status.critical : t.status.good} />
              <DayBar label="Target" value={target} max={max} color={t.borderStrong} />
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderRadius: radius.md,
                  padding: space.md,
                  backgroundColor: below ? t.statusSurface.critical : t.statusSurface.good,
                }}
              >
                <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: below ? t.statusText.critical : t.statusText.good }}>
                  {below ? "Short by" : row.status === "at" ? "Right on target" : "Over by"}
                </T>
                {row.status === "at" ? null : (
                  <Money value={Math.abs(row.gap ?? 0)} size={typeScale.title} weight="semibold" color={below ? t.statusText.critical : t.statusText.good} />
                )}
              </View>
            </>
          )}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done"
            style={({ pressed }) => ({
              minHeight: TAP_FLOOR,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: t.borderStrong,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, color: t.textPrimary }}>Done</T>
          </Pressable>
        </ContentScrollView>
      </View>
    </Modal>
  );
}

function DayBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const t = useTheme();
  const dayData: ChartDatum[] = [{ key: label, label, values: [{ label, value, color }] }];
  const daySelection = useChartSelection(dayData);
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: space.sm }}>
        <T variant="caption">{label}</T>
        <Money value={value} size={typeScale.bodySm} weight="semibold" />
      </View>
      <ChartPlotPressArea selection={daySelection} count={1} chartLabel={label}>
      <View accessible={false} style={{ height: 22, borderRadius: radius.sm, backgroundColor: t.surfaceMuted, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, height: "100%", borderRadius: radius.sm, backgroundColor: color }} />
      </View>
      </ChartPlotPressArea>
      <ChartValueReadout data={dayData} selection={daySelection} chartLabel={label} />
    </View>
  );
}

// ---------------------------------------------------------------- weekly flags

/** The month's checkpoints as a row of flags: missed, met, next, and the finish. */
export function CheckpointFlags({ checkpoints, today }: { checkpoints: readonly RecoveryCheckpoint[]; today: string }) {
  const t = useTheme();
  const nextIndex = checkpoints.findIndex((c) => c.endDate > today);
  const checkpointData: ChartDatum[] = checkpoints.map((checkpoint) => ({ key: checkpoint.endDate, label: `${shortDate(checkpoint.endDate)} checkpoint`, values: [{ label: "Cumulative target", value: checkpoint.cumulativeTarget }, { label: "Sales recorded", value: checkpoint.recordedAmount, unavailableLabel: checkpoint.status === "pending" ? "Checkpoint ahead" : "Unavailable" }, { label: "Variance", value: checkpoint.variance, display: checkpoint.variance === null ? undefined : formatMoney(checkpoint.variance, { decimals: true, signed: true }), unavailableLabel: checkpoint.status === "pending" ? "Checkpoint ahead" : "Unavailable" }], note: checkpoint.status === "pending" ? "Pending checkpoint" : checkpoint.status === "behind" ? "Behind target" : checkpoint.status === "on_pace" ? "On pace" : "Ahead of target" }));
  const checkpointSelection = useChartSelection(checkpointData, today);
  return (
    <View style={{ marginTop: space.lg }}>
      <View
        style={{
          position: "absolute",
          left: `${50 / checkpoints.length}%`,
          right: `${50 / checkpoints.length}%`,
          top: 18,
          height: 4,
          borderRadius: 2,
          backgroundColor: t.surfaceStrong,
        }}
      />
      <View style={{ flexDirection: "row" }}>
        {checkpoints.map((c, i) => {
          const isNext = i === nextIndex;
          const isLast = i === checkpoints.length - 1;
          const passed = c.status !== "pending";
          const missed = c.status === "behind";
          const reachedPct = c.recordedAmount !== null && c.cumulativeTarget > 0 ? (c.recordedAmount / c.cumulativeTarget) * 100 : null;
          const bg = missed
            ? t.statusSurface.critical
            : passed
              ? t.brandFill
              : isNext
                ? t.ACCENT.fill
                : isLast
                  ? t.textPrimary
                  : t.surface;
          const border = missed ? t.statusBorder.critical : passed ? t.brandFill : isNext ? t.ACCENT.fill : isLast ? t.textPrimary : t.borderStrong;
          const ink = missed ? t.statusText.critical : passed ? t.onBrandFill : isNext ? t.ACCENT.onFill : isLast ? t.surface : t.textFaint;
          // A checkpoint still ahead that is neither next nor the finish stays an empty ring.
          const icon: keyof typeof Ionicons.glyphMap | null = missed
            ? "close"
            : passed
              ? "checkmark"
              : isNext
                ? "arrow-forward"
                : isLast
                  ? "star"
                  : null;
          return (
            <Pressable
              key={c.endDate}
              {...checkpointSelection.bind(i)}
              accessibilityRole="button"
              accessibilityLabel={`Checkpoint ${shortDate(c.endDate)}: ${
                passed
                  ? `${missed ? "missed" : "met"}, ${Math.round(reachedPct ?? 0)}% of ${formatMoney(c.cumulativeTarget)}`
                  : `${isNext ? "next, " : ""}target ${formatMoney(c.cumulativeTarget)}`
              }`}
              style={({ pressed }) => ({ flex: 1, minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", opacity: pressed ? 0.75 : 1 })}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: bg,
                  borderWidth: 2,
                  borderColor: checkpointSelection.selectedIndex === i ? t.textPrimary : border,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {icon ? <Ionicons name={icon} size={18} color={ink} /> : null}
              </View>
              <T style={{ fontSize: typeScale.micro, fontFamily: font.sansSemibold, color: t.textPrimary, marginTop: 6 }}>
                {shortDate(c.endDate)}
              </T>
              <T style={{ fontSize: typeScale.micro, fontFamily: font.mono, color: t.textMuted }}>
                {compactAmount(c.cumulativeTarget)}
              </T>
            </Pressable>
          );
        })}
      </View>
      <ChartValueReadout data={checkpointData} selection={checkpointSelection} chartLabel="Weekly checkpoints" />
    </View>
  );
}

// ---------------------------------------------------------------- why the daily number

/** Remaining target split across the remaining open days, drawn as one tile per day. */
export function DailyTargetBreakdown({ period }: { period: RecoveryReportingPeriod }) {
  const t = useTheme();
  const coveredShare = period.target > 0 ? Math.max(0, Math.min(100, (period.sales / period.target) * 100)) : 0;
  const tileCount = Math.max(0, Math.min(31, Math.round(period.remainingOperatingDays)));
  const daysText = formatOperatingDays(period.remainingOperatingDays, period.operatingDaysIsApproximated);
  const breakdownData: ChartDatum[] = [
    { ...periodCoverageDatum(period), key: "coverage", label: "Remaining target breakdown" },
    { key: "days", label: "Remaining operating days", values: [{ label: "Remaining target", value: period.remainingTarget }, { label: "Operating days", value: period.remainingOperatingDays, display: `${daysText} days` }, { label: "Adjusted daily target", value: period.adjustedDailyTarget, unavailableLabel: "Unavailable" }], note: period.operatingDaysIsApproximated ? "Operating days are estimated. Tiles show an approximate day count." : "Each tile represents one remaining operating day." },
  ];
  const breakdownSelection = useChartSelection(breakdownData);
  return (
    <View style={{ marginTop: space.md }}>
      <ChartPlotPressArea selection={breakdownSelection} count={breakdownData.length} chartLabel="Remaining target breakdown" indexAtPoint={() => 0}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${formatMoney(period.sales)} covered, ${formatMoney(Math.max(0, period.remainingTarget))} left of ${formatMoney(period.target)}`}
        style={{ flexDirection: "row", height: 34, borderRadius: radius.md, overflow: "hidden", backgroundColor: t.ACCENT.surface }}
      >
        <View style={{ width: `${coveredShare}%`, backgroundColor: t.brandFill, justifyContent: "center", paddingLeft: coveredShare > 18 ? 8 : 0 }}>
          {coveredShare > 18 ? (
            <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.micro, color: t.onBrandFill }}>{compactAmount(period.sales)}</T>
          ) : null}
        </View>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "flex-end", paddingRight: space.sm, borderWidth: 1, borderColor: t.accent[100], borderLeftWidth: 0, borderTopRightRadius: radius.md, borderBottomRightRadius: radius.md }}>
          <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.caption, color: t.ACCENT.text }}>
            {`${formatMoney(Math.max(0, period.remainingTarget))} left`}
          </T>
        </View>
      </View>
      </ChartPlotPressArea>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
        <T variant="caption">Covered</T>
        <T variant="caption">{`of ${formatMoney(period.target)}`}</T>
      </View>

      {tileCount > 0 && period.adjustedDailyTarget !== null ? (
        <>
          <View style={{ alignItems: "flex-end", paddingRight: space.xl, marginVertical: 2 }}>
            <Ionicons name="arrow-down" size={18} color={t.ACCENT.fillStrong} />
          </View>
          <ChartPlotPressArea selection={breakdownSelection} count={breakdownData.length} chartLabel="Remaining operating days" indexAtPoint={() => 1}>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={`${daysText} remaining open days, ${formatMoney(period.adjustedDailyTarget)} each`}
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}
          >
            {Array.from({ length: tileCount }, (_, i) => (
              <View key={i} style={{ width: "8.4%", aspectRatio: 1, borderRadius: 6, backgroundColor: t.ACCENT.fill }} />
            ))}
          </View>
          </ChartPlotPressArea>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: space.sm, marginTop: space.md }}>
            <T style={{ fontFamily: font.monoMedium, fontSize: typeScale.bodySm, color: t.textMuted }}>
              {`${formatMoney(Math.max(0, period.remainingTarget))} ÷ ${daysText} days =`}
            </T>
            <View style={{ borderRadius: radius.sm, borderWidth: 1.5, borderColor: t.accent[300], backgroundColor: t.ACCENT.surface, paddingHorizontal: space.sm, paddingVertical: 2 }}>
              <Money value={period.adjustedDailyTarget} size={typeScale.title} weight="semibold" />
            </View>
          </View>
        </>
      ) : null}
      <ChartValueReadout data={breakdownData} selection={breakdownSelection} chartLabel="Daily target breakdown" />
    </View>
  );
}
