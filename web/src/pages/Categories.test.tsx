// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Categories } from "./Categories";
import type { BusinessProfile, ExpenseCategory } from "../lib/types";

/**
 * Cost-behavior classification in category management — plan §5.2/§15
 * Phase 5. The field is optional everywhere: creating a category must never
 * be blocked on it, and an existing category can be reclassified inline
 * without a separate edit screen.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

const categories: ExpenseCategory[] = [
  {
    id: 1,
    businessProfileId: 1,
    name: "Rent",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    costBehavior: "UNCLASSIFIED",
  },
];

const createCategory = vi.fn();
const updateCategory = vi.fn();

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({
    categories,
    loading: false,
    createCategory,
    updateCategory,
    refresh: vi.fn(),
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <Categories />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  createCategory.mockReset();
  createCategory.mockResolvedValue({ ...categories[0], id: 2, name: "New" });
  updateCategory.mockReset();
  updateCategory.mockResolvedValue({ ...categories[0], costBehavior: "VARIABLE" });
});

describe("Categories — cost-behavior classification", () => {
  it("does not require a cost-behavior choice to create a category", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "+ New category" }));

    await userEvent.type(screen.getByLabelText(/^Name/), "Supplies");
    await userEvent.click(screen.getByRole("button", { name: "Save category" }));

    expect(createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Supplies", costBehavior: undefined }),
    );
  });

  it("sends the chosen cost behavior when the owner picks one on create", async () => {
    const { container } = renderPage();
    await userEvent.click(screen.getByRole("button", { name: "+ New category" }));

    await userEvent.type(screen.getByLabelText(/^Name/), "Utilities");
    // Scoped by id rather than label text: the create form's "Cost behavior"
    // label and each row's "Cost behavior for <name>" select both start with
    // the same words, so a text query would be ambiguous here.
    const select = container.querySelector<HTMLSelectElement>("#cat-cost-behavior")!;
    await userEvent.selectOptions(select, "FIXED");
    await userEvent.click(screen.getByRole("button", { name: "Save category" }));

    expect(createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Utilities", costBehavior: "FIXED" }),
    );
  });

  it("lets an existing category be reclassified inline, without a separate edit screen", async () => {
    renderPage();
    const selects = screen.getAllByLabelText("Cost behavior for Rent");
    // Rendered once for the desktop table cell and once for the mobile row —
    // both wired the same way, so acting on either is a valid user action.
    expect(selects.length).toBeGreaterThanOrEqual(1);

    await userEvent.selectOptions(selects[0]!, "VARIABLE");

    expect(updateCategory).toHaveBeenCalledWith(1, { costBehavior: "VARIABLE" });
  });
});
