import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import * as fixtures from "./support/fixtures";

const get = vi.fn();
const post = vi.fn();
const user = { id: 1 };
const takeBootstrapProfiles = () => null;
vi.mock("../../src/lib/api", () => ({ api: { get, post }, errorMessage: (error: Error) => error.message }));
vi.mock("../../src/context/AuthContext", () => ({ useAuth: () => ({ profile: user, takeBootstrapProfiles }) }));
const { BusinessProfileProvider, useBusinessProfiles } = await import("../../src/context/BusinessProfileContext");
const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { CategoryPicker } = await import("../../src/screens/records/shared");

let business!: ReturnType<typeof useBusinessProfiles>;
function Probe({ choose, created }: { choose?: (id: number) => void; created?: () => void }) {
  business = useBusinessProfiles();
  return <>
    <Text>{business.categories.map((category) => category.name).join(", ") || "No active categories"}</Text>
    <Text>{business.categoriesLoading ? "Categories loading" : "Categories ready"}</Text>
    <Text>{business.categoriesError ?? "No category error"}</Text>
    {choose ? <CategoryPicker categories={business.categories} value={null} onChange={choose} onCreated={created!} /> : null}
  </>;
}
const wrap = (node: React.ReactNode) => <ThemeProvider initialMode="light"><BusinessProfileProvider>{node}</BusinessProfileProvider></ThemeProvider>;

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async (path: string, query?: { businessProfileId: number }) => path === "/business-profiles"
    ? [fixtures.businessProfile, { ...fixtures.businessProfile, id: 2, name: "Second business" }]
    : query?.businessProfileId === 1 ? [{ id: 10, name: "First business stock" }] : [{ id: 20, name: "Second business rent" }]);
});

