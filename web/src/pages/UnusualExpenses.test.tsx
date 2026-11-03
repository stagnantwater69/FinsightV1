// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UnusualExpensesPage } from "./UnusualExpenses";
import type { BusinessProfile, ExpenseBehavior } from "../lib/types";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";

const profile = { id: 1, name: "Burger stall" } as unknown as BusinessProfile;

let overviewResponse: unknown;
let failOverview = false;
const overviewCalls: Record<string, unknown>[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === "/records/months") return { data: { months: ["2026-10", "2026-09"] } };
      if (url === "/insights/expense-overview") {
        overviewCalls.push(config?.params ?? {});
        if (failOverview) throw new Error("network down");
        return { data: overviewResponse };
      }
      throw new Error(`unmocked GET ${url}`);
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

function behavior(count: number): ExpenseBehavior {
  return {
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-31T00:00:00.000Z",
    previousPeriodStart: "2026-09-01T00:00:00.000Z",
    previousPeriodEnd: "2026-09-30T00:00:00.000Z",
    periodDays: 31,
    totals: { current: 12_000, previous: 9_000 },
    dailyTotals: [],
    categoryTrends: [],
    unusualExpenses: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      description: `Unusual purchase ${index + 1}`,
      amount: 1_200,
      date: "2026-10-10T00:00:00.000Z",
      categoryId: 1,
      categoryName: "Raw Materials",
      zScore: 3,
      categoryMean: 400,
      categoryStdDev: 200,
    })),
    insufficientHistoryCategories: [{ categoryId: 2, categoryName: "Internet", historyCount: 1 }],
    latestExpenseDate: "2026-10-20T00:00:00.000Z",
  } as ExpenseBehavior;
}

function overview(count: number) {
  return {
    view: "detail",
    behavior: { status: "available", data: behavior(count) },
    opportunities: { status: "unavailable" },
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/insights/expense-behavior/unusual"]}>
      <UnusualExpensesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  beginServerStateSession("unusual-expenses-test");
  overviewCalls.length = 0;
  failOverview = false;
  overviewResponse = overview(13);
});

afterEach(() => endServerStateSession());

describe("Unusual expenses subpage", () => {
  it("lists every unusual expense from the detail overview, not just the preview", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "13 unusual expenses" })).toBeInTheDocument();
    expect(screen.getByText("Unusual purchase 1")).toBeInTheDocument();
    expect(screen.getByText("Unusual purchase 13")).toBeInTheDocument();
    expect(screen.getAllByText("3.0× usual")).toHaveLength(13);
    expect(screen.getByText(/Not enough history to check:/)).toHaveTextContent("Internet");
    expect(overviewCalls[0]).toMatchObject({ businessProfileId: 1, view: "detail" });
  });

  it("links back to the review section of Expense insight", async () => {
    renderPage();
    await screen.findByText("Unusual purchase 1");
    expect(screen.getAllByRole("link", { name: /Back to Expense insight/ })[0]).toHaveAttribute(
      "href",
      "/insights/expense-behavior#expense-review",
    );
  });

  it("says plainly when nothing in the period was unusual", async () => {
    overviewResponse = overview(0);
    renderPage();
    expect(await screen.findByText("Nothing unusual")).toBeInTheDocument();
  });

  it("offers a retry when the overview cannot load", async () => {
    failOverview = true;
    renderPage();
    expect(await screen.findByText(/Unusual expenses couldn.t load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
