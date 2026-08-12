import { beforeEach, describe, expect, it } from "vitest";

import { setFlash, takeFlash } from "../src/lib/flash";

/**
 * The one-shot property is the whole point of this module.
 *
 * WHY: the confirmation is app-wide rather than addressed to a screen, so if a
 * read did not clear it, the next screen to focus would show a stale "Expense
 * saved" for an expense that was saved minutes ago and already confirmed once.
 * Nothing in the UI can catch that; a rendered Callout looks correct whether
 * the message is fresh or left over.
 *
 * The module holds state between tests, so each one starts by draining it.
 */

beforeEach(() => {
  takeFlash();
});

describe("flash", () => {
  it("hands the message to the next taker", () => {
    setFlash("Expense saved.");
    expect(takeFlash()).toBe("Expense saved.");
  });

  it("clears on read, so a second taker gets nothing", () => {
    setFlash("Record updated.");
    takeFlash();
    expect(takeFlash()).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(takeFlash()).toBeNull();
  });
});
