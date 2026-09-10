// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Records } from "./Records";
import type { BusinessProfile } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS: the badge is a NUMBER, and must cost a number.
 *
 * The "Review flagged" pill used to be rendered from `data.length` of
 * `GET /records/flagged` — the entire flagged list, re-fetched on every filter
 * change and every keystroke, and roughly 8 MB of JSON for a business that
 * re-imported a spreadsheet (every re-added row is flagged as a duplicate).
 * The count has its own endpoint now. If anyone reintroduces the list fetch to
 * render this pill, the first test here fails.
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

describe("the flagged badge on Records", () => {
  it("reads the count endpoint and never downloads the flagged list", async () => {
    renderPage();

    const badge = await screen.findByRole("link", { name: /Review flagged/ });
    // expenses + sales, exactly what the server totalled.
    expect(badge).toHaveTextContent("4");

    const countCall = gets.find((g) => g.url === "/records/flagged/count");
    expect(countCall?.params).toMatchObject({ businessProfileId: 1 });
    // The list endpoint is not touched at all from this page.
    expect(gets.some((g) => g.url === "/records/flagged")).toBe(false);
  });

  it("hides the badge when nothing is flagged", async () => {
    getHandlers["/records/flagged/count"] = ok({ expenses: 0, sales: 0, total: 0 });
    renderPage();

    await waitFor(() => expect(gets.some((g) => g.url === "/records/flagged/count")).toBe(true));
    expect(screen.queryByRole("link", { name: /Review flagged/ })).not.toBeInTheDocument();
  });

  it("keeps the page usable when the count request fails", async () => {
    getHandlers["/records/flagged/count"] = () => {
      throw new Error("Request failed with status code 500");
    };
    renderPage();

    // The badge is decoration; the records list is the page.
    expect(await screen.findByRole("heading", { name: "Records" })).toBeInTheDocument();
    expect(screen.queryByText(/status code 500/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Review flagged/ })).not.toBeInTheDocument();
  });
});
