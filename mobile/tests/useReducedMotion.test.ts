import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reduce-motion subscription, driven directly.
 *
 * WHY THIS AND NOT THE HOOK: a render harness now exists (tests/render/), so
 * mounting the hook is possible — but what matters is not the `useState` call
 * anyway; it is the lifecycle around the platform API, which is why that half
 * lives in a plain function. Four things can go wrong there and none of them
 * is visible on screen:
 *
 *   - never taking the initial read, so the setting only takes effect if the
 *     owner toggles it while the app is open;
 *   - never subscribing, so a mid-session toggle is ignored;
 *   - never removing the subscription, which leaks a listener per skeleton
 *     box — and a loading dashboard mounts twelve of them;
 *   - reporting back after teardown, which is the likely one: the initial read
 *     is a promise taken during exactly the moment a screen is still settling
 *     and may well unmount before it resolves.
 *
 * `react-native` is mocked rather than imported. It ships untranspiled source
 * that node cannot parse, and the real AccessibilityInfo would answer for this
 * machine rather than for the case under test.
 */

type Handler = (reduced: boolean) => void;

const platform = {
  /** Resolves the initial read; the test decides when. */
  resolveInitial: (_reduced: boolean) => {},
  /** Handlers registered for "reduceMotionChanged". */
  handlers: [] as Handler[],
  /** Event names passed to addEventListener, so the literal itself is checked. */
  events: [] as string[],
  removeCount: 0,
  /** When set, the initial read rejects instead of resolving. */
  failInitial: false,
};

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () =>
      new Promise<boolean>((resolve, reject) => {
        if (platform.failInitial) {
          reject(new Error("no accessibility manager"));
          return;
        }
        platform.resolveInitial = resolve;
      }),
    addEventListener: (event: string, handler: Handler) => {
      platform.events.push(event);
      platform.handlers.push(handler);
      return {
        remove: () => {
          platform.removeCount += 1;
          platform.handlers = platform.handlers.filter((h) => h !== handler);
        },
      };
    },
  },
}));

const { subscribeToReducedMotion } = await import("../src/lib/useReducedMotion");

/** Lets the mocked promise's `.then` run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  platform.resolveInitial = () => {};
  platform.handlers = [];
  platform.events = [];
  platform.removeCount = 0;
  platform.failInitial = false;
});

describe("subscribeToReducedMotion", () => {
  it("subscribes to the event the platform actually publishes", async () => {
    // Guards the tests below: they drive the recorded handler, so they would
    // pass just as happily if it had been registered under a misspelled event
    // name that the real AccessibilityInfo never emits.
    const stop = subscribeToReducedMotion(() => {});
    expect(platform.events).toEqual(["reduceMotionChanged"]);
    expect(platform.handlers).toHaveLength(1);
    stop();
  });

  it("reports the system value from the initial read", async () => {
    const seen: boolean[] = [];
    const stop = subscribeToReducedMotion((v) => seen.push(v));

    expect(seen).toEqual([]); // asynchronous: nothing known yet
    platform.resolveInitial(true);
    await settle();

    expect(seen).toEqual([true]);
    stop();
  });

  it("reports a change made while the app is open", async () => {
    const seen: boolean[] = [];
    const stop = subscribeToReducedMotion((v) => seen.push(v));
    platform.resolveInitial(false);
    await settle();

    platform.handlers.forEach((h) => h(true));
    platform.handlers.forEach((h) => h(false));

    expect(seen).toEqual([false, true, false]);
    stop();
  });

  it("removes the subscription on teardown", () => {
    const stop = subscribeToReducedMotion(() => {});
    expect(platform.removeCount).toBe(0);

    stop();

    expect(platform.removeCount).toBe(1);
    expect(platform.handlers).toEqual([]);
  });

  it("stays silent when the initial read lands after teardown", async () => {
    const seen: boolean[] = [];
    const stop = subscribeToReducedMotion((v) => seen.push(v));

    stop();
    platform.resolveInitial(true);
    await settle();

    expect(seen).toEqual([]);
  });

  it("stays silent when a stale handler is called after teardown", async () => {
    const seen: boolean[] = [];
    const stop = subscribeToReducedMotion((v) => seen.push(v));
    const handler = platform.handlers[0]!;

    stop();
    handler(true); // as if the emitter had already queued this one

    expect(seen).toEqual([]);
  });

  it("leaves the caller on its default when the read fails", async () => {
    platform.failInitial = true;
    const seen: boolean[] = [];
    const stop = subscribeToReducedMotion((v) => seen.push(v));

    await settle();

    // No report, no unhandled rejection — the caller keeps whatever it
    // started with, which is the behaviour it had before this existed.
    expect(seen).toEqual([]);
    stop();
  });
});
