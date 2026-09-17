// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddExpense } from "./AddExpense";

const mocks = vi.hoisted(() => ({ post: vi.fn(), selected: { id: 1 }, remember: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { post: mocks.post } }));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({
  categories: [{ id: 2, name: "Supplies" }, { id: 3, name: "Utilities" }], loading: false,
  recentCategoryIds: [3], rememberCategory: mocks.remember,
}) }));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));

beforeEach(() => { mocks.post.mockReset(); mocks.remember.mockReset(); mocks.selected = { id: 1 }; });

describe("manual expense categories", () => {
  it("remembers the chosen category and offers no separate search control", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><AddExpense /></MemoryRouter>);
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    expect(mocks.remember).toHaveBeenCalledWith(2);
    expect(screen.getByRole("group", { name: "Recently used" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search categories" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^Category/), "3");
    expect(screen.getByRole("combobox", { name: /^Category/ })).toHaveValue("3");
  });

  it("requires Apply suggestion before changing a chosen category", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({ data: { suggestion: { categoryId: 2, categoryName: "Supplies" } } });
    render(<MemoryRouter><AddExpense /></MemoryRouter>);
    await user.selectOptions(screen.getByLabelText(/^Category/), "3");
    await user.type(screen.getByLabelText(/^Description/), "Paper for printing");
    await user.click(screen.getByRole("button", { name: "Suggest a category" }));
    await screen.findByRole("button", { name: "Apply suggestion" });
    expect(screen.getByRole("combobox", { name: /^Category/ })).toHaveValue("3");
    await user.click(screen.getByRole("button", { name: "Apply suggestion" }));
    expect(screen.getByLabelText(/^Category/)).toHaveValue("2");
  });

  it("ignores a delayed suggestion when the description changes", async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<MemoryRouter><AddExpense /></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Description/), "Paper");
    await user.click(screen.getByRole("button", { name: "Suggest a category" }));
    await user.type(screen.getByLabelText(/^Description/), " and electricity");
    await act(async () => { finish({ data: { suggestion: { categoryId: 2, categoryName: "Supplies" } } }); });
    expect(screen.queryByRole("button", { name: "Apply suggestion" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Category/)).toHaveValue("");
  });
});
