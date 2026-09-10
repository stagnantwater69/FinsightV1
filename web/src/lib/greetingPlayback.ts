/**
 * How Fin's greeting plays: the complete wave, on repeat.
 *
 * Ported verbatim from mobile's lib/greetingPlayback.ts so both clients play
 * the same wave at the same rate. See that file for the reasoning behind each
 * constant — none of it is platform-specific.
 */

/** The source video's own frame rate, halved — see greetingFrames.ts. */
export const GREETING_FPS = 12;

/** A calm, centred pose used when the owner has requested reduced motion. */
export const GREETING_REST_FRAME = 43;

/** How long to blend the last frame of the wave into the first. */
export const GREETING_WRAP_CROSSFADE_MS = 250;

/**
 * Where playback goes next. `total` is the length of the frame sequence,
 * passed in so this stays free of the asset list itself.
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
