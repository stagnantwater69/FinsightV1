/**
 * How Fin's greeting plays: the complete wave, on repeat.
 *
 * WHY THIS IS SEPARATE FROM greetingFrames.ts: that module `require()`s 103
 * PNGs, which node cannot parse and vitest has no asset stub configured for,
 * so anything sharing a file with it cannot be imported by a test at all. The
 * timings and the frame arithmetic are the part worth guarding — an off-by-one
 * here indexes past the end of the sequence and blanks the mascot out, which is
 * invisible in a diff and obvious on a phone — so they live on this side of the
 * line. The pictures stay on the other.
 */

/** The source video's own frame rate, halved — see greetingFrames.ts. */
export const GREETING_FPS = 12;

/** A calm, centred pose used when the owner has requested reduced motion. */
export const GREETING_REST_FRAME = 43;

/**
 * How long to blend the last frame of the wave into the first.
 *
 * THE SEQUENCE DOES NOT WRAP ON ITS OWN. Frame 102 back to frame 0 measures a
 * mean per-pixel difference of 22.4, against an average of 11.3 between
 * neighbouring frames — twice a normal step, because the source opens closer to
 * camera than it closes. Cut straight, that reads as a jump rather than as
 * motion, once every time round.
 *
 * There is no trim that fixes it: every [start, end] pair at least twelve
 * frames long was scored on how close its end-to-start cut came to an ordinary
 * adjacent step, and nothing anchored at the tail of the sequence comes in
 * under 11.0 — right on the threshold where a seam starts to show. So the wrap
 * is blended instead of avoided. A quarter of a second is long enough to cover
 * a cut of this size and short enough that it reads as Fin settling rather than
 * as a dissolve.
 */
export const GREETING_WRAP_CROSSFADE_MS = 250;

/**
 * Where playback goes next.
 *
 * `total` is the length of the frame sequence, passed in rather than imported
 * so that this stays free of the asset requires. The returned `blend` is true
 * on the tick that wraps the end of the sequence back to the start, which is
 * the caller's cue to run the crossfade.
 */
export function advanceGreetingFrame(
  frame: number,
  total: number
): { frame: number; blend: boolean } {
  const next = frame + 1;

  if (next >= total) {
    return { frame: 0, blend: true };
  }
  return { frame: next, blend: false };
}
