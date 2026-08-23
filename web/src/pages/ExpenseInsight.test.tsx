// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ExpenseInsight } from "./ExpenseInsight";
import type {
  BusinessProfile,
  ExpenseBehavior,
  RecurringPattern,
  RecurringSchedule,
} from "../lib/types";

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * `load()` once awaited five endpoints in one `Promise.all`. `Promise.all`
 * rejects the moment ANY member rejects and discards the responses that already
 * arrived — so when `/insights/recurring-schedules` went dark behind its server
 * feature flag (404 by design, so an unshipped feature is not advertised), the
 * whole page collapsed to an error banner: no KPI row, no charts, no category
 * table, no flags. An optional panel at the bottom of the page destroyed
 * everything above it.
 *
 * The tests below are written against BEHAVIOUR, not against status codes: each
 * failing endpoint is a plain rejection, exactly what a transient network drop
 * or a 500 also looks like from the client. If someone re-bundles the fetches,
 * the first test here fails.
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

/** Per-URL responses. A handler that throws stands for ANY failure — 404 from
 *  the feature gate, 500, or the request never leaving the device. */
let handlers: Record<string, () => unknown>;

function ok<T>(data: T) {
  return () => ({ data });
}

function failing() {
  return () => {
    throw new Error("Request failed with status code 404");
  };
}

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      const handler = handlers[url];
      if (!handler) throw new Error(`unmocked GET ${url}`);
      return handler();
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }] }),
}));

// Recharts measures its container, which jsdom reports as 0×0 — the charts
// render nothing useful here and are covered by their own tests. Stubbed so
// this file is about the load path, not about SVG.
vi.mock("../components/DonutChart", () => ({ DonutChart: () => null }));
vi.mock("../components/CategoryComparisonChart", () => ({ CategoryComparisonChart: () => null }));
vi.mock("../components/DailySpendChart", () => ({ DailySpendChart: () => null }));
vi.mock("../components/AskFinSightButton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/AskFinSightButton")>()),
  AskFinSightButton: () => null,
}));
// The page's "expand on this" link reaches Ask FinSight through the provider in
// the authenticated layout, which this file does not mount.
vi.mock("../context/AiChatContext", () => ({ useAiChat: () => ({ openChat: () => {} }) }));

function renderPage() {
  return render(
    <MemoryRouter>
      <ExpenseInsight />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  handlers = {
    "/insights/expense-behavior": ok(behavior),
    "/records/flagged": ok([]),
    "/insights/findings": ok({ items: [], nextCursor: null }),
    "/insights/recurring-patterns": ok([candidate]),
    "/insights/recurring-schedules": ok([schedule]),
  };
});

describe("ExpenseInsight resilience", () => {
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
  });

  it("hides the recurring agenda entirely rather than claiming nothing is scheduled", async () => {
    handlers["/insights/recurring-schedules"] = failing();
    renderPage();
    await screen.findByText("Total expenses");

    expect(screen.queryByText("Payments you asked FinSight to watch")).not.toBeInTheDocument();
    // The empty state would be a statement about the owner's business that we
    // have no evidence for — the difference between "none" and "cannot see".
    expect(screen.queryByText("Nothing scheduled yet")).not.toBeInTheDocument();
  });

  it("keeps the candidates panel working when only the schedules request fails", async () => {
    handlers["/insights/recurring-schedules"] = failing();
    renderPage();

    // /insights/recurring-patterns is ungated and answered; the two must not
    // fail together.
    expect(await screen.findByText("Does this repeat?")).toBeInTheDocument();
    expect(screen.getByText("Warehouse rent")).toBeInTheDocument();
    // Confirming creates a schedule and is behind the same gate, so the button
    // is not offered rather than offered-and-broken.
    expect(screen.queryByRole("button", { name: /Watch this/ })).not.toBeInTheDocument();
    // Dismissing is a different, ungated endpoint and stays available.
    expect(screen.getByRole("button", { name: /Not recurring/ })).toBeInTheDocument();
  });

  it("shows the agenda and the confirm action when schedules are available", async () => {
    renderPage();
    expect(await screen.findByText("Payments you asked FinSight to watch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Watch this/ })).toBeInTheDocument();
  });

  it("survives an unrelated supplementary failure the same way", async () => {
    // Not a feature flag and not a 404 — the point of the restructure is that
    // the page does not care which supplement failed or why.
    handlers["/insights/findings"] = failing();
    handlers["/records/flagged"] = failing();
    renderPage();

    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
    expect(screen.getByText("No findings need review")).toBeInTheDocument();
  });

  it("still surfaces an error when the CORE read fails", async () => {
    // The one failure that genuinely leaves nothing to show.
    handlers["/insights/expense-behavior"] = failing();
    renderPage();

    expect(await screen.findByText(/status code 404/)).toBeInTheDocument();
    expect(screen.queryByText("Total expenses")).not.toBeInTheDocument();
  });
});
