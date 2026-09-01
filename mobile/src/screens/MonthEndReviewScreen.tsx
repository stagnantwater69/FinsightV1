import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Callout, Card, ErrorNote, Money, Screen, ScreenHeader, T } from "../components/ui";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useInsight } from "../lib/useInsight";
import { formatMoney } from "../lib/money";
import { formatMonthLabel, lastMonthKey, shiftMonthKey } from "../lib/monthEndReview";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { RecoveryMonthEndReview } from "../lib/types";

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
export function MonthEndReviewScreen({ navigation }: any) {
  const { selected } = useBusinessProfiles();
  const [month, setMonth] = useState(() => lastMonthKey());

  const { data, loading, error } = useInsight<RecoveryMonthEndReview>(
    "/insights/recovery/month-end-review",
    { businessProfileId: selected?.id, month },
    [selected?.id, month],
  );

  if (!selected) return null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
        <ScreenHeader
          eyebrow="Recovery target"
          title="Month-end review"
          subtitle="A summary of how a completed month went, once it's over. Nothing here changes your Sales Coverage Target or your business profile."
        />

        <MonthPicker month={month} onChange={setMonth} />

        {loading && !data ? (
          <T variant="caption">Loading…</T>
        ) : error && !data ? (
          <ErrorNote>{error}</ErrorNote>
        ) : data?.status === "not_yet_reviewable" ? (
          <Card>
            <T variant="caption" style={{ lineHeight: 19 }}>
              This month isn't over yet, so there's nothing to review. Once it ends (business-locally), come back and
              pick it here to see how it went.
            </T>
          </Card>
        ) : data?.status === "reviewable" ? (
          <ReviewContent data={data} navigation={navigation} />
        ) : null}
      </ScrollView>
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
        borderRadius: radius.md,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      }}
    >
      <Pressable
        onPress={() => onChange(shiftMonthKey(month, -1))}
        accessibilityRole="button"
        accessibilityLabel="Previous month"
        style={{ padding: space.sm }}
      >
        <Ionicons name="chevron-back" size={20} color={t.textPrimary} />
      </Pressable>
      <T style={{ fontFamily: font.sansSemibold, fontSize: typeScale.body }}>{formatMonthLabel(month)}</T>
      <Pressable
        onPress={() => onChange(shiftMonthKey(month, 1))}
        accessibilityRole="button"
        accessibilityLabel="Next month"
        style={{ padding: space.sm }}
      >
        <Ionicons name="chevron-forward" size={20} color={t.textPrimary} />
      </Pressable>
    </View>
  );
}

function ReviewContent({
  data,
  navigation,
}: {
  data: Extract<RecoveryMonthEndReview, { status: "reviewable" }>;
  navigation: any;
}) {
  const t = useTheme();
  const { statusText, paper } = t;
  const surplus = data.surplusOrShortfall >= 0;

  return (
    <View style={{ gap: space.lg }}>
      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm }}>
          Coverage for {formatMonthLabel(data.month)}
        </T>
        <T style={{ fontFamily: font.monoSemibold, fontSize: typeScale.titleLg, marginBottom: 2 }}>
          {data.coveragePercent.toFixed(1)}%
        </T>
        <T
          style={{
            fontSize: typeScale.bodySm,
            color: surplus ? statusText.good : statusText.critical,
          }}
        >
          {`${formatMoney(Math.abs(data.surplusOrShortfall))} ${surplus ? "surplus" : "shortfall"}`}
        </T>
      </Card>

      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm }}>
          Strongest and weakest open day
        </T>
        <DayRow label="Strongest open day" day={data.strongestOpenDay} tint={statusText.good} />
        <View style={{ height: 1, backgroundColor: paper[200], marginVertical: space.sm }} />
        <DayRow label="Weakest open day" day={data.weakestOpenDay} tint={statusText.critical} />
      </Card>

      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm }}>
          Data completeness
        </T>
        <T style={{ fontSize: typeScale.bodySm }}>
          {data.missingOrProvisionalDayCount} of {data.openDayCount} open days missing or still provisional
        </T>
      </Card>

      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm }}>
          Original vs. final adjusted daily target
        </T>
        <View style={{ flexDirection: "row", gap: space.lg }}>
          <View style={{ flex: 1 }}>
            <T variant="label" style={{ marginBottom: 4 }}>
              Original
            </T>
            <Money value={data.originalDailyTarget} size={typeScale.body} weight="semibold" />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="label" style={{ marginBottom: 4 }}>
              Final adjusted
            </T>
            {data.finalAdjustedDailyTarget === null ? (
              <T variant="caption" style={{ lineHeight: 17 }}>
                Not available — the month's last open day couldn't produce a meaningful per-day rate.
              </T>
            ) : (
              <Money value={data.finalAdjustedDailyTarget} size={typeScale.body} weight="semibold" />
            )}
          </View>
        </View>
      </Card>

      {data.baselineAppearsOffFromPattern ? (
        <Callout tone="info">
          Your configured expected monthly expenses may not match the sales pattern actually recorded this month.
          This is just something to be aware of — nothing here changes your setup automatically.
        </Callout>
      ) : null}

      <Card>
        <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm }}>
          Questions worth thinking about for next month
        </T>
        {data.suggestedQuestionsForNextMonth.map((q, i) => (
          <View
            key={i}
            style={{ flexDirection: "row", gap: space.sm, marginBottom: i === data.suggestedQuestionsForNextMonth.length - 1 ? 0 : space.sm }}
          >
            <T style={{ fontSize: typeScale.bodySm }}>•</T>
            <T style={{ flex: 1, fontSize: typeScale.bodySm, lineHeight: 19 }}>{q}</T>
          </View>
        ))}
        <T variant="caption" style={{ marginTop: space.md, lineHeight: 17 }}>
          These are just things to think about — nothing here is applied automatically. Change any setting yourself,
          on your own terms, on the business profile screen.
        </T>
        <Pressable
          onPress={() => navigation.navigate("More", { screen: "BusinessProfileForm" })}
          accessibilityRole="button"
          accessibilityLabel="Edit business profile"
          style={{ marginTop: space.md }}
        >
          <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.brandText }}>
            Edit business profile
          </T>
        </Pressable>
      </Card>
    </View>
  );
}

function DayRow({
  label,
  day,
  tint,
}: {
  label: string;
  day: { date: string; sales: number } | null;
  tint: string;
}) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      <View>
        <T variant="label">{label}</T>
        <T variant="caption">{day ? day.date : "No open days this month"}</T>
      </View>
      {day ? <Money value={day.sales} size={typeScale.body} weight="semibold" color={tint} /> : null}
    </View>
  );
}
