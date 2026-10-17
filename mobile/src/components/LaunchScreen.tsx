import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Platform, StatusBar, Text, View } from "react-native";
import { useReducedMotion } from "../lib/useReducedMotion";
import { mascotSource } from "./MascotState";
import { font, space, typeScale } from "../theme/tokens";

/*
 * Fixed brand colours, not theme tokens: this screen continues the native
 * splash, which the OS paints before the owner's theme is known, so it is the
 * same in every theme (see app.config.ts). Values are LIGHT_BRAND / accent steps.
 */
const PLATE = "#ffffff"; // the native splash background
const INK = "#0f423f"; // brand-900: "Fin"
const TEAL = "#0d7f72"; // brand-600: "Sight" and the caret
const MUTED = "#4a585c"; // ink-600, 7:1 on white
/** The skyline along the bottom: pale mint rising to amber, a chart that grows. */
const SKYLINE: readonly { height: number; color: string }[] = [
  { height: 70, color: "#effcf9" },
  { height: 120, color: "#e3f8f2" },
  { height: 95, color: "#effcf9" },
  { height: 170, color: "#d6f4ec" },
  { height: 140, color: "#e3f8f2" },
  { height: 210, color: "#c8f0e4" },
  { height: 180, color: "#fff2da" },
  { height: 250, color: "#fde7bd" },
];

const NAME = "FinSight";
/** Where "Fin" ends and "Sight" begins. */
const SPLIT = 3;

/** Must match `imageWidth` for expo-splash-screen in app.config.ts, so the handover has no jump. */
const BADGE_WIDTH = 200;
/** The logo file's own proportions (1195 × 1316). */
const BADGE_HEIGHT = Math.round((BADGE_WIDTH * 1316) / 1195);
/** The logo's size once it has stepped aside for the name. */
const SMALL = 0.42;
const GAP = space.md;
const TYPE_STEP_MS = 70;
/** How long the finished name stays up before the sequence counts as done. */
const HOLD_MS = 300;
/**
 * The shortest time this screen stays up once the fonts arrive, by product
 * decision: the app opens only after both this and the sequence are done.
 * Change this one number to shorten it.
 */
export const MIN_SHOW_MS = 3_000;
/** The longest the app ever waits on this screen after the fonts arrive. */
const HOLD_CAP_MS = MIN_SHOW_MS + 2_000;

/**
 * Continues the native splash, then writes the name out beside the logo
 * while the session is restored.
 *
 * The logo starts exactly where the OS splash drew it (same file, same width,
 * screen centre), so the moment the native splash hides nothing moves. Then it
 * shrinks and steps left, and "FinSight" types out beside it behind a blinking
 * caret, the tagline fades in under the pair, and a pale bar-chart skyline
 * rises along the bottom edge. The caret keeps blinking while the app loads.
 *
 * The app opens (`onFinished`) once the sequence has finished (about 1.8s)
 * AND MIN_SHOW_MS has passed since the fonts arrived — the finished screen
 * holds, caret blinking, for the rest — and never later than HOLD_CAP_MS.
 * With Reduce Motion on, the finished layout shows at once and nothing moves
 * or blinks; the minimum time still applies.
 */
