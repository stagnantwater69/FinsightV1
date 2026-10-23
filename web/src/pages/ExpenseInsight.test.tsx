// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ExpenseInsight } from "./ExpenseInsight";
import type {
  AnomalyFinding,
  BusinessProfile,
  ExpenseBehavior,
  FinancialPosition,
  RecordItem,
  ReductionOpportunity,
  ReductionOpportunityResponse,
  ReductionSimulation,
  RecurringPattern,
  RecurringSchedule,
} from "../lib/types";
import type { DetailExpenseOverview } from "../lib/expenseOverview";
import { beginServerStateSession, endServerStateSession, invalidateServerState } from "../lib/serverStateCache";
import { routeDataRequests } from "../lib/routeDataPrefetch";
import { cachedApiGet } from "../lib/serverStateApi";

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * `load()` once awaited its core and supporting endpoints in one `Promise.all`. `Promise.all`
 * rejects the moment ANY member rejects and discards the responses that already
 * arrived — so when `/insights/recurring-schedules` went dark behind its server
 * feature flag (404 by design, so an unshipped feature is not advertised), the
 * whole page collapsed to an error banner: no KPI row, no charts, no category
 * table, no flags. An optional panel at the bottom of the page destroyed
 * everything above it.
 *
 * The schedules tests cover both transient request failures and a definitive
 * 404 from the feature gate. Other supplemental panels remain status-agnostic.
 */

const behavior: ExpenseBehavior = {
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-01-31T00:00:00.000Z",
  previousPeriodStart: "2025-12-01T00:00:00.000Z",
  previousPeriodEnd: "2025-12-31T00:00:00.000Z",
  periodDays: 30,
  totals: { current: 12000, previous: 9000 },
  dailyTotals: [],
  categoryTrends: [
    {
      categoryId: 1,
      categoryName: "Inventory",
      current: 12000,
      previous: 9000,
      direction: "up",
      change: 3000,
      percentChange: 33.3,
      recordCount: 4,
    },
  ],
  unusualExpenses: [],
  insufficientHistoryCategories: [],
  latestExpenseDate: new Date().toISOString(),
};

const candidate: RecurringPattern = {
  id: 7,
  description: "Warehouse rent",
  vendor: null,
  intervalDays: 30,
  expectedAmount: 9500,
  confidence: 0.9,
  nextExpectedDate: "2026-02-01T00:00:00.000Z",
  status: "CANDIDATE",
  category: { name: "Rent" },
};

const schedule: RecurringSchedule = {
  id: 3,
  businessProfileId: 1,
  categoryId: 1,
  categoryName: "Rent",
  label: "Warehouse rent",
  vendor: null,
  intervalDays: 30,
  expectedAmount: 9500,
  amountTolerance: 0.1,
  nextDueDate: "2026-02-01T00:00:00.000Z",
  lastRecordedDate: null,
  isActive: true,
  sourcePatternId: 7,
  dueState: "SCHEDULED",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
  largeExpenseThresholdPercent: 20,
} as unknown as BusinessProfile;

const profileB = {
  id: 2,
  name: "Second store",
  availableFunds: 80000,
  expectedMonthlyExpenses: 30000,
  largeExpenseThresholdPercent: 20,
} as unknown as BusinessProfile;

/** Mutable so a test can simulate switching business profiles mid-render. */
let selectedProfile: BusinessProfile = profile;

function financialPosition(
  calculatedAmount = profile.availableFunds,
): FinancialPosition {
  const confirmedSalesAdded = Math.max(
    0,
    calculatedAmount - profile.availableFunds,
  );
  const confirmedExpensesDeducted = Math.max(
    0,
    profile.availableFunds - calculatedAmount,
  );
  return {
    asOfDate: "2026-10-01",
    availableFunds: {
      calculatedAmount,
      baselineAmount: profile.availableFunds,
      baselineAt: "2026-08-01T00:00:00.000Z",
      baselineDate: "2026-08-01",
      confirmedSalesAdded,
      confirmedExpensesDeducted,
      confirmedSalesRecordCount: confirmedSalesAdded > 0 ? 1 : 0,
      confirmedExpenseRecordCount: confirmedExpensesDeducted > 0 ? 1 : 0,
      asOfDate: "2026-10-01",
    },
    monthlyExpenseBasis: {
      amount: 20_000,
      source: "owner_estimate",
      sourceMonth: null,
      ownerEstimate: 20_000,
      eligibleRecordCount: 0,
      recordsCompleteThroughMonth: null,
      recordsCompleteThroughConfirmedAt: null,
    },
  };
}

// Deliberately a DIFFERENT category name/amount from the `behavior` fixture's
// "Inventory" — the KPI row and category table already print "Inventory" and
// "PHP 12,000" from `behavior`, and a card that happened to repeat both would
// make assertions on this panel ambiguous for reasons that have nothing to do
// with this panel.
function makeOpportunity(
  overrides: Partial<ReductionOpportunity> = {},
): ReductionOpportunity {
  return {
    id: "opp-1",
    type: "CATEGORY_PRESSURE",
    categoryId: 3,
    categoryName: "Office Supplies",
    priority: "high",
    confidence: "strong",
    observation:
      "Office Supplies made up a large share of expenses this period.",
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
    suggestedChecks: ["Review the records contributing most to this category."],
    relatedRecordIds: [101, 102],
    limitations: [],
    ...overrides,
  };
}

function reductionResponse(
  overrides: Partial<ReductionOpportunityResponse> = {},
): ReductionOpportunityResponse {
  return {
    period: {
      days: 30,
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-31T00:00:00.000Z",
    },
    dataQuality: {
      status: "sufficient",
      currentRecordCount: 10,
      previousRecordCount: 8,
      message: null,
    },
    opportunities: [makeOpportunity()],
    detectorVersion: "v1",
    ...overrides,
  };
}

/** Per-URL responses. A handler that throws stands for ANY failure — 404 from
 *  the feature gate, 500, or the request never leaving the device. */
type GetConfig = { params?: Record<string, unknown>; signal?: AbortSignal };
let handlers: Record<string, (config?: GetConfig) => unknown>;
/** Every GET, with its query, so the period sent can be asserted. */
let getCalls: { url: string; params: Record<string, unknown> }[] = [];

function ok<T>(data: T) {
  return () => ({ data });
}

function failing() {
  return () => {
    throw new Error("Request failed with status code 404");
  };
}

function notFound() {
  return () => {
    throw Object.assign(new Error("Request failed with status code 404"), {
      isAxiosError: true,
      response: { status: 404, data: { error: "Not found" } },
    });
  };
}

function detailOverview(
  behaviorPanel: DetailExpenseOverview["behavior"] = {
    status: "available",
    data: behavior,
  },
  opportunitiesPanel: DetailExpenseOverview["opportunities"] = {
    status: "available",
    data: reductionResponse({ opportunities: [] }),
  },
): DetailExpenseOverview {
  return {
    view: "detail",
    behavior: behaviorPanel,
    opportunities: opportunitiesPanel,
  };
}

