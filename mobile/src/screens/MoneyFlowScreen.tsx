import { ContentScrollView } from "../components/ContentScrollView";
import { useState } from "react";
import { RefreshControl, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Card, Screen, T } from "../components/ui";
import { CashflowChart } from "../components/charts";
import { GranularityDropdown } from "../components/CashflowRangeDropdown";
import { SkeletonBox } from "../components/Skeleton";
import { ConnectionNotice, FreshnessStatus } from "../components/ConnectionNotice";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useTheme } from "../context/ThemeContext";
import { describeLoadFailure, toLoadFailure } from "../lib/connectionState";
import { useInsight } from "../lib/useInsight";
import { radius, space, typeScale } from "../theme/tokens";
import type { CashflowGranularity, DashboardCashflow } from "../lib/types";

/**
 * Money in and money out over time, reached from Home's "Where it went" card.
 *
 * It used to sit on Home itself behind "More charts", which most owners never
 * opened. Home now keeps a single picture of where the money went and links
 * here for the trend, so the chart is one deliberate tap away rather than
 * hidden in an expander.
 *
 * A PERIOD WITH NOTHING IN IT SAYS SO. A week with no records drew a flat
 * line at zero on a 0–4 axis, which is accurate and reads as broken. It now
 * says nothing was recorded, and points at the monthly view, where earlier
 * money in and out usually is.
 */
export function MoneyFlowScreen() {
  const t = useTheme();
  const { selected } = useBusinessProfiles();
  const [granularity, setGranularity] = useState<CashflowGranularity>("monthly");
  const [refreshing, setRefreshing] = useState(false);
  const state = useInsight<DashboardCashflow>(
    "/dashboard/cashflow",
    { businessProfileId: selected?.id, granularity },
    [selected?.id, granularity],
    { enabled: Boolean(selected) },
  );
  if (!selected) return null;

  const points = state.data?.points ?? [];
  const empty = state.data !== null && points.every((p) => p.sales === 0 && p.expenses === 0);
  const notice = describeLoadFailure(state.rawError ? toLoadFailure(state.rawError) : null, {
    hasData: state.data !== null,
    lastUpdatedAt: state.lastUpdatedAt,
    subject: "money in and out",
  });
  const rangeText = granularity === "monthly" ? "Last 6 months" : "Last 7 days";

  return (
    <Screen>
      <ContentScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              try {
                await state.load();
              } finally {
                setRefreshing(false);
              }
            }}
            tintColor={t.brand[600]}
          />
        }
      >
        <ConnectionNotice notice={notice} onRetry={() => void state.load()} busy={state.refreshing} />
        <Card>
          {state.loading && state.data === null ? (
            <SkeletonBox height={200} />
          ) : empty ? (
            <View style={{ gap: space.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                <T variant="heading" accessibilityRole="header">Money in and out</T>
                <GranularityDropdown value={granularity} onChange={setGranularity} />
              </View>
              <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.xl, borderRadius: radius.lg, backgroundColor: t.surfaceSunken }}>
                <Ionicons name="calendar-outline" size={28} color={t.textMuted} />
                <T style={{ fontSize: typeScale.bodySm, color: t.textPrimary }}>{`Nothing recorded · ${rangeText.toLowerCase()}`}</T>
                {granularity === "daily" ? (
                  <T variant="caption" style={{ textAlign: "center" }}>Switch to Monthly to see earlier money in and out.</T>
                ) : null}
              </View>
            </View>
          ) : (
            <CashflowChart
              data={points}
              granularity={granularity}
              title="Money in and out"
              subtitle={rangeText}
              action={<GranularityDropdown value={granularity} onChange={setGranularity} />}
            />
          )}
        </Card>
        <FreshnessStatus at={state.lastUpdatedAt} now={Date.now()} refreshing={refreshing || state.refreshing} />
      </ContentScrollView>
    </Screen>
  );
}