export function LaunchScreen({
  fontsReady,
  onFinished,
}: {
  fontsReady: boolean;
  /**
   * Called once the name has finished typing and MIN_SHOW_MS has passed, so
   * the app neither cuts the sequence off mid-word nor opens before the
   * minimum. Always called — within HOLD_CAP_MS of the fonts arriving — even
   * if a layout measurement never comes back, so the app can never get stuck.
   */
  onFinished?: () => void;
}) {
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const doneRef = useRef(false);
  const sequenceDone = useRef(false);
  const minimumDone = useRef(false);
  const release = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    finishedRef.current?.();
  };
  /** The sequence has played out; the app opens if the minimum time is up too. */
  const finish = () => {
    sequenceDone.current = true;
    if (minimumDone.current) release();
  };
  const reduceMotion = useReducedMotion();
  const step = useRef(new Animated.Value(0)).current;
  const caret = useRef(new Animated.Value(1)).current;
  const skyline = useRef(new Animated.Value(0)).current;
  const tagline = useRef(new Animated.Value(0)).current;
  const [typed, setTyped] = useState(0);
  /** The width of the lockup's name, measured once the fonts are in, so the logo knows how far to step. */
  const [nameWidth, setNameWidth] = useState<number | null>(null);

  // The handover: logo steps aside, then the name types, then the tagline.
  useEffect(() => {
    if (!fontsReady || nameWidth === null) return;
    if (reduceMotion) {
      step.setValue(1);
      skyline.setValue(1);
      tagline.setValue(1);
      setTyped(NAME.length);
      finish();
      return;
    }
    const rise = Animated.timing(skyline, { toValue: 1, duration: 700, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: Platform.OS !== "web" });
    const aside = Animated.timing(step, { toValue: 1, duration: 520, delay: 120, easing: Easing.bezier(0.5, 0, 0.2, 1), useNativeDriver: Platform.OS !== "web" });
    rise.start();
    let timer: ReturnType<typeof setInterval> | undefined;
    let hold: ReturnType<typeof setTimeout> | undefined;
    aside.start(({ finished }) => {
      if (!finished) return;
      timer = setInterval(() => {
        setTyped((count) => {
          if (count + 1 >= NAME.length) {
            clearInterval(timer);
            Animated.timing(tagline, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start(() => {
              // A beat with the whole name on screen before the app takes over.
              hold = setTimeout(finish, HOLD_MS);
            });
          }
          return Math.min(NAME.length, count + 1);
        });
      }, TYPE_STEP_MS);
    });
    return () => {
      rise.stop();
      aside.stop();
      if (timer) clearInterval(timer);
      if (hold) clearTimeout(hold);
    };
    // `finish` only reads refs, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontsReady, nameWidth, reduceMotion, skyline, step, tagline]);

  // The minimum time on screen, and the safety net: whatever happens to the
  // sequence, the app is let in by HOLD_CAP_MS.
  useEffect(() => {
    if (!fontsReady) return;
    const minimum = setTimeout(() => {
      minimumDone.current = true;
      if (sequenceDone.current) release();
    }, MIN_SHOW_MS);
    const cap = setTimeout(release, HOLD_CAP_MS);
    return () => {
      clearTimeout(minimum);
      clearTimeout(cap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontsReady]);

  // The caret blinks for as long as the app is still loading.
  useEffect(() => {
    if (!fontsReady || reduceMotion) {
      caret.setValue(reduceMotion ? 0 : 1);
      return;
    }
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(caret, { toValue: 0, duration: 1, delay: 380, useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(caret, { toValue: 1, duration: 1, delay: 380, useNativeDriver: Platform.OS !== "web" }),
      ]),
    );
    blink.start();
    return () => blink.stop();
  }, [caret, fontsReady, reduceMotion]);

  /*
   * The lockup is laid out in its FINAL shape — small logo, gap, name — and
   * the logo is drawn from its starting point: full size at the screen centre.
   * From the centre of the final row, the small logo sits half the name's
   * width (plus the gap) to the left of centre.
   */
  const smallWidth = BADGE_WIDTH * SMALL;
  const startOffset = nameWidth === null ? 0 : (nameWidth + GAP) / 2;
  const badgeTransform = [
    { translateX: step.interpolate({ inputRange: [0, 1], outputRange: [startOffset, 0] }) },
    { scale: step.interpolate({ inputRange: [0, 1], outputRange: [1 / SMALL, 1] }) },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: PLATE }}>
      <StatusBar barStyle="dark-content" backgroundColor={PLATE} />

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ pointerEvents: "none", position: "absolute", left: space.lg, right: space.lg, bottom: 0, flexDirection: "row", alignItems: "flex-end", gap: space.sm }}
      >
        {SKYLINE.map((bar, i) => (
          <Animated.View
            key={i}
            style={{
              flex: 1,
              height: bar.height,
              borderTopLeftRadius: 10,
              borderTopRightRadius: 10,
              backgroundColor: bar.color,
              // scaleY grows from the baseline: shift by half the lost height.
              transform: [
                { translateY: skyline.interpolate({ inputRange: [0, 1], outputRange: [bar.height / 2, 0] }) },
                { scaleY: skyline },
              ],
            }}
          />
        ))}
      </View>

      {/* Centred on the whole window, as the native splash is, not on the safe area. */}
      <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: GAP }}>
          <Animated.View style={{ width: smallWidth, height: BADGE_HEIGHT * SMALL, alignItems: "center", justifyContent: "center", transform: badgeTransform }}>
            <Image
              source={mascotSource("brandMark")}
              style={{ width: smallWidth, height: BADGE_HEIGHT * SMALL }}
              resizeMode="contain"
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </Animated.View>

          {fontsReady ? (
            <View
              accessible
              accessibilityRole="header"
              accessibilityLabel={NAME}
              onLayout={(e) => {
                const measuredWidth = e.nativeEvent.layout.width;
                setNameWidth((w) => w ?? measuredWidth);
              }}
              // Out of the row, unseen, until measured: joining the row before
              // the logo knows its offset would shove the logo left for a frame.
              style={{ flexDirection: "row", alignItems: "center", position: nameWidth === null ? "absolute" : "relative", opacity: nameWidth === null ? 0 : 1 }}
            >
              {/* The full name, invisible, holds the row's final width while the letters arrive. */}
              <Text style={{ fontFamily: font.displayBold, fontSize: typeScale.titleLg, opacity: 0 }}>{NAME}</Text>
              <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "center" }}>
                <Text style={{ fontFamily: font.displayBold, fontSize: typeScale.titleLg }}>
                  <Text style={{ color: INK }}>{NAME.slice(0, Math.min(typed, SPLIT))}</Text>
                  <Text style={{ color: TEAL }}>{typed > SPLIT ? NAME.slice(SPLIT, typed) : ""}</Text>
                </Text>
                <Animated.View style={{ width: 3, height: typeScale.titleLg, marginLeft: 2, borderRadius: 1, backgroundColor: TEAL, opacity: caret }} />
              </View>
            </View>
          ) : null}
        </View>

        {fontsReady ? (
          <Animated.View
            style={{
              alignItems: "center",
              marginTop: space.lg,
              opacity: tagline,
              transform: [{ translateY: tagline.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
            }}
          >
            <Text style={{ fontFamily: font.sans, fontSize: typeScale.body, color: MUTED, textAlign: "center", maxWidth: 320 }}>
              A clearer view of your business.
            </Text>
            <View accessible accessibilityRole="progressbar" accessibilityLabel="Opening FinSight" accessibilityState={{ busy: true }} style={{ marginTop: space.md }}>
              <Text style={{ fontFamily: font.sansMedium, fontSize: typeScale.bodySm, color: MUTED, textAlign: "center" }}>
                Opening your workspace…
              </Text>
            </View>
          </Animated.View>
        ) : null}
      </View>
    </View>
  );
}
