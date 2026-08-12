import { useEffect, useRef, useState } from "react";
import { Animated, Image, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Card, T } from "./ui";
import { SkeletonBox } from "./Skeleton";
import { useAuth } from "../context/AuthContext";
import { GREETING_FRAMES } from "../lib/greetingFrames";
import {
  advanceGreetingFrame,
  GREETING_FPS,
  GREETING_REST_FRAME,
  GREETING_WRAP_CROSSFADE_MS,
} from "../lib/greetingPlayback";
import { pickHeadline } from "../lib/homeInsight";
import { useReducedMotion } from "../lib/useReducedMotion";
import { brand, font, ink, radius, space, statusText, typeScale } from "../theme/tokens";
import type { DashboardSummary } from "../lib/types";

/**
 * The first thing on Home: who is looking, and what time it is for them.
 *
 * THIS USED TO BE TWO CARDS, then a greeting with a hand-animated still, then
 * a greeting playing assets/animatedgreeting.mp4 through a video component. A
 * greeting (person, not business — see below) sat above "At a glance", a
 * separate card of up to four bullet points; the two were merged so a mascot
 * was never floating above an unrelated card with nothing to do.
 *
 * FIN IS NOW A FRAME SEQUENCE, not a video. The whole point of putting a
 * mascot beside a speech bubble was for Fin to look like it is floating on
 * the card, not sitting in a little white rectangle — and no video codec
 * usable here can do that. Standard H.264 MP4 has no alpha channel at all;
 * the codecs that do (WebM+VP9, HEVC-with-alpha) are not both usable on iOS
 * and Android through Expo's video player. `lib/greetingFrames.ts` explains
 * how the source video became 103 already-transparent PNGs; this component
 * just cycles through them like a hand-drawn flipbook, which is the only
 * technique available here that actually gets rid of the background.
 *
 * FIN'S LINE LIVES HERE, beside the mascot. It spent one revision hung off the
 * header's bell instead, on the reasoning that its second-ranked branch was the
 * unread-alert count and the bell's badge already showed that number. Only half
 * of that turned out to be worth keeping: the message reads as something the
 * mascot is SAYING when it sits next to the mascot, and as a notification to
 * clear when it hangs off an alerts icon — and it is advice, not an alert. The
 * de-duplication survived the move back; homeInsight no longer mentions unread
 * alerts at all, because the badge counts them a thumb's width away.
 *
 * It is NOT DISMISSIBLE, which the bell version was. A fold-away speech bubble
 * reads as a notification to get rid of, which is the opposite of what a
 * greeting is for, and this is one short sentence rather than a list anyone
 * would need out of the way.
 *
 * Greets the PERSON, not the business. Everything else on this screen is scoped
 * to whichever business profile is selected — the header, the figures, the
 * charts — and an owner running two stalls switches between them several times
 * a visit. This line is the one part of the screen that stays theirs
 * regardless, which is what makes it read as a welcome rather than as another
 * label on the data.
 *
 * The headline is COMPOSED, NOT GENERATED — see lib/homeInsight for the full
 * reasoning. It costs nothing, works offline, and cannot say anything the data
 * does not.
 */

/** Visible size of the mascot in the card. */
const MASCOT_BOX = 92;

/**
 * How Fin's panel is coloured, by urgency.
 *
 * The warn pair is the app's existing treatment — the same `#fffbeb` surface on
 * `statusText.warning` ink that `ui.tsx` gives its warn chips and banners — so
 * an owner who has learned that amber-on-cream means "act on this" reads it the
 * same way here.
 *
 * FIN'S NAME IS TEAL, NOT AMBER, unlike the reference this layout was built
 * from. Amber is spoken for twice over: `tokens.ts` reserves the accent scale
 * for the Recovery Meter and primary CTAs and says so in as many words, and
 * amber-on-cream ALREADY means "urgent" in the row below. A mascot's name badge
 * sitting in that colour would be claiming an urgency it does not have, on
 * every ordinary day.
 */
