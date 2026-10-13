import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { Card } from "./ui";
import { SkeletonLine } from "./Skeleton";
import { dateLine, greetingFor, pickHeadline } from "../lib/homeInsight";
import { GREETING_FRAMES } from "../lib/greetingFrames";
import {
  advanceGreetingFrame,
  GREETING_FPS,
  GREETING_REST_FRAME,
  GREETING_WRAP_CROSSFADE_MS,
} from "../lib/greetingPlayback";
import { useReducedMotion } from "../lib/useReducedMotion";
import type { DashboardSummary } from "../lib/types";

/**
 * The two ways Fin's line can read, as themed token triples.
 *
 * These mirror `CALLOUT_TONES` in ui.tsx rather than inventing a second,
 * slightly different warn treatment — an owner who has learned that the amber
 * callout means "act on this" reads this panel the same way. `plain` takes the
 * brand triple for the same reason mobile's does.
 *
 * FIN'S NAME IS BRAND, NOT ACCENT, on the plain variant. The accent scale is
 * reserved for the Recovery Meter and primary CTAs (see tailwind.config.js), so
 * a name badge sitting in it every ordinary day would be claiming an urgency it
 * does not have. On the warn variant the whole panel is already the accent
 * triple, and the name inherits it.
 */
const MESSAGE_TONE = {
  plain: "bg-tint-brand text-tone-brand ring-edge-brand",
  warn: "bg-tint-accent text-tone-accent ring-edge-accent",
} as const;

/** Matches the 96px empty-state mascot box, less the row's own breathing room. */
const MASCOT_BOX = 88;

/**
 * Fetch and decode every frame before playback, resolving when the whole
 * sequence is in the browser's cache and ready to paint.
 *
 * `fetchpriority=low` on purpose: this is 1.5MB of decoration on a dashboard
 * whose figures are still in flight, and on a phone tethered to mobile data
 * the summary request must win the connection. Failures resolve rather than
 * reject — a missing frame should let the wave play with a held image, not
 * strand Fin on the rest pose forever.
 */
function preloadGreetingFrames(onReady: () => void): () => void {
  let cancelled = false;

  const load = (src: string) =>
    new Promise<void>((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.setAttribute("fetchpriority", "low");
      // Decoding ahead of time as well as downloading: an undecoded WebP
      // still costs a main-thread decode at paint, which at 12fps is exactly
      // the stutter this preload exists to remove.
      img.onload = () => {
        if (typeof img.decode === "function") {
          img.decode().then(
            () => resolve(),
            () => resolve(),
          );
        } else {
          resolve();
        }
      };
      img.onerror = () => resolve();
      img.src = src;
    });

  void Promise.all(GREETING_FRAMES.map(load)).then(() => {
    if (!cancelled) onReady();
  });

  return () => {
    cancelled = true;
  };
}

/**
 * Fin's flipbook: the complete greeting wave, on repeat.
 *
 * Ported from mobile's GreetingHero (FinFlipbook) so both clients play the
 * same wave at the same rate. The 103 frames are re-encoded to WebP and
 * served from /public (~1.5MB total, cached by the browser after the first
 * visit) rather than bundled — see lib/greetingFrames.ts.
 *
 * PLAYBACK NEVER FETCHES. Swapping `src` on a 12fps interval means a cold
 * cache requests each frame at the moment it is due, so the first cycle
 * shows blanks and held poses over a mobile connection. Instead Fin holds
 * the rest pose — one image, the same one reduced-motion users get — until
 * the sequence has been fetched AND decoded, and only then starts the
 * interval.
 *
 * Held as its own component for the same reason mobile's is: a state change
 * twelve times a second should only re-render the two images below, not the
 * greeting line, the speech bubble and the card around them.
 */
