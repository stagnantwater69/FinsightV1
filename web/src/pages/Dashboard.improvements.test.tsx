// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "../context/ThemeContext";
import { Dashboard } from "./Dashboard";
import type { DashboardSummary } from "../lib/types";
import type { DashboardExpenseOverview } from "../lib/expenseOverview";
import {
  beginServerStateSession,
  endServerStateSession,
  invalidateServerState,
} from "../lib/serverStateCache";

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

const overview: DashboardExpenseOverview = {
  view: "dashboard",
  comparison: { status: "unavailable", data: null },
  topOpportunity: { status: "available", data: null },
};

type GetConfig = { signal?: AbortSignal };
let summaryHandler: (config?: GetConfig) => Promise<{ data: DashboardSummary }>;
let overviewHandler: (config?: GetConfig) => Promise<{ data: DashboardExpenseOverview }>;

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

const openChat = vi.fn();
vi.mock("../context/AiChatContext", () => ({ useAiChat: () => ({ openChat }) }));

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: GetConfig) => {
      if (url === "/dashboard/summary") return summaryHandler(config);
      if (url === "/insights/expense-overview") return overviewHandler(config);
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
  summaryHandler = async () => ({ data: summary });
  overviewHandler = async () => ({ data: overview });
});

afterEach(() => endServerStateSession());

describe("Dashboard decision-first improvements", () => {
  it("shows where the calculated available-funds figure came from", async () => {
    summaryHandler = async () => ({
      data: {
        ...summary,
        overview: {
          ...summary.overview,
          availableFunds: 61_000,
          availableFundsCalculation: {
            calculatedAmount: 61_000,
            baselineAmount: 50_000,
            baselineAt: "2026-01-01T00:00:00.000Z",
            baselineDate: "2026-01-01",
            confirmedSalesAdded: 15_000,
            confirmedExpensesDeducted: 4_000,
            confirmedSalesRecordCount: 2,
            confirmedExpenseRecordCount: 1,
            asOfDate: "2026-01-31",
          },
        },
      },
    });

    renderDashboard();

    expect(await screen.findByText("PHP 61,000")).toBeVisible();
    expect(
      screen.getByText(/Starting PHP 50,000; 2 confirmed sales and 1 confirmed expense since Jan 1, 2026/),
    ).toBeVisible();
  });

  it("uses semantic all-time copy instead of Last 0 days", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "All time" }));
    // The filter's own button plus the captions under the figures.
    await waitFor(() => expect(screen.getAllByText("All time").length).toBeGreaterThan(1));
    expect(screen.queryByText(/Last 0 days/i)).not.toBeInTheDocument();
  });

  /*
   * The period label is lower-cased into the question that seeds Ask FinSight,
   * so "Last 0 days" would not just look wrong on a tile — it would be sent to
   * the AI as the owner's own words (QA register FUN-008).
   */
  it("seeds Ask FinSight with a question that reads naturally on All time", async () => {
    const user = userEvent.setup();
    openChat.mockClear();
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "All time" }));
    await user.click(await screen.findByRole("button", { name: "Ask FinSight about these figures" }));

    const question = openChat.mock.calls[0][1] as string;
    expect(question).toBe("Why is Inventory my largest expense category across all records?");
    expect(question).not.toMatch(/\b0 days?\b/);
  });

  it("distinguishes a comparison request failure from insufficient history", async () => {
    renderDashboard();
    expect(await screen.findByText("Comparison couldn’t load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("progressively discloses detailed charts on compact layouts", async () => {
    const user = userEvent.setup();
    renderDashboard();
    const toggle = await screen.findByRole("button", { name: "Show charts" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Hide charts" })).toHaveAttribute("aria-expanded", "true");
  });

  it("replaces an invalidated in-flight summary without showing a false refresh error", async () => {
    beginServerStateSession("dashboard-owner");
    let summaryCalls = 0;
    let firstRequestAborted = false;
    summaryHandler = (config) => {
      summaryCalls += 1;
      if (summaryCalls > 1) {
        return Promise.resolve({
          data: {
            ...summary,
            overview: { ...summary.overview, availableFunds: 61_000 },
          },
        });
      }
      return new Promise((_resolve, reject) => {
        config?.signal?.addEventListener("abort", () => {
          firstRequestAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };

    renderDashboard();
    await waitFor(() => expect(summaryCalls).toBe(1));
    await act(async () => {
      invalidateServerState({ businessProfileId: 1, tags: ["financial"] });
      await Promise.resolve();
    });

    expect(await screen.findByText("PHP 61,000")).toBeInTheDocument();
    expect(firstRequestAborted).toBe(true);
    expect(screen.queryByText("Dashboard couldn’t refresh.")).not.toBeInTheDocument();
  });

  it("keeps dashboard insight data visible and reports a failed revalidation", async () => {
    const availableOverview: DashboardExpenseOverview = {
      view: "dashboard",
      comparison: {
        status: "available",
        data: {
          period: undefined,
          totals: { current: 12_000, previous: 9_000 },
          categoryTrends: [{
            categoryId: 1,
            categoryName: "Inventory",
            current: 12_000,
            previous: 9_000,
            direction: "up",
            change: 3_000,
            percentChange: 33.3,
            recordCount: 4,
          }],
        },
      },
      topOpportunity: { status: "available", data: null },
    };
    let shouldFail = false;
    overviewHandler = async () => {
      if (shouldFail) throw new Error("Network unavailable");
      return { data: availableOverview };
    };

    renderDashboard();
    await screen.findByText("PHP 50,000");
    await waitFor(() => expect(screen.queryByText("Comparison couldn’t load")).not.toBeInTheDocument());
    shouldFail = true;
    await act(async () => {
      invalidateServerState({ businessProfileId: 1, resourcePrefix: "/insights/expense-overview" });
      await Promise.resolve();
    });

    expect(await screen.findByText("Dashboard details couldn’t refresh.")).toBeInTheDocument();
    expect(screen.queryByText("Comparison couldn’t load")).not.toBeInTheDocument();
  });
});