const MESSAGE_TONE = {
  plain: { surface: brand[50], border: brand[100], ink: ink[800], label: brand[700] },
  warn: { surface: "#fffbeb", border: "#f2dda6", ink: statusText.warning, label: statusText.warning },
} as const;

/**
 * Fin's flipbook: the complete greeting wave, on repeat.
 *
 * WHY THIS IS ITS OWN COMPONENT: advancing a frame is a state change, and a
 * state change re-renders whatever component holds it. Held in GreetingHero,
 * every one of the twelve frames a second would re-render the greeting line,
 * the speech bubble and the card around them, for as long as Home is open —
 * which, since the animation never stops, is the whole session. Holding it
 * here means React only ever re-renders the two images below.
 */
function FinFlipbook({ label }: { label: string }) {
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const [frame, setFrame] = useState(0);

  /*
   * A ref rather than state, so it survives the effect re-running: leaving the
   * tab and coming back picks the wave up where it was paused instead of
   * snapping Fin back to the opening frame.
   */
  const position = useRef(0);

  // Opacity of the outgoing final frame, laid over the restarted wave for one
  // short blend. Parked at 0 the rest of the time, so the overlay is invisible
  // until there is a seam to hide.
  const wrap = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    /*
     * "Reduce Motion" is usually on for a reason — see useReducedMotion's own
     * header. A wave that repeats forever is exactly the kind of thing that
     * setting exists to stop, so it holds on a calm centred pose instead.
     */
    if (reduceMotion) {
      setFrame(GREETING_REST_FRAME);
      return;
    }

    /*
     * Home is a tab, and react-navigation keeps a visited tab mounted. Without
     * this the flipbook would go on ticking twelve times a second behind
     * Records or More — work nobody can see, on the JS thread, indefinitely.
     * Whatever frame is showing simply stays put until the tab comes back.
     */
    if (!focused) return;

    let current = position.current;
    setFrame(current);

    const id = setInterval(() => {
      const next = advanceGreetingFrame(current, GREETING_FRAMES.length);
      current = next.frame;
      position.current = current;

      /*
       * The tick that wraps the end of the wave back to its start. The sequence
       * opens closer to camera than it closes, so this is a cut of twice a
       * normal step; fading the outgoing final frame out over the restarted
       * wave covers it. See GREETING_WRAP_CROSSFADE_MS for why the seam is
       * blended rather than trimmed away.
       */
      if (next.blend) {
        wrap.setValue(1);
        Animated.timing(wrap, {
          toValue: 0,
          duration: GREETING_WRAP_CROSSFADE_MS,
          useNativeDriver: true,
        }).start();
      }

      setFrame(current);
    }, 1000 / GREETING_FPS);

    return () => clearInterval(id);
  }, [focused, reduceMotion, wrap]);

  return (
    <View style={{ width: MASCOT_BOX, height: MASCOT_BOX, borderRadius: 12, overflow: "hidden" }}>
      <Image
        source={GREETING_FRAMES[frame]}
        style={{ width: "100%", height: "100%" }}
        resizeMode="cover"
        // The image carries the mascot's name unconditionally now. It used to
        // be announced only when the speech bubble beside it was absent —
        // otherwise the bubble's own "Fin" label said the name a second time
        // for one line. There is no bubble on this card any more.
        accessibilityLabel={label}
      />
      <Animated.Image
        source={GREETING_FRAMES[GREETING_FRAMES.length - 1]}
        resizeMode="cover"
        // Never announced: it is the same mascot as the image underneath it,
        // on screen for a quarter of a second.
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          opacity: wrap,
        }}
      />
    </View>
  );
}

/**
 * Read from the device's own clock, so it matches the wall the owner is
 * standing next to rather than the server's timezone. Deliberately not
 * memoised: Home recomputes this on every focus and refresh, so a screen left
 * open across noon corrects itself the next time it is looked at.
 */
