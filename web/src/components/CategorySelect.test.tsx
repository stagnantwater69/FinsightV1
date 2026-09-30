// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ExpenseCategory } from "../lib/types";

const categoriesRef: { value: ExpenseCategory[]; recent: number[] } = { value: [], recent: [] };
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({
    categories: categoriesRef.value,
    createCategory: vi.fn(),
    loading: false,
    recentCategoryIds: categoriesRef.recent,
    rememberCategory: vi.fn(),
  }),
}));
vi.mock("./Toast", () => ({ useToast: () => () => {} }));

import { CategorySelect } from "./CategorySelect";

const category = (id: number, name: string, kind?: "business" | "personal"): ExpenseCategory => ({
  id, businessProfileId: 1, name, description: null, createdAt: "2026-09-30T00:00:00.000Z", ...(kind ? { kind } : {}),
});

describe("business and personal categories in the picker", () => {
  it("groups personal categories under their own heading", () => {
    categoriesRef.value = [category(1, "Inventory / Stock", "business"), category(2, "Groceries", "personal"), category(3, "Utilities")];
    categoriesRef.recent = [];
    render(<CategorySelect value={1} onChange={() => {}} />);

    const business = screen.getByRole("group", { name: "Business" });
    const personal = screen.getByRole("group", { name: "Personal" });
    expect(within(business).getAllByRole("option").map((option) => option.textContent)).toEqual(["Inventory / Stock", "Utilities"]);
    expect(within(personal).getAllByRole("option").map((option) => option.textContent)).toEqual(["Groceries"]);
  });

  it("marks a personal category among the recently used ones", () => {
    categoriesRef.value = [category(1, "Inventory / Stock", "business"), category(2, "Groceries", "personal")];
    categoriesRef.recent = [2];
    render(<CategorySelect value={2} onChange={() => {}} />);

    const recent = screen.getByRole("group", { name: "Recently used" });
    expect(within(recent).getByRole("option").textContent).toBe("Groceries (Personal)");
  });

  it("keeps one flat list for a business with no personal categories", () => {
    categoriesRef.value = [category(1, "Inventory / Stock", "business"), category(3, "Utilities")];
    categoriesRef.recent = [];
    render(<CategorySelect value={1} onChange={() => {}} />);

    expect(screen.queryByRole("group")).toBeNull();
  });
});
