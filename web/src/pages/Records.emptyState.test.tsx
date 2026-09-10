// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Records } from "./Records";
import type { BusinessProfile } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS: a brand-new business gets ONE invitation, not a
 * filter bar over an empty set and three ways to add the same record.
 *
 * "No records at all" and "no records matched" are different pages, not two
 * captions. When the business genuinely has nothing, the search box, Type
 * select and "More filters" toggle are controls over an empty set — and they
 * make the empty state ambiguous, because the owner cannot tell whether a
 * filter is hiding their rows. The secondary add-strip and the header's own
 * add button stand down too, so "add an expense" stops appearing three times
 * in two different colours on the one screen whose job is to get the first
 * record in.
 *
 * The moment there is anything to filter, all of it comes back.
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
} as unknown as BusinessProfile;

let getHandlers: Record<string, () => unknown>;
const gets: { url: string; params: Record<string, unknown> | undefined }[] = [];

function ok<T>(data: T) {
  return () => ({ data });
}

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      gets.push({ url, params: config?.params });
      const handler = getHandlers[url];
      if (!handler) throw new Error(`unmocked GET ${url}`);
      return handler();
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [] }),
}));
vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
// The create/edit popups are their own screens with their own fetches — this
// file is about the page head, so they stay out of the way.
vi.mock("../components/AddExpenseModal", () => ({ AddExpenseModal: () => null }));
vi.mock("../components/AddSalesModal", () => ({ AddSalesModal: () => null }));
vi.mock("../components/DuplicateReviewModal", () => ({ DuplicateReviewModal: () => null }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/records"]}>
      <Records />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  gets.length = 0;
  getHandlers = {
    "/records/search": ok({ items: [], nextCursor: null }),
    "/records/flagged/count": ok({ expenses: 3, sales: 1, total: 4 }),
  };
});

const oneRecord = {
  type: "expense",
  id: 7,
  date: "2026-09-01T00:00:00.000Z",
  description: "Coffee beans",
  amount: 1200,
  categoryId: null,
  vendor: null,
  source: "MANUAL",
  reviewStatus: "Reviewed",
  duplicateStatus: "None",
};

describe("Records when the business has nothing yet", () => {
  it("shows one invitation and hides the filter bar", async () => {
    renderPage();

    // The invitation, with the mascot rather than the `compact` text-only variant.
    expect(await screen.findByText("You haven't added any records yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add your first expense" })).toBeInTheDocument();

    // No controls over an empty set.
    expect(screen.queryByLabelText("Search")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More filters/ })).not.toBeInTheDocument();
    // ...and no empty table underneath it.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers each way in exactly once", async () => {
    renderPage();
    await screen.findByText("You haven't added any records yet");

    // One primary. The header's "+ Add expense" and the secondary add-strip
    // both stand down while the empty state is carrying the same actions.
    expect(screen.queryByRole("button", { name: "+ Add expense" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Add sales" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /expense/i })).toHaveLength(1);

    // Receipt and CSV are still reachable — once each, from the empty state.
    expect(screen.getAllByRole("link", { name: /receipt/i })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /CSV/i })).toHaveLength(1);
  });

  it("brings the toolbar and the add actions back as soon as there is a record", async () => {
    getHandlers["/records/search"] = ok({ items: [oneRecord], nextCursor: null });
    renderPage();

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add expense" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add sales" })).toBeInTheDocument();
    expect(screen.queryByText("You haven't added any records yet")).not.toBeInTheDocument();
  });

  it("keeps the toolbar when a filter is what emptied the list", async () => {
    render(
      <MemoryRouter initialEntries={["/records?keyword=nothing-matches-this"]}>
        <Records />
      </MemoryRouter>,
    );

    // A filter hid the rows, so the owner needs the toolbar to get them back.
    expect(await screen.findByText(/No records match these filters/)).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.queryByText("You haven't added any records yet")).not.toBeInTheDocument();
  });
});
