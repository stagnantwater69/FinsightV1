import { useRef, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card } from "./ui";
import { CategoryBreakdown, DonutChart } from "./charts";
import { space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { formatMoney } from "../lib/money";
import { useReducedMotion } from "../lib/useReducedMotion";

interface CategoryRow {
  categoryId: number;
  categoryName: string;
  total: number;
  percent: number;
}

const FLIP_DURATION = 180;

/**
 * "Share of spending" and "Where your money went" are the same category
 * totals told two ways — a share of the whole, and a ranked list. Rather
 * than two cards saying the same thing twice down the screen, one card
 * flips between them on tap.
 *
 * The flip is a scaleX squish to a sliver and back, not a true 3D rotation.
 * A real flip needs both faces laid out and stacked so the outgoing one can
 * still be seen mid-turn, which means picking one fixed height for two views
 * whose natural heights differ — a six-row ranked list is taller than the
 * donut. Squishing to zero width and swapping content at the midpoint gets
 * the same "this turned over" read without measuring either face.
 */
export function SpendingBreakdownCard({ data }: { data: CategoryRow[] }) {
  const t = useTheme();
  const { ink } = t;
  const [showList, setShowList] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();

  const flip = () => {
    if (reduceMotion) {
      setShowList((v) => !v);
      return;
    }
    Animated.timing(progress, { toValue: 1, duration: FLIP_DURATION, useNativeDriver: true }).start(() => {
      setShowList((v) => !v);
      progress.setValue(0);
    });
  };

  const scaleX = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.05, 1] });

  const total = data.reduce((s, d) => s + d.total, 0);
  const sorted = [...data].sort((a, b) => b.total - a.total);

  /*
   * Built here rather than read off the chart underneath: collapsing the
   * whole card into one accessible element (so VoiceOver/TalkBack announce
   * "flip to see the other view" instead of wandering into a donut's arcs)
   * means the chart's own per-slice label is no longer reachable, so its
   * content is folded into this one instead — nothing is lost, it just moves
   * up a level.
   */
  const summaryLabel = showList
    ? `Where your money went, largest first. ${sorted
        .map((d) => `${d.categoryName}, ${formatMoney(d.total)}`)
        .join(". ")}. Tap to see the share of spending chart.`
    : `Share of spending. ${sorted
        .filter((d) => d.total > 0)
        .map((d) => `${d.categoryName}, ${total > 0 ? Math.round((d.total / total) * 100) : 0} percent`)
        .join(". ")}. Tap to see the ranked list.`;

  return (
    <Pressable onPress={flip} accessibilityRole="button" accessibilityLabel={summaryLabel}>
      <Card>
        {/*
          Decorative only. The enclosing Pressable is itself `accessible`, so
          this never becomes a separately-focusable node — no extra hiding
          needed on either platform.
        */}
        <View style={{ position: "absolute", top: space.lg, right: space.lg }}>
          <Ionicons name="swap-horizontal-outline" size={16} color={ink[400]} />
        </View>
        <Animated.View style={{ transform: [{ scaleX }] }}>
          {showList ? (
            <CategoryBreakdown data={data} subtitle="Largest first" />
          ) : (
            <DonutChart data={data} subtitle="This month" />
          )}
        </Animated.View>
      </Card>
    </Pressable>
  );
}
