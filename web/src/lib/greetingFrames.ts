/**
 * Fin's greeting wave, as a frame sequence — the same 103-frame sequence
 * mobile bundles into its binary (see mobile/src/lib/greetingFrames.ts for
 * how it was made from the source video), re-encoded to WebP and served from
 * /public/mascot/greeting-frames so the browser can cache it across visits.
 *
 * Plain URL strings rather than imports: these are static public assets, not
 * bundled modules, so there is nothing for the bundler to do with them.
 */
const FRAME_NUMBERS = Array.from({ length: 103 }, (_, i) => i + 17);

export const GREETING_FRAMES: string[] = FRAME_NUMBERS.map(
  (n) => `/mascot/greeting-frames/greeting_${String(n).padStart(3, "0")}.webp`
);