function setOverview(
  nextBehavior: ExpenseBehavior = behavior,
  nextOpportunities: ReductionOpportunityResponse = reductionResponse({ opportunities: [] }),
) {
  handlers["/insights/expense-overview"] = ok(
    detailOverview(
      { status: "available", data: nextBehavior },
      { status: "available", data: nextOpportunities },
    ),
  );
}

function setOpportunities(next: ReductionOpportunityResponse) {
  setOverview(behavior, next);
}

/**
 * POST payloads captured by URL, for the reduction-simulation tests below —
 * asserting on what the CLIENT sent, not just what it rendered afterwards.
 */
let postCalls: { url: string; body: unknown }[];
let postHandlers: Record<string, (body: unknown) => unknown>;

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      getCalls.push({ url, params: config?.params ?? {} });
      const handler = handlers[url];
      if (!handler) throw new Error(`unmocked GET ${url}`);
      return handler(config);
    },
    post: async (url: string, body: unknown) => {
      postCalls.push({ url, body });
      const handler = postHandlers[url];
      if (handler) return handler(body);
      return { data: {} };
    },
    patch: async () => ({ data: {} }),
  },
}));

const getFinancialPosition = vi.fn();
vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({
    selected: selectedProfile,
    getFinancialPosition,
  }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }] }),
}));

