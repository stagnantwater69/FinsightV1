import { ContentScrollView } from "../components/ContentScrollView";
import { useState } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import Svg, { Circle } from "react-native-svg";
import { ConnectionNotice, FreshnessStatus } from "../components/ConnectionNotice";
import { Callout, Card, Disclosure, Money, Screen, T } from "../components/ui";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { describeLoadFailure, toLoadFailure } from "../lib/connectionState";
import { useInsight } from "../lib/useInsight";
import { formatMoney } from "../lib/money";
import { formatFinancialDate, monthlyExpenseBasisProvenance } from "../lib/financialPosition";
import { formatMonthLabel, lastMonthKey, shiftMonthKey } from "../lib/monthEndReview";
import { font, radius, space, typeScale } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import type { BusinessProfile, RecoveryMonthEndReview } from "../lib/types";
import { ChartPlotPressArea, ChartValueReadout, useChartSelection, type ChartDatum } from "../components/ChartInteraction";
import { KpiWatermark } from "../components/KpiWatermark";
import type { MoreScreenProps } from "../navigation/types";

/**
 * Month-end review — Recovery Target Improvement Plan §10.9/§11 Phase 7.
 * `GET /insights/recovery/month-end-review`.
 *
 * REACHED FROM RecoveryTargetScreen via a small "View last month's summary"
 * link, same shape as OperatingScheduleScreen/RecoveryNotificationPreferences
 * before it — registered on MoreStack in App.tsx even though every entry
 * point to it lives on the Insights tab, because those two screens already
 * established that pattern for "a settings/data screen one hop off Recovery
 * Target" on this app.
 *
 * CRITICAL, per the plan's own repeated emphasis: `suggestedQuestionsForNextMonth`
 * are plain informational strings for the owner to think about, never
 * actionable prompts. There is no per-question button here, and nothing on
 * this screen ever calls a settings-mutating endpoint — the one
 * call-to-action ("Edit business profile") is a plain navigation link to the
 * existing, manual edit screen.
 */
export function MonthEndReviewScreen({ navigation }: MoreScreenProps<"MonthEndReview">) {
  const { selected } = useBusinessProfiles();
  const [month, setMonth] = useState(() => lastMonthKey());

  const reviewState = useInsight<RecoveryMonthEndReview>(
    "/insights/recovery/month-end-review",
    { businessProfileId: selected?.id, month },
    [selected?.id, month],
    { enabled: Boolean(selected) },
  );
  const { data, loading, refreshing, lastUpdatedAt, load } = reviewState;
  const notice = describeLoadFailure(
    reviewState.rawError ? toLoadFailure(reviewState.rawError) : null,
    {
      hasData: data !== null,
      lastUpdatedAt,
      subject: "these month-end details",
    },
  );

  if (!selected) return null;

  return (
    <Screen>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
        <MonthPicker month={month} onChange={setMonth} />

        <ConnectionNotice notice={notice} onRetry={load} busy={loading || refreshing} />
        <FreshnessStatus at={lastUpdatedAt} now={Date.now()} refreshing={refreshing} />

        {loading && !data ? (
          <T variant="caption">Loading…</T>
        ) : data?.status === "not_yet_reviewable" ? (
          <PendingReview month={data.month} />
        ) : data?.status === "reviewable" ? (
          <ReviewContent data={data} navigation={navigation} businessProfile={selected} />
        ) : null}
      </ContentScrollView>
    </Screen>
  );
}

/** Plain prev/next arrows around a month label — no calendar grid, since only the month itself is ever chosen here. */
function MonthPicker({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: t.surfaceRaised,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: t.border,
        paddingHorizontal: space.xs,
        paddingVertical: space.xs,
      }}
    >
      <Pressable
        onPress={() => onChange(shiftMonthKey(month, -1))}
        accessibilityRole="button"
        accessibilityLabel="Previous month"
        style={{ padding: space.sm, minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
      >
        <Ionicons name="chevron-back" size={20} color={t.textPrimary} />
      </Pressable>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm }}>
        <Ionicons name="calendar-outline" size={18} color={t.textPrimary} accessible={false} />
        <T style={{ flexShrink: 1, textAlign: "center", fontFamily: font.sansSemibold, fontSize: typeScale.body }}>{formatMonthLabel(month)}</T>
      </View>
      <Pressable
        onPress={() => onChange(shiftMonthKey(month, 1))}
        accessibilityRole="button"
        accessibilityLabel="Next month"
        style={{ padding: space.sm, minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
      >
        <Ionicons name="chevron-forward" size={20} color={t.textPrimary} />
      </Pressable>
    </View>
  );
}

