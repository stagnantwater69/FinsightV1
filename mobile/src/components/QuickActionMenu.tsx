import { useEffect, useRef, useState } from "react";
import { Animated, BackHandler, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "./ui";
import { useTourTarget } from "./tour/targets";
import type { TourTargetKey } from "./tour/steps";
import { font, radius, space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import { useReducedMotion } from "../lib/useReducedMotion";
import * as haptics from "../lib/haptics";

/**
 * The five things an owner opens FinSight to do, arced above the raised
 * button in the tab bar.
 *
 * WHY THE BUTTON STOPPED BEING A SHORTCUT TO ONE THING. It went straight to
 * the camera, which is right for the single most common action and wrong for
 * the bar's most prominent control: recording a sale, typing an expense,
 * importing a spreadsheet and fixing a category were each three taps away
 * behind a tab, while the one action that already had a Quick Actions card on
 * Home had the whole button to itself. Scanning stays first — it is the
 * centre of the arc and the largest — but it no longer crowds out the four
 * things beside it.
 *
 * WHY AN ARC AND NOT A SHEET. The actions have to read as belonging to the
 * button that produced them, and a sheet sliding up from the bottom edge
 * reads as belonging to the screen. Springing them out of the button along a
 * curve says where they came from and where they will go back to, which is
 * also what makes the X in the middle obvious rather than a control that
 * needs a label.
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

/**
 * Where each action lands, measured anticlockwise from the right-hand
 * horizontal. Five slots across the top half, symmetrical about vertical.
 *
 * WIDER THAN BEFORE, and stopping further from horizontal. At 24°/156° the
 * outer pair sat almost level with the tab bar's own icons and read as part
 * of it; at 30°/150° they clear it, and the extra spread between neighbours
 * is what stops two adjacent circles overlapping once the radius is small on
 * a narrow phone.
 */
const ANGLES = [150, 120, 90, 60, 30];

/** Each action's circle. */
const ITEM = 54;

/**
 * How far the actions travel, derived from the screen rather than fixed.
 *
 * A constant 132 put the outer circles at ±114pt from centre, which is off
 * the edge of a 320pt phone once the label is counted. This keeps the whole
 * arc inside the screen with a margin, and never grows so large on a tablet
 * that the actions leave the thumb's reach.
 */
function radiusFor(width: number): number {
  const halfSpan = Math.cos((30 * Math.PI) / 180); // the outermost x, as a fraction
  const usable = width / 2 - ITEM / 2 - space.lg;
  return Math.max(96, Math.min(150, usable / halfSpan));
}

export function QuickActionMenu({
  visible,
  actions,
  onClose,
  heldOpen = false,
}: {
  visible: boolean;
  /** Up to five. The middle of the list takes the top of the arc. */
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
  const { brand, paper } = t;
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const RADIUS = radiusFor(width);

  /**
   * Which action the finger is currently on, or null.
   *
   * The labels were drawn under every circle at once and the outer ones
   * overlapped their neighbours — five captions across an arc is more text
   * than the arc has room for. Showing only the one being touched fixes the
   * collision and, more usefully, turns the label into an answer to the
   * question a finger hovering over an unfamiliar icon is actually asking.
   */
  const [touched, setTouched] = useState<string | null>(null);

  /*
   * One value per action rather than one shared value, because they are
   * staggered — the arc should unfurl from the middle outwards rather than
   * arriving as a single block, which is what tells the eye there are five
   * separate things rather than one shape.
   */
  const progress = useRef(actions.map(() => new Animated.Value(0))).current;

  /*
   * When the arc does not fly, and why that is not only a motion preference.
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

    /*
     * Ordered from the centre out, so the stagger radiates rather than
     * sweeping left to right. `Math.abs` of the distance from the middle
     * index gives each side the same delay as its mirror.
     */
    const middle = (actions.length - 1) / 2;
    const animations = progress.map((value, i) =>
      Animated.sequence([
        Animated.delay(Math.abs(i - middle) * 45),
        Animated.spring(value, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 7 }),
      ]),
    );
    Animated.parallel(animations).start();
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

  /*
   * The centre of the raised tab-bar button, derived from the same figures
   * MainTabs lays the bar out with: a 60pt bar over the safe-area inset, 6pt
   * of top padding, and a 54pt circle pulled 20pt above it. Hard-coding a
   * guess here would drift the moment the bar's height changed.
   */
  const centreFromBottom = 47 + insets.bottom;
  const tabBarHeight = 60 + insets.bottom;

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
        style={{ flex: 1 }}
      >
        {/*
          The dim stops above the tab bar so the bar stays legible — an owner
          who opened this by mistake can still see where Home is. Tapping
          there closes the menu rather than switching tabs, which is what
          "tap outside to close" has to mean for the gesture to be reliable.

          Dropped entirely while the tour holds the menu open: the tour lays
          its own scrim over the screen, and two of them stacked make the arc
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

        {actions.map((action, i) => {
          const angle = ((ANGLES[i] ?? 90) * Math.PI) / 180;
          return (
            <RadialItem
              key={action.key}
              action={action}
              value={progress[i]!}
              settled={settled}
              dx={Math.cos(angle) * RADIUS}
              dy={Math.sin(angle) * RADIUS}
              left={width / 2 - ITEM / 2}
              bottom={centreFromBottom - ITEM / 2}
              showLabel={touched === action.key}
              onTouch={setTouched}
              onClose={onClose}
            />
          );
        })}

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
            left: width / 2 - 27,
            bottom: centreFromBottom - 27,
            width: 54,
            height: 54,
            borderRadius: 27,
            backgroundColor: pressed ? brand[800] : brand[700],
            borderWidth: 4,
            borderColor: paper.DEFAULT,
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <Ionicons name="close" size={24} color={t.onBrandSolid} />
        </Pressable>
      </Pressable>
    </View>
  );
}

/**
 * One circle in the arc.
 *
 * Its own component only so that `useTourTarget` can be called for it — a hook
 * cannot be called inside the parent's `map`. Same reason QuickActions splits
 * its tiles. Everything else about the circle is what it was inline.
 */
function RadialItem({
  action,
  value,
  settled,
  dx,
  dy,
  left,
  bottom,
  showLabel,
  onTouch,
  onClose,
}: {
  action: RadialAction;
  value: Animated.Value;
  /** Placed where it lands rather than flown into place — see `settled`. */
  settled: boolean;
  dx: number;
  dy: number;
  left: number;
  bottom: number;
  showLabel: boolean;
  onTouch: (key: string | null) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const { ink, paper } = t;
  // Round target, round ring. Registered on the circle itself rather than on
  // the container, so the spotlight is measured on the coloured disc the owner
  // is being shown.
  const tourTarget = useTourTarget(action.tourTarget, {
    radius: 999,
    pad: { top: 6, right: 6, bottom: 6, left: 6 },
  });

  const content = (
    <>
      {/*
        The label, only while the finger is on the action.

        `onPressIn`/`onPressOut` rather than a long-press: the point is to
        answer "what is this one?" for a finger already on the target, and a
        delay would make that answer arrive after the decision. Positioned
        absolutely ABOVE the circle so showing it cannot move the circle under
        the finger.
      */}
      {showLabel ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: ITEM + 8,
            paddingHorizontal: space.sm,
            paddingVertical: 4,
            borderRadius: radius.sm,
            backgroundColor: ink[900],
          }}
        >
          <T style={{ fontSize: 11.5, color: t.textOnFill, fontFamily: font.sansMedium }} numberOfLines={1}>
            {action.label}
          </T>
        </View>
      ) : null}

      <Pressable
        {...tourTarget}
        onPressIn={() => onTouch(action.key)}
        onPressOut={() => onTouch(null)}
        onPress={() => {
          haptics.tapped();
          onClose();
          action.onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        style={({ pressed }) => ({
          width: ITEM,
          height: ITEM,
          borderRadius: ITEM / 2,
          backgroundColor: action.color,
          alignItems: "center",
          justifyContent: "center",
          // A ring in the scrim's own colour, so the circles read as sitting
          // above the dimmed page rather than punched into it.
          borderWidth: 3,
          borderColor: paper.DEFAULT,
          transform: [{ scale: pressed ? 1.08 : 1 }],
        })}
      >
        <Ionicons name={action.icon} size={23} color={action.onColor} />
      </Pressable>
    </>
  );

  /*
   * NO TRANSFORM in the settled case, deliberately. Where the circle is
   * becomes a question of layout, which `measureInWindow` answers identically
   * on every platform and at every instant — which is what the product tour
   * needs in order to put a spotlight on it. The animated case below is the
   * ordinary one, where nothing is measuring anything.
   */
  if (settled) {
    return (
      <View style={{ position: "absolute", left: left + dx, bottom: bottom + dy, alignItems: "center" }}>
        {content}
      </View>
    );
  }

  return (
    <Animated.View
      style={{
        position: "absolute",
        left,
        bottom,
        alignItems: "center",
        opacity: value,
        transform: [
          { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
          { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -dy] }) },
          /*
            Scaled from nothing rather than from 0.4, and rotated a little on
            the way out. Starting at 0.4 meant five circles were already
            visible, stacked on the button, before the animation began — so the
            arc appeared to slide apart rather than to come out of anything.
          */
          { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) },
        ],
      }}
    >
      {content}
    </Animated.View>
  );
}
