/**
 * What pressing the Records tab should do.
 *
 * Kept out of App.tsx because App.tsx renders the navigator and the mobile
 * suite has no render harness to mount one in — the rule below is small, it
 * is easy to get subtly wrong, and it was written to fix a bug reported from
 * a device. Here vitest can reach it.
 */

/** The screen "reset to the list" lands on. */
export const RECORDS_LIST_SCREEN = "RecordsList";

export type RecordsTabPress = "reset-to-list" | "default";

/**
 * THE BUG THIS FIXES, from @react-navigation/bottom-tabs' own tab handler:
 *
 *     if (!focused && !event.defaultPrevented) {
 *       navigation.dispatch(CommonActions.navigate(route.name, route.params));
 *     }
 *
 * Two separate defects fall out of that one line for any tab whose stack can
 * be navigated into from elsewhere.
 *
 * 1. `!focused`. Pressing a tab you are ALREADY on runs no branch at all —
 *    not a pop-to-top, not a navigate: nothing. Someone deep in the Records
 *    stack who reached for Records to get back out found the button dead.
 *    This was reported from a device, from the scanner's review screen.
 *
 * 2. `route.params`. Reaching a nested screen means
 *    `navigate("Records", { screen: … })` — the only form React Navigation
 *    forwards into a child navigator without an explicit target — and those
 *    params STICK to the Records tab route. The line above replays them on
 *    every later press, so returning to Records from another tab did not open
 *    records, it reopened whatever was last navigated to.
 *
 * The rule: intervene when the default would do the wrong thing, and stay out
 * of the way otherwise.
 *
 *   - focused          → reset to the list. Fixes (1), and is what pressing
 *                        the tab you are already on should do anyway.
 *   - stuck elsewhere  → reset to the list. Fixes (2).
 *   - anything else    → let the default run, so returning to Records from
 *                        another tab still restores where the owner was
 *                        rather than throwing away a half-typed expense.
 */
export function recordsTabPressAction(
  /** Whether Records is already the active tab. */
  isFocused: boolean,
  /** The nested screen stuck in the Records tab route's params, if any. */
  stickyNestedScreen: string | undefined,
): RecordsTabPress {
  if (isFocused) return "reset-to-list";
  /*
   * ANY stuck destination, not just the scanner.
   *
   * Every cross-tab route into Records — the tab bar's action arc, Home's
   * quick actions, a category row on an insight — has to use
   * `navigate("Records", { screen: … })`, because that is the only form React
   * Navigation forwards into a child navigator without an explicit target.
   * Each of them therefore leaves a destination on the tab route, and the
   * handler above replays it. Naming them one at a time would mean the next
   * one added is the next bug.
   *
   * `RecordsList` is exempt because replaying it is what pressing Records
   * should do anyway.
   */
  if (stickyNestedScreen !== undefined && stickyNestedScreen !== RECORDS_LIST_SCREEN) {
    return "reset-to-list";
  }
  return "default";
}
