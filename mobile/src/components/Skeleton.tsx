import { useEffect, useRef } from "react";
import { Animated, View, ViewStyle } from "react-native";
import { useReducedMotion } from "../lib/useReducedMotion";
import { radius, space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";

/** The two ends of the pulse, and the point it rests at when it must not pulse. */
const DIM = 0.3;
const BRIGHT = 0.7;
const RESTING = 0.5;

export function SkeletonBox({
  width,
  height,
  borderRadius = radius.md,
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  borderRadius?: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const { paper } = t;
  const opacity = useRef(new Animated.Value(DIM)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    /*
     * Reduced motion: hold still at the midpoint of the pulse.
     *
     * This is the app's most persistent animation — it runs for as long as
     * anything is loading, and a dashboard shows twelve of these boxes at
     * once, all breathing together. Sitting at RESTING keeps the box reading
     * as a placeholder rather than as real content, which is the whole job of
     * the pulse; only the movement goes.
     */
    if (reduceMotion) {
      opacity.setValue(RESTING);
      return;
    }

    // The setting can be turned off again mid-session, so start from the
    // bottom of the pulse rather than from wherever it was parked.
    opacity.setValue(DIM);
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: BRIGHT,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: DIM,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity, reduceMotion]);

  return (
    <Animated.View
      style={[
        {
          width: width ?? "100%",
          height,
          borderRadius,
          backgroundColor: paper[200],
          opacity,
        },
        style,
      ]}
    />
  );
}

export function SkeletonCard({ style }: { style?: ViewStyle }) {
  const t = useTheme();
  const { paper } = t;
  return (
    <View
      style={[
        {
          backgroundColor: paper.DEFAULT,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: paper[200],
          padding: space.lg,
          gap: space.md,
        },
        style,
      ]}
    >
      <SkeletonBox width="40%" height={16} />
      <SkeletonBox width="75%" height={26} />
      <SkeletonBox width="60%" height={14} />
    </View>
  );
}

export function SkeletonDashboard() {
  return (
    <View style={{ gap: space.lg }}>
      <SkeletonCard />
      <SkeletonCard style={{ height: 80 }} />
      <View style={{ flexDirection: "row", gap: space.md }}>
        <SkeletonCard style={{ flex: 1 }} />
        <SkeletonCard style={{ flex: 1 }} />
      </View>
      <SkeletonCard style={{ height: 150 }} />
      <SkeletonCard style={{ height: 180 }} />
      <SkeletonCard style={{ height: 140 }} />
    </View>
  );
}

export function SkeletonList({ count = 5 }: { count?: number }) {
  const t = useTheme();
  const { paper } = t;
  return (
    <View style={{ gap: space.sm }}>
      {Array.from({ length: count }).map((_, i) => (
        <View
          key={i}
          style={{
            backgroundColor: paper.DEFAULT,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: paper[200],
            padding: space.lg,
            gap: space.xs,
          }}
        >
          <SkeletonBox width="60%" height={16} />
          <SkeletonBox width="40%" height={12} />
        </View>
      ))}
    </View>
  );
}