// Recharts measures its container, which jsdom reports as 0×0 — the charts
// render nothing useful here and are covered by their own tests. Stubbed so
// this file is about the load path, not about SVG.
vi.mock("../components/DonutChart", () => ({ DonutChart: () => null }));
vi.mock("../components/CategoryComparisonChart", () => ({
  CategoryComparisonChart: () => null,
}));
vi.mock("../components/DailySpendChart", () => ({
  DailySpendChart: () => null,
}));
vi.mock("../components/AskFinSightButton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/AskFinSightButton")>()),
  AskFinSightButton: () => null,
}));
// The page's "expand on this" link and each opportunity card's "Ask FinSight
// about this" button reach Ask FinSight through the provider in the
// authenticated layout, which this file does not mount. `openChat` is a spy
// (not a plain no-op) so tests below can assert what a card actually hands it.
const openChat = vi.fn();
vi.mock("../context/AiChatContext", () => ({
  useAiChat: () => ({ openChat }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ExpenseInsight />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  selectedProfile = profile;
  getFinancialPosition.mockReset();
  getFinancialPosition.mockResolvedValue(financialPosition());
  openChat.mockClear();
  postCalls = [];
  postHandlers = {};
  getCalls = [];
  handlers = {
    "/records/months": ok({ months: ["2026-09", "2026-08"] }),
    "/insights/expense-overview": ok(detailOverview()),
    "/records/flagged": ok({ items: [], nextCursor: null }),
    "/records/flagged/count": ok({ expenses: 0, sales: 0, total: 0 }),
    "/insights/findings": ok({ items: [], nextCursor: null }),
    "/insights/recurring-patterns": ok([candidate]),
    "/insights/recurring-schedules": ok([schedule]),
  };
});

describe("ExpenseInsight resilience", () => {
  it("uses record-derived available funds for the expense-share figure", async () => {
    getFinancialPosition.mockResolvedValue(financialPosition(24_000));
    renderPage();

    const label = await screen.findByText(
      "Share of recorded available funds",
    );
    const tile = label.parentElement;
    expect(tile).not.toBeNull();
    expect(within(tile!).getByText("50%")).toBeInTheDocument();
    expect(
      within(tile!).getByText(
        "PHP 12,000 of PHP 24,000 recorded available funds",
      ),
    ).toBeInTheDocument();
    expect(getFinancialPosition).toHaveBeenCalledWith(
      profile.id,
      expect.any(AbortSignal),
    );
  });

  it("refreshes recorded funds only for a matching business invalidation", async () => {
    getFinancialPosition
      .mockResolvedValueOnce(financialPosition(24_000))
      .mockResolvedValueOnce(financialPosition(30_000));
    renderPage();

    expect(
      await screen.findByText(
        "PHP 12,000 of PHP 24,000 recorded available funds",
      ),
    ).toBeInTheDocument();
    expect(getFinancialPosition).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateServerState({
        businessProfileId: profileB.id,
        tags: ["financial"],
      });
    });
    expect(getFinancialPosition).toHaveBeenCalledTimes(1);

    act(() => {
      invalidateServerState({
        businessProfileId: profile.id,
        tags: ["financial"],
      });
    });

    expect(
      await screen.findByText(
        "PHP 12,000 of PHP 30,000 recorded available funds",
      ),
    ).toBeInTheDocument();
    expect(getFinancialPosition).toHaveBeenCalledTimes(2);
  });

  it("labels the starting-funds fallback when recorded funds cannot load", async () => {
    getFinancialPosition.mockRejectedValue(
      new Error("Recorded balance is temporarily unavailable."),
    );
    renderPage();

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(
      "Recorded balance couldn’t load. Using starting funds.",
    );
    expect(
      screen.getByRole("button", { name: "Retry recorded balance" }),
    ).toBeInTheDocument();

    const tile = screen.getByText("Share of recorded available funds")
      .parentElement;
    expect(tile).not.toBeNull();
    expect(within(tile!).getByText("24%")).toBeInTheDocument();
    expect(
      within(tile!).getByText("PHP 12,000 of PHP 50,000 recorded available funds"),
    ).toBeInTheDocument();
  });

  it("still renders its core content when the schedules request fails", async () => {
    handlers["/insights/recurring-schedules"] = failing();
    renderPage();

    // The KPI row and the category table — the reason the page exists.
    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
    expect(screen.getByText("Category summary")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Inventory/ })).toBeInTheDocument();
    // And no page-level error: one dark optional endpoint is not a reason to
    // tell an owner their figures failed to load.
    expect(screen.queryByText(/status code 404/)).not.toBeInTheDocument();
    expect(screen.queryByText("Payments you asked FinSight to watch")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing scheduled yet")).not.toBeInTheDocument();
  });

  it("hides the recurring agenda entirely rather than claiming nothing is scheduled", async () => {
    handlers["/insights/recurring-schedules"] = notFound();
    renderPage();
    await screen.findByText("Total expenses");

    expect(
      screen.queryByText("Payments you asked FinSight to watch"),
    ).not.toBeInTheDocument();
    // The empty state would be a statement about the owner's business that we
    // have no evidence for — the difference between "none" and "cannot see".
    expect(screen.queryByText("Nothing scheduled yet")).not.toBeInTheDocument();
  });

  it("keeps the candidates panel working when only the schedules request fails", async () => {
    handlers["/insights/recurring-schedules"] = notFound();
    renderPage();

    // /insights/recurring-patterns is ungated and answered; the two must not
    // fail together.
    expect(await screen.findByText("Possible recurring expenses")).toBeInTheDocument();
    expect(screen.getByText("Warehouse rent")).toBeInTheDocument();
    // Confirming creates a schedule and is behind the same gate, so the button
    // is not offered rather than offered-and-broken.
    expect(
      screen.queryByRole("button", { name: /Watch this/ }),
    ).not.toBeInTheDocument();
    // Dismissing is a different, ungated endpoint and stays available.
    expect(
      screen.getByRole("button", { name: /Not recurring/ }),
    ).toBeInTheDocument();
  });

  it("shows the agenda and the confirm action when schedules are available", async () => {
    renderPage();
    expect(
      await screen.findByText("Payments you asked FinSight to watch"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Watch this/ }),
    ).toBeInTheDocument();
  });

  it("survives an unrelated supplementary failure the same way", async () => {
    // Not a feature flag and not a 404 — the point of the restructure is that
    // the page does not care which supplement failed or why.
    handlers["/insights/findings"] = failing();
    handlers["/records/flagged"] = failing();
    handlers["/records/flagged/count"] = failing();
    renderPage();

    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
    expect(screen.getByText("Finding details are temporarily unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("No findings to review")).not.toBeInTheDocument();
  });

  it("keeps last-known supplemental data and labels a failed mounted refresh", async () => {
    const flagged = {
      id: 41,
      type: "expense",
      businessProfileId: profile.id,
      date: "2026-01-20T00:00:00.000Z",
      description: "Emergency freezer repair",
      amount: 8_500,
      categoryId: 1,
      categoryName: "Inventory",
      largeExpenseFlag: true,
      reviewStatus: "Needs Review",
      duplicateStatus: "Not Checked",
      source: "MANUAL_ENTRY",
    } as unknown as RecordItem;
    const finding = {
      id: 52,
      expenseRecordId: flagged.id,
      type: "AMOUNT_OUTLIER",
      severity: "HIGH",
      score: 3.2,
      title: "Repair cost is higher than usual",
      reasons: ["Higher than recent repairs"],
      status: "OPEN",
      detectedAt: "2026-01-20T00:00:00.000Z",
    } as AnomalyFinding;
    handlers["/records/flagged"] = ok({ items: [flagged], nextCursor: null });
    handlers["/records/flagged/count"] = ok({ expenses: 1, sales: 0, total: 1 });
    handlers["/insights/findings"] = ok({ items: [finding], nextCursor: null });
    renderPage();

    expect(await screen.findByText("Emergency freezer repair")).toBeInTheDocument();
    expect(await screen.findByText("Repair cost is higher than usual")).toBeInTheDocument();
    expect(await screen.findAllByText("Warehouse rent")).not.toHaveLength(0);

    handlers["/records/flagged"] = failing();
    handlers["/records/flagged/count"] = failing();
    handlers["/insights/findings"] = failing();
    handlers["/insights/recurring-patterns"] = failing();
    await act(async () => {
      invalidateServerState({ businessProfileId: profile.id, tags: ["financial"] });
      await Promise.resolve();
    });

    expect(await screen.findByText(/Showing recently loaded flagged record details/)).toBeInTheDocument();
    expect(screen.getByText(/Showing recently loaded finding details/)).toBeInTheDocument();
    expect(screen.getByText(/Showing recently loaded recurring expense suggestions/)).toBeInTheDocument();
    expect(screen.getByText("Emergency freezer repair")).toBeInTheDocument();
    expect(screen.getByText("Repair cost is higher than usual")).toBeInTheDocument();
    expect(screen.getAllByText("Warehouse rent")).not.toHaveLength(0);
    expect(screen.queryByText("Nothing flagged")).not.toBeInTheDocument();
    expect(screen.queryByText("No findings to review")).not.toBeInTheDocument();
  });

  it("keeps cached schedules visible after a transient refresh failure and retries", async () => {
    renderPage();
    expect(await screen.findByText("Payments you asked FinSight to watch")).toBeInTheDocument();

    handlers["/insights/recurring-schedules"] = failing();
    await act(async () => {
      invalidateServerState({
        businessProfileId: profile.id,
        resourcePrefix: "/insights/recurring-schedules",
      });
      await Promise.resolve();
    });

    expect(
      await screen.findByText("Recurring payments couldn’t refresh."),
    ).toBeInTheDocument();
    expect(screen.getByText("Showing recently loaded schedules.")).toBeInTheDocument();
    expect(screen.getByText("Payments you asked FinSight to watch")).toBeInTheDocument();

    handlers["/insights/recurring-schedules"] = ok([
      { ...schedule, label: "Warehouse rent revised" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Retry schedules" }));

    expect(await screen.findAllByText("Warehouse rent revised")).not.toHaveLength(0);
    await waitFor(() => {
      expect(screen.queryByText("Recurring payments couldn’t refresh.")).not.toBeInTheDocument();
    });
  });

  it("drops cached schedules when a mounted refresh confirms the feature is unavailable", async () => {
    renderPage();
    expect(await screen.findByText("Payments you asked FinSight to watch")).toBeInTheDocument();

    handlers["/insights/recurring-schedules"] = notFound();
    await act(async () => {
      invalidateServerState({
        businessProfileId: profile.id,
        resourcePrefix: "/insights/recurring-schedules",
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("Payments you asked FinSight to watch")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Recurring payments couldn’t refresh.")).not.toBeInTheDocument();
    expect(screen.getByText("Possible recurring expenses")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Watch this/ })).not.toBeInTheDocument();
  });

  it("surfaces a recoverable error when the overview request fails", async () => {
    handlers["/insights/expense-overview"] = failing();
    renderPage();

    expect(await screen.findByText(/status code 404/)).toBeInTheDocument();
    expect(screen.queryByText("Total expenses")).not.toBeInTheDocument();

    handlers["/insights/expense-overview"] = ok(detailOverview());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
    expect(screen.queryByText(/status code 404/)).not.toBeInTheDocument();
  });

  it("reports only the unavailable behavior panel and recovers on retry", async () => {
    handlers["/insights/expense-overview"] = ok(
      detailOverview(
        { status: "unavailable", data: null },
        { status: "available", data: reductionResponse() },
      ),
    );
    renderPage();

    expect(await screen.findByText("Expense insight couldn’t load")).toBeInTheDocument();
    expect(screen.getByText("The expense behavior panel is temporarily unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/Opportunities couldn’t load/)).not.toBeInTheDocument();

    handlers["/insights/expense-overview"] = ok(detailOverview());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
  });

  it("offers suggested questions in the summary that open Ask FinSight without sending", async () => {
    renderPage();
    await screen.findByText("Total expenses");

    await userEvent.click(
      screen.getByRole("button", { name: "How can I spend less on Inventory?" }),
    );
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith(
      "Expense Insights",
      expect.stringContaining("How can I reduce my Inventory expenses"),
      undefined,
    );
    // The same figures as the tiles, as short points rather than one paragraph.
    expect(screen.getByText(/rose the most/)).toBeInTheDocument();
    expect(screen.getByText(/Total spending is/)).toBeInTheDocument();
  });

  it("provides direct navigation through the long insight page", async () => {
    renderPage();
    await screen.findByText("Total expenses");

    const nav = screen.getByRole("navigation", {
      name: "Expense insight sections",
    });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "#expense-overview",
    );
    expect(screen.getByRole("link", { name: "Categories" })).toHaveAttribute(
      "href",
      "#expense-categories",
    );
    expect(
      screen.queryByRole("link", { name: "Opportunities" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "#expense-review",
    );
  });

  it("omits resolved empty passive panels and lets Summary use the full review row", async () => {
    renderPage();
    await screen.findByText("Total expenses");

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Reduction opportunities" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Large expense flags" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Unusual expenses" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Findings to review" }),
      ).not.toBeInTheDocument();
    });

    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(document.getElementById("expense-review")).not.toHaveClass(
      "lg:grid-cols-2",
    );
  });

  it("keeps populated passive panels, with flags and unusual expenses side by side", async () => {
    const flagged = {
      id: 61,
      type: "expense",
      businessProfileId: profile.id,
      date: "2026-01-21T00:00:00.000Z",
      description: "Replacement compressor",
      amount: 9_000,
      categoryId: 1,
      categoryName: "Inventory",
      largeExpenseFlag: true,
      reviewStatus: "Needs Review",
      duplicateStatus: "Not Checked",
      source: "MANUAL_ENTRY",
    } as unknown as RecordItem;
    const finding = {
      id: 62,
      expenseRecordId: flagged.id,
      type: "AMOUNT_OUTLIER",
      severity: "HIGH",
      score: 3.4,
      title: "Compressor cost is higher than usual",
      reasons: ["Higher than recent equipment expenses"],
      status: "OPEN",
      detectedAt: "2026-01-21T00:00:00.000Z",
    } as AnomalyFinding;
    setOverview({
      ...behavior,
      unusualExpenses: [
        {
          id: 63,
          description: "Rush inventory delivery",
          amount: 6_000,
          date: "2026-01-22T00:00:00.000Z",
          categoryId: 1,
          categoryName: "Inventory",
          zScore: 3.1,
          categoryMean: 1_500,
          categoryStdDev: 900,
        },
      ],
    });
    handlers["/records/flagged"] = ok({ items: [flagged], nextCursor: null });
    handlers["/records/flagged/count"] = ok({
      expenses: 1,
      sales: 0,
      total: 1,
    });
    handlers["/insights/findings"] = ok({
      items: [finding],
      nextCursor: null,
    });

    renderPage();

    expect(await screen.findByText("Replacement compressor")).toBeInTheDocument();
    expect(screen.getByText("Rush inventory delivery")).toBeInTheDocument();
    expect(
      screen.getByText("Compressor cost is higher than usual"),
    ).toBeInTheDocument();
    // The summary now leads the page body; inside Review, flags and unusual
    // expenses share the two-column row.
    const review = document.getElementById("expense-review")!;
    expect(review.querySelector(".lg\\:grid-cols-2")).not.toBeNull();
    expect(
      within(review).getByRole("heading", { name: "Large expense flags" }),
    ).toBeInTheDocument();
    expect(
      within(review).getByRole("heading", { name: "Unusual expenses" }),
    ).toBeInTheDocument();
  });

  it("pages findings three at a time once there are more than three", async () => {
    const user = userEvent.setup();
    const findingsList = Array.from({ length: 7 }, (_, i) => ({
      id: 100 + i,
      expenseRecordId: 200 + i,
      type: "AMOUNT_OUTLIER",
      severity: "MEDIUM",
      score: 2,
      title: `Finding number ${i + 1}`,
      reasons: ["Higher than usual"],
      status: "OPEN",
      detectedAt: "2026-01-20T00:00:00.000Z",
    })) as AnomalyFinding[];
    handlers["/insights/findings"] = ok({ items: findingsList, nextCursor: null });
    renderPage();

    expect(await screen.findByText("Finding number 1")).toBeInTheDocument();
    expect(screen.getByText("Finding number 3")).toBeInTheDocument();
    expect(screen.queryByText("Finding number 4")).not.toBeInTheDocument();
    expect(
      screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "Showing 1–3 of 7 findings"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Rows")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Finding number 4")).toBeInTheDocument();
    expect(screen.queryByText("Finding number 1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Last page" }));
    expect(screen.getByText("Finding number 7")).toBeInTheDocument();
    expect(screen.queryByText("Finding number 6")).not.toBeInTheDocument();
  });

  it("does not page three or fewer findings", async () => {
    const findingsList = Array.from({ length: 3 }, (_, i) => ({
      id: 100 + i,
      expenseRecordId: 200 + i,
      type: "AMOUNT_OUTLIER",
      severity: "MEDIUM",
      score: 2,
      title: `Finding number ${i + 1}`,
      reasons: ["Higher than usual"],
      status: "OPEN",
      detectedAt: "2026-01-20T00:00:00.000Z",
    })) as AnomalyFinding[];
    handlers["/insights/findings"] = ok({ items: findingsList, nextCursor: null });
    renderPage();

    expect(await screen.findByText("Finding number 3")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
    expect(screen.queryByText(/findings$/)).not.toBeInTheDocument();
  });

  it("restores empty supplemental panels when a refresh fails", async () => {
    renderPage();
    await screen.findByText("Total expenses");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Large expense flags" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Findings to review" }),
      ).not.toBeInTheDocument();
    });

    handlers["/records/flagged"] = failing();
    handlers["/records/flagged/count"] = failing();
    handlers["/insights/findings"] = failing();
    await act(async () => {
      invalidateServerState({
        businessProfileId: profile.id,
        tags: ["records", "insights-findings"],
      });
      await Promise.resolve();
    });

    expect(
      await screen.findByText(/Showing recently loaded flagged record details/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Showing recently loaded finding details/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Large expense flags" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Findings to review" }),
    ).toBeInTheDocument();
  });

  it("keeps empty overview supplements visible while their refresh is stale", async () => {
    renderPage();
    await screen.findByText("Total expenses");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Reduction opportunities" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Unusual expenses" }),
      ).not.toBeInTheDocument();
    });

    handlers["/insights/expense-overview"] = failing();
    await act(async () => {
      invalidateServerState({
        businessProfileId: profile.id,
        resourcePrefix: "/insights/expense-overview",
      });
      await Promise.resolve();
    });

    expect(
      await screen.findByText("Expense insight couldn’t refresh"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reduction opportunities" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Unusual expenses" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/recently loaded opportunity data/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/recently loaded unusual-expense results/),
    ).toBeInTheDocument();
  });
});

