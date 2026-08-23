import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Callout, Card, ErrorNote, Money, Screen, T } from "../components/ui";
import { RecoveryMeter } from "../components/RecoveryMeter";
import { SkeletonCard } from "../components/Skeleton";
import { CoverageColumns } from "../components/charts";
import { AskFinSight } from "../components/AskFinSight";
import { AskFinSightFab, FAB_CLEARANCE } from "../components/AskFinSightFab";
import { InsightHeader, Medallion } from "../components/InsightsShared";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useInsight } from "../lib/useInsight";
import { font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { RecoveryInsight } from "../lib/types";

// ---------------------------------------------------------------- Recovery target

export function RecoveryTargetScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, paper, statusText } = t;
  const { selected } = useBusinessProfiles();
  const [askOpen, setAskOpen] = useState(false);
  const { data, loading, error } = useInsight<RecoveryInsight>(
    "/insights/recovery",
    { businessProfileId: selected?.id, coverageDays: 14 },
    [selected?.id]
  );

  if (!selected) return null;

  return (
    <Screen safeTop>
      <ScrollView
        // The FAB floats over this list, so the scroll has to end far enough
        // up that it can never cover the last card.
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl + FAB_CLEARANCE }}
      >
        <InsightHeader navigation={navigation} active="RecoveryTarget" title="Recovery target" />

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {loading || !data ? (
          <View style={{ gap: space.lg }}>
            <SkeletonCard style={{ height: 120 }} />
            <SkeletonCard style={{ height: 150 }} />
            <SkeletonCard style={{ height: 140 }} />
            <SkeletonCard style={{ height: 180 }} />
          </View>
        ) : (
          <View style={{ gap: space.lg }}>
            {/*
              SAID BEFORE THE FIGURES, because without it the figures are a
              false accusation.

              Recovery is month-to-date and has no period to select, so imported
              history that stops months ago shows zero sales against the full
              monthly target — a screen confidently reporting that the owner
              missed everything, in a month they never traded in. The arithmetic
              is right; this is the sentence that makes it honest.
            */}
            {data.monthHasNoRecords ? (
              <Callout tone="warn">
                No sales are recorded for this month yet, so every figure below compares your target
                against zero. It isn't a shortfall you've made — there's simply nothing in this month
                to measure.
                {data.latestSaleDate
                  ? ` Your most recent sale is dated ${new Date(data.latestSaleDate).toLocaleDateString(
                      undefined,
                      { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" },
                    )}.`
                  : ""}
              </Callout>
            ) : null}

            <Card>
              <RecoveryMeter data={data} />
            </Card>

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>Remaining recovery target</T>
              <T variant="caption" style={{ marginBottom: space.md }}>
                Recalculated across your remaining operating days. This is an estimate — your profile records how many
                days a month you operate, not which days.
              </T>
              {/*
                Four lines that are read as a calculation, so each one is
                given a glyph: the eye can then follow expenses → sales →
                what is left → over how many days, without re-reading the
                labels every time it returns to the card.
              */}
              <Row
                icon="wallet-outline"
                label="Expected monthly expenses"
                value={data.expectedMonthlyExpenses}
                first
              />
              <Row icon="bar-chart-outline" label="Sales reference so far" value={data.salesThisMonth} />
              <Row
                icon="flag-outline"
                label="Remaining target"
                value={data.remainingTarget}
                tint={statusText.critical}
              />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.sm,
                  paddingVertical: space.sm,
                  borderTopWidth: 1,
                  borderTopColor: paper[200],
                }}
              >
                <Medallion icon="calendar-outline" tint={brand[700]} surface={brand[50]} size={28} />
                <T style={{ flex: 1, fontSize: typeScale.bodySm }}>Remaining operating days</T>
                <T style={{ fontSize: typeScale.bodySm, fontFamily: font.monoMedium }}>≈ {data.remainingOperatingDays}</T>
              </View>
            </Card>

            {/*
              The columns show the run of days at a glance and where the
              target line sits; the rows below keep the exact figure and the
              gap for each day, which a 110px chart cannot carry.
            */}
            <Card>
              <CoverageColumns
                data={data.dailyCoverage.map((d) => ({ date: d.date, amount: d.sales }))}
                target={data.dailyNeededTarget}
                subtitle="Sales each day against the target, in PHP"
              />
            </Card>

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.md }}>Day by day</T>
              {data.dailyCoverage.map((d, i) => {
                const c =
                  d.status === "below" ? statusText.critical : d.status === "at" ? statusText.warning : statusText.good;
                return (
                  <View
                    key={d.date}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      paddingVertical: space.sm,
                      gap: space.sm,
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: paper[200],
                    }}
                  >
                    <T variant="caption" style={{ width: 56, fontFamily: font.monoMedium }}>{d.date.slice(5)}</T>
                    <Money value={d.sales} size={13} weight="medium" />
                    <View style={{ flex: 1, alignItems: "flex-end" }}>
                      <T style={{ fontSize: typeScale.caption, color: c }}>
                        {d.status === "at"
                          ? "Reached"
                          : `${Math.round(Math.abs(d.gap)).toLocaleString("en-PH")} ${d.status}`}
                      </T>
                    </View>
                  </View>
                );
              })}
            </Card>
          </View>
        )}
      </ScrollView>

      {/*
        Outside the ScrollView so it stays put while the page moves under it —
        the same placement and the same reasoning as Home. The question an
        owner wants to ask an insight is usually prompted by something they
        have just scrolled past, which a button pinned to the end of the page
        is the worst possible place for.
      */}
      <AskFinSightFab onPress={() => setAskOpen(true)} />

      <AskFinSight visible={askOpen} onClose={() => setAskOpen(false)} module="Recovery Target" />
    </Screen>
  );
}

function Row({
  icon,
  label,
  value,
  tint,
  first,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: number;
  /** Colours the FIGURE only — the label stays neutral so the row still scans. */
  tint?: string;
  /** Drops the top rule, so the list does not open with one under a caption. */
  first?: boolean;
}) {
  const t = useTheme();
  const { brand, paper } = t;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingVertical: space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: paper[200],
      }}
    >
      <Medallion icon={icon} tint={brand[700]} surface={brand[50]} size={28} />
      <T style={{ fontSize: typeScale.bodySm, flex: 1 }}>{label}</T>
      <Money value={value} size={14} weight="medium" color={tint} />
    </View>
  );
}
