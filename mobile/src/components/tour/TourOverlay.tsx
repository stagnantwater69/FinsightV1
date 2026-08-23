import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, T } from "../ui";
import { TAP, radius, space } from "../../theme/tokens";
import { useTheme } from "../../context/ThemeContext";
import { useReducedMotion } from "../../lib/useReducedMotion";
// From the context object rather than from the provider that renders this
// component: importing the provider here would be a require cycle.
import { useTourOptional } from "../../context/tourContextValue";
import { nextStepIndex, previousStepIndex, stepPosition, TOUR_STEPS } from "./steps";
import {
  measureTourTarget,
  revealTourTarget,
  stepIsOnScreen,
  tourTargetOptions,
} from "./targets";
import {
  cardPlacement,
  frameIsUsable,
  rectsAgree,
  scrimPanels,
  spotlightFrame,
  type Size,
  type TourRect,
} from "./geometry";
import { TourMascot } from "./TourMascot";

/**
 * The tour's overlay: dim, spotlight, card, and Fin.
 *
 * Rendered only by TourProvider while a run is active.
 *
 * HOW THE SPOTLIGHT WORKS. Web punches a hole in the dim with a huge
 * box-shadow spread; React Native has no such trick and no CSS mask. The
 * robust native equivalent is FOUR DIM PANELS — above, below, left and right
 * of the measured rectangle — leaving the target area untouched, plus a ring
 * drawn around it. No SVG, no mask, no extra dependency, and it degrades
 * cleanly: when there is no rectangle the four panels collapse into one
 * full-screen dim behind a centered card.
 *
 * NOT A MODAL, DELIBERATELY. It was one, and that is what put every spotlight
 * a status bar's height above the control it was describing: a Modal is a
 * separate native window on Android, `measureInWindow` reports the app's
 * window, and the two origins differ by whatever the system decided to inset.
 * Drawn in the app's own tree the overlay shares one coordinate space with
 * everything it points at — and it still translates each target by its OWN
 * measured origin (geometry.ts) rather than trusting that its parent sits at
 * 0,0, so a future layout change cannot quietly reintroduce the same drift.
 *
 * THE SCREEN IS SCROLLED TO THE STEP. Home is taller than the phone, so the
 * figures the "Dashboard overview" step describes, the header switcher and the
 * Import CSV tile are usually all off screen when their step comes up. Before
 * a step is shown, a target that lives in the page is scrolled into the band
 * above the card — see revealTourTarget. Targets in the fixed furniture (the
 * tab bar, the Ask button) never move the page.
 *
 * A MISSING TARGET NEVER STRANDS THE TOUR. Measurement is retried for about a
 * second (a tab bar item mid-transition, a card still laying out); if it never
 * lands, the step is skipped IN THE DIRECTION OF TRAVEL — forward for Next,
 * backward for Back, and forward when there is nothing behind. Same rule web
 * follows, and the reason the step counter counts only what is showable.
 *
 * TOUCHES. The overlay covers the app, so nothing underneath is interactive
 * while a step is up — including inside the cut-out, which is a visual
 * emphasis and not a live control. That matches web, where a transparent layer
 * blocks the page.
 *
 * MOTION. The card cross-fades between steps, and the spotlight fades in with
 * it. Both are dropped entirely when the phone asks for reduced motion.
 */

/** The card's clearance from the spotlight and from the safe area. */
const GAP = space.md;
/**
 * Sampling budget for a target: ~1.7s at 14 x 120ms.
 *
 * It covers two different waits with one loop — an element that has not laid
 * out yet (a tab bar item mid-transition, a card still arriving) and one that
 * has laid out but is still MOVING. Both end the same way: a rectangle that
 * measures the same twice running.
 */
const MEASURE_TRIES = 14;
const MEASURE_INTERVAL_MS = 120;
/** How long a scroll is given to settle before the target is measured. */
const SCROLL_SETTLE_MS = 420;
/**
 * A head start for the "+" menu, whose circles spring out along an arc.
 *
 * Not the thing that makes the measurement correct — `rectsAgree` below does
 * that, by refusing any rectangle that has not measured the same twice — but
 * it stops the first few samples being spent on a circle that has not left the
 * button yet. A fixed wait alone was the bug: on a first open the springs
 * start late enough (the step's own render is in front of them on the JS
 * thread) that the arc was still travelling when the timer fired, so the
 * spotlight landed on the "+" and stayed there until the step was revisited.
 */