describe("category isolation during business switching", () => {
  it("ignores a delayed category fetch from the previous business", async () => {
    let finishFirst!: (value: unknown) => void;
    const original = get.getMockImplementation()!;
    get.mockImplementation((path: string, query?: { businessProfileId: number }) => path === "/records/categories" && query?.businessProfileId === 1
      ? new Promise((resolve) => { finishFirst = resolve; }) : original(path, query));
    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(business.selected?.id).toBe(1));
    await act(() => business.selectProfile(2));
    await waitFor(() => expect(q.getByText("Second business rent")).toBeTruthy());
    await act(() => finishFirst([{ id: 10, name: "First business stock" }]));
    expect(q.queryByText("First business stock")).toBeNull();
    expect(business.categories.map((category) => category.id)).toEqual([20]);
  });

  it("never appends a category created for a previous business to the active list", async () => {
    let finishCreate!: (value: unknown) => void;
    post.mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }));
    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(q.getByText("First business stock")).toBeTruthy());
    let pending!: Promise<unknown>;
    await act(() => { pending = business.createCategory({ name: "First business equipment" }); });
    expect(post).toHaveBeenCalledWith("/records/categories", { businessProfileId: 1, name: "First business equipment" });
    await act(() => business.selectProfile(2));
    await waitFor(() => expect(q.getByText("Second business rent")).toBeTruthy());
    await act(async () => {
      finishCreate({ id: 11, name: "First business equipment" });
      await expect(pending).rejects.toThrow("Business changed. Choose a category for the current business.");
    });
    expect(business.categories.map((category) => category.id)).toEqual([20]);
    expect(q.queryByText(/First business equipment/)).toBeNull();
  });

  it("does not choose or refresh a late created category after a business switch", async () => {
    let finishCreate!: (value: unknown) => void;
    post.mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }));
    const choose = vi.fn();
    const created = vi.fn();
    const q = await render(wrap(<Probe choose={choose} created={created} />));
    await waitFor(() => expect(business.selected?.id).toBe(1));
    await fireEvent.changeText(q.getByLabelText("New category name"), "First business equipment");
    const button = q.getByRole("button", { name: "Add" });
    let fiber = button.unstable_fiber;
    while (fiber && typeof fiber.memoizedProps?.onPress !== "function") fiber = fiber.return;
    await act(() => { void fiber!.memoizedProps.onPress(); });
    await act(() => business.selectProfile(2));
    await waitFor(() => expect(q.getByText("Second business rent")).toBeTruthy());
    await act(() => finishCreate({ id: 11, name: "First business equipment" }));
    expect(choose).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect(q.getByLabelText("New category name").props.value).toBe("");
    expect(business.categories.map((category) => category.id)).toEqual([20]);
  });

  it("preserves the selected business's rows when a refresh fails, then clears the error on retry", async () => {
    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(q.getByText("First business stock")).toBeTruthy());

    get.mockRejectedValueOnce(new Error("network unavailable"));
    await act(async () => {
      await expect(business.refreshCategories()).rejects.toThrow("network unavailable");
    });

    expect(q.getByText("First business stock")).toBeTruthy();
    expect(q.getByText("network unavailable")).toBeTruthy();
    expect(q.getByText("Categories ready")).toBeTruthy();

    get.mockResolvedValueOnce([{ id: 12, name: "Updated stock" }]);
    await act(async () => {
      await business.refreshCategories();
    });

    expect(q.getByText("Updated stock")).toBeTruthy();
    expect(q.getByText("No category error")).toBeTruthy();
  });

  it("does not let an older refresh erase a category that was just created", async () => {
    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(q.getByText("First business stock")).toBeTruthy());

    let finishRefresh!: (value: unknown) => void;
    get.mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    post.mockResolvedValueOnce({ id: 11, name: "First business equipment" });

    let pendingRefresh!: Promise<void>;
    await act(() => { pendingRefresh = business.refreshCategories(); });
    await act(async () => {
      await business.createCategory({ name: "First business equipment" });
    });
    expect(q.getByText(/First business stock, First business equipment/)).toBeTruthy();

    await act(async () => {
      finishRefresh([{ id: 10, name: "First business stock" }]);
      await pendingRefresh;
    });

    expect(q.getByText(/First business stock, First business equipment/)).toBeTruthy();
    expect(business.categories.map((category) => category.id)).toEqual([10, 11]);
  });

  it("merges a category created before the initial category fetch completes", async () => {
    let finishInitial!: (value: unknown) => void;
    const original = get.getMockImplementation()!;
    get.mockImplementation((path: string, query?: { businessProfileId: number }) =>
      path === "/records/categories" && query?.businessProfileId === 1
        ? new Promise((resolve) => { finishInitial = resolve; })
        : original(path, query),
    );
    post.mockResolvedValueOnce({ id: 11, name: "First business equipment" });

    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/records/categories", { businessProfileId: 1 }));

    await act(async () => {
      await business.createCategory({ name: "First business equipment" });
    });
    expect(q.getByText("First business equipment")).toBeTruthy();

    await act(() => finishInitial([{ id: 10, name: "First business stock" }]));
    await waitFor(() => expect(q.getByText(/First business stock, First business equipment/)).toBeTruthy());
    expect(business.categories.map((category) => category.id)).toEqual([10, 11]);
  });

  it("does not expose a late category failure from the previous business", async () => {
    let failFirst!: (error: Error) => void;
    const original = get.getMockImplementation()!;
    get.mockImplementation((path: string, query?: { businessProfileId: number }) =>
      path === "/records/categories" && query?.businessProfileId === 1
        ? new Promise((_resolve, reject) => { failFirst = reject; })
        : original(path, query),
    );

    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(business.selected?.id).toBe(1));
    await act(() => business.selectProfile(2));
    await waitFor(() => expect(q.getByText("Second business rent")).toBeTruthy());

    await act(() => failFirst(new Error("first business offline")));

    expect(q.queryByText("first business offline")).toBeNull();
    expect(q.getByText("No category error")).toBeTruthy();
    expect(business.categories.map((category) => category.id)).toEqual([20]);
  });
});
