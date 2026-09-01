// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { BusinessProfile, DashboardSummary, ReductionOpportunity, ReductionOpportunityResponse, UserPreferences } from "../lib/types";

/**
 * Dashboard top-opportunity summary card — plan §13.1/§15 Phase 5.
 *
 * A compact link-out only, reusing `GET /insights/reduction-opportunities`
 * (the list is already ranked; the card just reads the first result). Never
 * the full opportunity list, and never shown for limited confidence or an
 * empty/insufficient-history response.
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
} as unknown as BusinessProfile;

const profileB = { ...profile, id: 2, name: "Second store" } as unknown as BusinessProfile;

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

function makeOpportunity(overrides: Partial<ReductionOpportunity> = {}): ReductionOpportunity {
  return {
    id: "opp-1",
    type: "CATEGORY_PRESSURE",
    categoryId: 3,
    categoryName: "Office Supplies",
    priority: "high",
    confidence: "strong",
    observation: "Office Supplies made up a large share of expenses this period.",
    rationale: "Office Supplies crossed the high-share threshold this period.",
    evidence: {
      currentAmount: 7654,
      previousAmount: 5000,
      changeAmount: 2654,
      changePercent: 53.1,
      expenseSharePercent: 22.5,
      recordCount: 4,
      unusualRecordCount: 0,
      possibleDuplicateCount: 0,
    },
    costBehavior: "unclassified",
    suggestedChecks: [],
    relatedRecordIds: [],
    limitations: [],
    ...overrides,
  };
}

function reductionResponse(overrides: Partial<ReductionOpportunityResponse> = {}): ReductionOpportunityResponse {
  return {
    period: { days: 30, start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.000Z" },
    dataQuality: { status: "sufficient", currentRecordCount: 10, previousRecordCount: 8, message: null },
    opportunities: [],
    detectorVersion: "v1",
    ...overrides,
  };
}

let preferences: UserPreferences;
let selectedProfile: BusinessProfile;
let reductionHandler: () => unknown;

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ profile: { id: 1, firstName: "Ken" }, preferences }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedProfile, profiles: [profile], loading: false }),
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
      if (url === "/insights/reduction-opportunities") return reductionHandler();
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
  preferences = { showDashboardMascotMessage: false, tourStatus: null, tourStep: null, tourAlwaysShow: false };
  selectedProfile = profile;
  reductionHandler = () => ({ data: reductionResponse({ opportunities: [makeOpportunity()] }) });
});

describe("Dashboard top reduction opportunity card", () => {
  it("shows the top opportunity with its category and a supporting figure, linking to Expense Insights", async () => {
    renderDashboard();

    expect(await screen.findByText("Reduction opportunity")).toBeInTheDocument();
    expect(screen.getByText("Office Supplies made up a large share of expenses this period.")).toBeInTheDocument();
    expect(screen.getByText("PHP 7,654")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Review opportunity →" });
    expect(link).toHaveAttribute("href", "/insights/expense-behavior");
  });

  it("does not show the card when confidence is limited", async () => {
    reductionHandler = () => ({
      data: reductionResponse({ opportunities: [makeOpportunity({ confidence: "limited" })] }),
    });
    renderDashboard();

    await waitFor(() => expect(screen.getByText("Available business funds")).toBeInTheDocument());
    expect(screen.queryByText("Reduction opportunity")).not.toBeInTheDocument();
  });

  it("does not show the card when the opportunities list is empty", async () => {
    reductionHandler = () => ({ data: reductionResponse({ opportunities: [] }) });
    renderDashboard();

    await waitFor(() => expect(screen.getByText("Available business funds")).toBeInTheDocument());
    expect(screen.queryByText("Reduction opportunity")).not.toBeInTheDocument();
  });

  it("does not show the card when the request fails", async () => {
    reductionHandler = () => {
      throw new Error("Request failed with status code 500");
    };
    renderDashboard();

    await waitFor(() => expect(screen.getByText("Available business funds")).toBeInTheDocument());
    expect(screen.queryByText("Reduction opportunity")).not.toBeInTheDocument();
    // Quiet failure — no page-level error banner over an otherwise-working dashboard.
    expect(screen.queryByText(/status code 500/)).not.toBeInTheDocument();
  });

  it("clears a stale card from the previous business profile on switch", async () => {
    const { rerender } = renderDashboard();
    expect(await screen.findByText("Reduction opportunity")).toBeInTheDocument();

    selectedProfile = profileB;
    reductionHandler = () => ({ data: reductionResponse({ opportunities: [] }) });
    rerender(
      <MemoryRouter>
        <ThemeProvider>
          <Dashboard />
        </ThemeProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.queryByText("Reduction opportunity")).not.toBeInTheDocument());
  });
});
