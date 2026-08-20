import { describe, expect, it } from "vitest";
import {
  cardPlacement,
  frameIsUsable,
  rectsAgree,
  resolvePadding,
  scrimPanels,
  scrollDeltaToReveal,
  spotlightFrame,
  type Size,
  type TourRect,
} from "../src/components/tour/geometry";

/**
 * The tour's arithmetic — the part of the overlay that has actually been wrong
 * on a device.
 *
 * Three defects motivated this file, and there is a case for each: a spotlight
 * drawn a status bar's height ABOVE the tab icon it described (two coordinate
 * spaces treated as one), a card sitting ON TOP of the thing it pointed at,
 * and steps describing figures that were scrolled off the screen.
 */

/** A phone, roughly: 393 x 852pt with a notch and a gesture bar. */
const SCREEN: Size = { width: 393, height: 852 };
const INSETS = { top: 44, bottom: 34 };

describe("translating a measured target into the overlay's space", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR. `measureInWindow` reports the app's
   * window; the overlay draws in its own. When those origins differ — a Modal
   * on Android sitting above the status bar while the app sits below it — a
   * spotlight drawn at the raw coordinates lands that far off the control.
   */
  it("subtracts the overlay's own origin", () => {
    const icon: TourRect = { x: 100, y: 780, width: 22, height: 22 };
    const flush = spotlightFrame(icon, { x: 0, y: 0 }, SCREEN);
    const shifted = spotlightFrame(icon, { x: 0, y: -44 }, SCREEN);

    expect(flush.y).toBe(780 - 8);
    // An overlay whose own origin is 44pt above the app's window draws the
    // same icon 44pt further down its own canvas — the same place on screen.
    expect(shifted.y).toBe(flush.y + 44);
  });

  it("pads the hole, and takes the target's own padding when it asks", () => {
    const icon: TourRect = { x: 100, y: 700, width: 22, height: 22 };
    const tight = spotlightFrame(icon, { x: 0, y: 0 }, SCREEN);
    expect({ width: tight.width, height: tight.height }).toEqual({ width: 38, height: 38 });

    // A tab icon asks for room for the label underneath it, which is part of
    // the same button but is not what got measured.
    const withLabel = spotlightFrame(icon, { x: 0, y: 0 }, SCREEN, {
      top: 8,
      bottom: 26,
      left: 26,
      right: 26,
    });
    expect(withLabel.height).toBe(22 + 8 + 26);
    expect(withLabel.width).toBe(22 + 26 + 26);
    expect(withLabel.y).toBe(692);
  });

  it("never produces a negative or off-canvas rectangle", () => {
    const straddling: TourRect = { x: -30, y: -10, width: 60, height: 40 };
    const frame = spotlightFrame(straddling, { x: 0, y: 0 }, SCREEN);
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.width).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(SCREEN.width);
  });

  it("defaults every side of the padding that was not given", () => {
    expect(resolvePadding({ bottom: 26 })).toEqual({ top: 8, right: 8, bottom: 26, left: 8 });
  });
});

describe("deciding a target is not worth pointing at", () => {
  it("accepts a target that is on screen", () => {
    const rect: TourRect = { x: 16, y: 300, width: 360, height: 120 };
    expect(frameIsUsable(spotlightFrame(rect, { x: 0, y: 0 }, SCREEN), rect)).toBe(true);
  });

  it("rejects one that is almost entirely scrolled away", () => {
    // 120pt of card with 100 of it above the top of the screen.
    const rect: TourRect = { x: 16, y: -100, width: 360, height: 120 };
    expect(frameIsUsable(spotlightFrame(rect, { x: 0, y: 0 }, SCREEN), rect)).toBe(false);
  });
});

/**
 * THE OTHER MEASUREMENT DEFECT. The quick-add steps open the "+" menu and
 * point at one of the circles that springs out of it along an arc. Measured
 * once, on arrival, the answer is "the circle is on the + button" — because at
 * that instant it is. The overlay therefore accepts only a rectangle that has
 * measured the same twice, which is an observation about the animation rather
 * than a guess about how long it takes on this phone.
 */
describe("knowing a target has stopped moving", () => {
  const settled: TourRect = { x: 100, y: 600, width: 54, height: 54 };

  it("accepts two readings that agree", () => {
    expect(rectsAgree(settled, { ...settled })).toBe(true);
  });

  it("absorbs sub-pixel rounding between two samples", () => {
    expect(rectsAgree(settled, { ...settled, x: 100.4, y: 599.7 })).toBe(true);
  });

  it("rejects a target still travelling out of the button", () => {
    // Mid-flight along the arc: tens of points between frames, not fractions.
    expect(rectsAgree({ ...settled, x: 170, y: 700 }, settled)).toBe(false);
  });

  it("rejects one that is still growing into place", () => {
    expect(rectsAgree({ ...settled, width: 20, height: 20 }, settled)).toBe(false);
  });
});