/**
 * Reduction opportunities — plan §10.3 required states and §14.3 test list.
 */
describe("ExpenseInsight reduction opportunities", () => {
  it("shows a loading skeleton, then up to three ranked cards even when four are returned", async () => {
    // Controlled rather than timer-delayed: a transient loading node can be
    // returned by `findByText` and then detached before the following
    // assertion on a busy full-suite run. Holding the request pending proves
    // the state deterministically and makes the test independent of CPU load.
    let resolveOpportunities!: (value: unknown) => void;
    handlers["/insights/expense-overview"] = () =>
      new Promise((resolve) => {
        resolveOpportunities = resolve;
      });
    renderPage();

    expect(
      await screen.findByText("Loading expense insights…"),
    ).toBeInTheDocument();

    resolveOpportunities({
      data: detailOverview(
        { status: "available", data: behavior },
        {
          status: "available",
          data: reductionResponse({
            opportunities: [
              makeOpportunity({ id: "opp-1", categoryName: "Office Supplies" }),
              makeOpportunity({ id: "opp-2", categoryName: "Utilities" }),
              makeOpportunity({ id: "opp-3", categoryName: "Transport" }),
              makeOpportunity({ id: "opp-4", categoryName: "Marketing" }),
            ],
          }),
        },
      ),
    });

    expect(await screen.findByText("Office Supplies")).toBeInTheDocument();
    expect(screen.getByText("Utilities")).toBeInTheDocument();
    expect(screen.getByText("Transport")).toBeInTheDocument();
    // The fourth-ranked opportunity is capped client-side even though it came
    // back from the API — never trust the server as the only guarantee of 3.
    expect(screen.queryByText("Marketing")).not.toBeInTheDocument();
  });

  it("labels priority and confidence with visible text, not colour alone", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [
          makeOpportunity({ priority: "high", confidence: "limited" }),
        ],
      }),
    );
    renderPage();

    expect(await screen.findByText("High priority")).toBeInTheDocument();
    expect(screen.getByText("Limited confidence")).toBeInTheDocument();
  });

  it("renders evidence figures through the shared money formatter", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [
          makeOpportunity({
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
          }),
        ],
      }),
    );
    renderPage();

    // "PHP 7,654" is `formatMoney`'s exact output — asserting on it, not a
    // hand-rolled `toFixed`, is what proves the shared formatter was used.
    expect(await screen.findByText("PHP 7,654")).toBeInTheDocument();
  });

  it("links 'View related records' to the records list filtered by the opportunity's category", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [
          makeOpportunity({ categoryId: 5, categoryName: "Office Supplies" }),
        ],
      }),
    );
    renderPage();

    const link = await screen.findByRole("link", {
      name: /View related records/,
    });
    expect(link).toHaveAttribute("href", "/records?type=expense&categoryId=5");
  });

  it("opens Ask FinSight with the plan's worked question and the SELECTED opportunity's structured fields, scoped to Expense Insights", async () => {
    const opportunity = makeOpportunity({
      id: "opp-7",
      categoryId: 9,
      categoryName: "Office Supplies",
    });
    const other = makeOpportunity({
      id: "opp-8",
      categoryId: 10,
      categoryName: "Utilities",
    });
    setOpportunities(
      reductionResponse({ opportunities: [opportunity, other] }),
    );
    renderPage();

    const buttons = await screen.findAllByRole("button", {
      name: /Ask FinSight about this/,
    });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);

    expect(openChat).toHaveBeenCalledTimes(1);
    expect(openChat).toHaveBeenCalledWith(
      "Expense Insights",
      "Why was this reduction opportunity selected, and what should I check first?",
      opportunity,
    );
    // Not the other card's opportunity, and not a free-form prose summary.
    expect(openChat.mock.calls[0][2].id).toBe("opp-7");
  });

  it("omits the panel when the list is empty and history is sufficient", async () => {
    setOpportunities(
      reductionResponse({ opportunities: [] }),
    );
    renderPage();

    await screen.findByText("Total expenses");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Reduction opportunities" }),
      ).not.toBeInTheDocument();
    });
  });

  it("omits the panel when dataQuality says history is insufficient", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [],
        dataQuality: {
          status: "insufficient",
          currentRecordCount: 1,
          previousRecordCount: 0,
          message:
            "Record a few more expenses before FinSight can suggest anything here.",
        },
      }),
    );
    renderPage();

    await screen.findByText("Total expenses");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Reduction opportunities" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText(
        "Record a few more expenses before FinSight can suggest anything here.",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps a populated limited-data panel and its limitation message", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [makeOpportunity()],
        dataQuality: {
          status: "limited",
          currentRecordCount: 3,
          previousRecordCount: 1,
          message: "Suggestions are based on limited history.",
        },
      }),
    );
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Reduction opportunities" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Suggestions are based on limited history."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Opportunities" }),
    ).toHaveAttribute("href", "#expense-opportunities");
  });

  it("shows an API error with a retry action, and recovers on retry", async () => {
    handlers["/insights/expense-overview"] = ok(
      detailOverview(
        { status: "available", data: behavior },
        { status: "unavailable", data: null },
      ),
    );
    renderPage();

    expect(
      await screen.findByText(/Opportunities couldn’t load/),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });

    setOpportunities(
      reductionResponse({ opportunities: [makeOpportunity({ categoryName: "Office Supplies" })] }),
    );
    await userEvent.click(retry);

    expect(await screen.findByText("Office Supplies")).toBeInTheDocument();
    expect(
      screen.queryByText(/Opportunities couldn’t load/),
    ).not.toBeInTheDocument();
  });

  it("clears stale cards from the previous business profile on switch", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [makeOpportunity({ categoryName: "Office Supplies" })],
      }),
    );
    const { rerender } = renderPage();
    expect(await screen.findByText("Office Supplies")).toBeInTheDocument();

    // Switch profile: the page stays populated (a different category, so the
    // rest of the page keeps rendering normally), but the new profile's
    // overview response has no opportunity. The ONLY reason
    // "Office Supplies" could still be on screen afterwards is a stale card
    // that was never cleared when the switch happened.
    selectedProfile = profileB;
    setOverview({
      ...behavior,
      categoryTrends: [
        {
          categoryId: 2,
          categoryName: "Utilities",
          current: 4000,
          previous: 3000,
          direction: "up",
          change: 1000,
          percentChange: 33.3,
          recordCount: 2,
        },
      ],
      totals: { current: 4000, previous: 3000 },
    }, reductionResponse({ opportunities: [] }));

    rerender(
      <MemoryRouter>
        <ExpenseInsight />
      </MemoryRouter>,
    );

    // "Utilities" legitimately appears twice on a populated page (the "Highest
    // category" KPI and the category table), so this just confirms the page
    // finished re-rendering for the new profile rather than pinning a count.
    await waitFor(() =>
      expect(screen.getAllByText("Utilities").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("Office Supplies")).not.toBeInTheDocument();
  });
});

