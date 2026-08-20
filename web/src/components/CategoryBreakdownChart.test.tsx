// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryBreakdownChart, toRows } from "./CategoryBreakdownChart";
import { ThemeProvider } from "../context/ThemeContext";
import type { DashboardSummary } from "../lib/types";
import type { ComponentProps } from "react";

type Breakdown = DashboardSummary["expenseCategoryBreakdown"];

/**
 * The bars themselves are not assertable here: `ResponsiveContainer` measures
 * its parent, and jsdom reports every element as 0x0, so recharts renders an
 * empty container whatever the data. The visible row count is therefore pinned
 * at the data boundary (`toRows`, which is exactly what the chart is handed),
 * and the DOM assertions cover the control and its ARIA wiring — the parts a
 * keyboard or screen-reader user actually touches.
 */
function breakdownOf(count: number): Breakdown {
  return Array.from({ length: count }, (_, i) => ({
    categoryId: i + 1,
    categoryName: `Category ${i + 1}`,
    // Descending, so the "top N" answer is unambiguous.
    total: (count - i) * 1000,
    percent: 100 / count,
  }));
}

/**
 * jsdom ships no `matchMedia`, and the chart asks it whether the viewport is
 * narrow. A never-matching stub pins the wide layout, which is the one with
 * the long-tail problem this control exists for.
 */
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

describe("toRows", () => {
  it("keeps only the top N while collapsed", () => {
    const rows = toRows(breakdownOf(13), 5, false);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.name)).toEqual([
      "Category 1",
      "Category 2",
      "Category 3",
      "Category 4",
      "Category 5",
    ]);
  });

  it("returns every category once expanded", () => {
    expect(toRows(breakdownOf(13), 5, true)).toHaveLength(13);
  });

  /** The payload's order is not trusted — "top 5" has to mean the five biggest. */
  it("ranks by total, largest first, regardless of payload order", () => {
    const unsorted = [
      { categoryId: 1, categoryName: "Rent", total: 100, percent: 10 },
      { categoryId: 2, categoryName: "Salaries", total: 900, percent: 60 },
      { categoryId: 3, categoryName: "Utilities", total: 400, percent: 30 },
    ];
    expect(toRows(unsorted, 2, false).map((r) => r.name)).toEqual(["Salaries", "Utilities"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [
      { categoryId: 1, categoryName: "Rent", total: 100, percent: 25 },
      { categoryId: 2, categoryName: "Salaries", total: 900, percent: 75 },
    ];
    toRows(input, 1, false);
    expect(input.map((c) => c.categoryName)).toEqual(["Rent", "Salaries"]);
  });

  it("is a no-op when there is less than a full page of categories", () => {
    expect(toRows(breakdownOf(3), 5, false)).toHaveLength(3);
  });
});

/** The palette is theme-derived, so the chart needs the provider around it. */
function renderChart(props: ComponentProps<typeof CategoryBreakdownChart>) {
  return render(
    <ThemeProvider>
      <CategoryBreakdownChart {...props} />
    </ThemeProvider>
  );
}

describe("CategoryBreakdownChart overflow control", () => {
  it("offers to reveal the tail, counting the true total", () => {
    renderChart({ breakdown: breakdownOf(13) });
    const toggle = screen.getByRole("button", { name: "Show all 13 categories" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands and collapses again, swapping the label", async () => {
    const user = userEvent.setup();
    renderChart({ breakdown: breakdownOf(13) });

    await user.click(screen.getByRole("button", { name: "Show all 13 categories" }));
    const collapse = screen.getByRole("button", { name: "Show top 5 only" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    await user.click(collapse);
    expect(screen.getByRole("button", { name: "Show all 13 categories" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("points aria-controls at the region that actually changes", () => {
    const { container } = renderChart({ breakdown: breakdownOf(13) });
    const controls = screen.getByRole("button").getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(controls!)}`)).not.toBeNull();
  });

  it("honours a custom topN in both the label and the threshold", () => {
    renderChart({ breakdown: breakdownOf(9), topN: 3 });
    expect(screen.getByRole("button", { name: "Show all 9 categories" })).toBeInTheDocument();
  });

  it("renders no toggle when nothing is hidden", () => {
    renderChart({ breakdown: breakdownOf(5) });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no toggle below the threshold either", () => {
    renderChart({ breakdown: breakdownOf(2) });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the empty state, and no toggle, with nothing to chart", () => {
    renderChart({ breakdown: [] });
    expect(screen.getByText("No expenses in this period yet")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
