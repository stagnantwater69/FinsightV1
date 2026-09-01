// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ExpenseInsight } from "./ExpenseInsight";
import type {
  BusinessProfile,
  ExpenseBehavior,
  ReductionOpportunity,
  ReductionOpportunityResponse,
  ReductionSimulation,
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

const profileB = {
  id: 2,
  name: "Second store",
  availableFunds: 80000,
  expectedMonthlyExpenses: 30000,
  largeExpenseThresholdPercent: 20,
} as unknown as BusinessProfile;

/** Mutable so a test can simulate switching business profiles mid-render. */
let selectedProfile: BusinessProfile = profile;

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
let handlers: Record<string, () => unknown>;

function ok<T>(data: T) {
  return () => ({ data });
}

function failing() {
  return () => {
    throw new Error("Request failed with status code 404");
  };
}

/**
 * POST payloads captured by URL, for the reduction-simulation tests below —
 * asserting on what the CLIENT sent, not just what it rendered afterwards.
 */
let postCalls: { url: string; body: unknown }[];
let postHandlers: Record<string, (body: unknown) => unknown>;

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      const handler = handlers[url];
      if (!handler) throw new Error(`unmocked GET ${url}`);
      return handler();
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

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedProfile }),
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
  openChat.mockClear();
  postCalls = [];
  postHandlers = {};
  handlers = {
    "/insights/expense-behavior": ok(behavior),
    "/records/flagged": ok([]),
    "/insights/findings": ok({ items: [], nextCursor: null }),
    "/insights/recurring-patterns": ok([candidate]),
    "/insights/recurring-schedules": ok([schedule]),
    "/insights/reduction-opportunities": ok(
      reductionResponse({ opportunities: [] }),
    ),
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

    expect(
      screen.queryByText("Payments you asked FinSight to watch"),
    ).not.toBeInTheDocument();
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
    renderPage();

    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
    expect(screen.getByText("No findings need review")).toBeInTheDocument();
  });

  it("surfaces a recoverable error when the CORE read fails", async () => {
    // The one failure that genuinely leaves nothing to show.
    handlers["/insights/expense-behavior"] = failing();
    renderPage();

    expect(await screen.findByText(/status code 404/)).toBeInTheDocument();
    expect(screen.queryByText("Total expenses")).not.toBeInTheDocument();

    handlers["/insights/expense-behavior"] = ok(behavior);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Total expenses")).toBeInTheDocument();
    expect(screen.queryByText(/status code 404/)).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Opportunities" })).toHaveAttribute(
      "href",
      "#expense-opportunities",
    );
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "#expense-review",
    );
  });
});

/**
 * Reduction opportunities — plan §10.3 required states and §14.3 test list.
 */