const QUICK_ADD_SETTLE_MS = 240;
/** The scrim. ink[900] at the same weight the app's other modal backdrops use. */
/** The scrim. Fixed rather than themed: the tour dims the whole app, and a
 *  lighter dim on a dark page would not read as a spotlight at all. */
const SCRIM = "rgba(26,32,34,0.55)";

export function TourOverlay() {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const tour = useTourOptional();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  const stepIndex = tour?.stepIndex ?? 0;
  const step = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0]!;

  /** The overlay's own position and size, in window coordinates. */
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const rootRef = useRef<View | null>(null);

  const [rect, setRect] = useState<TourRect | null>(null);
  /**
   * The card's own height, measured rather than guessed: it changes with the
   * length of the step's copy and with the system font-size setting, and a
   * hard-coded estimate is how a card ends up half off the bottom of a small
   * phone at large type. The initial value only governs the first frame.
   */
  const [cardHeight, setCardHeight] = useState(240);
  const cardHeightRef = useRef(cardHeight);
  cardHeightRef.current = cardHeight;
  /** Which way the owner is moving, so a dead target is skipped that way. */
  const directionRef = useRef<1 | -1>(1);
  const fade = useRef(new Animated.Value(1)).current;

  const next = tour?.next;
  const back = tour?.back;

  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    // Measured, not assumed: this is the anchor every target is translated by.
    rootRef.current?.measureInWindow((x, y) => {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        setOrigin((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
      } else {
        setOrigin((prev) => prev ?? { x: 0, y: 0 });
      }
    });
  }, []);

  // ---- scroll the step's target into view, then measure it ----
  const ready = size.height > 0 && origin !== null;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRect(null);

    const key = step.target;
    if (!key || !ready || !origin) return;

    const card = cardHeightRef.current;
    const viewport = {
      viewportTop: origin.y + insets.top + GAP,
      viewportBottom: origin.y + size.height - insets.bottom - card - GAP * 2,
      preferredTop: origin.y + insets.top + GAP + size.height * 0.1,
    };

    let tries = 0;
    /** The previous sample, which the next one has to agree with. */
    let previous: TourRect | null = null;

    const usable = (measured: TourRect) =>
      frameIsUsable(spotlightFrame(measured, origin, size, tourTargetOptions(key)?.pad), measured);

    const attempt = () => {
      void measureTourTarget(key).then((measured) => {
        if (cancelled) return;

        if (measured && usable(measured)) {
          // Two samples that agree mean the target has stopped moving. One
          // sample means nothing: the arc of quick-add actions travels out of
          // the "+" button, so an early reading is a spotlight on the button.
          if (previous && rectsAgree(previous, measured)) {
            setRect(measured);
            return;
          }
          previous = measured;
        } else {
          // Gone or unmeasurable — a half-scrolled target, an unmounted view.
          // Start the agreement over rather than pairing readings from either
          // side of the gap.
          previous = null;
        }

        if (++tries >= MEASURE_TRIES) {
          // Out of budget. A target that measured but never settled is still
          // worth pointing at — better a spotlight a few points out than a
          // step skipped over a feature the owner can see. Nothing measured at
          // all means there is nothing to point at: move on rather than sit on
          // a dimmed screen describing something that is not there.
          if (previous) setRect(previous);
          else {
            const hasPrevious = previousStepIndex(TOUR_STEPS, stepIndex, stepIsOnScreen) !== null;
            if (directionRef.current === -1 && hasPrevious) back?.();
            else next?.();
          }
          return;
        }
        timer = setTimeout(attempt, MEASURE_INTERVAL_MS);
      });
    };

    const begin = () => {
      // The menu opens because THIS step is active (App.tsx watches
      // activeStepId), so the first frame of the step is also the first frame
      // of the menu — give the arc a moment before spending samples on it.
      if (step.requiresQuickAdd) timer = setTimeout(attempt, QUICK_ADD_SETTLE_MS);
      else attempt();
    };

    void revealTourTarget(key, viewport).then((scrolled) => {
      if (cancelled) return;
      if (scrolled) timer = setTimeout(begin, SCROLL_SETTLE_MS);
      else begin();
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `cardHeight` is read through a ref on purpose: it changes when the card
    // for THIS step lays out, and re-running the effect on it would re-scroll
    // the page underneath every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, step.target, step.requiresQuickAdd, next, back, ready, origin, size.height, size.width, insets.top, insets.bottom]);

  // ---- announce each step, since the card's content swaps in place ----
  const { position, total } = stepPosition(TOUR_STEPS, stepIndex, stepIsOnScreen);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(
      `Step ${position} of ${total}. ${step.title}. ${step.body}`,
    );
    // Announced on a step change, not on every re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  // ---- cross-fade the card between steps ----
  useEffect(() => {
    if (reduceMotion) {
      fade.setValue(1);
      return;
    }
    fade.setValue(0);
    const animation = Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [stepIndex, reduceMotion, fade]);

  // ---- Android's back button ----
  // Treated as the visible Skip control rather than ignored: an overlay that
  // will not close to Back reads as a hang, and the tour is one row in More
  // away from being replayed. (The Modal this used to be got the same
  // behaviour free from onRequestClose.)
  const stop = tour?.stop;
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      stop?.("skipped");
      return true;
    });
    return () => sub.remove();
  }, [stop]);

  if (!tour) return null;

  const isLast = nextStepIndex(TOUR_STEPS, stepIndex, stepIsOnScreen) === null;
  const canGoBack = previousStepIndex(TOUR_STEPS, stepIndex, stepIsOnScreen) !== null;

  const goNext = () => {
    directionRef.current = 1;
    tour.next();
  };
  const goBack = () => {
    directionRef.current = -1;
    tour.back();
  };

  const targetOptions = step.target ? tourTargetOptions(step.target) : undefined;
  const frame =
    rect && origin && size.height > 0
      ? spotlightFrame(rect, origin, size, targetOptions?.pad)
      : null;
  const placement = frame
    ? cardPlacement({ frame, size, insets, cardHeight, gap: GAP })
    : null;

  return (
    <View
      ref={rootRef}
      onLayout={onRootLayout}
      style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 24 }]}
      accessibilityViewIsModal
      accessibilityLabel="Product tour"
      // Swallows every touch aimed at the app underneath, which is what the
      // Modal used to do. Buttons inside the card still receive their own.
      onStartShouldSetResponder={() => true}
    >
      {/*
        The dim. One full-screen panel when there is nothing to spotlight
        (the welcome and completion cards, and the moment before a target
        measures — so the screen never flashes bright between steps), four
        panels around the target when there is.
      */}
      {frame ? (
        scrimPanels(frame, size).map((panel, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={{ position: "absolute", backgroundColor: SCRIM, ...panel }}
          />
        ))
      ) : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM }]}
        />
      )}

      {frame ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: frame.y,
            left: frame.x,
            width: frame.width,
            height: frame.height,
            borderRadius: targetOptions?.radius ?? radius.md,
            borderWidth: 2,
            borderColor: brand[400],
          }}
        />
      ) : null}

      <Animated.View
        style={{
          position: "absolute",
          left: space.lg,
          right: space.lg,
          opacity: fade,
          ...(placement
            ? { top: placement.top }
            : { top: 0, bottom: 0, justifyContent: "center" }),
        }}
      >
        <View
          onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
          style={{
            backgroundColor: paper.DEFAULT,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: paper[200],
            padding: space.lg,
            shadowColor: ink[900],
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.18,
            shadowRadius: 12,
            elevation: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
            <TourMascot mascot={step.mascot} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                <T accessibilityRole="header" variant="title" style={{ flex: 1 }}>
                  {step.title}
                </T>
                <Pressable
                  onPress={() => tour.stop("skipped")}
                  accessibilityRole="button"
                  accessibilityLabel="Close the tour"
                  hitSlop={12}
                  style={({ pressed }) => ({
                    width: TAP - 12,
                    height: TAP - 12,
                    marginTop: -space.xs,
                    marginRight: -space.xs,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.full,
                    backgroundColor: pressed ? paper[100] : "transparent",
                  })}
                >
                  <Ionicons name="close" size={20} color={ink[500]} />
                </Pressable>
              </View>
              <T style={{ marginTop: space.xs }}>{step.body}</T>
            </View>
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
              marginTop: space.lg,
            }}
          >
            <T variant="caption" accessibilityLabel={`Step ${position} of ${total}`}>
              {position} of {total}
            </T>
            <Pressable
              onPress={() => tour.stop("skipped")}
              accessibilityRole="button"
              accessibilityLabel="Skip the tour"
              hitSlop={12}
              style={({ pressed }) => ({
                minHeight: TAP - 20,
                justifyContent: "center",
                paddingHorizontal: space.xs,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <T variant="caption" style={{ color: ink[600], textDecorationLine: "underline" }}>
                Skip
              </T>
            </Pressable>
            <View style={{ flex: 1 }} />
            {canGoBack ? (
              <Button title="Back" variant="secondary" onPress={goBack} />
            ) : null}
            <Button title={isLast ? "Finish" : "Next"} variant="brand" onPress={goNext} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}
