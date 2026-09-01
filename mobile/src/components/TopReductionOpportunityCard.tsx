import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, Money, T } from "./ui";
import { TAP_FLOOR } from "./touchTarget";
import * as haptics from "../lib/haptics";
import { font, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { ReductionOpportunity } from "../lib/types";

/**
 * The Dashboard's one compact link-out to the top reduction opportunity —
 * plan §13.1/§15 Phase 5.
 *
 * Deliberately re-fetches nothing of its own: `DashboardScreen` fetches the
 * SAME `GET /insights/reduction-opportunities` Expense Insight already uses
 * and hands this component only the highest-ranked result, already filtered
 * for confidence and emptiness — this component has no opinion about when it
 * should render, it just draws what it is given (same division of labor
 * `ReductionOpportunitiesSection` follows for its own state).
 *
 * Modeled on SpendingBreakdownCard's "small self-contained summary card"
 * shape rather than reusing the full opportunity card from Expense
 * Insight — plan §13.1 is explicit that the Dashboard shows title, category,
 * ONE supporting figure and a link, not the complete card.
 */
export function TopReductionOpportunityCard({
  opportunity,
  onPress,
}: {
  opportunity: ReductionOpportunity;
  onPress: () => void;
}) {
  const t = useTheme();
  const { brand, ink } = t;

  return (
    <Pressable
      onPress={() => {
        haptics.tapped();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={`Reduction opportunity: ${opportunity.categoryName}, ${opportunity.observation}. Review opportunity.`}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, minHeight: TAP_FLOOR })}
    >
      <Card>
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <T variant="label" style={{ color: brand[700], textTransform: "uppercase", letterSpacing: 0.4 }}>
              Reduction opportunity
            </T>
            <T style={{ marginTop: 4, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: ink[900] }}>
              {opportunity.categoryName}
            </T>
            <T variant="caption" numberOfLines={2} style={{ marginTop: 2 }}>
              {opportunity.observation}
            </T>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: space.sm }}>
              <T variant="caption">This period:</T>
              <Money value={opportunity.evidence.currentAmount} size={typeScale.bodySm} weight="semibold" />
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color={ink[400]} />
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: space.md }}>
          <T style={{ color: brand[700], fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>
            Review opportunity
          </T>
        </View>
      </Card>
    </Pressable>
  );
}