describe("ExpenseInsight reduction opportunities", () => {
  it("shows a loading skeleton, then up to three ranked cards even when four are returned", async () => {
    // Delayed on purpose: the core expense-behavior read resolves on the next
    // microtask, so the page leaves ITS OWN initial full-page skeleton before
    // this panel's fetch (still pending) has a chance to render its own.
    handlers["/insights/reduction-opportunities"] = () =>
      new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              data: reductionResponse({
                opportunities: [
                  makeOpportunity({
                    id: "opp-1",
                    categoryName: "Office Supplies",
                  }),
                  makeOpportunity({ id: "opp-2", categoryName: "Utilities" }),
                  makeOpportunity({ id: "opp-3", categoryName: "Transport" }),
                  makeOpportunity({ id: "opp-4", categoryName: "Marketing" }),
                ],
              }),
            }),
          // Comfortably longer than the core expense-behavior fetch (a
          // same-tick microtask) can possibly take to resolve, even under a
          // busy CPU running the full suite in parallel — otherwise this can
          // race and skip the loading state entirely under load.
          150,
        );
      });
    renderPage();

    expect(
      await screen.findByText("Loading reduction opportunities…"),
    ).toBeInTheDocument();

    expect(await screen.findByText("Office Supplies")).toBeInTheDocument();
    expect(screen.getByText("Utilities")).toBeInTheDocument();
    expect(screen.getByText("Transport")).toBeInTheDocument();
    // The fourth-ranked opportunity is capped client-side even though it came
    // back from the API — never trust the server as the only guarantee of 3.
    expect(screen.queryByText("Marketing")).not.toBeInTheDocument();
  });

  it("labels priority and confidence with visible text, not colour alone", async () => {
    handlers["/insights/reduction-opportunities"] = ok(
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
    handlers["/insights/reduction-opportunities"] = ok(
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
    handlers["/insights/reduction-opportunities"] = ok(
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
    handlers["/insights/reduction-opportunities"] = ok(
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

  it("shows a 'no material opportunities found' state when the list is empty but history is sufficient", async () => {
    handlers["/insights/reduction-opportunities"] = ok(
      reductionResponse({ opportunities: [] }),
    );
    renderPage();

    expect(
      await screen.findByText("No material opportunities found"),
    ).toBeInTheDocument();
  });

  it("shows the insufficient-history message from dataQuality instead of any cards", async () => {
    handlers["/insights/reduction-opportunities"] = ok(
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

    expect(
      await screen.findByText(
        "Record a few more expenses before FinSight can suggest anything here.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No material opportunities found"),
    ).not.toBeInTheDocument();
  });

  it("shows an API error with a retry action, and recovers on retry", async () => {
    handlers["/insights/reduction-opportunities"] = failing();
    renderPage();

    expect(
      await screen.findByText(/Couldn't load reduction opportunities/),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });

    handlers["/insights/reduction-opportunities"] = ok(
      reductionResponse({
        opportunities: [makeOpportunity({ categoryName: "Office Supplies" })],
      }),
    );
    await userEvent.click(retry);

    expect(await screen.findByText("Office Supplies")).toBeInTheDocument();
    expect(
      screen.queryByText(/Couldn't load reduction opportunities/),
    ).not.toBeInTheDocument();
  });

  it("clears stale cards from the previous business profile on switch", async () => {
    handlers["/insights/reduction-opportunities"] = ok(
      reductionResponse({
        opportunities: [makeOpportunity({ categoryName: "Office Supplies" })],
      }),
    );
    const { rerender } = renderPage();
    expect(await screen.findByText("Office Supplies")).toBeInTheDocument();

    // Switch profile: the page stays populated (a different category, so the
    // rest of the page keeps rendering normally), but the new profile's
    // reduction-opportunities request is left unmocked. The ONLY reason
    // "Office Supplies" could still be on screen afterwards is a stale card
    // that was never cleared when the switch happened.
    selectedProfile = profileB;
    delete handlers["/insights/reduction-opportunities"];
    handlers["/insights/expense-behavior"] = ok({
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
    });

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
    handlers["/insights/reduction-opportunities"] = ok(
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
    handlers["/insights/reduction-opportunities"] = ok(
      reductionResponse({
        opportunities: [makeOpportunity({ costBehavior: "fixed" })],
      }),
    );
    renderPage();

    expect(await screen.findByText("Fixed cost")).toBeInTheDocument();
    expect(screen.getByText(/Classified as a fixed cost/)).toBeInTheDocument();
  });

  it("badges a mixed-cost category and adds its own distinguishing caution note", async () => {
    handlers["/insights/reduction-opportunities"] = ok(
      reductionResponse({
        opportunities: [makeOpportunity({ costBehavior: "mixed" })],
      }),
    );
    renderPage();

    expect(await screen.findByText("Mixed cost")).toBeInTheDocument();
    expect(screen.getByText(/Classified as a mixed cost/)).toBeInTheDocument();
  });

  it("badges a variable-cost category with no extra caution note", async () => {
    handlers["/insights/reduction-opportunities"] = ok(
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
    handlers["/insights/reduction-opportunities"] = ok(
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
      await screen.findByText("Thanks for the feedback."),
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
    await screen.findByText("Thanks for the feedback.");
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
describe("ExpenseInsight simulate reduction", () => {
  beforeEach(() => {
    handlers["/insights/reduction-opportunities"] = ok(
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

    await userEvent.type(screen.getByLabelText(/Reduction percentage/), "15");
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
    expect(call?.body).toMatchObject({
      businessProfileId: profile.id,
      categoryId: 3,
      periodDays: 30,
      reduction: { kind: "percent", value: 15 },
    });
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
    await userEvent.type(screen.getByLabelText(/Reduction amount/), "500");
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

    await userEvent.type(screen.getByLabelText(/Reduction percentage/), "150");
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
    await userEvent.type(screen.getByLabelText(/Reduction amount/), "999999");
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

    await userEvent.type(screen.getByLabelText(/Reduction percentage/), "10");
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

    await userEvent.type(screen.getByLabelText(/Reduction percentage/), "15");
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
