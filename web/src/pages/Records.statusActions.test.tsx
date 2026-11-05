// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ profile: { id: 17 } }) }));
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Records } from "./Records";
import type { BusinessProfile, RecordItem } from "../lib/types";

/** The status column is where the owner acts: "Check" explains and confirms, "Repeat?" compares. */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFunds: 50000,
  expectedMonthlyExpenses: 20000,
  largeExpenseThresholdPercent: 25,
} as unknown as BusinessProfile;

const base = {
  type: "expense",
  businessProfileId: 1,
  date: "2026-10-17T00:00:00.000Z",
  categoryId: 1,
  source: "MANUAL_ENTRY",
  largeExpenseFlag: false,
  reviewStatus: "Reviewed",
  duplicateStatus: "Not Checked",
} as const;

const records = [
  { ...base, id: 1, description: "Freezer repair", amount: 8000, largeExpenseFlag: true, reviewStatus: "Needs Review" },
  { ...base, id: 2, description: "Rice sacks", amount: 900, duplicateStatus: "Flagged" },
  { ...base, id: 3, description: "Ice", amount: 60 },
] as unknown as RecordItem[];

const patches: { url: string; body: unknown }[] = [];
const compared: unknown[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/records/search") return { data: { items: records, nextCursor: null } };
      if (url === "/records/flagged/count") return { data: { expenses: 2, sales: 0, total: 2 } };
      throw new Error(`unmocked GET ${url}`);
    },
    post: async () => ({ data: {} }),
    patch: async (url: string, body: unknown) => {
      patches.push({ url, body });
      return { data: {} };
    },
    delete: async () => ({ data: {} }),
  },
}));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: profile }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({ categories: [] }) }));
vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("../components/AddExpenseModal", () => ({ AddExpenseModal: () => null }));
vi.mock("../components/AddSalesModal", () => ({ AddSalesModal: () => null }));
vi.mock("../components/DuplicateReviewModal", () => ({
  DuplicateReviewModal: ({ open, recordId }: { open: boolean; recordId: number | null }) => {
    if (open) compared.push(recordId);
    return null;
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/records"]}>
      <Records />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  patches.length = 0;
  compared.length = 0;
});

describe("clickable record statuses", () => {
  it("explains a Check with the owner's own threshold and confirms it in place", async () => {
    const user = userEvent.setup();
    renderPage();

    const [check] = await screen.findAllByRole("button", { name: /Needs your review: why Freezer repair/ });
    await user.click(check!);
    // 25% of the PHP 20,000 estimate.
    expect(screen.getByText(/large-expense threshold of/)).toHaveTextContent("PHP 5,000");

    const popup = check!.parentElement!;
    await user.click(within(popup).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(patches).toEqual([{ url: "/records/expenses/1", body: { reviewStatus: "Reviewed" } }]));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Needs your review: why Freezer repair/ })).not.toBeInTheDocument(),
    );
  });

  it("opens the compare window from Repeat?", async () => {
    const user = userEvent.setup();
    renderPage();

    const [repeat] = await screen.findAllByRole("button", { name: /Possible duplicate: compare Rice sacks/ });
    await user.click(repeat!);
    expect(compared).toContain(2);
  });

  it("leaves Confirmed as plain text", async () => {
    renderPage();
    await screen.findAllByText("Ice");
    expect(screen.queryByRole("button", { name: /(review: why|compare) Ice/ })).not.toBeInTheDocument();
  });
});
