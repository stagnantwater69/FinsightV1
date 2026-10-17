// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { DashboardSummary } from "../../lib/types";
import { RecoveryFocus } from "./RecoveryFocus";

const baseRecovery = {
  status: "behind",
  asOfDate: "2026-09-17",
  timezone: "Asia/Manila",
  todaysSales: 500,
  todaysTarget: 1_250,
  todaysGap: -750,
  monthCoveragePercent: 50,
  salesThisMonth: 10_000,
  onTrack: false,
};

function renderRecovery(recovery: Partial<DashboardSummary["recoveryStatus"]> = {}, needsSetup = false) {
  const summary = { recoveryStatus: { ...baseRecovery, ...recovery } } as DashboardSummary;
  return render(<MemoryRouter><RecoveryFocus summary={summary} needsSetup={needsSetup} action={{ to: "/insights/recovery", label: "View recovery plan" }} /></MemoryRouter>);
}

describe("dashboard today's target", () => {
  it("turns a negative server gap into the remaining sale amount with an Add sale action", () => {
    renderRecovery();

    const target = screen.getByRole("region", { name: "Today’s recovery target" });
    expect(within(target).getByText("PHP 750")).toBeVisible();
    expect(within(target).getByText("more in sales to reach today’s target")).toBeVisible();
    expect(within(target).getByText("PHP 500")).toBeVisible();
    expect(within(target).getByText("PHP 1,250")).toBeVisible();
    expect(within(target).getByText("Current month · September 2026")).toBeVisible();
    expect(within(target).getByRole("link", { name: "Add sale" })).toHaveAttribute("href", "/records/sales/new");
  });

  it("shows a reached daily target when sales exceed the target", () => {
    renderRecovery({ todaysSales: 1_500, todaysGap: 250 });

    expect(screen.getByText("Today’s sales target reached")).toBeVisible();
    expect(screen.queryByText("more in sales to reach today’s target")).not.toBeInTheDocument();
  });

  it("does not infer a closed day or achieved target from a zero daily target", () => {
    renderRecovery({ todaysSales: 0, todaysTarget: 0, todaysGap: 0 });

    expect(screen.getByText("No target set for today")).toBeVisible();
    expect(screen.queryByText(/closed|Today’s sales target reached/i)).not.toBeInTheDocument();
  });

  it("prioritizes incomplete data over a seemingly reached target", () => {
    renderRecovery({ status: "data_incomplete", todaysSales: 1_500, todaysGap: 250 });

    expect(screen.getByText("Review your records before relying on this target.")).toBeVisible();
    expect(screen.queryByText("Today’s sales target reached")).not.toBeInTheDocument();
  });

  it("uses the explicit covered status for a completed monthly target", () => {
    renderRecovery({ status: "covered", todaysTarget: 0, todaysGap: 0, monthCoveragePercent: 100 });

    expect(screen.getByText("This month’s target is covered")).toBeVisible();
    expect(screen.queryByText("No target set for today")).not.toBeInTheDocument();
  });
});
