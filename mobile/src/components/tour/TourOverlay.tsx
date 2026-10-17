import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  findNodeHandle,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, T } from "../ui";
import { radius, space } from "../../theme/tokens";
import { shadowStyle } from "../../theme/shadow";
import { TAP_FLOOR } from "../touchTarget";
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
  cardViewportHeight,
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
 * A MISSING TARGET NEVER STRANDS THE TOUR. Measurement has a two-second
 * deadline (a tab bar item mid-transition, a card still laying out); if it never
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
/** A wall-clock bound also covers native measurements that never call back. */
const MEASURE_BUDGET_MS = 2000;
const MEASURE_INTERVAL_MS = 80;
/** The scrim. Fixed rather than themed: the tour dims the whole app, and a
 *  lighter dim on a dark page would not read as a spotlight at all. */
const SCRIM = "rgba(26,32,34,0.55)";

export function TourOverlay() {
  const t = useTheme();
  const { ink, paper } = t;
  const tour = useTourOptional();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  const stepIndex = tour?.stepIndex ?? 0;
  const requestedStep = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0]!;
  const [shownStepIndex, setShownStepIndex] = useState(stepIndex);
  const step = TOUR_STEPS[shownStepIndex] ?? TOUR_STEPS[0]!;
  const [settling, setSettling] = useState(!!requestedStep.target);
  const navigationLock = useRef(false);
  const tourRef = useRef(tour);
  tourRef.current = tour;
  const headingRef = useRef<View | null>(null);
  const [headingFocused, setHeadingFocused] = useState(false);
  const mounted = useRef(true);
  const layoutRevision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      layoutRevision.current += 1;
    };
  }, []);

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
  const cardY = useRef(new Animated.Value(0)).current;
  const lastTop = useRef<number | null>(null);
  const positionedHeight = useRef(0);

  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const revision = ++layoutRevision.current;
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    // Measured, not assumed: this is the anchor every target is translated by.
    rootRef.current?.measureInWindow((x, y) => {
      if (!mounted.current || layoutRevision.current !== revision) return;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        setOrigin((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
      } else {
        setOrigin((prev) => prev ?? { x: 0, y: 0 });
      }
    });
  }, []);

  // ---- scroll the step's target into view, then measure it ----
  const ready = size.height > 0 && origin !== null;
  const pending = !ready || settling || shownStepIndex !== stepIndex;
  const maxCardHeight = cardViewportHeight(size, insets, GAP);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    navigationLock.current = true;
    setSettling(true);
    if (!ready || !origin) return;
    const key = requestedStep.target;

    const finish = (measured: TourRect | null) => {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      if (!reduceMotion && shownStepIndex !== stepIndex) fade.setValue(0);
      setRect(measured);
      setShownStepIndex(stepIndex);
      setSettling(false);
      navigationLock.current = false;
    };

    const skip = () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      const current = tourRef.current;
      if (!current || current.stepIndex !== stepIndex) return;
      const direction = directionRef.current === -1 ? "back" : "next";
      if (current.skipUnavailable) current.skipUnavailable(direction);
      else {
        const hasPrevious = previousStepIndex(TOUR_STEPS, stepIndex, stepIsOnScreen) !== null;
        if (direction === "back" && hasPrevious) current.back();
        else current.next();
      }
    };

    if (!key) {
      finish(null);
      return;
    }

    const card = Math.min(cardHeightRef.current, maxCardHeight);
    const viewport = {
      viewportTop: origin.y + insets.top + GAP,
      viewportBottom: origin.y + size.height - insets.bottom - card - GAP * 2,
      preferredTop: origin.y + insets.top + GAP + size.height * 0.1,
    };

    /** The previous sample, which the next one has to agree with. */
    let previous: TourRect | null = null;

    const usable = (measured: TourRect) =>
      frameIsUsable(spotlightFrame(measured, origin, size, tourTargetOptions(key)?.pad), measured);

    const attempt = () => {
      void measureTourTarget(key, controller.signal).then((measured) => {
        if (cancelled) return;

        if (measured && usable(measured)) {
          // Two samples that agree mean the target has stopped moving. One
          // sample means nothing: the arc of quick-add actions travels out of
          // the "+" button, so an early reading is a spotlight on the button.
          if (previous && rectsAgree(previous, measured)) {
            finish(measured);
            return;
          }
          previous = measured;
        } else {
          // Gone or unmeasurable — a half-scrolled target, an unmounted view.
          // Start the agreement over rather than pairing readings from either
          // side of the gap.
          previous = null;
        }

        timer = setTimeout(attempt, MEASURE_INTERVAL_MS);
      }).catch(() => {
        if (!cancelled) timer = setTimeout(attempt, MEASURE_INTERVAL_MS);
      });
    };
    deadline = setTimeout(skip, MEASURE_BUDGET_MS);
    void revealTourTarget(key, viewport, { animated: !reduceMotion, signal: controller.signal }).then(() => {
      if (cancelled) return;
      attempt();
    }).catch(() => {
      if (!cancelled) attempt();
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
    };
    // `cardHeight` is read through a ref on purpose: it changes when the card
    // for THIS step lays out, and re-running the effect on it would re-scroll
    // the page underneath every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, requestedStep.target, ready, origin, size.height, size.width, insets.top, insets.bottom, reduceMotion, fade]);

  // ---- announce each step, since the card's content swaps in place ----
  const eligible = (candidate: typeof step) => !tour?.unavailableStepIds?.includes(candidate.id) && stepIsOnScreen(candidate);
  const { position, total } = stepPosition(TOUR_STEPS, shownStepIndex, eligible);
  useEffect(() => {
    if (pending) return;
    const timer = setTimeout(() => {
      if (Platform.OS === "web") (headingRef.current as (View & { focus?: () => void }) | null)?.focus?.();
      else {
        const handle = findNodeHandle(headingRef.current);
        if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
        AccessibilityInfo.announceForAccessibility(`Step ${position} of ${total}. ${step.title}. ${step.body}`);
      }
    }, reduceMotion ? 0 : 180);
    return () => clearTimeout(timer);
    // Announced on a step change, not on every re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownStepIndex, pending, reduceMotion]);

  // ---- cross-fade the card between steps ----
  useEffect(() => {
    if (reduceMotion) {
      fade.setValue(1);
      return;
    }
    fade.setValue(0);
    const animation = Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== "web" });
    animation.start();
    return () => animation.stop();
  }, [shownStepIndex, reduceMotion, fade]);

  // ---- Android's back button ----
  // Treated as the visible Skip control rather than ignored: an overlay that
  // will not close to Back reads as a hang, and the tour is one row in More
  // away from being replayed. (The Modal this used to be got the same
  // behaviour free from onRequestClose.)
  const stop = tour?.stop;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      stop?.("skipped");
      return true;
    });
    return () => sub.remove();
  }, [stop]);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") tourRef.current?.stop("skipped");
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);

  const isLast = nextStepIndex(TOUR_STEPS, shownStepIndex, eligible) === null;
  const canGoBack = previousStepIndex(TOUR_STEPS, shownStepIndex, eligible) !== null;

  const goNext = () => {
    if (pending || navigationLock.current) return;
    navigationLock.current = true;
    directionRef.current = 1;
    tourRef.current?.next();
  };
  const goBack = () => {
    if (pending || navigationLock.current) return;
    navigationLock.current = true;
    directionRef.current = -1;
    tourRef.current?.back();
  };

  const targetOptions = step.target ? tourTargetOptions(step.target) : undefined;
  const frame =
    !pending && rect && origin && size.height > 0
      ? spotlightFrame(rect, origin, size, targetOptions?.pad)
      : null;
  const placement = frame
    ? cardPlacement({ frame, size, insets, cardHeight: Math.min(cardHeight, maxCardHeight), gap: GAP })
    : null;
  const candidateTop = pending && lastTop.current !== null
    ? lastTop.current
    : placement?.top ?? Math.max(insets.top + GAP, (size.height - Math.min(cardHeight, maxCardHeight)) / 2);
  const minTop = insets.top + GAP;
  const maxTop = Math.max(minTop, size.height - insets.bottom - GAP - Math.min(cardHeight, maxCardHeight));
  const top = Math.max(minTop, Math.min(candidateTop, maxTop));
  useEffect(() => {
    if (!ready) return;
    const resized = positionedHeight.current !== size.height;
    positionedHeight.current = size.height;
    if (reduceMotion || lastTop.current === null || resized) {
      cardY.setValue(top);
      lastTop.current = top;
      return;
    }
    lastTop.current = top;
    const animation = Animated.timing(cardY, { toValue: top, duration: 180, useNativeDriver: Platform.OS !== "web" });
    animation.start();
    return () => animation.stop();
  }, [top, ready, reduceMotion, cardY, size.height]);

  if (!tour) return null;

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
            style={{ pointerEvents: "none", position: "absolute", backgroundColor: SCRIM, ...panel }}
          />
        ))
      ) : (
        <View
          style={[StyleSheet.absoluteFill, { pointerEvents: "none", backgroundColor: SCRIM }]}
        />
      )}

      {frame ? (
        <Animated.View
          style={{
            pointerEvents: "none",
            opacity: fade,
            position: "absolute",
            top: frame.y,
            left: frame.x,
            width: frame.width,
            height: frame.height,
            borderRadius: targetOptions?.radius ?? radius.md,
            borderWidth: 2,
            borderColor: t.brandText,
          }}
        />
      ) : null}

      <Animated.View
        style={{
          position: "absolute",
          left: space.lg,
          right: space.lg,
          opacity: ready ? fade : 0,
          top: 0,
          transform: [{ translateY: cardY }],
        }}
      >
        <ScrollView
          onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space.lg }}
          style={{
            backgroundColor: paper.DEFAULT,
            maxHeight: maxCardHeight,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: paper[200],
            ...shadowStyle({ color: t.shadow, offsetY: 4, opacity: 0.18, blurRadius: 12, elevation: 8 }),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
            <TourMascot mascot={step.mascot} size={56} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                <View
                  ref={headingRef}
                  accessible
                  accessibilityRole="header"
                  accessibilityLabel={`Step ${position} of ${total}. ${step.title}`}
                  tabIndex={Platform.OS === "web" ? -1 : undefined}
                  onFocus={() => setHeadingFocused(true)}
                  onBlur={() => setHeadingFocused(false)}
                  style={{ flex: 1, ...(Platform.OS === "web" && headingFocused ? { outlineColor: t.brandText, outlineWidth: 2, outlineStyle: "solid", outlineOffset: space.xs } : {}) }}
                >
                <T variant="title">
                  {step.title}
                </T>
                </View>
                <Pressable
                  onPress={() => tour.stop("skipped")}
                  accessibilityRole="button"
                  accessibilityLabel="Close the tour"
                  style={({ pressed }) => ({
                    width: TAP_FLOOR,
                    height: TAP_FLOOR,
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
              <T accessibilityLiveRegion={Platform.OS === "web" ? "polite" : undefined} style={{ marginTop: space.xs }}>{step.body}</T>
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
            <T variant="caption" accessibilityLabel={`Step ${position} of ${total}`} style={{ flex: 1 }}>
              {position} of {total}
            </T>
            <Pressable
              onPress={() => tour.stop("skipped")}
              accessibilityRole="button"
              accessibilityLabel="Skip the tour"
              style={({ pressed }) => ({
                minHeight: TAP_FLOOR,
                justifyContent: "center",
                paddingHorizontal: space.xs,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <T variant="caption" style={{ color: ink[600], textDecorationLine: "underline" }}>
                Skip tour
              </T>
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm }}>
            {canGoBack ? (
              <Button title="Back" variant="secondary" onPress={goBack} disabled={pending} style={{ flexGrow: 1, flexBasis: 96 }} focusRingColor={t.brandText} />
            ) : null}
            <Button title={isLast ? "Finish" : shownStepIndex === 0 ? "Start tour" : "Next"} variant="primary" onPress={goNext} disabled={pending} style={{ flexGrow: 1, flexBasis: 96 }} focusRingColor={t.brandText} />
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}
