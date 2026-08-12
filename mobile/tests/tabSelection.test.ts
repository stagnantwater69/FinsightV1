import { describe, expect, it } from "vitest";
import { recordsTabPressAction } from "../src/lib/tabSelection";

/**
 * Pressing Records.
 *
 * Reported from a device: the records list simply could not be reached from
 * the scanner's review screen — the tab did nothing at all.
 *
 * Both causes are in one line of @react-navigation/bottom-tabs' tab handler,
 * `if (!focused …) navigate(route.name, route.params)`. These pin the rule
 * that works around it, including the case it must NOT interfere with.
 */
describe("recordsTabPressAction", () => {
  /**
   * THE REPORTED BUG. The review screen lives on the Records stack, so
   * Records is the focused tab while it is up — and the library's handler
   * runs no branch for a focused tab. The button was dead.
   */
  it("resets to the list when Records is already focused", () => {
    expect(recordsTabPressAction(true, "ScanReceipt")).toBe("reset-to-list");
    expect(recordsTabPressAction(true, undefined)).toBe("reset-to-list");
    expect(recordsTabPressAction(true, "AddExpense")).toBe("reset-to-list");
  });

  /**
   * THE SECOND, QUIETER BUG. `navigate("Records", { screen: … })` leaves that
   * directive on the Records tab route, and the handler replays stored params
   * on every later press — so pressing Records from another tab reopened
   * whatever was last navigated to instead of showing records.
   *
   * ANY destination, not just the scanner. Every cross-tab route into Records
   * has to use this form, because it is the only one React Navigation
   * forwards into a child navigator without an explicit target — so naming
   * the screens one at a time would mean the next one added is the next bug.
   */
  it("resets to the list when any destination is stuck in the tab's params", () => {
    expect(recordsTabPressAction(false, "ScanReceipt")).toBe("reset-to-list");
    expect(recordsTabPressAction(false, "AddExpense")).toBe("reset-to-list");
    expect(recordsTabPressAction(false, "ImportCsv")).toBe("reset-to-list");
    expect(recordsTabPressAction(false, "Categories")).toBe("reset-to-list");
  });

  /**
   * A DELIBERATE TRADE, recorded here because it used to be the opposite.
   *
   * This case previously returned "default" so that returning to Records from
   * another tab restored where the owner was — including a half-typed
   * expense. It cannot: the same stored params that would restore it are the
   * ones the handler replays, and there is no way to keep the restore without
   * also keeping the unwanted re-navigation.
   *
   * Given the choice, "press Records, see records" is the promise worth
   * holding. The form that gets lost is reachable again in one tap, and only
   * from a path that crosses two tabs to begin with.
   */
  it("does not try to restore a sub-screen reached from another tab", () => {
    expect(recordsTabPressAction(false, "EditRecord")).toBe("reset-to-list");
  });

  /** Nothing stuck, and the list itself, both leave the default alone. */
  it("stays out of the way when there is no destination to replay", () => {
    expect(recordsTabPressAction(false, undefined)).toBe("default");
    expect(recordsTabPressAction(false, "RecordsList")).toBe("default");
  });
});