/**
 * Cost-behavior badge and caution note — plan §5.2/§10.2/§15 Phase 5.
 */
describe("ExpenseInsight reduction opportunities — cost behavior", () => {
  it("shows no cost-behavior badge or note for an unclassified category", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [makeOpportunity({ costBehavior: "unclassified" })],
      }),
    );
    renderPage();
    await screen.findByText("Office Supplies");

    expect(screen.queryByText("Fixed cost")).not.toBeInTheDocument();
    expect(screen.queryByText("Mixed cost")).not.toBeInTheDocument();
    expect(screen.queryByText(/Classified as a/)).not.toBeInTheDocument();
  });

  it("badges a fixed-cost category and adds a distinguishing caution note", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [makeOpportunity({ costBehavior: "fixed" })],
      }),
    );
    renderPage();

    expect(await screen.findByText("Fixed cost")).toBeInTheDocument();
    expect(screen.getByText(/Fixed cost: check the contract/)).toBeInTheDocument();
  });

  it("badges a mixed-cost category and adds its own distinguishing caution note", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [makeOpportunity({ costBehavior: "mixed" })],
      }),
    );
    renderPage();

    expect(await screen.findByText("Mixed cost")).toBeInTheDocument();
    expect(screen.getByText(/Mixed cost: part stays flat/)).toBeInTheDocument();
  });

  it("badges a variable-cost category with no extra caution note", async () => {
    setOpportunities(
      reductionResponse({
        opportunities: [makeOpportunity({ costBehavior: "variable" })],
      }),
    );
    renderPage();

    expect(await screen.findByText("Variable cost")).toBeInTheDocument();
    expect(screen.queryByText(/Classified as a/)).not.toBeInTheDocument();
  });
});

