// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { GreetingHero } from "./GreetingHero";
import type { DashboardSummary } from "../lib/types";

/**
 * A render test rather than a logic one, because the sentence itself is already
 * covered in lib/homeInsight.test.ts. What is only checkable on screen is the
 * wiring: that the mascot is actually reachable at the path the build ships it
 * to, that the loading state holds the panel's shape instead of collapsing, and
 * that the warn branch changes the panel's treatment rather than only its text.
 */

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { firstName: "Ken" } }),
}));

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    periodDays: 30,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    overview: { availableFunds: 5000, totalExpenses: 0, totalSalesReference: 0 },
    expenseCategoryBreakdown: [],
    recoveryStatus: { remainingTarget: 500, remainingOperatingDays: 0 },
    recordsNeedingReview: 0,
    alerts: [],
    ...over,
  } as unknown as DashboardSummary;
}

describe("GreetingHero", () => {
  it("greets the owner by first name", () => {
    render(<GreetingHero summary={summary()} />);
    expect(screen.getByRole("heading").textContent).toContain("Ken");
  });

  it("points the mascot at the asset the build actually emits", () => {
    // The path is a string literal in the component and a file in public/;
    // nothing but a test connects the two, and a typo here renders a broken
    // image in production while typecheck and lint both stay green.
    render(<GreetingHero summary={summary()} />);
    expect(screen.getByAltText("Fin, FinSight's mascot")).toHaveAttribute(
      "src",
      "/mascot/greeting.webp",
    );
  });

  it("shows Fin's line once the summary arrives", () => {
    render(<GreetingHero summary={summary()} />);
    expect(
      screen.getByText("Nothing's been recorded yet this period — add your first expense or sale."),
    ).toBeInTheDocument();
  });

  it("holds the panel with skeleton lines while the summary is still loading", () => {
    const { container } = render(<GreetingHero summary={null} />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(2);
  });

  it("switches the panel to the warn treatment when records need review", () => {
    const { container } = render(<GreetingHero summary={summary({ recordsNeedingReview: 2 })} />);
    expect(screen.getByText("You have 2 records waiting for a second look.")).toBeInTheDocument();
    // The tone has to reach the panel, not just the sentence — an owner reads
    // the amber before they read the words.
    expect(container.querySelector(".bg-tint-accent")).not.toBeNull();
  });
});
