// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { BusinessProfile, DashboardSummary, RecoveryStatus, UserPreferences } from "../lib/types";

/**
 * The Dashboard "Recovery status" KPI tile — RECOVERY-TARGET-IMPROVEMENT-PLAN
 * §8.1/§11 Phase 1.
 *
 * Confirms the tile prefers the server's explicit `status` once present,
 * including the three readings the old `onTrack`/`needsSetup` booleans could
 * never express on their own: no sales yet this month, target reached, and
 * ahead of pace.
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
} as unknown as BusinessProfile;

function summaryWithStatus(status: RecoveryStatus): DashboardSummary {
  return {
    periodDays: 30,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    overview: { availableFunds: 50000, totalExpenses: 12000, totalSalesReference: 30000 },
    expenseCategoryBreakdown: [{ categoryId: 1, categoryName: "Inventory", total: 12000, percent: 100 }],
    recoveryStatus: {
      expectedMonthlyExpenses: 20000,
      operatingDays: 26,
      dailyNeededTarget: 770,
      salesThisMonth: 30000,
      remainingTarget: 0,
      daysInMonth: 31,
      calendarDaysLeftInMonth: 10,
      remainingOperatingDays: 8,
      remainingOperatingDaysIsApproximated: false,
      adjustedDailyTarget: 0,
      todaysTarget: 0,
      todaysSales: 0,
      todaysGap: 0,
      todaysStatus: "at",
      monthCoveragePercent: 100,
      onTrack: true,
      status,
    },
    recordsNeedingReview: 0,
    alerts: [],
    lifetime: { recordCount: 4, latestRecordDate: "2026-01-30T00:00:00.000Z" },
  } as unknown as DashboardSummary;
}

let preferences: UserPreferences;
let currentSummary: DashboardSummary;

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { id: 1, firstName: "Ken" }, preferences }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile, profiles: [profile], loading: false }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }] }),
}));

vi.mock("../context/AiChatContext", () => ({
  useAiChat: () => ({ openChat: vi.fn() }),
}));

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/dashboard/summary") return { data: currentSummary };
      throw new Error(`unmocked GET ${url}`);
    },
  },
}));

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <Dashboard />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** jsdom ships no `matchMedia`; the category chart asks it for the viewport. */
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

beforeEach(() => {
  preferences = {
    showDashboardMascotMessage: false,
    tourStatus: null,
    tourStep: null,
    tourAlwaysShow: false,
  };
});

describe("Dashboard recovery-status KPI — status-driven rendering", () => {
  it("shows 'No sales yet' for no_current_month_data, which the old booleans couldn't express", async () => {
    currentSummary = summaryWithStatus("no_current_month_data");
    renderDashboard();
    await waitFor(() => expect(screen.getByText("No sales yet")).toBeInTheDocument());
    expect(screen.getByText("No sales recorded this month")).toBeInTheDocument();
  });

  it("shows 'Target reached' for covered", async () => {
    currentSummary = summaryWithStatus("covered");
    renderDashboard();
    await waitFor(() => expect(screen.getByText("Target reached")).toBeInTheDocument());
  });

  it("shows 'Ahead of pace' for ahead", async () => {
    currentSummary = summaryWithStatus("ahead");
    renderDashboard();
    // Appears twice — the KPI tile and the embedded Recovery Meter both read
    // the same server status, which is the point: they can't disagree.
    await waitFor(() => expect(screen.getAllByText("Ahead of pace").length).toBeGreaterThan(0));
  });

  it("still falls back to the boolean-derived label when status is absent", async () => {
    const summary = summaryWithStatus("on_pace");
    // Delete `status` to simulate an older cached response.
    delete (summary.recoveryStatus as { status?: RecoveryStatus }).status;
    currentSummary = summary;
    renderDashboard();
    await waitFor(() => expect(screen.getByText("On track")).toBeInTheDocument());
  });
});
