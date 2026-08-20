// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { FlaggedRecords } from "./FlaggedRecords";
import type { AnomalyFinding, BusinessProfile, RecordItem } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS.
 *
 * The queue is a merge of two sources that used to be separate screens. Three
 * things can silently break it, and all three are user-visible mistakes about
 * someone's books:
 *
 *   1. the same record appearing twice, with two sets of buttons;
 *   2. a filter chip hiding something it shouldn't, or claiming a count it
 *      can't show;
 *   3. a feedback value being unreachable — the previous UI could only ever
 *      produce two of the five, so three of the labels the evaluation harness
 *      measures precision against were dead letters.
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
  largeExpenseThresholdPercent: 20,
} as unknown as BusinessProfile;

function record(over: Partial<RecordItem> = {}): RecordItem {
  return {
    id: 1,
    type: "expense",
    businessProfileId: 1,
    duplicateOfRecordId: null,
    date: "2026-03-04T00:00:00.000Z",
    description: "Rice sack",
    amount: 2400,
    source: "MANUAL_ENTRY",
    reviewStatus: "Needs Review",
    duplicateStatus: "Not Checked",
    createdAt: "2026-03-04T00:00:00.000Z",
    ...over,
  } as RecordItem;
}

const outlier: AnomalyFinding = {
  id: 10,
  expenseRecordId: 1,
  type: "AMOUNT_OUTLIER",
  severity: "HIGH",
  score: 0.91,
  title: "Unusually large Inventory expense",
  reasons: ["PHP 2,400 is about 4x your usual Inventory expense."],
  status: "OPEN",
  detectedAt: "2026-03-05T00:00:00.000Z",
  method: "zscore-iqr",
  detectorVersion: "amount-outlier-v2",
  metadata: { categoryMean: 600, historyCount: 12 },
};

let getHandlers: Record<string, () => unknown>;
const patched: { url: string; body: unknown }[] = [];

function ok<T>(data: T) {
  return () => ({ data });
}

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      const handler = getHandlers[url];
      if (!handler) throw new Error(`unmocked GET ${url}`);
      return handler();
    },
    post: async () => ({ data: { resolved: 0 } }),
    patch: async (url: string, body: unknown) => {
      patched.push({ url, body });
      return { data: {} };
    },
    delete: async () => ({ data: {} }),
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

// The drawer is portalled and fetches its own history; its own test file
// covers it. Here it only has to prove it was opened with the right module.
vi.mock("../components/AskFinSightDrawer", () => ({
  AskFinSightDrawer: ({
    open,
    module,
    initialQuestion,
  }: {
    open: boolean;
    module: string;
    initialQuestion?: string;
  }) =>
    open ? (
      <div data-testid="ask-drawer">
        <span>{module}</span>
        <span>{initialQuestion}</span>
      </div>
    ) : null,
}));

vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));

function renderPage() {
  return render(
    <MemoryRouter>
      <FlaggedRecords />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  patched.length = 0;
  getHandlers = {
    "/records/flagged": ok<RecordItem[]>([]),
    "/insights/findings": ok({ items: [], nextCursor: null }),
    "/records/csv-imports/batches": ok([]),
  };
});

