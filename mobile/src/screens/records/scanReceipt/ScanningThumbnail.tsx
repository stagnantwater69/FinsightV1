import { useEffect, useRef } from "react";
import { Animated, Image, View } from "react-native";
import { useReducedMotion } from "../../../lib/useReducedMotion";
import { radius } from "../../../theme/tokens";
import { useTheme } from "../../../context/ThemeContext";

const HEIGHT = 220;
const LINE_HEIGHT = 3;

/**
 * The actual captured page, with a line sweeping down it while the server
 * reads it — literal progress against the photo the owner just took, rather
 * than generic skeleton bars with no connection to it.
 *
 * Same `Animated`/`useReducedMotion` shape as `Skeleton.tsx`'s pulse: no new
 * animation library, and Reduce Motion rests the line at the vertical centre
 * instead of sweeping, the same fallback `SkeletonBox` already uses.
 */
export function ScanningThumbnail({ uri }: { uri: string }) {
  const t = useTheme();
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(0.5);
      return;
    }

    progress.setValue(0);
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1800,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion]);

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [0, HEIGHT - LINE_HEIGHT] });

  return (
    <View
      style={{
        width: "100%",
        height: HEIGHT,
        borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: t.paper[100],
        borderWidth: 1,
        borderColor: t.ink[200],
      }}
    >
      <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          transform: [{ translateY }],
        }}
      >
        {/* A soft glow behind the line rather than a hard-edged bar. */}
        <View
          style={{
            height: 28,
            marginTop: -13,
            backgroundColor: t.brandSolid,
            opacity: 0.16,
          }}
        />
        <View style={{ height: LINE_HEIGHT, backgroundColor: t.brandSolid, marginTop: -15 }} />
      </Animated.View>
    </View>
  );
}
