import { describe, expect, it } from "vitest";
import { placeZoneLabels, ZONE_LABEL_GAP } from "./impactBand";

function overlaps(lefts: (number | null)[], widths: number[]) {
  const boxes = lefts.flatMap((left, i) => (left === null ? [] : [[left, left + widths[i]!] as const]));
  return boxes.some(([, right], i) => i + 1 < boxes.length && right + ZONE_LABEL_GAP > boxes[i + 1]![0]);
}

describe("placeZoneLabels", () => {
  // "Low", "PHP 3,880", "PHP 9,700" on a PHP 61,000 slider, as the demo bakery saw it.
  const widths = [21, 54, 54];
  const at = (amount: number, band: number) => (amount / 61_000) * band;

  it.each([1150, 690, 330])("keeps labels apart on a %ipx band", (band) => {
    const lefts = placeZoneLabels(band, [
      { center: widths[0]! / 2, width: widths[0]! },
      { center: at(3_880, band), width: widths[1]! },
      { center: at(9_700, band), width: widths[2]! },
    ]);
    expect(overlaps(lefts, widths)).toBe(false);
    expect(lefts[0]).toBe(0);
    expect(lefts.at(-1)).not.toBeNull();
    for (const [i, left] of lefts.entries()) if (left !== null) expect(left + widths[i]!).toBeLessThanOrEqual(band);
  });

  it("centres labels on their points when there is room", () => {
    expect(placeZoneLabels(1000, [{ center: 10, width: 20 }, { center: 400, width: 60 }, { center: 800, width: 60 }]))
      .toEqual([0, 370, 770]);
  });

  it("drops the middle label rather than the high one when the band is too narrow", () => {
    expect(placeZoneLabels(140, [{ center: 10, width: 20 }, { center: 60, width: 54 }, { center: 70, width: 54 }]))
      .toEqual([0, null, 43]);
  });
});
