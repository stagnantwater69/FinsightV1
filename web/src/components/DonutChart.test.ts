import { describe, expect, it } from "vitest";
import { fitLabelSize, toSlices } from "./DonutChart";
import { OTHER_COLOR } from "../lib/chartPalette";

const PALETTE = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
const cat = (categoryName: string, total: number) => ({ categoryName, total });

describe("toSlices", () => {
  it("orders largest first, so the dominant category leads", () => {
    const slices = toSlices([cat("Rent", 100), cat("Inventory", 500), cat("Utilities", 250)], PALETTE);
    expect(slices.map((s) => s.name)).toEqual(["Inventory", "Utilities", "Rent"]);
  });

  /**
   * Colour follows RANK, not the order the API happened to return. That is
   * what lets a category keep its colour as the period changes.
   */
  it("assigns colours by rank from the palette", () => {
    const slices = toSlices([cat("Rent", 100), cat("Inventory", 500)], PALETTE);
    expect(slices[0]!.color).toBe("c0");
    expect(slices[1]!.color).toBe("c1");
  });

  it("gives every category its own slice while there are six or fewer", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((n, i) => cat(n, 100 - i));
    const slices = toSlices(six, PALETTE);
    expect(slices).toHaveLength(6);
    expect(slices.some((s) => s.name.startsWith("Other"))).toBe(false);
  });

  /**
   * Past about six wedges a donut stops being readable, so the remainder folds
   * into one slice rather than becoming a fan of slivers.
   */
  it("folds everything past the sixth into a single Other", () => {
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n, i) => cat(n, 100 - i));
    const slices = toSlices(nine, PALETTE);

    expect(slices).toHaveLength(7);
    const other = slices[6]!;
    expect(other.name).toBe("Other (3)");
    // g + h + i = 94 + 93 + 92
    expect(other.total).toBe(279);
  });

  /** Grey from outside the palette, so it never reads as another category. */
  it("colours Other with the neutral, not a palette hue", () => {
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n, i) => cat(n, 100 - i));
    const other = toSlices(nine, PALETTE).at(-1)!;
    expect(other.color).toBe(OTHER_COLOR);
    expect(PALETTE).not.toContain(other.color);
  });

  /**
   * The wedges have to account for every peso the owner spent, or the chart
   * quietly under-reports. Folding into Other must not lose anything.
   */
  it("keeps the sum of slices equal to the sum of the input", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((n, i) => cat(n, (i + 1) * 37));
    const expected = many.reduce((s, c) => s + c.total, 0);
    expect(toSlices(many, PALETTE).reduce((s, d) => s + d.total, 0)).toBe(expected);
  });

  it("drops categories with nothing spent rather than drawing empty wedges", () => {
    const slices = toSlices([cat("Rent", 100), cat("Unused", 0), cat("Also unused", 0)], PALETTE);
    expect(slices.map((s) => s.name)).toEqual(["Rent"]);
  });

  it("returns nothing when there is nothing to show", () => {
    expect(toSlices([], PALETTE)).toEqual([]);
    expect(toSlices([cat("Unused", 0)], PALETTE)).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const input = [cat("Rent", 100), cat("Inventory", 500)];
    toSlices(input, PALETTE);
    expect(input.map((c) => c.categoryName)).toEqual(["Rent", "Inventory"]);
  });
});

/**
 * The centre total used to be a fixed 18px, which overflowed the ring on any
 * business past five figures — a visible bug. These pin the fix.
 */
describe("fitLabelSize", () => {
  const HOLE_WIDTH = 2 * (62 - 22 / 2) - 12; // mirrors the ring geometry
  const widthOf = (label: string) => label.length * 0.6 * fitLabelSize(label);

  it.each([
    "PHP 500",
    "PHP 9,500",
    "PHP 96,917",
    "PHP 150,000",
    "PHP 1,234,567",
    "PHP 99,999,999",
  ])("keeps %s inside the ring", (label) => {
    expect(widthOf(label)).toBeLessThanOrEqual(HOLE_WIDTH);
  });

  it("shrinks as the amount gets longer", () => {
    expect(fitLabelSize("PHP 1,234,567")).toBeLessThan(fitLabelSize("PHP 500"));
  });

  it("never grows past the design size for a short amount", () => {
    expect(fitLabelSize("PHP 5")).toBe(18);
  });

  it("never shrinks below the readable floor, however long the amount", () => {
    expect(fitLabelSize("PHP 999,999,999,999,999")).toBe(10);
  });
});