/**
 * Helpful / Not relevant feedback — plan §15 Phase 5.
 */
describe("ExpenseInsight reduction opportunities — feedback", () => {
  beforeEach(() => {
    setOpportunities(
      reductionResponse({
        opportunities: [
          makeOpportunity({ id: "opp-1", categoryName: "Office Supplies" }),
        ],
      }),
    );
  });

  it("posts 'helpful' feedback with the card's opportunityId and shows a confirmation", async () => {
    postHandlers["/insights/reduction-opportunities/feedback"] = () => ({
      data: {
        opportunityId: "opp-1",
        rating: "helpful",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    renderPage();

    const helpful = await screen.findByRole("button", { name: /Helpful/ });
    await userEvent.click(helpful);

    expect(
      await screen.findByText("Saved"),
    ).toBeInTheDocument();
    expect(helpful).toHaveAttribute("aria-pressed", "true");

    const call = postCalls.find(
      (c) => c.url === "/insights/reduction-opportunities/feedback",
    );
    expect(call?.body).toEqual({
      businessProfileId: profile.id,
      opportunityId: "opp-1",
      rating: "helpful",
    });
  });

  it("lets the owner change their answer from 'helpful' to 'not relevant'", async () => {
    postHandlers["/insights/reduction-opportunities/feedback"] = (body) => ({
      data: {
        opportunityId: "opp-1",
        rating: (body as { rating: string }).rating,
        createdAt: "2026-01-01",
      },
    });
    renderPage();

    const helpful = await screen.findByRole("button", { name: /Helpful/ });
    const notRelevant = screen.getByRole("button", { name: /Not relevant/ });

    await userEvent.click(helpful);
    await screen.findByText("Saved");
    expect(helpful).toHaveAttribute("aria-pressed", "true");

    // Changing the answer must not be blocked or treated as an error — the
    // backend upserts by (businessProfileId, opportunityId, userId).
    await userEvent.click(notRelevant);
    await waitFor(() =>
      expect(notRelevant).toHaveAttribute("aria-pressed", "true"),
    );
    expect(helpful).toHaveAttribute("aria-pressed", "false");

    const calls = postCalls.filter(
      (c) => c.url === "/insights/reduction-opportunities/feedback",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ rating: "not_relevant" });
  });
});

// jsdom does not implement <dialog>'s showModal()/close() (see Modal.tsx),
// so every test in this file that opens the simulation modal needs it
// stubbed the same way a real browser would behave — open just toggles the
// `open` attribute, which is all Modal.tsx's own effect relies on.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

function simulationResult(
  overrides: Partial<ReductionSimulation> = {},
): ReductionSimulation {
  return {
    categoryId: 3,
    categoryName: "Office Supplies",
    period: { days: 30, start: "2026-01-01", end: "2026-01-31" },
    categoryExpenses: { before: 7654, after: 6505.9 },
    totalExpenses: { before: 12000, after: 10851.9 },
    hypotheticalReduction: 1148.1,
    requestedReductionPercent: 15,
    assumptions: [
      "This is a hypothetical scenario for planning purposes only — no expense record is created, edited, or deleted.",
      "Available business funds are not changed by this simulation; recorded spending history is the only thing being recalculated.",
    ],
    ...overrides,
  };
}

/**
 * Simulate reduction — plan §12, Phase 4.
 */
/**
 * The page mounts one ReductionSimulationModal per opportunity row, and a
 * native <dialog> stays in the DOM while closed. Field queries therefore have
 * to be scoped to the one dialog that is open: a document-wide label query
 * finds a copy per row. (A fixed element id used to hide that by making every
 * label resolve to the first control — WEB-F01.)
 */
function openSimulationDialog(): HTMLElement {
  const open = document.querySelectorAll<HTMLElement>("dialog[open]");
  expect(open).toHaveLength(1);
  return open[0]!;
}

describe("ExpenseInsight simulate reduction", () => {
  beforeEach(() => {
    setOpportunities(
      reductionResponse({
        opportunities: [
          makeOpportunity({
            id: "opp-1",
            categoryId: 3,
            categoryName: "Office Supplies",
          }),
          makeOpportunity({
            id: "opp-2",
            categoryId: 4,
            categoryName: "Utilities",
          }),
        ],
      }),
    );
  });

  it("opens the modal scoped to the card it was launched from", async () => {
    renderPage();
    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[1]); // the Utilities card

    expect(
      await screen.findByRole("heading", {
        name: "Simulate reduction — Utilities",
      }),
    ).toBeInTheDocument();
    // Not the other card's modal.
    expect(
      screen.queryByRole("heading", {
        name: "Simulate reduction — Office Supplies",
      }),
    ).not.toBeInTheDocument();
  });

  it("submits a valid percent reduction and shows the result, including assumptions", async () => {
    postHandlers["/insights/reduction-simulation"] = () => ({
      data: simulationResult(),
    });
    renderPage();

    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    await userEvent.click(buttons[0]);
    await screen.findByRole("heading", {
      name: "Simulate reduction — Office Supplies",
    });

    await userEvent.type(within(openSimulationDialog()).getByLabelText(/Reduction percentage/), "15");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));

    expect(
      await screen.findByText(/Hypothetical reduction/),
    ).toBeInTheDocument();
    // Before/after figures from the response, not recomputed client-side.
    expect(screen.getByText("PHP 7,654.00")).toBeInTheDocument();
    expect(screen.getByText("PHP 6,505.90")).toBeInTheDocument();
    expect(screen.getByText("PHP 12,000.00")).toBeInTheDocument();
    expect(screen.getByText("PHP 10,851.90")).toBeInTheDocument();
    // The assumptions the server sent back, surfaced verbatim.
    expect(
      screen.getByText(
        /This is a hypothetical scenario for planning purposes only/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Available business funds are not changed by this simulation/,
      ),
    ).toBeInTheDocument();

    const call = postCalls.find(
      (c) => c.url === "/insights/reduction-simulation",
    );
    // The simulation asks about the same period the cards were computed for:
    // the newest month with records, which the page opens on.
    expect(call?.body).toMatchObject({
      businessProfileId: profile.id,
      categoryId: 3,
      period: "month",
      month: "2026-09",
      reduction: { kind: "percent", value: 15 },
    });
    expect(call?.body).not.toHaveProperty("periodDays");
  });

  it("submits a valid peso-amount reduction", async () => {
    postHandlers["/insights/reduction-simulation"] = () => ({
      data: simulationResult({ requestedReductionPercent: 6.5 }),
    });
    renderPage();

    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    await userEvent.click(buttons[0]);
    await screen.findByRole("heading", {
      name: "Simulate reduction — Office Supplies",
    });

    await userEvent.click(screen.getByRole("radio", { name: "Peso amount" }));
    await userEvent.type(within(openSimulationDialog()).getByLabelText(/Reduction amount/), "500");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));

    expect(
      await screen.findByText(/Hypothetical reduction/),
    ).toBeInTheDocument();
    const call = postCalls.find(
      (c) => c.url === "/insights/reduction-simulation",
    );
    expect(call?.body).toMatchObject({
      reduction: { kind: "amount", value: 500 },
    });
  });

  it("rejects an out-of-range percent client-side, without a round trip", async () => {
    renderPage();
    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    await userEvent.click(buttons[0]);
    await screen.findByRole("heading", {
      name: "Simulate reduction — Office Supplies",
    });

    await userEvent.type(within(openSimulationDialog()).getByLabelText(/Reduction percentage/), "150");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));

    expect(
      await screen.findByText(
        "Enter a percentage greater than 0 and no greater than 100.",
      ),
    ).toBeInTheDocument();
    expect(
      postCalls.find((c) => c.url === "/insights/reduction-simulation"),
    ).toBeUndefined();
  });

  it("rejects a peso amount above the category's period baseline client-side", async () => {
    // The card's own evidence.currentAmount is 7654 (see makeOpportunity).
    renderPage();
    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    await userEvent.click(buttons[0]);
    await screen.findByRole("heading", {
      name: "Simulate reduction — Office Supplies",
    });

    await userEvent.click(screen.getByRole("radio", { name: "Peso amount" }));
    await userEvent.type(within(openSimulationDialog()).getByLabelText(/Reduction amount/), "999999");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));

    expect(
      await screen.findByText(
        /Enter an amount up to the category's period total/,
      ),
    ).toBeInTheDocument();
    expect(
      postCalls.find((c) => c.url === "/insights/reduction-simulation"),
    ).toBeUndefined();
  });

  it("shows the server's validation message on a 400, e.g. a zero-baseline category", async () => {
    postHandlers["/insights/reduction-simulation"] = () => {
      throw new Error(
        "Request failed with status code 400: No expenses were recorded for this category in the selected period, so a reduction cannot be simulated.",
      );
    };
    renderPage();

    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    await userEvent.click(buttons[0]);
    await screen.findByRole("heading", {
      name: "Simulate reduction — Office Supplies",
    });

    await userEvent.type(within(openSimulationDialog()).getByLabelText(/Reduction percentage/), "10");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));

    expect(
      await screen.findByText(
        /No expenses were recorded for this category in the selected period/,
      ),
    ).toBeInTheDocument();
  });

  it("never references availableFunds anywhere in the simulation UI or its request payload", async () => {
    postHandlers["/insights/reduction-simulation"] = () => ({
      data: simulationResult(),
    });
    renderPage();

    const buttons = await screen.findAllByRole("button", {
      name: /Simulate reduction/,
    });
    await userEvent.click(buttons[0]);
    await screen.findByRole("heading", {
      name: "Simulate reduction — Office Supplies",
    });

    await userEvent.type(within(openSimulationDialog()).getByLabelText(/Reduction percentage/), "15");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    await screen.findByText(/Hypothetical reduction/);

    const call = postCalls.find(
      (c) => c.url === "/insights/reduction-simulation",
    );
    expect(JSON.stringify(call?.body)).not.toMatch(/availableFunds/i);

    // Scoped to the modal itself — the REST of this page legitimately shows
    // a "Share of available funds" KPI tile, so asserting on the whole
    // document would be a false positive for the thing this test exists to
    // catch: this simulation UI misrepresenting itself as touching funds.
    const dialog = screen.getByRole("dialog", {
      name: "Simulate reduction — Office Supplies",
    });
    expect(dialog.textContent).not.toMatch(/available funds/i);
  });
});

