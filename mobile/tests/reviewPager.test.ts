import { describe, expect, it } from "vitest";
import { clampPageIndex, pageIndexFromOffset, pagerPosition, reviewConfirmAction, showAddPageSlot } from "../src/lib/reviewPager";

describe("review pager rules", () => {
  it("makes the check keep a new Batch capture, and finish only when every page is kept", () => {
    expect(reviewConfirmAction("batch", true)).toBe("keep-page");
    expect(reviewConfirmAction("batch", false)).toBe("finish-batch");
    expect(reviewConfirmAction("standard", false)).toBe("use-receipt");
    expect(reviewConfirmAction("standard", true)).toBe("use-receipt");
  });

  it("offers Add page only in a Batch with room and no capture waiting", () => {
    expect(showAddPageSlot("batch", false, false)).toBe(true);
    expect(showAddPageSlot("batch", true, false)).toBe(false);
    expect(showAddPageSlot("batch", false, true)).toBe(false);
    expect(showAddPageSlot("standard", false, false)).toBe(false);
  });

  it("clamps page indexes and settles swipes on whole pages", () => {
    expect(clampPageIndex(-1, 3)).toBe(0);
    expect(clampPageIndex(7, 3)).toBe(2);
    expect(clampPageIndex(Number.NaN, 3)).toBe(0);
    expect(clampPageIndex(2, 0)).toBe(0);
    expect(pageIndexFromOffset(0, 360, 3)).toBe(0);
    expect(pageIndexFromOffset(370, 360, 3)).toBe(1);
    expect(pageIndexFromOffset(5000, 360, 3)).toBe(2);
    expect(pageIndexFromOffset(200, 0, 3)).toBe(0);
  });

  it("writes the position the way the pager shows it", () => {
    expect(pagerPosition(0, 1)).toBe("1/1");
    expect(pagerPosition(4, 3)).toBe("3/3");
    expect(pagerPosition(0, 0)).toBe("1/1");
  });
});
