// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
    todaysGap: -1250,
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

type GetConfig = { signal?: AbortSignal; params?: Record<string, unknown> };
let selectedBusiness = { id: 1, name: "Store" };
// The two supplementary dashboard feeds. They reject by default, the way an
// unmocked endpoint does, so every older test also covers "optional panel
// failed without taking the page down".
const feedHandlers: {
  cashflow: () => Promise<unknown>;
  records: () => Promise<unknown>;
} = {
  cashflow: async () => { throw new Error("unmocked cashflow"); },
  records: async () => { throw new Error("unmocked records"); },
};
let summaryHandler: (config?: GetConfig) => Promise<{ data: DashboardSummary }>;
let overviewHandler: (config?: GetConfig) => Promise<{ data: DashboardExpenseOverview }>;

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    profile: { id: 1, firstName: "Ana" },
    preferences: { showDashboardMascotMessage: false, tourStatus: null, tourStep: null, tourAlwaysShow: false },
  }),
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedBusiness, profiles: [], loading: false }),
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
      if (url === "/dashboard/cashflow") return feedHandlers.cashflow();
      if (url === "/records/search") return feedHandlers.records();
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
  selectedBusiness = { id: 1, name: "Store" };
  feedHandlers.cashflow = async () => { throw new Error("unmocked cashflow"); };
  feedHandlers.records = async () => { throw new Error("unmocked records"); };
  summaryHandler = async () => ({ data: summary });
  overviewHandler = async () => ({ data: overview });
});

afterEach(() => endServerStateSession());