describe("ExpenseInsight period filter", () => {
  it("opens on the newest month with one scoped overview request", async () => {
    renderPage();
    await screen.findByText("Total spent");
    const periodCalls = getCalls.filter((call) => call.url === "/insights/expense-overview");
    expect(periodCalls).toHaveLength(1);
    expect(periodCalls[0]?.params).toMatchObject({
      businessProfileId: profile.id,
      period: "month",
      month: "2026-09",
      view: "detail",
    });
    expect(periodCalls[0]?.params).not.toHaveProperty("periodDays");
    expect(getCalls.some((call) => call.url === "/insights/expense-behavior")).toBe(false);
    expect(getCalls.some((call) => call.url === "/insights/reduction-opportunities")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Month" })).toHaveTextContent("September 2026");
  });

  it("offers This week and Month without an All time entry point", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total spent");
    expect(screen.getByRole("button", { name: "This week" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Month" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All time" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => {
      expect(getCalls.filter((call) => call.url === "/insights/expense-overview").at(-1)!.params).toMatchObject({
        period: "week",
        view: "detail",
      });
    });
  });

  it("defaults to its own recorded month without replacing another page's All time choice", async () => {
    window.sessionStorage.setItem(
      "finsight.reportingPeriod.1",
      JSON.stringify({ kind: "all" }),
    );

    renderPage();
    await screen.findByText("Total spent");

    const periodCalls = getCalls.filter((call) => call.url === "/insights/expense-overview");
    expect(periodCalls).toHaveLength(1);
    expect(periodCalls[0]?.params).toMatchObject({
      period: "month",
      month: "2026-09",
      view: "detail",
    });
    expect(screen.getByRole("combobox", { name: "Month" })).toHaveTextContent("September 2026");
    expect(screen.queryByRole("button", { name: "All time" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(JSON.parse(window.sessionStorage.getItem("finsight.reportingPeriod.1")!)).toEqual({
        kind: "all",
      });
    });
  });

  it("does not offer All time from the no-expenses state", async () => {
    setOverview({
      ...behavior,
      totals: { current: 0, previous: 0 },
      dailyTotals: [],
      categoryTrends: [],
      latestExpenseDate: "2026-08-15T00:00:00.000Z",
    });

    renderPage();
    expect(await screen.findByText("No expenses in September 2026")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All time" })).not.toBeInTheDocument();
  });

  it("still loads a selected month after switching away from This week", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Total spent");

    await user.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => {
      expect(getCalls.filter((call) => call.url === "/insights/expense-overview").at(-1)!.params).toMatchObject({
        period: "week",
      });
    });
    await user.click(screen.getByRole("combobox", { name: "Month" }));
    await user.click(screen.getByRole("option", { name: "August 2026" }));
    await waitFor(() => {
      expect(getCalls.filter((call) => call.url === "/insights/expense-overview").at(-1)!.params).toMatchObject({
        period: "month",
        month: "2026-08",
        view: "detail",
      });
    });
  });

  it("never paints a late month response after switching to This week", async () => {
    const user = userEvent.setup();
    let releaseMonth!: (value: unknown) => void;
    const monthRequest = new Promise((resolve) => {
      releaseMonth = resolve;
    });
    const weekBehavior: ExpenseBehavior = {
      ...behavior,
      categoryTrends: [{
        ...behavior.categoryTrends[0],
        categoryName: "This-week travel",
        current: 2_000,
        previous: 1_000,
      }],
    };
    handlers["/insights/expense-overview"] = (config) =>
      config?.params?.period === "week"
        ? { data: detailOverview(
            { status: "available", data: weekBehavior },
            { status: "available", data: reductionResponse({ opportunities: [] }) },
          ) }
        : monthRequest;

    renderPage();
    await user.click(screen.getByRole("button", { name: "This week" }));
    expect(await screen.findAllByText("This-week travel")).not.toHaveLength(0);

    await act(async () => {
      releaseMonth({ data: detailOverview() });
      await monthRequest;
    });
    expect(screen.queryByText("Inventory")).not.toBeInTheDocument();
    expect(screen.getAllByText("This-week travel").length).toBeGreaterThan(0);
  });
});

describe("ExpenseInsight long-data previews", () => {
  function highVolumeBehavior(): ExpenseBehavior {
    return {
      ...behavior,
      totals: { current: 12_000, previous: 9_000 },
      categoryTrends: Array.from({ length: 12 }, (_, index) => ({
        ...behavior.categoryTrends[0],
        categoryId: index + 1,
        categoryName: `Category ${index + 1}`,
        current: 1_000,
        previous: 750,
        change: 250,
        recordCount: 4,
      })),
      unusualExpenses: Array.from({ length: 13 }, (_, index) => ({
        id: index + 1,
        description: `Unusual purchase ${index + 1}`,
        amount: 900,
        date: "2026-09-20T00:00:00.000Z",
        categoryId: 1,
        categoryName: "Category 1",
        zScore: 3,
        categoryMean: 300,
        categoryStdDev: 200,
      })),
    };
  }

  function panel(title: string) {
    return screen.getByRole("heading", { name: title }).parentElement!.parentElement!.parentElement!;
  }

  it("limits categories while retaining totals for every category and allows full inspection", async () => {
    const user = userEvent.setup();
    setOverview(highVolumeBehavior());
    renderPage();
    await screen.findByRole("heading", { name: "Category summary" });
    const summary = within(panel("Category summary"));
    expect(summary.queryByText("Category 7")).not.toBeInTheDocument();
    const totalRow = summary.getByRole("row", { name: /^Total / });
    expect(within(totalRow).getByText("PHP 12,000")).toBeInTheDocument();
    expect(within(totalRow).getByText("48")).toBeInTheDocument();
    expect(summary.getByText("Showing 6 of 12 categories")).toBeInTheDocument();
    await user.click(summary.getByRole("button", { name: "Show all 12 categories" }));
    expect(summary.getAllByText("Category 12").length).toBeGreaterThan(0);
    expect(within(totalRow).getByText("PHP 12,000")).toBeInTheDocument();
    await user.click(summary.getByRole("button", { name: "Show less" }));
    expect(summary.queryByText("Category 7")).not.toBeInTheDocument();
  });

  it("exposes every unusual expense without changing the full flagged count", async () => {
    const user = userEvent.setup();
    setOverview(highVolumeBehavior());
    renderPage();
    await screen.findByRole("heading", { name: "Unusual expenses" });
    const unusual = within(panel("Unusual expenses"));
    expect(unusual.getByText("13 flagged")).toBeInTheDocument();
    expect(unusual.getByText("Unusual purchase 5")).toBeInTheDocument();
    expect(unusual.queryByText("Unusual purchase 6")).not.toBeInTheDocument();
    await user.click(unusual.getByRole("button", { name: "Show all 13 unusual expenses" }));
    expect(unusual.getByText("Unusual purchase 13")).toBeInTheDocument();
    expect(unusual.getByText("13 flagged")).toBeInTheDocument();
    await user.click(unusual.getByRole("button", { name: "Show less" }));
    expect(unusual.queryByText("Unusual purchase 6")).not.toBeInTheDocument();
  });

  it("resets expanded expense previews when the reporting period changes", async () => {
    const user = userEvent.setup();
    setOverview(highVolumeBehavior());
    renderPage();
    await screen.findByRole("heading", { name: "Unusual expenses" });
    await user.click(within(panel("Unusual expenses")).getByRole("button", { name: "Show all 13 unusual expenses" }));
    await user.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => expect(within(panel("Unusual expenses")).queryByText("Unusual purchase 6")).not.toBeInTheDocument());
    await user.click(screen.getByRole("combobox", { name: "Month" }));
    await user.click(screen.getByRole("option", { name: "September 2026" }));
    await waitFor(() => expect(within(panel("Unusual expenses")).getByRole("button", { name: "Show all 13 unusual expenses" })).toHaveAttribute("aria-expanded", "false"));
  });

  it("reveals reduction opportunities beyond the preview and keeps their actions available", async () => {
    const user = userEvent.setup();
    setOverview(behavior, reductionResponse({
      opportunities: Array.from({ length: 6 }, (_, index) => makeOpportunity({
        id: `opp-${index + 1}`,
        categoryId: index + 1,
        categoryName: `Opportunity category ${index + 1}`,
      })),
    }));
    renderPage();
    const expand = await screen.findByRole("button", { name: "Show all 6 opportunities" });
    expect(screen.queryByText("Opportunity category 4")).not.toBeInTheDocument();
    await user.click(expand);
    expect(screen.getByText("Opportunity category 6")).toBeInTheDocument();
    const simulations = screen.getAllByRole("button", { name: /Simulate reduction/ });
    expect(simulations).toHaveLength(6);
    await user.click(simulations[5]);
    expect(await screen.findByRole("heading", { name: "Simulate reduction — Opportunity category 6" })).toBeInTheDocument();
  });
});

it('binds the expense-insight view to its own reporting period scope', () => {
  const wrapper = ExpenseInsight();
  expect(wrapper.props.scope).toBe('expense-insight');
  expect(typeof wrapper.props.children.type).toBe('function');
});

describe("ExpenseInsight opening on the navigation's warm-up", () => {
  afterEach(() => endServerStateSession());

  it("reads the overview the nav link started, instead of asking again", async () => {
    beginServerStateSession(17);
    const warmed = routeDataRequests("/insights/expense-behavior", profile.id, ["2026-09", "2026-08"], "ready");
    expect(warmed.map((request) => request.url)).toEqual(["/insights/expense-overview"]);
    await Promise.all(warmed.map((request) => cachedApiGet(request.url, { params: request.params }, request.scope)));

    renderPage();

    await screen.findByText("Share of recorded available funds", undefined, { timeout: 10_000 });
    await waitFor(() => expect(getCalls.some((call) => call.url === "/records/flagged")).toBe(true));
    // A key that differed in any field would have sent a second overview here.
    expect(getCalls.filter((call) => call.url === "/insights/expense-overview")).toHaveLength(1);
  }, 20_000);

  it("waits for the month list before guessing a month", () => {
    expect(routeDataRequests("/insights/expense-behavior", profile.id, [], "loading")).toEqual([]);
  });
});
