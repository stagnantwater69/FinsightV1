// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { GreetingHero } from "./GreetingHero";
import { GREETING_FRAMES } from "../lib/greetingFrames";
import { GREETING_FPS, GREETING_REST_FRAME } from "../lib/greetingPlayback";
import type { DashboardSummary } from "../lib/types";

/**
 * Fin's wave is 103 files and ~1.5MB. Swapping `src` on a 12fps interval
 * asks for each of them at the moment it is due, which on a cold cache over
 * mobile data — the connection this product's owners actually have — shows
 * blanks and held poses for the whole first cycle.
 *
 * So what has to hold is a loading ORDER, and none of it is visible to a
 * render-only assertion:
 *
 *   - at rest, exactly one image is on screen and it is the rest pose;
 *   - the interval does not start until every frame has loaded;
 *   - under reduced motion the frames are never requested at all — the
 *     setting saves the download, not only the movement.
 *
 * `Image` is stubbed because jsdom never loads anything, so the readiness
 * signal has to be driven by hand; it doubles as the record of exactly which
 * frames were requested.
 */

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { firstName: "Ken" } }),
}));

let requested: string[] = [];
let preloaders: StubImage[] = [];

class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = "auto";
  private stored = "";

  set src(value: string) {
    this.stored = value;
    requested.push(value);
    preloaders.push(this);
  }

  get src() {
    return this.stored;
  }

  setAttribute() {}
}

/** jsdom ships no matchMedia; `reduced` picks which answer it gives. */
function stubMatchMedia(reduced: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function summary(): DashboardSummary {
  return {
    periodDays: 30,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    overview: { availableFunds: 5000, totalExpenses: 0, totalSalesReference: 0 },
    expenseCategoryBreakdown: [],
    recoveryStatus: { remainingTarget: 500, remainingOperatingDays: 0 },
    recordsNeedingReview: 0,
    alerts: [],
  } as unknown as DashboardSummary;
}

const REST_SRC = GREETING_FRAMES[GREETING_REST_FRAME];

function mascot() {
  return screen.getByAltText("Fin, FinSight's mascot");
}

/** Every frame reports itself loaded, which is what unblocks playback. */
async function finishPreload() {
  await act(async () => {
    preloaders.forEach((img) => img.onload?.());
  });
}

beforeEach(() => {
  requested = [];
  preloaders = [];
  vi.stubGlobal("Image", StubImage);
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the greeting flipbook's loading order", () => {
  it("holds the rest pose, alone on screen, until the frames are ready", async () => {
    stubMatchMedia(false);
    const { container } = render(<GreetingHero summary={summary()} />);

    expect(mascot()).toHaveAttribute("src", REST_SRC);
    // One request, not two: the wrap cross-fade layer is a second frame
    // nobody can see while the wave is not running.
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("does not start the interval while frames are still downloading", async () => {
    stubMatchMedia(false);
    render(<GreetingHero summary={summary()} />);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Twenty-four ticks' worth of time has passed. If the flipbook were
    // running, it would be fetching frames as they fall due.
    expect(mascot()).toHaveAttribute("src", REST_SRC);
  });

  it("preloads the whole sequence up front rather than during playback", () => {
    stubMatchMedia(false);
    render(<GreetingHero summary={summary()} />);

    expect(new Set(requested)).toEqual(new Set(GREETING_FRAMES));
  });

  it("plays on from the pose already on screen once every frame has loaded", async () => {
    stubMatchMedia(false);
    render(<GreetingHero summary={summary()} />);
    await finishPreload();

    await act(async () => {
      vi.advanceTimersByTime(1000 / GREETING_FPS);
    });

    // It moves off the rest pose on the first tick, and it moves to the NEXT
    // pose rather than cutting back to the top of the sequence.
    expect(mascot()).toHaveAttribute("src", GREETING_FRAMES[GREETING_REST_FRAME + 1]);
  });

  it("requests no animation frames at all under reduced motion", () => {
    stubMatchMedia(true);
    const { container } = render(<GreetingHero summary={summary()} />);

    expect(requested).toEqual([]);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(mascot()).toHaveAttribute("src", REST_SRC);
  });
});