describe("Dashboard decision-first improvements", () => {
  it("shows where the calculated available-funds figure came from", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByText("How it’s calculated"));
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

  it("compares all three period figures with named dates and describes a negative net honestly", async () => {
    summaryHandler = async () => ({ data: {
      ...summary,
      overview: { ...summary.overview, totalSalesReference: 10_000, totalExpenses: 12_000 },
      periodComparison: {
        previousStart: "2025-12-01",
        previousEnd: "2025-12-31",
        sales: { previous: 8_000, changeAmount: 2_000, changePercent: 25 },
        expenses: { previous: 15_000, changeAmount: -3_000, changePercent: -20 },
        net: { previous: -7_000, changeAmount: 5_000, changePercent: null },
      },
    } });
    renderDashboard();

    const figures = await screen.findByRole("region", { name: "Key figures" });
    await within(figures).findByText("25% increase");
    expect(within(figures).getByText("20% decrease")).toBeVisible();
    expect(within(figures).getByText("PHP 5,000 increase")).toBeVisible();
    expect(within(figures).getAllByText(/vs Dec 1-31, 2025/)).toHaveLength(3);
    expect(within(figures).getByText("−PHP 2,000")).toBeVisible();
    expect(within(figures).getByText("Expenses exceeded sales")).toBeVisible();
    expect(within(figures).queryByText("0% of sales kept")).not.toBeInTheDocument();
  });

  it("does not invent a percentage when the previous amount is zero and labels unchanged net neutrally", async () => {
    summaryHandler = async () => ({ data: {
      ...summary,
      overview: { ...summary.overview, totalSalesReference: 3_000, totalExpenses: 3_000 },
      periodComparison: {
        previousStart: "2025-12-01",
        previousEnd: "2025-12-31",
        sales: { previous: 0, changeAmount: 3_000, changePercent: null },
        expenses: { previous: 0, changeAmount: 3_000, changePercent: null },
        net: { previous: 0, changeAmount: 0, changePercent: null },
      },
    } });
    renderDashboard();

    const figures = await screen.findByRole("region", { name: "Key figures" });
    expect(within(figures).getAllByText("PHP 3,000 increase")).toHaveLength(2);
    expect(within(figures).getByText("No change")).toBeVisible();
    expect(within(figures).queryByText(/Infinity|NaN/)).not.toBeInTheDocument();
  });

  it("respects an explicit unavailable comparison instead of using a legacy expense delta on All time", async () => {
    const user = userEvent.setup();
    summaryHandler = async () => ({ data: { ...summary, periodComparison: null } });
    overviewHandler = async () => ({ data: {
      ...overview,
      comparison: { status: "available", data: { totals: { current: 12_000, previous: 9_000 }, categoryTrends: [], period: undefined } },
    } });
    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "All time" }));

    const figures = await screen.findByRole("region", { name: "Key figures" });
    expect(within(figures).queryByText(/increase|decrease|vs /)).not.toBeInTheDocument();
  });

  it("separates the overview refresh time from the date of the latest transaction", async () => {
    beginServerStateSession("dashboard-owner");
    renderDashboard();

    expect(await screen.findByText(/Overview updated/)).toBeVisible();
    expect(screen.getByText(/Latest transaction recorded:/)).toHaveTextContent("Jan 30, 2026");
  });

  it("hides the previous business's totals and freshness data while a new business loads and fails", async () => {
    let rejectNewBusiness!: (reason: Error) => void;
    summaryHandler = async (config) => config?.params?.businessProfileId === 2
      ? new Promise((_resolve, reject) => { rejectNewBusiness = reject; })
      : { data: summary };
    const { rerender } = renderDashboard();
    await screen.findByText("PHP 50,000");

    selectedBusiness = { id: 2, name: "Second store" };
    rerender(<MemoryRouter><ThemeProvider><Dashboard /></ThemeProvider></MemoryRouter>);

    expect(screen.queryByText("PHP 50,000")).not.toBeInTheDocument();
    expect(screen.queryByText(/Latest transaction recorded:/)).not.toBeInTheDocument();
    await waitFor(() => expect(rejectNewBusiness).toBeTypeOf("function"));
    await act(async () => { rejectNewBusiness(new Error("offline")); });
    expect(await screen.findByText("Dashboard couldn’t load.")).toBeVisible();
    expect(screen.queryByText("PHP 50,000")).not.toBeInTheDocument();
  });

  it("hides old period figures instead of presenting them under a newly selected period after a failure", async () => {
    const user = userEvent.setup();
    let rejectNewPeriod!: (reason: Error) => void;
    summaryHandler = async (config) => config?.params?.period === "all"
      ? new Promise((_resolve, reject) => { rejectNewPeriod = reject; })
      : { data: summary };
    renderDashboard();
    await screen.findByText("PHP 50,000");

    await user.click(screen.getByRole("button", { name: "All time" }));

    expect(screen.queryByText("PHP 50,000")).not.toBeInTheDocument();
    await waitFor(() => expect(rejectNewPeriod).toBeTypeOf("function"));
    await act(async () => { rejectNewPeriod(new Error("offline")); });
    expect(await screen.findByText("Dashboard couldn’t load.")).toBeVisible();
    expect(screen.queryByText("PHP 50,000")).not.toBeInTheDocument();
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

describe("Dashboard cash flow and recent records", () => {
  it("shows money in vs out for the chart's window, and the newest records signed by type", async () => {
    const user = userEvent.setup();
    feedHandlers.cashflow = async () => ({
      data: {
        granularity: "monthly",
        points: [
          { date: "2025-12", sales: 9000, expenses: 4000 },
          { date: "2026-01", sales: 30000, expenses: 12000 },
        ],
      },
    });
    feedHandlers.records = async () => ({
      data: {
        items: [
          { id: 1, type: "sales", businessProfileId: 1, date: "2026-01-30T00:00:00.000Z", description: "Market day takings", amount: 2500, source: "Manual Entry", reviewStatus: "Confirmed", duplicateStatus: "Flagged", duplicateOfRecordId: null, createdAt: "2026-01-30T00:00:00.000Z" },
          { id: 2, type: "expense", businessProfileId: 1, categoryId: 1, date: "2026-01-29T00:00:00.000Z", description: "Rice sacks", amount: 1800, source: "Manual Entry", reviewStatus: "Needs Review", duplicateStatus: "NONE", duplicateOfRecordId: null, createdAt: "2026-01-29T00:00:00.000Z" },
        ],
        nextCursor: null,
      },
    });
    renderDashboard();

    // Totals across the chart's own window, not the period's.
    expect(await screen.findByText("PHP 39,000")).toBeInTheDocument();
    expect(screen.getByText("PHP 16,000")).toBeInTheDocument();
    expect(screen.getByText("+PHP 23,000")).toBeInTheDocument();

    expect(await screen.findByText("Market day takings")).toBeInTheDocument();
    expect(screen.getByText("Rice sacks")).toBeInTheDocument();
    // A sale reads as money in, an expense as money out, with its category.
    expect(screen.getByRole("link", { name: "View all records" })).toHaveAttribute("href", "/records?dateFrom=2026-01-01&dateTo=2026-01-31");
    const table = screen.getByRole("table", { name: /Most recent records/ });
    expect(within(table).getByText("Inventory")).toBeInTheDocument();
    expect(within(table).getByText("Sales")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Market day takings" })).toHaveAttribute("href", "/records/sales/1/edit");
    expect(within(table).getByRole("link", { name: "Rice sacks" })).toHaveAttribute("href", "/records/expenses/2/edit");
    expect(within(table).getByText("Needs review")).toBeVisible();
    const flaggedSale = within(table).getByRole("row", { name: /Market day takings/ });
    expect(within(flaggedSale).getByText("Possible duplicate")).toBeVisible();
    expect(within(flaggedSale).queryByText("Needs review")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All time" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "View all records" })).toHaveAttribute("href", "/records"));
  });

  it("keeps the page up when the optional feeds fail, with a retry inside each panel", async () => {
    renderDashboard();
    expect(await screen.findByText("Cash flow couldn’t load.")).toBeInTheDocument();
    expect(await screen.findByText("Recent records couldn’t load.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload cash flow" })).toBeInTheDocument();
    // The page's own figures are untouched.
    expect(screen.getByText("Available funds")).toBeInTheDocument();
  });
});
