// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { DashboardSummary } from "../lib/types";

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
    salesThisMonth: 10000,
    remainingTarget: 10000,
    daysInMonth: 31,
    calendarDaysLeftInMonth: 10,
    remainingOperatingDays: 8,
    remainingOperatingDaysIsApproximated: false,
    adjustedDailyTarget: 1250,
    todaysTarget: 1250,
    todaysSales: 0,
    todaysGap: 1250,
    todaysStatus: "behind",
    monthCoveragePercent: 50,
    onTrack: false,
    status: "behind",
  },
  recordsNeedingReview: 0,
  alerts: [],
  lifetime: { recordCount: 4, latestRecordDate: "2026-01-30T00:00:00.000Z" },
} as unknown as DashboardSummary;

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    profile: { id: 1, firstName: "Ana" },
    preferences: { showDashboardMascotMessage: false, tourStatus: null, tourStep: null, tourAlwaysShow: false },
  }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1, name: "Store" }, profiles: [], loading: false }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }] }),
}));

vi.mock("../context/AiChatContext", () => ({ useAiChat: () => ({ openChat: vi.fn() }) }));

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/dashboard/summary") return { data: summary };
      if (url === "/insights/reduction-opportunities") return { data: { opportunities: [] } };
      if (url === "/insights/expense-behavior") throw new Error("comparison unavailable");
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

describe("Dashboard decision-first improvements", () => {
  it("uses semantic all-time copy instead of Last 0 days", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "All time" }));
    await waitFor(() => expect(screen.getAllByText("Across all records").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Last 0 days/i)).not.toBeInTheDocument();
  });

  it("distinguishes a comparison request failure from insufficient history", async () => {
    renderDashboard();
    expect(await screen.findByText("Expense comparison couldn’t load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("progressively discloses detailed charts on compact layouts", async () => {
    const user = userEvent.setup();
    renderDashboard();
    const toggle = await screen.findByRole("button", { name: "View detailed charts" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Hide detailed charts" })).toHaveAttribute("aria-expanded", "true");
  });
});