function PendingReview({ month }: { month: string }) {
  const t = useTheme();
  return (
    <Card style={{ alignItems: "center", gap: space.md, paddingVertical: space.xxl }}>
      <View style={{ width: 64, height: 64, borderRadius: radius.full, backgroundColor: t.brandSurface, alignItems: "center", justifyContent: "center" }}><Ionicons name="calendar-outline" size={30} color={t.brandText} accessible={false} /></View>
      <T accessibilityRole="header" style={{ color: t.brandHeading, fontFamily: font.sansSemibold, fontSize: typeScale.title, textAlign: "center" }}>{formatMonthLabel(month)} isn't ready to review</T>
      <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22, textAlign: "center" }}>A review is available once this month ends in your business's local time. Choose an earlier month to review its records.</T>
    </Card>
  );
}

function ReviewContent({
  data,
  navigation,
  businessProfile,
}: {
  data: Extract<RecoveryMonthEndReview, { status: "reviewable" }>;
  navigation: MoreScreenProps<"MonthEndReview">["navigation"];
  businessProfile: BusinessProfile;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 360 || fontScale > 1.2;
  const shortfall = data.surplusOrShortfall < 0;
  const aboveBasis = data.surplusOrShortfall > 0;
  const coverage = Number.isFinite(data.coveragePercent) ? data.coveragePercent.toFixed(1) : null;
  const coverageFontSize = coverage === null ? typeScale.bodySm : coverage.length > 6 ? typeScale.bodySm : coverage.length > 4 ? typeScale.title : typeScale.titleLg;
  const progress = Number.isFinite(data.coveragePercent) ? Math.max(0, Math.min(100, data.coveragePercent)) : 0;
  const circumference = 2 * Math.PI * 50;
  const missing = data.missingOrProvisionalDayCount > 0;
  const sourceLabel = data.monthlyExpenseBasis?.source === "previous_complete_month" ? "Confirmed expense records" : "Starting estimate";
  const coverageData: ChartDatum[] = [{ key: data.month, label: `${formatMonthLabel(data.month)} sales coverage`, values: [{ label: "Expense basis", value: data.monthlyExpenseBasis?.amount ?? null, unavailableLabel: "Unavailable" }, { label: "Coverage", value: Number.isFinite(data.coveragePercent) ? data.coveragePercent : null, display: coverage === null ? undefined : `${coverage}%`, unavailableLabel: "Unavailable" }, { label: shortfall ? "Shortfall" : "Above expense basis", value: Math.abs(data.surplusOrShortfall) }], note: `${sourceLabel}. Sales above the expense basis are not a measure of profit.${missing ? " Some open days need complete sales records." : ""}` }];
  const coverageSelection = useChartSelection(coverageData, data.month);

  return (
    <View style={{ gap: space.lg }}>
      <View style={{ backgroundColor: t.brandSolidPressed, borderRadius: radius.xl, padding: space.lg, gap: space.md }}>
        <KpiWatermark name="stats-chart-outline" color={t.onBrandSolid} opacity={0.065} borderRadius={radius.xl} />
        <T accessibilityRole="header" style={{ color: t.onBrandSolid, fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>Sales coverage</T>
        <View style={{ flexDirection: stacked ? "column" : "row", alignItems: "center", gap: space.lg }}>
          <ChartPlotPressArea selection={coverageSelection} count={1} chartLabel="Month-end sales coverage" style={{ width: 116, height: 116 }}>
          <View accessible accessibilityRole="progressbar" accessibilityLabel={`Sales coverage for ${formatMonthLabel(data.month)}: ${coverage === null ? "unavailable" : `${coverage}% covered`}`} accessibilityValue={{ min: 0, max: 100, now: progress, text: coverage === null ? "Unavailable" : `${coverage}% covered` }} style={{ width: 116, height: 116, alignItems: "center", justifyContent: "center" }}>
            <Svg width={116} height={116} viewBox="0 0 116 116" {...(Platform.OS === "web" ? { "aria-hidden": true } : { accessible: false })} style={{ position: "absolute" }}>
              <Circle cx={58} cy={58} r={50} fill="none" stroke={t.onBrandSolidMuted + "35"} strokeWidth={9} />
              {progress > 0 ? <Circle cx={58} cy={58} r={50} fill="none" stroke={t.onBrandSolidMuted} strokeWidth={9} strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - progress / 100)} strokeLinecap="round" transform="rotate(-90 58 58)" /> : null}
            </Svg>
            <T style={{ maxWidth: 96, color: t.onBrandSolid, fontFamily: font.sansSemibold, fontSize: coverageFontSize, lineHeight: 32, textAlign: "center" }}>{coverage === null ? "Unavailable" : `${coverage}%`}</T>
            <T style={{ color: t.onBrandSolidMuted, fontSize: typeScale.bodySm }}>{coverage === null ? "coverage" : "covered"}</T>
          </View>
          </ChartPlotPressArea>
          <View style={{ flex: stacked ? undefined : 1, width: stacked ? "100%" : undefined, gap: space.sm, alignItems: stacked ? "center" : "flex-start" }}>
            <Money value={Math.abs(data.surplusOrShortfall)} decimals size={typeScale.titleLg} weight="semibold" color={t.onBrandSolid} style={{ alignSelf: "stretch", textAlign: stacked ? "center" : "left" }} />
            <T style={{ color: t.onBrandSolidMuted, fontFamily: font.sansMedium, fontSize: typeScale.bodyLg, lineHeight: 24, textAlign: stacked ? "center" : "left" }}>{shortfall ? "still to cover" : aboveBasis ? "Above expense basis" : "Expense basis covered"}</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.full, backgroundColor: shortfall ? t.ACCENT.fill : t.onBrandSolidMuted }}>
              <Ionicons name={shortfall ? "alert-circle" : "checkmark-circle"} size={16} color={shortfall ? t.ACCENT.onFill : t.brandSolidPressed} accessible={false} />
              <T style={{ flexShrink: 1, color: shortfall ? t.ACCENT.onFill : t.brandSolidPressed, fontFamily: font.sansMedium, fontSize: typeScale.label }}>{shortfall ? "Below target" : aboveBasis ? "Above basis" : "Covered"}</T>
            </View>
          </View>
        </View>
        <T style={{ color: t.onBrandSolid, fontSize: typeScale.bodySm, lineHeight: 22, textAlign: "center" }}>Sales compared with expense basis</T>
        <ChartValueReadout data={coverageData} selection={coverageSelection} chartLabel="Month-end sales coverage" />
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: missing ? t.statusSurface.warning : t.surface, borderRadius: radius.md, padding: space.md }}>
        <Ionicons name={missing ? "alert-circle-outline" : data.openDayCount > 0 ? "checkmark-circle-outline" : "calendar-outline"} size={24} color={missing ? t.statusText.warning : t.textSecondary} accessible={false} />
        <T style={{ flex: 1, color: missing ? t.statusText.warning : t.textSecondary, fontFamily: font.sansMedium, fontSize: typeScale.bodySm, lineHeight: 22 }}>{data.openDayCount === 0 ? "No open days this month" : missing ? `${data.missingOrProvisionalDayCount} of ${data.openDayCount} open days need complete sales records` : `Sales records are complete for all ${data.openDayCount} open days.`}</T>
      </View>

      {data.monthlyExpenseBasis ? (
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
            <Ionicons name="calculator-outline" size={24} color={t.textSecondary} accessible={false} />
            <View style={{ flex: 1, gap: space.xs }}>
              <T accessibilityRole="header" style={{ fontFamily: font.sansSemibold, fontSize: typeScale.bodyLg }}>Expense basis</T>
              <T variant="caption">{sourceLabel}</T>
              <Money value={data.monthlyExpenseBasis.amount} decimals size={typeScale.title} weight="semibold" style={{ flexShrink: 1 }} />
            </View>
          </View>
          <Disclosure title="How this is calculated">
            <View style={{ gap: space.sm, paddingTop: space.sm }}>
              <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22 }}>{monthlyExpenseBasisProvenance(data.monthlyExpenseBasis)}</T>
              <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22 }}>Sales coverage compares recorded sales with this expense basis. Amounts above the basis are not a measure of profit.</T>
            </View>
          </Disclosure>
        </Card>
      ) : null}

      <View style={{ gap: space.md }}>
        <SectionHeading>Sales day highlights</SectionHeading>
        <View style={{ flexDirection: stacked ? "column" : "row", gap: space.md }}>
          <DayTile label="Strongest day" day={data.strongestOpenDay} strong />
          <DayTile label="Weakest day" day={data.weakestOpenDay} />
        </View>
      </View>

      <View style={{ gap: space.md }}>
        <SectionHeading>Daily target</SectionHeading>
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "center", gap: space.md }}>
            <View style={{ flex: stacked ? undefined : 1, gap: space.xs }}>
              <T variant="label">Original</T>
              <Money value={data.originalDailyTarget} decimals size={typeScale.title} weight="semibold" />
            </View>
            <Ionicons name={stacked ? "arrow-down" : "arrow-forward"} size={22} color={t.textMuted} accessible={false} />
            <View style={{ flex: stacked ? undefined : 1, gap: space.xs }}>
              <T variant="label">Final adjusted</T>
              {data.finalAdjustedDailyTarget === null ? <T style={{ color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22 }}>Not available because the month's last open day could not produce a meaningful per-day rate.</T> : <Money value={data.finalAdjustedDailyTarget} decimals size={typeScale.title} weight="semibold" />}
            </View>
          </View>
          <T variant="caption" style={{ textAlign: "center" }}>For this completed month.</T>
        </Card>
      </View>

      {data.baselineAppearsOffFromPattern ? <Callout tone="info">Your monthly expense basis may not match the sales pattern recorded this month. This note does not change your starting estimate or record coverage.</Callout> : null}

      <View style={{ gap: space.md }}>
        <SectionHeading>Next month: what to check</SectionHeading>
        <Card style={{ gap: space.md }}>
          {data.suggestedQuestionsForNextMonth.map((q, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, borderTopWidth: i ? 1 : 0, borderTopColor: t.border, paddingTop: i ? space.md : 0 }}>
              <View style={{ minWidth: 28, minHeight: 28, borderRadius: radius.full, backgroundColor: t.brandSurface, alignItems: "center", justifyContent: "center", padding: space.xs }}><T style={{ color: t.brandText, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>{i + 1}</T></View>
              <T style={{ flex: 1, color: t.textSecondary, fontSize: typeScale.bodySm, lineHeight: 22 }}>{q}</T>
            </View>
          ))}
          {data.suggestedQuestionsForNextMonth.length === 0 ? <T variant="caption">No questions provided for this month.</T> : null}
        </Card>
        <T variant="caption" style={{ lineHeight: 19 }}>These are questions to consider. Nothing here changes your financial settings or records.</T>
        <Pressable onPress={() => navigation.navigate("More", { screen: "BusinessProfileForm", params: { profile: businessProfile } })} accessibilityRole="button" accessibilityLabel="Edit business profile" style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, borderWidth: 1, borderColor: t.brandText, borderRadius: radius.md, opacity: pressed ? 0.7 : 1 })}>
          <Ionicons name="create-outline" size={20} color={t.brandText} accessible={false} /><T style={{ flexShrink: 1, color: t.brandText, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm, textAlign: "center" }}>Edit business profile</T>
        </Pressable>
      </View>
    </View>
  );
}

