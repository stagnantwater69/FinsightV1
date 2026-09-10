// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { BusinessProfile, DashboardSummary } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS: the page uses the honest window names, not just the
 * module that defines them.
 *
 * `/dashboard/summary` computes a rolling lookback ending today. The control
 * said "This week" / "This month" over it, and the KPI cards repeated those
 * words as the period the figures cover — so a 30-day window ending on the
 * 20th was captioned as the calendar month. `lib/dashboardPeriod.ts` holds the
 * wording (shared word-for-word with mobile); this checks the Dashboard
 * actually renders it, on the control and on the cards it captions.
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
} as unknown as BusinessProfile;

const summary = {
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
  },
  recordsNeedingReview: 0,
  alerts: [],
  lifetime: { recordCount: 4, latestRecordDate: "2026-01-30T00:00:00.000Z" },
} as unknown as DashboardSummary;

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { id: 1, firstName: "Ken" }, preferences: { showDashboardMascotMessage: false } }),
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

const summaryCalls: Record<string, unknown>[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === "/dashboard/summary") {
        summaryCalls.push(config?.params ?? {});
        return { data: summary };
      }
      // The comparison and opportunity panels are optional and fail quietly.
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

describe("Dashboard period labels", () => {
  it("names the four windows by length, matching mobile", async () => {
    renderDashboard();
    await waitFor(() => expect(screen.getByRole("button", { name: "30 days" })).toBeInTheDocument());

    for (const label of ["Today", "7 days", "30 days", "All time"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // The two captions that used to describe a rolling lookback as a calendar
    // period are gone from the control.
    expect(screen.queryByRole("button", { name: "This week" })).toBeNull();
    expect(screen.queryByRole("button", { name: "This month" })).toBeNull();
  });

  it("captions the KPI cards and the summary panel with the same window", async () => {
    renderDashboard();

    // Default window: 30 days.
    expect(await screen.findByRole("heading", { name: "Last 30 days at a glance" })).toBeInTheDocument();
    expect(screen.getAllByText("Last 30 days").length).toBeGreaterThan(0);
  });

  it("re-captions when the window changes, and keeps 'all time' as it was", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByRole("heading", { name: "Last 30 days at a glance" });

    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(await screen.findByRole("heading", { name: "Last 7 days at a glance" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All time" }));
    expect(
      await screen.findByRole("heading", { name: "Across all records at a glance" }),
    ).toBeInTheDocument();

    // The window arithmetic is the server's and did not change: `days: 0` is
    // still the all-time sentinel it sends.
    expect(summaryCalls.map((c) => c.periodDays)).toContain(0);
  });
});
