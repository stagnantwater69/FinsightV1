import { useEffect, useRef } from "react";
import { Animated, BackHandler, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "./ui";
import { QuickActionIcon } from "./QuickActionIcon";
import { useTourTarget } from "./tour/targets";
import type { TourTargetKey } from "./tour/steps";
import { font, radius, space, typeScale } from "../theme/tokens";
import { shadowStyle } from "../theme/shadow";
import { BAR_HEIGHT, addCentreFromBottom, barAreaHeight, barSideInset } from "./floatingTabBarLayout";
import { useTheme } from "../context/ThemeContext";
import { useReducedMotion } from "../lib/useReducedMotion";
import * as haptics from "../lib/haptics";

/**
 * The five things an owner opens FinSight to do, as a speed dial rising from
 * the "+" beside the floating tab bar.
 *
 * WHY A STACK, AND WHY EVERY LABEL SHOWS. The "+" moved out of the middle of
 * the bar to its own circle at the right, so the actions rise straight up
 * from it, under the same thumb, nearest action first. The arc this replaced
 * showed a label only while a finger was on a circle, because five captions
 * across an arc collided; stacked, each one has a row to itself, so the owner
 * reads "Add expense" before touching anything instead of guessing from an
 * icon. Springing out of the button still says where they came from, and the
 * X drawn over it says how to put them back.
 */

export interface RadialAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** The circle's fill. */
  color: string;
  /** The glyph on it — from `categoricalOnColor`, never assumed to be white. */
  onColor: string;
  onPress: () => void;
  /**
   * Registers this circle as a product-tour target. The tour's "Receipt
   * scanner" and "Import a spreadsheet" steps spotlight two of these — see
   * components/tour/steps.ts — which is why the menu is drawn in the app's own
   * window rather than in a Modal: a Modal is a separate native window, and
   * the tour could neither draw over it nor measure inside it.
   */
  tourTarget?: TourTargetKey;
}

/** Each action's circle. */
const ITEM = 52;