describe("the unified review queue", () => {
  it("shows one card, not two, when a finding and a legacy flag describe the same record", async () => {
    getHandlers["/records/flagged"] = ok([record({ id: 1, largeExpenseFlag: true })]);
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: null });
    renderPage();

    expect(await screen.findByText("Unusually large Inventory expense")).toBeInTheDocument();
    // The legacy card's own title must not also appear.
    expect(screen.queryByText(/is large for your business/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    // …and the flag it replaced is still stated, as a secondary line.
    expect(screen.getByText(/Also flagged as a large expense/)).toBeInTheDocument();
  });

  it("preserves the threshold explanation, naming the number and linking to the setting", async () => {
    getHandlers["/records/flagged"] = ok([record({ id: 1, largeExpenseFlag: true })]);
    renderPage();

    expect(await screen.findByText(/large-expense threshold of/)).toBeInTheDocument();
    // 20% of PHP 20,000 — the owner's own figures, not a generic sentence.
    expect(screen.getByText("PHP 4,000")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change the threshold" })).toBeInTheDocument();
  });

  it("shows the comparison baseline rather than a raw score", async () => {
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: null });
    renderPage();

    expect(
      await screen.findByText("Compared against your usual PHP 600 in this category, across 12 past records."),
    ).toBeInTheDocument();
    // The band is words. The raw score exists only inside the collapsed audit
    // panel — present for support, never part of what the owner reads first.
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("0.91")).not.toBeVisible();
  });

  it("puts the model detail behind an expander, wired to the panel it controls", async () => {
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: null });
    renderPage();

    const toggle = await screen.findByRole("button", { name: "Why FinSight flagged this" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");

    await userEvent.click(toggle);
    expect(screen.getByText("zscore-iqr")).toBeInTheDocument();
    expect(screen.getByText("amount-outlier-v2")).toBeInTheDocument();
    expect(screen.getByText("0.91")).toBeInTheDocument();
    expect(screen.getByText("categoryMean")).toBeInTheDocument();
  });

  it("filters the queue by category, and each chip says how much it holds", async () => {
    getHandlers["/records/flagged"] = ok([
      record({ id: 2, duplicateStatus: "Flagged", duplicateOfRecordId: 9, description: "Ice delivery" }),
      record({ id: 3, source: "RECEIPT_SCAN", description: "Hardware run" }),
    ]);
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: null });
    renderPage();

    await screen.findByText("Unusually large Inventory expense");
    const filters = screen.getByRole("group", { name: "Filter the review queue" });
    expect(within(filters).getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(within(filters).getByRole("button", { name: /^Duplicate/ }));
    // Twice: the group's own heading and its (collapsed) member list.
    expect(screen.getAllByText("Ice delivery").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unusually large Inventory expense")).not.toBeInTheDocument();
    expect(screen.queryByText(/Hardware run/)).not.toBeInTheDocument();

    await userEvent.click(within(filters).getByRole("button", { name: /^Scan issue/ }));
    expect(screen.getByText(/Hardware run/)).toBeInTheDocument();
    expect(screen.queryByText("Ice delivery")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Discard all/ })).not.toBeInTheDocument();
  });

  it("makes all five feedback values reachable, and sends the right status with each", async () => {
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: null });
    renderPage();
    await screen.findByText("Unusually large Inventory expense");

    const expected: [RegExp, string, string][] = [
      [/^Yes — this was unusual$/, "CONFIRMED", "CONFIRMED_UNUSUAL"],
      [/^This is normal for my business$/, "DISMISSED", "EXPECTED_TRANSACTION"],
      [/^Wrong match/, "DISMISSED", "INCORRECT_MATCH"],
      [/^It is a duplicate$/, "CONFIRMED", "DUPLICATE"],
      [/^No longer relevant$/, "RESOLVED", "NO_LONGER_RELEVANT"],
    ];

    for (const [label] of expected) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("button", { name: /^Wrong match/ }));
    expect(patched).toEqual([
      { url: "/insights/findings/10/review", body: { status: "DISMISSED", feedback: "INCORRECT_MATCH" } },
    ]);
  });

  it("opens Ask FinSight scoped to the review queue, with the finding in the question", async () => {
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: null });
    renderPage();
    await screen.findByText("Unusually large Inventory expense");

    expect(screen.queryByTestId("ask-drawer")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Explain this flag" }));

    const drawer = screen.getByTestId("ask-drawer");
    expect(within(drawer).getByText("Records Review")).toBeInTheDocument();
    expect(within(drawer).getByText(/Unusually large Inventory expense/)).toBeInTheDocument();
  });

  it("keeps one bulk decision for a whole imported duplicate group", async () => {
    getHandlers["/records/flagged"] = ok([
      record({ id: 4, importBatchId: 7, duplicateStatus: "Flagged" }),
      record({ id: 5, importBatchId: 7, duplicateStatus: "Flagged", description: "Sugar" }),
    ]);
    getHandlers["/records/csv-imports/batches"] = ok([
      { id: 7, title: "March expenses.csv", uploadDate: "2026-03-01T00:00:00.000Z", status: "Reviewed" },
    ]);
    renderPage();

    expect(await screen.findByText("March expenses.csv")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard all 2" })).toBeInTheDocument();
    // One card for the group — not one per record.
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });

  it("offers another page only when the server said there is one", async () => {
    getHandlers["/insights/findings"] = ok({ items: [outlier], nextCursor: 10 });
    renderPage();
    expect(await screen.findByRole("button", { name: "Show more findings" })).toBeInTheDocument();
  });

  it("still renders the legacy flags when the findings request fails", async () => {
    getHandlers["/records/flagged"] = ok([record({ id: 1, largeExpenseFlag: true })]);
    getHandlers["/insights/findings"] = () => {
      throw new Error("Request failed with status code 500");
    };
    renderPage();

    expect(await screen.findByText(/is large for your business/)).toBeInTheDocument();
    expect(screen.queryByText(/status code 500/)).not.toBeInTheDocument();
  });
});
