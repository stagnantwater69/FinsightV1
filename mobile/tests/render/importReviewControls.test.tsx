import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import type { ExpenseCategory } from "../../src/lib/types";

const post = vi.fn();
vi.mock("../../src/lib/api", () => ({ api: { post } }));
const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { ResultDetails } = await import("../../src/components/ResultDetails");
const { ReviewNotices } = await import("../../src/screens/records/scanReceipt/ReviewNotices");
const { CategorySelect } = await import("../../src/components/ui");
const { CategorySuggestionAction } = await import("../../src/components/CategorySuggestionAction");
const { useImportOperation } = await import("../../src/lib/useImportOperation");
const wrap = (node: React.ReactNode) => <ThemeProvider initialMode="light">{node}</ThemeProvider>;
const categories = [{ id: 701, name: "Inventory" }, { id: 702, name: "Utilities" }] as ExpenseCategory[];
beforeEach(() => post.mockReset());

describe("import review controls", () => {
  it("toggles optional comments with an accessible expanded state", async () => {
    const q = await render(wrap(<ResultDetails label="scan evidence"><Text>Printed source text</Text></ResultDetails>));
    const more = q.getByRole("button", { name: "Show more, scan evidence" });
    expect(more.props.accessibilityState.expanded).toBe(false);
    expect(q.queryByText("Printed source text")).toBeNull();
    await fireEvent.press(more);
    expect(q.getByText("Printed source text")).toBeTruthy();
    const less = q.getByRole("button", { name: "Show less, scan evidence" });
    expect(less.props.accessibilityState.expanded).toBe(true);
    await fireEvent.press(less);
    expect(q.queryByText("Printed source text")).toBeNull();
  });

  it("keeps duplicate warnings visible while optional evidence is collapsed", async () => {
    const q = await render(wrap(<ReviewNotices notices={[
      { tone: "warn", text: "Check for duplicate items.", detail: "Page 2 repeats page 1." },
      { tone: "info", text: "Overlapping sections were combined." },
    ]} />));
    expect(q.getByText("Check for duplicate items.")).toBeTruthy();
    expect(q.queryByText("Page 2 repeats page 1.")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Show more, scan notes" }));
    expect(q.getByText("Page 2 repeats page 1.")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Show less, scan notes" }));
    expect(q.getByText("Check for duplicate items.")).toBeTruthy();
  });

  it("searches categories and offers recently chosen categories", async () => {
    const changed = vi.fn();
    const q = await render(wrap(<CategorySelect options={categories} value={null} onChange={changed} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a category, category" }));
    await fireEvent.changeText(q.getByLabelText("Search categories"), "util");
    expect(q.queryByText("Inventory")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Utilities" }));
    expect(changed).toHaveBeenCalledWith(702);
    await fireEvent.press(q.getByRole("button", { name: "Choose a category, category" }));
    expect(q.getByText("Recently chosen")).toBeTruthy();
    expect(q.getByLabelText("Search categories").props.value).toBe("");
  });

  it("applies a suggested category only after the owner explicitly accepts it", async () => {
    const apply = vi.fn();
    post.mockResolvedValue({ suggestion: { categoryId: 701, categoryName: "Inventory", source: "history" } });
    const q = await render(wrap(<CategorySuggestionAction businessId={3} description="Coffee beans" vendor="Supplier" categories={categories} value={702} onApply={apply} />));
    await fireEvent.press(q.getByRole("button", { name: "Suggest a category" }));
    await waitFor(() => expect(q.getByText("Suggested: Inventory")).toBeTruthy());
    expect(apply).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/ai/suggest-category", { businessProfileId: 3, description: "Coffee beans", vendor: "Supplier" });
    await fireEvent.press(q.getByRole("button", { name: "Apply suggestion" }));
    expect(apply).toHaveBeenCalledWith(701);
  });

  it("ignores a category suggestion after the description or business changes", async () => {
    let resolve!: (value: unknown) => void;
    post.mockReturnValue(new Promise((done) => { resolve = done; }));
    const apply = vi.fn();
    const props = { businessId: 3, description: "Coffee beans", categories, value: null, onApply: apply };
    const q = await render(wrap(<CategorySuggestionAction {...props} />));
    await fireEvent.press(q.getByRole("button", { name: "Suggest a category" }));
    await q.rerender(wrap(<CategorySuggestionAction {...props} businessId={4} description="Power bill" />));
    await act(() => resolve({ suggestion: { categoryId: 701, categoryName: "Inventory" } }));
    expect(q.queryByText("Suggested: Inventory")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("serializes actions and invalidates async results on business change or unmount", async () => {
    let operation!: ReturnType<typeof useImportOperation>;
    function Probe({ businessId }: { businessId: number }) { operation = useImportOperation(businessId); return <Text>Probe</Text>; }
    const q = await render(<Probe businessId={1} />);
    const first = operation.begin()!;
    expect(operation.begin()).toBeNull();
    expect(operation.current(first)).toBe(true);
    await q.rerender(<Probe businessId={2} />);
    expect(first.controller.signal.aborted).toBe(true);
    expect(operation.current(first)).toBe(false);
    const second = operation.begin()!;
    expect(second).toBeTruthy();
    operation.finish(first);
    expect(operation.begin()).toBeNull();
    await q.unmount();
    expect(second.controller.signal.aborted).toBe(true);
    expect(operation.current(second)).toBe(false);
  });
});