function SectionHeading({ children }: { children: string }) {
  const t = useTheme();
  return <T accessibilityRole="header" style={{ color: t.brandHeading, fontFamily: font.sansSemibold, fontSize: typeScale.title, lineHeight: 26 }}>{children}</T>;
}

function DayTile({ label, day, strong = false }: { label: string; day: { date: string; sales: number } | null; strong?: boolean }) {
  const t = useTheme();
  const shortDate = day ? new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  return (
    <View accessible accessibilityLabel={day ? `${label}: ${formatFinancialDate(day.date)}, ${formatMoney(day.sales, { decimals: true })} recorded sales` : `${label}: No open days this month`} style={{ flex: 1, backgroundColor: strong ? t.brandSurface : t.surface, borderWidth: 1, borderColor: t.border, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}><Ionicons name={strong ? "trending-up" : "trending-down"} size={22} color={strong ? t.brandText : t.textSecondary} accessible={false} /><T style={{ flex: 1, color: t.textSecondary, fontSize: typeScale.bodySm }}>{label}</T></View>
      {day ? <Money value={day.sales} decimals size={typeScale.title} weight="semibold" style={{ flexShrink: 1 }} /> : null}
      <T variant="caption">{shortDate ?? "No open days this month"}</T>
    </View>
  );
}