function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Today, as an eyebrow over the greeting.
 *
 * `en-PH` to match DateField, and read off the device clock for the same reason
 * `greetingFor` is: it should agree with the calendar on the wall the owner is
 * standing next to. Uppercasing is left to `textTransform` rather than done to
 * the string, so a screen reader still announces "Thursday, August 6" rather
 * than spelling out capitals.
 */
function dateLine(now: Date): string {
  return now.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * `summary` is nullable because this renders before the dashboard figures
 * arrive — the date, the greeting and Fin do not depend on them, so there is no
 * reason to make an owner wait on a network response before being welcomed. The
 * panel simply has nothing in it until `summary` lands.
 */
export function GreetingHero({ summary }: { summary: DashboardSummary | null }) {
  const { profile } = useAuth();
  const now = new Date();
  const greeting = greetingFor(now.getHours());
  const firstName = profile?.firstName?.trim();
  const headline = summary ? pickHeadline(summary) : null;
  const tone = MESSAGE_TONE[headline?.tone ?? "plain"];

  return (
    <Card style={{ paddingVertical: space.md, gap: space.md }}>
      <View>
        <T
          variant="label"
          style={{ textTransform: "uppercase", letterSpacing: 0.6, color: ink[400] }}
        >
          {dateLine(now)}
        </T>

        {/*
          The NAME is the bold word, not the whole line. "Good evening" is the
          same three words every day at this hour; the name is the only part
          that is about the person reading it, so it carries the weight. Both
          halves are the display face at title size — only the weight changes,
          which is what keeps it one sentence rather than two labels.
        */}
        <T accessibilityRole="header" variant="title" style={{ marginTop: 2, fontFamily: font.display }}>
          {greeting}
          {firstName ? (
            <>
              {/*
                `variant="title"` on the nested span too, overriding only the
                weight. Left on the default body variant it would carry body's
                own `lineHeight: 22` into a 20pt display line and shift the
                baseline — nested Text inherits the variant it is given, not the
                one it sits inside.
              */}
              , <T variant="title" style={{ fontFamily: font.displayBold }}>{firstName}</T>
            </>
          ) : null}
          !
        </T>
      </View>

      {/*
        Fin and its line share a row.

        THE PANEL DOES NOT TUCK UNDER THE MASCOT, which the reference layout
        this was built from does. Measured before trying it: the owl's alpha
        bounding box spans the full 320px width of every frame in the sequence,
        so there is no transparent margin for a panel to slide beneath. Any
        overlap at all clips the mascot rather than nesting behind it. A plain
        gap instead — the alternative was re-rendering 103 frames onto a wider
        canvas to buy a few points of tuck, which is not what it is worth.
      */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {/*
          No crop math needed here, unlike artCrop.ts's other assets: every
          frame was already cropped to a centred square and background-removed
          when the sequence was generated (see lib/greetingFrames.ts), so this
          is just a plain image at box size.
        */}
        <FinFlipbook label="Fin, FinSight's mascot" />

        <View
          style={{
            flex: 1,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            minHeight: MASCOT_BOX - space.md,
            justifyContent: "center",
            backgroundColor: tone.surface,
            borderWidth: 1,
            borderColor: tone.border,
            borderRadius: radius.xl,
          }}
        >
          <T variant="label" style={{ color: tone.label, fontFamily: font.sansSemibold }}>
            Fin
          </T>
          {headline ? (
            <T style={{ fontSize: typeScale.label, lineHeight: 19, marginTop: 2, color: tone.ink }}>{headline.text}</T>
          ) : (
            /*
              The panel keeps its shape while the figures load rather than
              popping into existence a beat after the card — a greeting that
              changes height on arrival reads as a glitch. Skeleton lines, not a
              spinner: this is text arriving, and the pulse is already gated on
              reduced motion.
            */
            <View style={{ gap: 6, marginTop: 6 }}>
              <SkeletonBox width="92%" height={9} borderRadius={4} />
              <SkeletonBox width="64%" height={9} borderRadius={4} />
            </View>
          )}
        </View>
      </View>
    </Card>
  );
}
