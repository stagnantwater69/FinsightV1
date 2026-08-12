import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Whether the owner has asked their phone to reduce motion.
 *
 * WHY: "Reduce Motion" is usually turned on for a reason — sliding and pulsing
 * interfaces make some people genuinely nauseous, and the setting is how they
 * say so once instead of fighting every app individually. Nothing in this app
 * was listening, so a skeleton pulsed twice a second for as long as a screen
 * was loading and the Ask FinSight sheet slid up the display regardless.
 *
 * Nothing in React Native does this for you. `Animated.loop` and
 * `Animated.timing` run exactly the same whether the setting is on or off, so
 * every animation has to be gated by hand against this value.
 *
 * The lookup is asynchronous, so the first render always reports "no reduced
 * motion" and the true answer arrives a tick later. That is the platform's
 * shape, not a choice: the honest consequence is that a gated animation can
 * start and then be cut short, which is still far better than running to
 * completion. Callers set the final value directly when it flips, rather than
 * animating to it.
 */

/**
 * The subscription itself, as a plain function.
 *
 * WHY SEPARATE FROM THE HOOK: there is no render harness in this project — no
 * testing-library, no react-test-renderer — so a hook cannot be exercised in a
 * test at all. The part worth guarding is not the `useState` call, it is the
 * lifecycle around the platform API: that the initial read is taken, that a
 * later system toggle is heard, that the subscription is removed, and that a
 * slow initial read cannot report back after the caller has gone away. All of
 * that lives here, where a test can drive it directly.
 *
 * Returns the teardown, so the hook body is a one-liner.
 */
export function subscribeToReducedMotion(onChange: (reduced: boolean) => void): () => void {
  let live = true;

  // The initial read is a promise, and on a cold start it can easily resolve
  // after the component that asked for it has unmounted — a skeleton is shown
  // precisely while things are still settling. Reporting then would set state
  // on a dead component.
  AccessibilityInfo.isReduceMotionEnabled()
    .then((reduced) => {
      if (live) onChange(reduced);
    })
    .catch(() => {
      // The setting could not be read. Say nothing and leave the caller on its
      // default of "motion is fine", which is the behaviour it had before this
      // existed. An unhandled rejection here would surface as a warning about
      // an accessibility query, which tells the owner nothing useful.
    });

  const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduced) => {
    if (live) onChange(reduced);
  });

  return () => {
    live = false;
    // `remove()` on the subscription that addEventListener handed back. The
    // paired-remover form that older guides use was dropped from
    // AccessibilityInfo and does not exist in this version.
    subscription.remove();
  };
}

/** The hook form: `const reduceMotion = useReducedMotion();` */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => subscribeToReducedMotion(setReduced), []);

  return reduced;
}
