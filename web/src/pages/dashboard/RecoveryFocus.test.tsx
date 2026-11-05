// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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

function renderRecovery(recovery: Partial<DashboardSummary["recoveryStatus"]> = {}, needsSetup = false, onAddSale = () => {}) {
  const summary = { recoveryStatus: { ...baseRecovery, ...recovery } } as DashboardSummary;
  return render(<MemoryRouter><RecoveryFocus summary={summary} needsSetup={needsSetup} action={{ to: "/insights/recovery", label: "View recovery plan" }} onAddSale={onAddSale} /></MemoryRouter>);
}

describe("dashboard today's target", () => {
  it("turns a negative server gap into the remaining sale amount with an Add sale action", () => {
    const onAddSale = vi.fn();
    renderRecovery({}, false, onAddSale);

    const target = screen.getByRole("region", { name: "Today’s recovery target" });
    expect(within(target).getByText("PHP 750")).toBeVisible();
    expect(within(target).getByText("more in sales to reach today’s target")).toBeVisible();
    expect(within(target).getByText("PHP 500")).toBeVisible();
    expect(within(target).getByText("PHP 1,250")).toBeVisible();
    expect(within(target).getByText("Current month · September 2026")).toBeVisible();
    // Opens the add-sales popup in place, as Records does.
    fireEvent.click(within(target).getByRole("button", { name: "Add sale" }));
    expect(onAddSale).toHaveBeenCalledTimes(1);
  });

  it("explains why the catch-up pace is higher than today's target, and only then", () => {
    const note = "Higher than today’s target because earlier days this month fell short.";
    const { unmount } = renderRecovery({ adjustedDailyTarget: 1_600 });
    expect(screen.getByText("Needed per day from now")).toBeVisible();
    expect(screen.getByText(note)).toBeVisible();
    unmount();

    renderRecovery({ adjustedDailyTarget: 1_250 });
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });

  it("gives Behind pace its month figure: how far behind, what was expected, and the month target", () => {
    renderRecovery({ expectedSalesToDate: 12_000, paceVarianceAmount: -2_000, remainingTarget: 30_000 });

    const target = screen.getByRole("region", { name: "Today’s recovery target" });
    expect(within(target).getByText("Behind by PHP 2,000")).toBeVisible();
    expect(within(target).getByText("PHP 12,000")).toBeVisible();
    // 10,000 recorded plus 30,000 remaining.
    expect(within(target).getByText("PHP 40,000")).toBeVisible();
  });

  it("leaves the month block out when the server sends no pace", () => {
    renderRecovery();
    expect(screen.queryByText("Month so far")).not.toBeInTheDocument();
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
