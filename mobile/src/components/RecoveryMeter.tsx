import { View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Money, T } from "./ui";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "./ChartInteraction";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { dayStatusTone } from "../lib/recoveryTone";
import { resolveMonthStatus } from "../lib/recoveryStatus";
import type { RecoveryTargets } from "../lib/types";

/**
 * The Recovery Meter — the product's signature component, and one of only two
 * places the amber accent appears (the other being primary CTAs).
 *
 * Amber marks the ADJUSTED DAILY TARGET only: the number that answers "what
 * does today need to look like?". The progress bars stay on the status palette,
 * because those encode good/bad and amber must not start meaning "warning".
 *
 * Renders purely from the backend's computed object — no arithmetic here, so
 * Dashboard and the Recovery screen cannot drift apart, and neither can mobile
 * and web.
 */

export function RecoveryMeter({
  data,
  hideStatusPill = false,
}: {
  data: RecoveryTargets;
  /**
   * RecoveryTargetScreen already shows a dedicated EmptyState illustration
   * for `monthHasNoRecords` right above this meter — without this, its own
   * "No sales recorded yet this month" pill repeats the same message a
   * second time in the same scroll view.
   */
  hideStatusPill?: boolean;
}) {
  const t = useTheme();
  const { ACCENT, ink, paper, statusText, status } = t;
  const monthRatio = Math.min(data.monthCoveragePercent / 100, 1);
  const monthStatus = resolveMonthStatus(data);
  const monthFill = status[monthStatus.tone];
  const monthInk = statusText[monthStatus.tone];
  // Kept for the one remaining boolean-driven line below (the "add expected
  // expenses" hint), which only applies to `needs_setup`.
  const needsSetupNow = data.status ? data.status === "needs_setup" : !!data.needsSetup;

  // `todaysStatus` is never "closed" — `dayStatusTone` never returns "muted"
  // for it, so `status`/`statusText`/`statusSurface` (which have no "muted"
  // entry) are always safe to index here.
  const todayTone = dayStatusTone(data.todaysStatus) as "good" | "warning" | "critical";
  const todayFill = status[todayTone];
  const todayInk = statusText[todayTone];
  const todayRatio =
    data.todaysTarget > 0 ? Math.min(data.todaysSales / data.todaysTarget, 1) : data.todaysSales > 0 ? 1 : 0;
  /*
    The soft surface behind today's panel. Literals for the same reason
    InsightsScreens gives: tokens.ts carries the status FILLS and the darkened
    TEXT steps but no tinted backgrounds, and it is a hand-kept mirror of
    web's config — adding a scale on mobile alone would put the two out of step.
  */
  const todaySurface = t.statusSurface[todayTone];

  return (
    <View>
      {hideStatusPill ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.sm }}>
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: monthInk,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <T style={{ color: t.textOnFill, fontSize: typeScale.micro }}>{monthStatus.glyph}</T>
          </View>
          <T style={{ color: monthInk, fontSize: typeScale.bodySm }}>{monthStatus.copy}</T>
        </View>
      )}
      {needsSetupNow ? (
        <T variant="caption" style={{ marginBottom: space.sm }}>
          Add a starting monthly expense estimate to calculate your target.
        </T>
      ) : null}

      <Bar ratio={monthRatio} color={monthFill} height={12} label="Month-to-date coverage" detail={{ key: data.asOfDate ?? "month", label: "Month-to-date coverage", values: [{ label: "Sales recorded", value: data.salesThisMonth }, { label: "Expense basis", value: needsSetupNow ? null : data.expectedMonthlyExpenses, unavailableLabel: "Needs setup" }, { label: "Coverage", value: needsSetupNow ? null : data.monthCoveragePercent, display: needsSetupNow ? undefined : `${data.monthCoveragePercent.toFixed(1)}%`, unavailableLabel: "Needs setup" }], note: monthStatus.copy }} />
      <T variant="caption" style={{ marginTop: 6 }}>
        <Money value={data.salesThisMonth} size={12} weight="regular" color={ink[500]} /> of{" "}
        <Money value={data.expectedMonthlyExpenses} size={12} weight="regular" color={ink[500]} /> needed this month (
        {data.monthCoveragePercent.toFixed(0)}%)
      </T>

      <View style={{ flexDirection: "row", gap: space.md, marginTop: space.lg }}>
        <View style={{ flex: 1 }}>
          <T variant="caption">Daily needed target</T>
          <Money value={data.dailyNeededTarget} size={15} style={{ marginTop: 2 }} />
        </View>
        {/* The accent moment. */}
        <View style={{ flex: 1, backgroundColor: ACCENT.surface, borderRadius: radius.sm, padding: space.sm }}>
          <T variant="caption" style={{ color: ACCENT.text }}>
            Adjusted daily target
          </T>
          <Money value={data.adjustedDailyTarget} size={15} weight="semibold" color={ACCENT.text} style={{ marginTop: 2 }} />
        </View>
      </View>

      <T variant="caption" style={{ marginTop: 6 }}>
        <Money value={data.remainingTarget} size={12} weight="regular" color={ink[500]} /> across{" "}
        {data.remainingOperatingDays} remaining open day{data.remainingOperatingDays === 1 ? "" : "s"}.
      </T>

      {/*
        Today, given a panel of its own.
        
        It answers a different question from everything above it — those are
        about the month, this is about the shift the owner is currently
        standing in — and separated only by a rule it read as the last row of
        the month's figures. The tint is the status colour's own surface, so
        a day that is behind looks behind before a word is read.
      */}
      <View
        style={{
          marginTop: space.lg,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: todaySurface,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.sm }}>
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: paper.DEFAULT,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="calendar-outline" size={16} color={todayInk} />
          </View>
          <T style={{ flex: 1, fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansSemibold }}>Today</T>
          <T style={{ color: todayInk, fontSize: typeScale.caption }}>
            {data.todaysStatus === "at" ? (
              "Reached target"
            ) : (
              <>
                <Money value={Math.abs(data.todaysGap)} size={12} weight="regular" color={todayInk} />{" "}
                {data.todaysStatus} target
              </>
            )}
          </T>
        </View>
        <Bar ratio={todayRatio} color={todayFill} height={8} label="Today's progress" detail={{ key: data.asOfDate ?? "today", label: "Today's progress", values: [{ label: "Sales recorded", value: data.todaysSales }, { label: "Today's target", value: needsSetupNow ? null : data.todaysTarget, unavailableLabel: "Needs setup" }, { label: "Gap", value: needsSetupNow ? null : data.todaysGap, unavailableLabel: "Needs setup" }], note: data.todaysStatus === "at" ? "Reached target" : `${data.todaysStatus === "below" ? "Below" : "Above"} target` }} />
        <T variant="caption" style={{ marginTop: 6 }}>
          <Money value={data.todaysSales} size={12} weight="regular" color={ink[500]} /> recorded of{" "}
          <Money value={data.todaysTarget} size={12} weight="regular" color={ink[500]} /> needed today
        </T>
      </View>
    </View>
  );
}

function Bar({ ratio, color, height, label, detail }: { ratio: number; color: string; height: number; label: string; detail: ChartDatum }) {
  const t = useTheme();
  const { ink } = t;
  const barData = [detail];
  const barSelection = useChartSelection(barData);
  return (
    <View>
    <ChartPlotPressArea selection={barSelection} count={1} chartLabel={label}>
    <View
      // Without `accessible`, RN leaves `isAccessibilityElement` false and the
      // role/label/value below are set on a view the platform never surfaces —
      // the bar is announced as nothing at all. Same fix, same reason, as the
      // Spending Impact gauge.
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(ratio * 100) }}
      style={{ height, backgroundColor: ink[100], borderRadius: height / 2, overflow: "hidden" }}
    >
      <View style={{ width: `${ratio * 100}%`, height: "100%", backgroundColor: color, borderRadius: height / 2 }} />
    </View>
    </ChartPlotPressArea>
    <ChartValueReadout data={barData} selection={barSelection} chartLabel={label} />
    </View>
  );
}
