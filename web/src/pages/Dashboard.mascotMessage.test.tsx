// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { BusinessProfile, DashboardSummary, UserPreferences } from "../lib/types";

/**
 * THE ONE THING THE "Daily Mascot Message" SWITCH IS ALLOWED TO DO.
 *
 * Fin appears in six places on this app: the dashboard greeting, the Ask
 * FinSight trigger, the guided tour, empty states, onboarding, and business
 * setup. Only the FIRST is an unprompted daily message, and only the first is
 * what the preference turns off. Every other appearance is a reply to
 * something the owner just did, and hiding those would break features that
 * have nothing to do with a greeting.
 *
 * So this file asserts the gate BOTH ways round: the greeting goes, and the
 * floating Ask FinSight owl on the very same page stays.
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

let preferences: UserPreferences;

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
      if (url === "/dashboard/summary") return { data: summary };
      // The month-over-month panel is optional and already fails quietly.
      throw new Error(`unmocked GET ${url}`);
    },
  },
}));

function renderDashboard() {
  return render(
    <MemoryRouter>
      {/* The charts read the categorical palette off the active theme. */}
      <ThemeProvider>
        <Dashboard />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** The greeting's mascot, by the alt text only GreetingHero renders. */
const greeting = () => screen.queryByAltText("Fin, FinSight's mascot");

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
    showDashboardMascotMessage: true,
    tourStatus: null,
    tourStep: null,
    tourAlwaysShow: false,
  };
});

describe("the Dashboard daily mascot message preference", () => {
  it("shows Fin's greeting when the preference is on", async () => {
    renderDashboard();
    await waitFor(() => expect(greeting()).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /Good (morning|afternoon|evening), Ken!/ })).toBeInTheDocument();
  });

  it("hides the greeting panel entirely when the preference is off", async () => {
    preferences = { ...preferences, showDashboardMascotMessage: false };
    renderDashboard();
    // Wait for the page itself to have loaded before concluding anything is
    // missing — an assertion that passes because the fetch had not resolved
    // yet would pass with the gate removed too.
    await waitFor(() => expect(screen.getByText("Available business funds")).toBeInTheDocument());
    expect(greeting()).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Good (morning|afternoon|evening), Ken!/ })).not.toBeInTheDocument();
  });

  it("leaves the Ask FinSight trigger alone — it is not a daily message", async () => {
    preferences = { ...preferences, showDashboardMascotMessage: false };
    renderDashboard();
    await waitFor(() => expect(screen.getByText("Available business funds")).toBeInTheDocument());

    const fab = screen.getByRole("button", { name: "Ask FinSight" });
    expect(fab).toBeInTheDocument();
    expect(fab.querySelector("img")).toHaveAttribute("src", "/mascot/ask-fin.webp");
  });

  it("keeps the tour's dashboard spotlight pointed at something either way", async () => {
    // With the greeting gone the tour's "Dashboard overview" step would have
    // no target and TourOverlay would silently skip it, so the KPI row carries
    // the same marker as a fallback.
    preferences = { ...preferences, showDashboardMascotMessage: false };
    const { container } = renderDashboard();
    await waitFor(() => expect(screen.getByText("Available business funds")).toBeInTheDocument());
    expect(container.querySelectorAll('[data-tour="dashboard-summary"]').length).toBeGreaterThan(0);
  });
});
