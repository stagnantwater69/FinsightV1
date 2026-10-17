import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import * as fixtures from "./support/fixtures";

const get = vi.fn();
const post = vi.fn();
const recordLoading = vi.fn();
let user = { id: 1, firstName: "Nena", avatarUrl: null as string | null };
const takeBootstrapProfiles = () => null;
vi.mock("../../src/lib/api", () => ({ api: { get, post }, errorMessage: (error: Error) => error.message }));
vi.mock("../../src/context/AuthContext", () => ({ useAuth: () => ({ profile: user, takeBootstrapProfiles }) }));
const { BusinessProfileProvider, useBusinessProfiles } = await import("../../src/context/BusinessProfileContext");
const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { CategoryPicker } = await import("../../src/screens/records/shared");

let business!: ReturnType<typeof useBusinessProfiles>;
function Probe({ choose, created }: { choose?: (id: number) => void; created?: () => void }) {
  business = useBusinessProfiles();
  const loading = business.loading;
  React.useEffect(() => { recordLoading(loading); }, [loading]);
  return <>
    <Text>{business.categories.map((category) => category.name).join(", ") || "No active categories"}</Text>
    <Text>{business.categoriesLoading ? "Categories loading" : "Categories ready"}</Text>
    <Text>{business.categoriesError ?? "No category error"}</Text>
    {choose ? <CategoryPicker categories={business.categories} value={null} onChange={choose} onCreated={created!} /> : null}
  </>;
}
const wrap = (node: React.ReactNode) => <ThemeProvider initialMode="light"><BusinessProfileProvider>{node}</BusinessProfileProvider></ThemeProvider>;

beforeEach(() => {
  user = { id: 1, firstName: "Nena", avatarUrl: null };
  get.mockReset(); post.mockReset(); recordLoading.mockReset();
  get.mockImplementation(async (path: string, query?: { businessProfileId: number }) => path === "/business-profiles"
    ? [fixtures.businessProfile, { ...fixtures.businessProfile, id: 2, name: "Second business" }]
    : query?.businessProfileId === 1 ? [{ id: 10, name: "First business stock" }] : [{ id: 20, name: "Second business rent" }]);
});

describe("business bootstrap after account profile changes", () => {
  it("does not restore an archived business when an older overlapping refresh finishes last", async () => {
    await render(wrap(<Probe />));
    await waitFor(() => expect(business.selected?.id).toBe(1));
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    get.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishNew = resolve; }));
    let older!: Promise<void>;
    let newer!: Promise<void>;
    await act(() => { older = business.refresh(); newer = business.refresh(); });
    const remaining = { ...fixtures.businessProfile, id: 2, name: "Remaining active business" };
    await act(async () => { finishNew([remaining]); await newer; });
    expect(business.profiles).toEqual([remaining]);
    expect(business.selected?.id).toBe(2);
    await act(async () => { finishOld([fixtures.businessProfile, remaining]); await older; });
    expect(business.profiles).toEqual([remaining]);
    expect(business.selected?.id).toBe(2);
    expect(business.loading).toBe(false);
    expect(business.error).toBeNull();
  });

  it("does not replace a newer business-list success with an older failure", async () => {
    await render(wrap(<Probe />));
    await waitFor(() => expect(business.selected?.id).toBe(1));
    let failOld!: (error: Error) => void;
    get.mockReturnValueOnce(new Promise((_resolve, reject) => { failOld = reject; }))
      .mockResolvedValueOnce([fixtures.businessProfile]);
    let older!: Promise<void>;
    await act(() => { older = business.refresh(); });
    older.catch(() => undefined);
    await act(async () => { await business.refresh(); });
    await act(async () => { failOld(new Error("Old list connection failed")); await older.catch(() => undefined); });
    expect(business.profiles).toEqual([fixtures.businessProfile]);
    expect(business.error).toBeNull();
    expect(business.loading).toBe(false);
  });

  it("keeps the selected business and categories loaded when the same owner saves a name or avatar", async () => {
    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(q.getByText("First business stock")).toBeTruthy());
    await act(() => business.selectProfile(2));
    await waitFor(() => expect(q.getByText("Second business rent")).toBeTruthy());
    const selected = business.selected;
    const profiles = business.profiles;
    const categories = business.categories;
    get.mockClear(); recordLoading.mockClear();

    user = { ...user, firstName: "Updated owner", avatarUrl: "https://images.example.test/new-avatar.jpg" };
    await q.rerender(wrap(<Probe />));

    expect(get).not.toHaveBeenCalled();
    expect(recordLoading).not.toHaveBeenCalledWith(true);
    expect(business.loading).toBe(false);
    expect(business.profiles).toBe(profiles);
    expect(business.selected).toBe(selected);
    expect(business.categories).toBe(categories);
    expect(q.getByText("Second business rent")).toBeTruthy();
  });

  it("reloads businesses and replaces scoped categories when a different owner becomes active", async () => {
    const q = await render(wrap(<Probe />));
    await waitFor(() => expect(q.getByText("First business stock")).toBeTruthy());
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    get.mockClear(); recordLoading.mockClear();
    get.mockImplementation((path: string, query?: { businessProfileId: number }) => path === "/business-profiles"
      ? pending : Promise.resolve(query?.businessProfileId === 3 ? [{ id: 30, name: "Other owner's rent" }] : []));
    user = { id: 2, firstName: "Other owner", avatarUrl: null };

    await q.rerender(wrap(<Probe />));
    expect(get.mock.calls.filter(([path]) => path === "/business-profiles")).toHaveLength(1);
    expect(recordLoading).toHaveBeenCalledWith(true);
    expect(business.loading).toBe(true);
    expect(q.queryByText("First business stock")).toBeNull();

    const otherBusiness = { ...fixtures.businessProfile, id: 3, name: "Other owner's business" };
    await act(() => finish([otherBusiness]));
    await waitFor(() => expect(q.getByText("Other owner's rent")).toBeTruthy());
    expect(business.loading).toBe(false);
    expect(business.profiles).toEqual([otherBusiness]);
    expect(business.selected?.id).toBe(3);
    expect(business.categories.map((category) => category.id)).toEqual([30]);
    expect(q.queryByText("First business stock")).toBeNull();
  });
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