describe("the scrim", () => {
  const frame = spotlightFrame({ x: 100, y: 300, width: 100, height: 60 }, { x: 0, y: 0 }, SCREEN);

  it("leaves the hole open and covers everything else", () => {
    const panels = scrimPanels(frame, SCREEN);
    const covered = panels.reduce((sum, p) => sum + p.width * p.height, 0);
    expect(covered).toBe(SCREEN.width * SCREEN.height - frame.width * frame.height);
  });

  it("never asks for a negative panel, whatever the target's position", () => {
    for (const rect of [
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 353, y: 812, width: 40, height: 40 },
      { x: 0, y: 400, width: SCREEN.width, height: 60 },
    ]) {
      const panels = scrimPanels(spotlightFrame(rect, { x: 0, y: 0 }, SCREEN), SCREEN);
      for (const panel of panels) {
        expect(panel.width).toBeGreaterThanOrEqual(0);
        expect(panel.height).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("where the card goes", () => {
  const card = 260;

  it("sits below a target near the top of the screen", () => {
    const frame = spotlightFrame({ x: 16, y: 60, width: 300, height: 40 }, { x: 0, y: 0 }, SCREEN);
    const placement = cardPlacement({ frame, size: SCREEN, insets: INSETS, cardHeight: card, gap: 12 });
    expect(placement.above).toBe(false);
    expect(placement.top).toBeGreaterThanOrEqual(frame.y + frame.height);
    expect(placement.overlaps).toBe(false);
  });

  /** The tab bar. There is nothing below it to put a card in. */
  it("sits above a target at the bottom of the screen", () => {
    const frame = spotlightFrame({ x: 40, y: 780, width: 60, height: 44 }, { x: 0, y: 0 }, SCREEN);
    const placement = cardPlacement({ frame, size: SCREEN, insets: INSETS, cardHeight: card, gap: 12 });
    expect(placement.above).toBe(true);
    expect(placement.top + card).toBeLessThanOrEqual(frame.y);
    expect(placement.overlaps).toBe(false);
  });

  it("stays inside the safe area at both ends", () => {
    for (const y of [0, 200, 500, 830]) {
      const frame = spotlightFrame({ x: 16, y, width: 300, height: 44 }, { x: 0, y: 0 }, SCREEN);
      const placement = cardPlacement({ frame, size: SCREEN, insets: INSETS, cardHeight: card, gap: 12 });
      expect(placement.top).toBeGreaterThanOrEqual(INSETS.top);
      expect(placement.top + card).toBeLessThanOrEqual(SCREEN.height - INSETS.bottom);
    }
  });

  /**
   * The case the old "below unless the target is past halfway" rule got wrong:
   * a target just over the middle with a tall card, where neither side is
   * comfortable. Reported honestly so the overlay can scroll the page instead
   * of quietly covering the feature it is describing.
   */
  it("reports an overlap rather than hiding it", () => {
    const frame = spotlightFrame({ x: 16, y: 300, width: 360, height: 300 }, { x: 0, y: 0 }, SCREEN);
    const placement = cardPlacement({ frame, size: SCREEN, insets: INSETS, cardHeight: 400, gap: 12 });
    expect(placement.overlaps).toBe(true);
  });
});

describe("scrolling the page to the step", () => {
  const viewport = { viewportTop: 60, viewportBottom: 500, preferredTop: 140 };

  it("leaves a target that is already in view alone", () => {
    expect(scrollDeltaToReveal({ x: 16, y: 200, width: 300, height: 120 }, viewport)).toBe(0);
  });

  it("scrolls down for a target below the fold", () => {
    const delta = scrollDeltaToReveal({ x: 16, y: 700, width: 300, height: 120 }, viewport);
    expect(delta).toBe(560);
  });

  it("scrolls back up for a target above the fold", () => {
    const delta = scrollDeltaToReveal({ x: 16, y: -40, width: 300, height: 120 }, viewport);
    expect(delta).toBe(-180);
  });

  it("counts a target that is only partly visible as needing a scroll", () => {
    // Bottom edge past the band the card needs: still moved, not left half-lit.
    expect(scrollDeltaToReveal({ x: 16, y: 450, width: 300, height: 120 }, viewport)).not.toBe(0);
  });
});