function FinFlipbook({ label }: { label: string }) {
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState(GREETING_REST_FRAME);
  const [wrapOpacity, setWrapOpacity] = useState(0);

  // A ref rather than state, so it survives the effect re-running: leaving
  // the tab and coming back picks the wave up where it was paused instead of
  // snapping Fin back to the opening frame. It starts at the rest pose so
  // that the first tick continues from the image already on screen rather
  // than cutting to the top of the sequence.
  const position = useRef(GREETING_REST_FRAME);

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    // Under reduced motion the other 102 frames are never shown, so they are
    // never requested either — the setting saves the download, not just the
    // movement.
    if (reduceMotion) return;
    return preloadGreetingFrames(() => setReady(true));
  }, [reduceMotion]);

  useEffect(() => {
    // "Reduce Motion" is usually on for a reason — a wave that repeats
    // forever is exactly what that setting exists to stop, so it holds on a
    // calm centred pose instead.
    if (reduceMotion) {
      setFrame(GREETING_REST_FRAME);
      return;
    }

    // Nothing moves until every frame is decoded and waiting.
    if (!ready) return;

    // Paused while the tab isn't visible: otherwise the flipbook keeps
    // ticking twelve times a second in a background tab nobody can see.
    if (!visible) return;

    let current = position.current;
    setFrame(current);

    const id = setInterval(() => {
      const next = advanceGreetingFrame(current, GREETING_FRAMES.length);
      current = next.frame;
      position.current = current;

      // The tick that wraps the end of the wave back to its start. The
      // sequence opens closer to camera than it closes, so this is a cut of
      // twice a normal step; fading the outgoing final frame out over the
      // restarted wave covers it. See GREETING_WRAP_CROSSFADE_MS.
      if (next.blend) {
        setWrapOpacity(1);
        requestAnimationFrame(() => setWrapOpacity(0));
      }

      setFrame(current);
    }, 1000 / GREETING_FPS);

    return () => clearInterval(id);
  }, [visible, reduceMotion, ready]);

  const playing = ready && !reduceMotion;

  return (
    <div
      className="relative shrink-0 select-none overflow-hidden rounded-xl"
      style={{ width: MASCOT_BOX, height: MASCOT_BOX }}
    >
      <img
        src={GREETING_FRAMES[frame]}
        alt={label}
        width={MASCOT_BOX}
        height={MASCOT_BOX}
        loading="eager"
        fetchPriority="high"
        className="h-full w-full object-cover"
        draggable={false}
      />
      {/*
        The wrap layer only exists while the wave is actually running: at
        rest — and permanently, under reduced motion — it is a second image
        request for a frame nobody will see.
      */}
      {playing ? (
        <img
          src={GREETING_FRAMES[GREETING_FRAMES.length - 1]}
          alt=""
          aria-hidden="true"
          width={MASCOT_BOX}
          height={MASCOT_BOX}
          className="absolute inset-0 h-full w-full object-cover transition-opacity ease-linear"
          style={{ opacity: wrapOpacity, transitionDuration: `${GREETING_WRAP_CROSSFADE_MS}ms` }}
          draggable={false}
        />
      ) : null}
    </div>
  );
}

/**
 * The dashboard's opening line: who is reading, what day it is, and the one
 * thing worth saying about the business right now.
 *
 * Ported from mobile's GreetingHero so both clients open the same way. The
 * sentence itself comes from `pickHeadline`, shared verbatim with mobile.
 */
export function GreetingHero({ summary }: { summary: DashboardSummary | null }) {
  const { profile } = useAuth();
  const now = new Date();
  const greeting = greetingFor(now.getHours());
  const firstName = profile?.firstName?.trim();
  const headline = summary ? pickHeadline(summary) : null;
  const tone = MESSAGE_TONE[headline?.tone ?? "plain"];

  return (
    <Card className="mb-6 p-5">
      <p className="text-xs uppercase tracking-[0.06em] text-ink-500">{dateLine(now)}</p>

      {/*
        The NAME is the bold word, not the whole line. "Good evening" is the
        same three words every day at this hour; the name is the only part that
        is about the person reading it, so it carries the weight.
      */}
      <h2 className="mt-0.5 font-display text-xl font-semibold text-ink-900">
        {greeting}
        {firstName ? (
          <>
            , <span className="font-extrabold">{firstName}</span>
          </>
        ) : null}
        !
      </h2>

      {/*
        Fin and its line share a row, with a plain gap rather than the panel
        tucking under the mascot: the art's alpha box is a centred square with
        no transparent margin to slide beneath, so any overlap clips it.
      */}
      {/* Wraps below ~200px (a 320px phone at 200% zoom), where Fin and the
          panel cannot share a line: the panel's own padding alone exceeds
          what is left beside the art. The row is unchanged above that. */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <FinFlipbook label="Fin, FinSight's mascot" />

        <div className={`min-w-0 flex-1 rounded-2xl px-4 py-3 ring-1 ${tone}`}>
          <p className="text-xs font-semibold">Fin</p>
          {headline ? (
            <p className="mt-0.5 text-[13px] leading-relaxed">{headline.text}</p>
          ) : (
            /*
              The panel keeps its shape while the figures load rather than
              popping into existence a beat after the card — a greeting that
              changes height on arrival reads as a glitch.
            */
            <div className="mt-2 space-y-1.5">
              <SkeletonLine className="h-2 w-[92%]" />
              <SkeletonLine className="h-2 w-[64%]" />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
