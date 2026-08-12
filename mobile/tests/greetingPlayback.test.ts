import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceGreetingFrame,
  GREETING_FPS,
  GREETING_REST_FRAME,
  GREETING_WRAP_CROSSFADE_MS,
} from "../src/lib/greetingPlayback";

/**
 * Fin waves on repeat, which is arithmetic on a frame index driven by a timer.
 * There is no render harness in this project, so the sums live in a plain
 * module and are checked here.
 *
 * The bugs this guards are all quiet in a diff and loud on a phone: run one
 * frame past the end of the sequence and `GREETING_FRAMES[frame]` is undefined,
 * so the mascot blanks out; wrap one frame early and the last frame of the wave
 * is never shown; miss the blend on the wrap and the seam the crossfade exists
 * to cover is on display every time round.
 */

/**
 * The real sequence length.
 *
 * Counted off disk rather than written down, because the crossfade below was
 * measured against THIS sequence. Regenerate the frames with different trim
 * points and a hardcoded length here would keep passing while playback ran off
 * the end of the array.
 */
const TOTAL = readdirSync(new URL("../assets/greeting-frames", import.meta.url)).filter((f) =>
  f.endsWith(".png")
).length;

/** Runs playback for `ticks` frames, returning every frame that was shown. */
function play(ticks: number, from = 0) {
  const shown = [from];
  const wraps: number[] = [];
  let frame = from;

  for (let i = 0; i < ticks; i += 1) {
    const next = advanceGreetingFrame(frame, TOTAL);
    if (next.blend) wraps.push(shown.length);
    frame = next.frame;
    shown.push(frame);
  }

  return { shown, wraps };
}

describe("advanceGreetingFrame", () => {
  it("plays the wave straight through, one frame at a time", () => {
    const { shown } = play(10);
    expect(shown).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("shows every frame of the sequence before wrapping", () => {
    const { shown, wraps } = play(TOTAL - 1);
    expect(shown).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
    expect(shown.at(-1)).toBe(TOTAL - 1);
    // Reaching the final frame is not itself a wrap — that comes one tick later.
    expect(wraps).toEqual([]);
  });

  it("wraps from the final frame back to the first", () => {
    const { frame, blend } = advanceGreetingFrame(TOTAL - 1, TOTAL);
    expect(frame).toBe(0);
    expect(blend).toBe(true);
  });

  it("does not wrap one frame early", () => {
    // The failure mode: the last frame of the wave is never shown.
    const { frame, blend } = advanceGreetingFrame(TOTAL - 2, TOTAL);
    expect(frame).toBe(TOTAL - 1);
    expect(blend).toBe(false);
  });

  it("never indexes past the end of the sequence", () => {
    const { shown } = play(TOTAL * 3);
    expect(Math.max(...shown)).toBeLessThan(TOTAL);
    expect(Math.min(...shown)).toBeGreaterThanOrEqual(0);
  });

  it("keeps looping the complete animation rather than settling anywhere", () => {
    // Four passes should visit every frame, not just a sub-range of them.
    const { shown } = play(TOTAL * 4);
    expect(new Set(shown).size).toBe(TOTAL);
  });

  it("asks for the crossfade once per lap, on the wrapping tick", () => {
    const laps = 4;
    const { wraps } = play(TOTAL * laps);
    expect(wraps).toHaveLength(laps);
    // The first wrap lands on the tick after the final frame was shown, and
    // each one after it a full sequence later.
    expect(wraps).toEqual(Array.from({ length: laps }, (_, i) => TOTAL * (i + 1)));
  });

  it("resumes from wherever it was paused", () => {
    // Leaving the tab mid-wave and returning picks up, rather than restarting.
    const { shown } = play(3, 40);
    expect(shown).toEqual([40, 41, 42, 43]);
  });
});

describe("greeting playback constants", () => {
  it("rests on a pose inside the sequence", () => {
    expect(GREETING_REST_FRAME).toBeGreaterThanOrEqual(0);
    expect(GREETING_REST_FRAME).toBeLessThan(TOTAL);
  });

  it("blends for a fraction of a lap, not across one", () => {
    // A crossfade running into the body of the wave would read as a dissolve
    // rather than as Fin settling.
    const lapMs = (TOTAL / GREETING_FPS) * 1000;
    expect(GREETING_WRAP_CROSSFADE_MS).toBeGreaterThan(0);
    expect(GREETING_WRAP_CROSSFADE_MS).toBeLessThan(lapMs / 4);
  });
});
