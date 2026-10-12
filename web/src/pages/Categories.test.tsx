// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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
const refresh = vi.fn();
let loadingError: string | null = null;
let categoryRows = categories;
let loading = false;

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({
    categories: categoryRows,
    loading,
    loadingError,
    createCategory,
    updateCategory,
    refresh,
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
  loadingError = null;
  categoryRows = categories;
  loading = false;
  refresh.mockReset();
  refresh.mockResolvedValue(undefined);
  createCategory.mockReset();
  createCategory.mockResolvedValue({ ...categories[0], id: 2, name: "New" });
  updateCategory.mockReset();
  updateCategory.mockResolvedValue({ ...categories[0], costBehavior: "VARIABLE" });
});

describe("category error recovery", () => {
  it("shows a retryable load failure separately from a successful empty list", async () => {
    categoryRows = [];
    loadingError = "Could not load this business's categories";
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(loadingError);
    expect(screen.queryByText(/No categories yet/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry loading categories" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the creation error separate from the category list's loading error", async () => {
    loadingError = "Category list unavailable";
    createCategory.mockRejectedValueOnce(new Error("A category with that name already exists"));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "+ New category" }));
    await userEvent.type(screen.getByLabelText(/^Name/), "Rent");
    await userEvent.click(screen.getByRole("button", { name: "Save category" }));
    expect(await screen.findByText("A category with that name already exists")).toBeVisible();
    expect(screen.getByText(/Category list unavailable/)).toBeVisible();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Rent");
  });

  it("reports an inline classification failure and restores the last known choice", async () => {
    updateCategory.mockRejectedValueOnce(new Error("Classification could not be saved"));
    renderPage();
    const select = screen.getAllByLabelText("Cost behavior for Rent")[0];
    await userEvent.selectOptions(select, "VARIABLE");
    expect(await screen.findByText("Classification could not be saved")).toBeVisible();
    expect(select).toHaveValue("UNCLASSIFIED");
    expect(select).toBeEnabled();
  });

  it("disables a classification only while saving and announces a successful save", async () => {
    let finish!: (value: unknown) => void;
    updateCategory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderPage();
    const select = screen.getAllByLabelText("Cost behavior for Rent")[0];
    await userEvent.selectOptions(select, "FIXED");
    expect(select).toBeDisabled();
    await act(async () => finish({ ...categories[0], costBehavior: "FIXED" }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(screen.getByRole("status")).toHaveTextContent(/saved/i);
  });
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
