import { useEffect, useRef } from "react";
import { Animated, Image, Pressable } from "react-native";
import { space } from "../theme/tokens";
import { cropArtToBox, FAB_ART_BOUNDS } from "../lib/artCrop";
import { useReducedMotion } from "../lib/useReducedMotion";
import * as haptics from "../lib/haptics";

/**
 * Ask FinSight, as a floating action button.
 *
 * It used to be a rectangular button sitting in the row under the header,
 * where it competed with the period selector for the same glance and scrolled
 * away the moment an owner moved down the screen. As a FAB it stays reachable
 * from anywhere on Home, which is the point — the question an owner wants to
 * ask is usually prompted by something they have just scrolled PAST.
 *
 * NO CIRCLE, NO WHITE FILL. FAB.png used to be an opaque white-background
 * square, and the button filled itself white with a border and a shadow so
 * that square would disappear into the page rather than show as a hard-edged
 * box. The asset is now a real transparent cutout — head, glasses, question
 * bubble, nothing else — so there is nothing left for a container to hide.
 * The soft shadow under the owl and under the bubble is painted into the PNG
 * itself; adding React Native's own shadow on top would draw a second,
 * rectangular one behind an irregular shape and look like a mistake.
 */

/** Diameter of the touch target. 56 is the Material default; this is the mascot's own request to sit a little larger since it now floats free of a container. */
const SIZE = 72;

/*
 * cropArtToBox still does the sizing — the art (owl + bubble + sparkle marks)
 * fills only ~64% of FAB.png's canvas width, sitting off-centre, so it is
 * scaled up and offset to fill the touch target rather than rendered small in
 * the middle of it. `fill` is 1 (its default) rather than the 0.92 this used
 * before: that inset existed only to keep a CIRCLE's corners from clipping
 * the art, and there is no circle to clip against any more.
 */
const CROP = cropArtToBox(FAB_ART_BOUNDS, SIZE);

/** One half of the idle bob, in ms. Slow enough to read as breathing rather than as something demanding attention. */
const BOB_DURATION = 1400;
const BOB_DISTANCE = 5;

export function AskFinSightFab({ onPress }: { onPress: () => void }) {
  const bob = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    /*
     * "Reduce Motion" is usually on for a reason, and a button that never
     * stops moving is exactly the kind of thing it is turned on to stop. The
     * FAB keeps its press response; only the perpetual bob is dropped, and it
     * is parked at rest rather than mid-bounce.
     */
    if (reduceMotion) {
      bob.setValue(0);
      return;
    }
    bob.setValue(0);
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: BOB_DURATION, useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: BOB_DURATION, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [bob, reduceMotion]);

  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -BOB_DISTANCE] });

  return (
    <Animated.View
      // No safe-area inset needed: the tab bar is laid out below the screen
      // rather than over it, so this sits clear of both the bar and the
      // phone's own navigation gestures.
      style={{
        position: "absolute",
        right: space.lg,
        bottom: space.lg,
        transform: [{ translateY }, { scale: press }],
      }}
    >
      <Pressable
        onPress={() => {
          haptics.tapped();
          onPress();
        }}
        onPressIn={() =>
          Animated.spring(press, { toValue: 0.92, useNativeDriver: true, speed: 40, bounciness: 0 }).start()
        }
        onPressOut={() =>
          Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }).start()
        }
        accessibilityRole="button"
        accessibilityLabel="Ask FinSight"
        // Width/height only: this is a transparent hit-box sized to the touch
        // target, not a container to be painted. Nothing here is visible —
        // the artwork is what the owner sees.
        style={{ width: SIZE, height: SIZE }}
      >
        <Image
          source={require("../../assets/FAB.png")}
          style={{
            // Deliberately NOT flex-centred: the image is placed by the
            // margins cropArtToBox returns, which are measured from the
            // top-left corner. Centring would apply on top of them and undo
            // the correction.
            width: CROP.imageSize,
            height: CROP.imageSize,
            marginLeft: CROP.marginLeft,
            marginTop: CROP.marginTop,
          }}
          resizeMode="contain"
        />
      </Pressable>
    </Animated.View>
  );
}

/**
 * How much room a screen must leave at the end of its scroll so the FAB
 * never covers the last card.
 */
export const FAB_CLEARANCE = SIZE + space.lg * 2;
