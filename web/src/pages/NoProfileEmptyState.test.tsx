// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { Dashboard } from "./Dashboard";
import { Records } from "./Records";
import { Categories } from "./Categories";
import { FlaggedRecords } from "./FlaggedRecords";
import { ExpenseInsight } from "./ExpenseInsight";
import { SpendingImpact } from "./SpendingImpact";
import { RecoveryInsightPage } from "./RecoveryInsightPage";
import { RecoveryMonthEndReviewPage } from "./RecoveryMonthEndReview";
import { Notifications } from "./Notifications";
import { ImportCsv } from "./ImportCsv";
import { AddExpense } from "./AddExpense";
import { AddSalesRecord } from "./AddSalesRecord";

/**
 * WHAT "SKIP FOR NOW" SKIPS TO.
 *
 * The old contract was that every authenticated page answered "no business
 * selected" with the same <NoBusinessProfile /> card. That made the skip a
 * lie: seventeen doors, one card behind all of them, and an owner who reported
 * their dashboard as "nothing but that card" was describing the whole app.
 *
 * The contract these tests now pin is the split that replaced it:
 *
 *   - a page that only READS is ENTERABLE. It renders its normal chrome —
 *     heading, toolbar, table — sitting in its own existing empty state. No
 *     sample data, no gate card;
 *   - a page that WRITES a record stays GATED. A form that cannot save is a
 *     worse dead end than the card, one click further in.
 *
 * All nine read-only pages are mounted here, not a representative two: the
 * defect this replaced was found on the page nobody thought to check.
 *
 * The extra assertion on those pages is the one that matters most:
 * they must SETTLE. A fetch that never runs still has to end in "loaded, and
 * empty" rather than an eternal skeleton, which is what a bare
 * `if (!selected) return;` inside a loader left behind.
 */

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({
    profiles: [],
    selected: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({
    categories: [],
    loading: false,
    createCategory: vi.fn(),
    updateCategory: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    profile: { id: 1, firstName: "Ana" },
    preferences: { showDashboardMascotMessage: true },
  }),
}));

// Dashboard and the insight pages open Ask FinSight through this context;
// the drawer itself lives in the authenticated layout, not in the page.
vi.mock("../context/AiChatContext", () => ({ useAiChat: () => ({ openChat: vi.fn() }) }));

vi.mock("../context/NotificationContext", () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    loading: false,
    error: null,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));

function mount(Page: () => ReactElement) {
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
}

describe.each([
  ["Dashboard", Dashboard, "Dashboard"],
  ["Records", Records, "Records"],
  ["Categories", Categories, "Expense categories"],
  ["Notifications", Notifications, "Notifications"],
  ["Needs review", FlaggedRecords, "Needs review"],
  ["Expense insight", ExpenseInsight, "Expense insight"],
  ["Spending impact", SpendingImpact, "Spending impact"],
  ["Recovery target", RecoveryInsightPage, "Recovery target"],
  ["Month-end review", RecoveryMonthEndReviewPage, "Month-end review"],
])("%s with no business — read-only, so enterable", (_name, Page, heading) => {
  it("renders its own page and its own empty state, not the setup gate", () => {
    mount(Page as () => ReactElement);

    // Its normal chrome, exactly as an owner with a business would see it.
    expect(screen.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    // The gate card belongs to the write pages now. Identified by its own
    // "Continue setup" action rather than by its heading, since an enterable
    // page's empty state may legitimately invite setup in its own words.
    expect(screen.queryByRole("link", { name: "Continue setup" })).not.toBeInTheDocument();
    expect(screen.queryByText("Welcome to FinSight")).not.toBeInTheDocument();
  });

  it("settles into a loaded-and-empty state rather than a skeleton", () => {
    const { container } = mount(Page as () => ReactElement);

    expect(container.querySelector("[aria-busy='true']")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
  });
});

describe("Categories with no business", () => {
  it("points its create action at setup instead of a form that cannot save", () => {
    mount(Categories);

    // "Create your first category" would call createCategory(), which throws
    // without a business profile — the dead end this replaced.
    expect(screen.queryByRole("button", { name: /create your first category/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /finish setting up your business/i }),
    ).toHaveAttribute("href", "/onboarding");
  });
});

describe.each([
  ["Import CSV", ImportCsv],
  ["Add expense", AddExpense],
  ["Add sales record", AddSalesRecord],
])("%s with no business — writes a record, so still gated", (_name, Page) => {
  it("shows the setup gate rather than an unsaveable form", () => {
    mount(Page as () => ReactElement);

    expect(screen.getByText("Finish setting up your business")).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue setup" })).toHaveAttribute(
      "href",
      "/onboarding",
    );
  });
});
