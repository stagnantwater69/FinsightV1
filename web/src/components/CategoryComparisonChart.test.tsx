// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("shows a compact preview without rescaling the chart against only visible categories", async () => {
    const user = userEvent.setup();
    const { container } = render(<CategoryComparisonChart trends={trends} />);
    expect(screen.queryByText("Category 7")).not.toBeInTheDocument();
    const firstBar = container.querySelector("li > span[aria-hidden] > span") as HTMLElement;
    expect(firstBar.style.width).toBe("5%");
    await user.click(screen.getByRole("button", { name: "Show all 12 categories" }));
    expect(screen.getByText("Category 12")).toBeInTheDocument();
    expect(firstBar.style.width).toBe("5%");
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Category 7")).not.toBeInTheDocument();
  });
});
