import { describe, expect, it } from "vitest";
import type { RecurringPattern } from "./types";

/**
 * The real assertion here is the `@ts-expect-error` below, and it is enforced
 * by `npm run typecheck` rather than by the vitest runner: if "DISABLED" ever
 * creeps back into RecurringPattern["status"], the suppression stops
 * suppressing anything and tsc fails with "Unused '@ts-expect-error'
 * directive."
 *
 * Why guard a type at all: the server never writes DISABLED, and
 * recurringPatternReviewSchema answers 400 to it, so a widened union would let
 * a caller here typecheck its way into a request the API rejects at runtime.
 */
function disabledIsNotAStatus(): void {
  // @ts-expect-error — DISABLED is not a RecurringPattern status; see types.ts.
  const status: RecurringPattern["status"] = "DISABLED";
  void status;
}

describe("RecurringPattern status union", () => {
  it("models only the three statuses the API round-trips", () => {
    const statuses: RecurringPattern["status"][] = ["CANDIDATE", "CONFIRMED", "DISMISSED"];
    expect(statuses).toHaveLength(3);
    expect(() => disabledIsNotAStatus()).not.toThrow();
  });
});
