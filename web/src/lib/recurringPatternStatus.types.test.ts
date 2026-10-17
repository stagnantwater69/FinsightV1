import { describe, expect, it } from "vitest";
import type { RecurringPattern } from "./types";

// Legacy DISABLED rows remain readable; the backend HTTP suite separately
// verifies that the review endpoint rejects DISABLED writes.
function unknownIsNotAStatus(): void {
  // @ts-expect-error — PAUSED is not a persisted recurring-pattern status.
  const status: RecurringPattern["status"] = "PAUSED";
  void status;
}

describe("RecurringPattern status union", () => {
  it("models all four statuses the read endpoint can return, including legacy rows", () => {
    const statuses: RecurringPattern["status"][] = ["CANDIDATE", "CONFIRMED", "DISMISSED", "DISABLED"];
    expect(statuses).toHaveLength(4);
    expect(() => unknownIsNotAStatus()).not.toThrow();
  });
});
