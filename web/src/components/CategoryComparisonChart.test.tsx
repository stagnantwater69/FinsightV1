// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryComparisonChart } from "./CategoryComparisonChart";
import type { CategoryTrend } from "../lib/types";

const trends: CategoryTrend[] = Array.from({ length: 12 }, (_, index) => ({
  categoryId: index + 1,
  categoryName: `Category ${index + 1}`,
  current: 1000,
  previous: index === 11 ? 20_000 : 500,
  direction: "up",
  change: 500,
  percentChange: 100,
  recordCount: 1,
}));

describe("CategoryComparisonChart long lists", () => {
  it("previews six categories and opens the full list in a popup on the same scale", async () => {
    const user = userEvent.setup();
    const { container } = render(<CategoryComparisonChart trends={trends} />);
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(false);
    const firstBar = container.querySelector("li > span[aria-hidden] > span") as HTMLElement;
    expect(firstBar.style.width).toBe("5%");
    expect(screen.getByText("Showing 6 of 12 categories")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all 12 categories" }));
    expect(dialog.open).toBe(true);
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(12);
    expect(within(dialog).getByText("Category 12")).toBeInTheDocument();
    expect(firstBar.style.width).toBe("5%");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(dialog.open).toBe(false);
  });
});
