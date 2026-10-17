// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { BusinessProfile, DashboardSummary } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS: the Dashboard's period filter is exactly
 * This week | Month | All time, the Month list is the business's own months
 * with records (never a fixed January-December), and every figure on the page
 * is asked for, and captioned with, the same selection.
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
let months: string[] | Error = ["2026-09", "2026-08", "2025-12"];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === "/records/months") {
        if (months instanceof Error) throw months;
        return { data: { months } };
      }
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

beforeEach(() => {
  summaryCalls.length = 0;
  months = ["2026-09", "2026-08", "2025-12"];
  window.sessionStorage.clear();
});

describe("Dashboard period filter", () => {
  it("offers exactly three choices, not a button per month or rolling windows", async () => {
    renderDashboard();
    const group = await screen.findByRole("group", { name: "Period" });
    expect(within(group).getByRole("button", { name: "This week" })).toBeInTheDocument();
    expect(within(group).getByRole("combobox", { name: "Month" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "All time" })).toBeInTheDocument();
    expect(within(group).getAllByRole("button")).toHaveLength(2);
    for (const gone of ["Today", "7 days", "30 days"]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
  });

  it("lists only the months the business has records in, newest year first, and starts on the newest", async () => {
    const user = userEvent.setup();
    renderDashboard();
    const trigger = await screen.findByRole("combobox", { name: "Month" });
    await waitFor(() => expect(summaryCalls.at(-1)).toMatchObject({ period: "month", month: "2026-09" }));
    expect(trigger).toHaveTextContent("September 2026");
    await user.click(trigger);
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    // Laid out as a calendar: newest year first, months in calendar order.
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(["August 2026", "September 2026", "December 2025"]);
    expect(screen.getByRole("option", { name: "September 2026" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    expect(screen.getAllByText("September 2026").length).toBeGreaterThan(1);
  });

  it("asks for the chosen month and captions the figures with it", async () => {
    const user = userEvent.setup();
    renderDashboard();
    const trigger = await screen.findByRole("combobox", { name: "Month" });
    await waitFor(() => expect(summaryCalls.length).toBeGreaterThan(0));

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "December 2025" }));
    await waitFor(() => expect(summaryCalls.at(-1)).toMatchObject({ period: "month", month: "2025-12" }));
    expect((await screen.findAllByText("December 2025")).length).toBeGreaterThan(1);
  });

  it("asks for this week and all time by name", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await waitFor(() => expect(summaryCalls.length).toBeGreaterThan(0));

    await user.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => expect(summaryCalls.at(-1)).toEqual({ businessProfileId: 1, period: "week" }));
    expect(screen.getByRole("button", { name: "This week" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "All time" }));
    await waitFor(() => expect(summaryCalls.at(-1)).toEqual({ businessProfileId: 1, period: "all" }));
    expect(screen.getAllByText("All time").length).toBeGreaterThan(1);
  });

  it("starts on this week, with Month unavailable, when the business has no records", async () => {
    months = [];
    renderDashboard();
    await waitFor(() => expect(summaryCalls.at(-1)).toMatchObject({ period: "week" }));
    expect(screen.getByRole("combobox", { name: "Month" })).toBeDisabled();
  });

  it("still loads, on this week, when the month list cannot be read", async () => {
    months = new Error("offline");
    renderDashboard();
    await waitFor(() => expect(summaryCalls.at(-1)).toMatchObject({ period: "week" }));
  });
});

it('binds the dashboard view to its own reporting period scope', () => {
  const wrapper = Dashboard();
  expect(wrapper.props.scope).toBe('dashboard');
  expect(typeof wrapper.props.children.type).toBe('function');
});