export function QuickActionMenu({
  visible,
  actions,
  onClose,
  heldOpen = false,
}: {
  visible: boolean;
  /** Up to five. The first sits nearest the "+", the rest stack above it. */
  actions: RadialAction[];
  onClose: () => void;
  /**
   * Open because the product tour is pointing inside it, not because the owner
   * pressed the button.
   *
   * Held open this way it must not behave like a menu the owner opened: a tap
   * outside is the tour's own card, and the back button belongs to the tour,
   * which closes the whole run rather than one menu. Same divergence web's
   * AppShell makes for the same two steps.
   */
  heldOpen?: boolean;
}) {
  const t = useTheme();
  const { brand } = t;
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const reduceMotion = useReducedMotion();

  /*
   * One value per action rather than one shared value, because they are
   * staggered — the stack should rise from the button one action at a time
   * rather than arriving as a single block, which is what tells the eye there
   * are five separate things rather than one shape.
   */
  const progress = useRef(actions.map(() => new Animated.Value(0))).current;

  /*
   * When the stack does not fly, and why that is not only a motion preference.
   *
   * "Reduce Motion" is usually on for a reason: the actions still appear, they
   * simply do not travel.
   *
   * `heldOpen` is the product tour, and there the reason is correctness. The
   * tour spotlights one of these circles, which means measuring it — and a
   * circle measured while it is still travelling out of the "+" button
   * measures AT the button, which is exactly where the first spotlight kept
   * landing. Waiting for the animation is a race the tour cannot reliably win
   * (the springs start on the JS thread, behind the step's own render); not
   * animating at all is not a race. It reads better too: a card explaining a
   * control should not be pointing at something that is still moving.
   */
  const settled = heldOpen || reduceMotion;

  useEffect(() => {
    if (!visible) {
      progress.forEach((value) => value.setValue(0));
      return;
    }
    if (settled) {
      progress.forEach((value) => value.setValue(1));
      return;
    }

    // Nearest the button first, so the stack reads as rising out of it.
    const animations = progress.map((value, i) =>
      Animated.sequence([
        Animated.delay(i * 40),
        Animated.spring(value, { toValue: 1, useNativeDriver: Platform.OS !== "web", speed: 14, bounciness: 7 }),
      ]),
    );
    const animation = Animated.parallel(animations);
    animation.start();
    return () => animation.stop();
  }, [visible, settled, progress, actions.length]);

  /*
   * Android's back button, which the Modal used to give us through
   * `onRequestClose`. Without it the menu would swallow nothing and Back would
   * leave the app from an open menu.
   */
  useEffect(() => {
    if (!visible || heldOpen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, heldOpen, onClose]);

  if (!visible) return null;

  // The "+" centre, from the same figures the floating bar lays itself out with.
  const centreFromBottom = addCentreFromBottom(insets.bottom, fontScale);
  const tabBarHeight = barAreaHeight(insets.bottom, fontScale);
  const sideInset = barSideInset(width);

  return (
    /*
     * NOT A MODAL. It was one, and a Modal is a separate native window: the
     * product tour — which draws in the app's window — could not put its scrim
     * over the menu, and `measureInWindow` inside it reports coordinates in a
     * different space, which is the same class of bug that had every spotlight
     * drawn a status bar too high. In the app's tree the menu sits above the
     * tab bar (elevation) and below the tour, and one coordinate space serves
     * both.
     */
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 40, elevation: 20 }]}
      accessibilityViewIsModal={!heldOpen}
    >
      <Pressable
        onPress={heldOpen ? undefined : onClose}
        accessibilityRole={heldOpen ? undefined : "button"}
        accessibilityLabel={heldOpen ? undefined : "Close the actions menu"}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        {/*
          The dim stops above the tab bar so the bar stays legible — an owner
          who opened this by mistake can still see where Home is. Tapping
          there closes the menu rather than switching tabs, which is what
          "tap outside to close" has to mean for the gesture to be reliable.

          Dropped entirely while the tour holds the menu open: the tour lays
          its own scrim over the screen, and two scrims together make the stack
          read as sitting in a hole rather than above the page.
        */}
        {heldOpen ? null : (
          <View
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: tabBarHeight,
              backgroundColor: t.scrimStrong,
            }}
          />
        )}

      </Pressable>
        <ScrollView
          style={{ position: "absolute", right: sideInset, bottom: tabBarHeight, width: width - sideInset * 2, maxHeight: Math.max(48, height - tabBarHeight - insets.top - space.lg) }}
          contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", alignItems: "flex-end", gap: space.md, paddingVertical: space.sm }}
          keyboardShouldPersistTaps="handled"
        >
        {[...actions].reverse().map((action, reverseIndex) => (
          <DialItem
            key={action.key}
            action={action}
            value={progress[actions.length - reverseIndex - 1]!}
            settled={settled}
            onClose={onClose}
          />
        ))}
        </ScrollView>

        {/*
          The button itself, redrawn as an X in the same place and at the same
          size as the one that opened this. The real one is behind the modal —
          drawing over it rather than trying to reach it keeps the two from
          disagreeing about what is on screen.
        */}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close the actions menu"
          style={({ pressed }) => ({
            position: "absolute",
            right: sideInset,
            bottom: centreFromBottom - BAR_HEIGHT / 2,
            width: BAR_HEIGHT,
            height: BAR_HEIGHT,
            borderRadius: BAR_HEIGHT / 2,
            backgroundColor: pressed ? brand[800] : brand[700],
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <Ionicons name="close" size={28} color={t.onBrandSolid} />
        </Pressable>
    </View>
  );
}

/**
 * One row of the dial: its label on the left, its circle on the right, the
 * whole row one target.
 *
 * Its own component only so that `useTourTarget` can be called for it — a hook
 * cannot be called inside the parent's `map`.
 */
function DialItem({
  action,
  value,
  settled,
  onClose,
}: {
  action: RadialAction;
  value: Animated.Value;
  /** Placed where it lands rather than flown into place — see `settled`. */
  settled: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const { paper } = t;
  // Registered on the circle itself, so the tour's spotlight is measured on the
  // coloured disc the owner is being shown.
  const tourTarget = useTourTarget(action.tourTarget, {
    radius: 999,
    pad: { top: 6, right: 6, bottom: 6, left: 6 },
  });

  const content = (
    <Pressable
      onPress={() => {
        haptics.tapped();
        onClose();
        action.onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => ({ minHeight: ITEM, flexDirection: "row", alignItems: "center", gap: space.sm, opacity: pressed ? 0.85 : 1 })}
    >
      <View
        style={{
          flexShrink: 1,
          minHeight: 36,
          justifyContent: "center",
          paddingHorizontal: space.md,
          borderRadius: radius.full,
          backgroundColor: t.surfaceRaised,
          ...shadowStyle({ color: t.shadow, offsetY: 3, opacity: 0.16 * t.shadowStrength, blurRadius: 8, elevation: 4 }),
        }}
      >
        <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, color: t.textPrimary, paddingVertical: space.sm }}>
          {action.label}
        </T>
      </View>
      <View
        {...tourTarget}
        style={{
          width: ITEM,
          height: ITEM,
          borderRadius: ITEM / 2,
          backgroundColor: action.color,
          alignItems: "center",
          justifyContent: "center",
          // A ring in the page's own colour, so the circles read as sitting
          // above the dimmed page rather than punched into it.
          borderWidth: 3,
          borderColor: paper.DEFAULT,
        }}
      >
        <QuickActionIcon actionKey={action.key} fallback={action.icon} color={action.onColor} />
      </View>
    </Pressable>
  );

  /*
   * NO TRANSFORM in the settled case, deliberately. Where the circle is
   * becomes a question of layout, which `measureInWindow` answers identically
   * on every platform and at every instant — which is what the product tour
   * needs in order to put a spotlight on it.
   */
  if (settled) {
    return <View style={{ maxWidth: "100%" }}>{content}</View>;
  }

  return (
    <Animated.View
      style={{
        maxWidth: "100%",
        opacity: value,
        transform: [
          { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
        ],
      }}
    >
      {content}
    </Animated.View>
  );
}
