import { useCallback, useEffect, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView, View } from "react-native";
import { eligibilityTarget, type TourTargetKey } from "./steps";
import { scrollDeltaToReveal, type Padding, type TourRect } from "./geometry";

/**
 * How the overlay finds the thing a step is talking about.
 *
 * WHY A REGISTRY AND NOT REFS PASSED DOWN. The elements the tour points at are
 * scattered across the tab bar (App.tsx), Home's header, its quick actions and
 * its floating Ask button — four different owners, none of which is a parent
 * of the overlay. Threading refs from each of them through the navigator to a
 * modal would put tour plumbing in the signature of every component on the
 * way. A key each side agrees on keeps the coupling to one string.
 *
 * WHY measureInWindow. React Native has no getBoundingClientRect, and
 * `measure` is parent-relative — which puts the hole in the wrong place for
 * anything inside a ScrollView. `measureInWindow` gives one shared space for
 * every target, whatever it is nested in. The overlay measures ITSELF the same
 * way and subtracts, so window coordinates never have to equal overlay
 * coordinates (geometry.ts explains why they are not the same thing).
 *
 * WHY EVERYTHING FAILS SOFT. Measurement is asynchronous and can simply never
 * call back — a view scrolled out of the tree, an element unmounted between
 * the step change and the measure, a native node already detached. Every path
 * here resolves to `null` instead of hanging, because the overlay turns null
 * into "skip this step", and a promise that never settles would turn it into
 * "the tour is stuck", which is the one outcome that must not happen.
 */

export type { TourRect } from "./geometry";

/**
 * What a screen can say about its target beyond "here it is".
 *
 * `pad` widens the hole where the element measured is smaller than the thing
 * the owner recognises — a tab bar icon is 22pt of glyph sitting above a label
 * that is part of the same button, and a ring drawn around the glyph alone
 * reads as pointing at half a control.
 *
 * `scrolls` marks a target that lives inside the scrolling page rather than in
 * the fixed furniture. Only those may cause the screen to move; the tab bar
 * must never make Home scroll.
 */
export interface TourTargetOptions {
  pad?: Partial<Padding>;
  scrolls?: boolean;
  /** Corner radius for the ring — round targets get a round ring. */
  radius?: number;
}

interface Registration extends TourTargetOptions {
  get: () => View | null;
}

/** Live registrations. Module scope because the tour is a singleton. */
const registry = new Map<TourTargetKey, Registration>();

/**
 * The one scrolling surface the tour may drive (Home's page).
 *
 * Registered by the screen through `useTourScrollView`, which also tracks the
 * current offset — React Native cannot be asked for it, and "scroll to an
 * absolute position" is useless when what we know is "move this element 200pt
 * up from where it is now".
 */
interface TourScroller {
  scrollBy: (dy: number) => void;
}
let scroller: TourScroller | null = null;

/**
 * Register an element as a tour target.
 *
 * Usage: `<View {...useTourTarget("dashboard-summary")}>…</View>`.
 *
 * `collapsable: false` is not optional. Android's view flattening removes a
 * plain layout-only View from the native hierarchy, and a view that is not
 * there cannot be measured — the target would silently never resolve and the
 * step would silently skip, on one platform only.
 */
export function useTourTarget(key: TourTargetKey | undefined, options?: TourTargetOptions) {
  const ref = useRef<View | null>(null);
  // Serialised so a fresh options object on every render does not re-register
  // the target on every render.
  const optionsKey = JSON.stringify(options ?? {});

  useEffect(() => {
    // `undefined` is a real case, not sloppiness: a component rendered once per
    // item (a quick-action tile) has to call the hook unconditionally while
    // only one of those items is a tour target.
    if (!key) return;
    const entry: Registration = { get: () => ref.current, ...(JSON.parse(optionsKey) as TourTargetOptions) };
    registry.set(key, entry);
    return () => {
      // Only clear our own entry: two elements can briefly claim one key while
      // a screen is being replaced, and the outgoing one must not delete the
      // incoming one's registration.
      if (registry.get(key) === entry) registry.delete(key);
    };
  }, [key, optionsKey]);

  return { ref, collapsable: false } as const;
}

/** Whether anything currently claims this key — the cheap, synchronous check. */
export function hasTourTarget(key: TourTargetKey): boolean {
  return registry.get(key)?.get() != null;
}

/** How this target asked to be drawn, if it said anything. */
export function tourTargetOptions(key: TourTargetKey): TourTargetOptions | undefined {
  const entry = registry.get(key);
  return entry ? { pad: entry.pad, scrolls: entry.scrolls, radius: entry.radius } : undefined;
}

/**
 * The scrolling page's registration.
 *
 * `<ScrollView {...useTourScrollView()} …>` is the whole of the screen's side
 * of it: a ref, an onScroll listener, and nothing the screen has to remember
 * to keep in sync.
 */
export function useTourScrollView() {
  const ref = useRef<ScrollView | null>(null);
  const offset = useRef(0);

  useEffect(() => {
    const entry: TourScroller = {
      scrollBy: (dy) =>
        ref.current?.scrollTo({ y: Math.max(0, offset.current + dy), animated: true }),
    };
    scroller = entry;
    return () => {
      if (scroller === entry) scroller = null;
    };
  }, []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.y;
  }, []);

  return { ref, onScroll, scrollEventThrottle: 16 } as const;
}

/**
 * Bring a target into a part of the screen the card can work around.
 *
 * Returns whether anything was asked to move, so the overlay knows whether to
 * wait for a scroll to settle before it measures again. Targets outside the
 * page — the tab bar, the floating Ask button — always answer false: they are
 * already where they are going to be, and scrolling Home for them would move
 * the page for no reason the owner can see.
 */
export async function revealTourTarget(
  key: TourTargetKey,
  viewport: { viewportTop: number; viewportBottom: number; preferredTop: number },
): Promise<boolean> {
  const entry = registry.get(key);
  if (!entry?.scrolls || !scroller) return false;

  const rect = await measureTourTarget(key);
  if (!rect) return false;

  const delta = scrollDeltaToReveal(rect, viewport);
  // Under a few points is a target that is already fine; moving the page for
  // it would be visible jitter with no gain.
  if (Math.abs(delta) < 24) return false;

  scroller.scrollBy(delta);
  return true;
}

/**
 * Is this step's target on screen right now? Steps without one — the welcome
 * and completion cards — always are.
 *
 * Shared by the provider (which uses it to walk over steps whose features are
 * not present) and the overlay (which uses it for "N of M"), so the two can
 * never disagree about how many steps this owner is being shown.
 */
export function stepIsOnScreen(step: { target?: TourTargetKey; requiresQuickAdd?: boolean }): boolean {
  const key = eligibilityTarget(step);
  return !key || hasTourTarget(key);
}

/** How long to wait for a measurement before treating the target as absent. */
const MEASURE_TIMEOUT_MS = 400;

export function measureTourTarget(key: TourTargetKey): Promise<TourRect | null> {
  const node = registry.get(key)?.get();
  if (!node) return Promise.resolve(null);

  return new Promise<TourRect | null>((resolve) => {
    let settled = false;
    const finish = (rect: TourRect | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rect);
    };
    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);

    try {
      node.measureInWindow((x, y, width, height) => {
        const usable =
          Number.isFinite(x) && Number.isFinite(y) && width > 2 && height > 2;
        finish(usable ? { x, y, width, height } : null);
      });
    } catch {
      finish(null);
    }
  });
}

/** Test seam and teardown: forget every registration. */
export function resetTourTargets() {
  registry.clear();
  scroller = null;
}
