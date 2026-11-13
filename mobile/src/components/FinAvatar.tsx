import { useEffect, useRef } from "react";
import { Animated, Easing, Image, Platform, View } from "react-native";

import { useTheme } from "../context/ThemeContext";
import { useReducedMotion } from "../lib/useReducedMotion";
import { mascotSource } from "./MascotState";

/**
 * Fin's face in a round mint badge, the one avatar Ask FinSight uses at every
 * size. The mint is baked into the art, so the badge looks the same in both
 * themes, like the brand teal.
 *
 * Decorative: the "Fin" label or the sheet title beside it says who is
 * speaking. `thinking` adds a ring that pulses while an answer is being
 * worked out, which is genuine ongoing work; under Reduce Motion the ring
 * stays still.
 */
export function FinAvatar({ size = 32, thinking = false }: { size?: number; thinking?: boolean }) {
  const t = useTheme();
  const reduceMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!thinking || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const beat = (toValue: number) =>
      Animated.timing(pulse, { toValue, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== "web" });
    const loop = Animated.loop(Animated.sequence([beat(0.3), beat(1)]));
    loop.start();
    return () => loop.stop();
  }, [thinking, reduceMotion, pulse]);

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: size, height: size }}
    >
      {thinking ? (
        <Animated.View
          style={{ position: "absolute", top: -4, left: -4, right: -4, bottom: -4, borderRadius: 999, borderWidth: 2, borderColor: t.brand[300], opacity: pulse }}
        />
      ) : null}
      <Image
        source={mascotSource("finAvatar")}
        style={{ width: size, height: size, borderRadius: size / 2, borderWidth: size >= 64 ? 4 : 2, borderColor: t.surface }}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}
