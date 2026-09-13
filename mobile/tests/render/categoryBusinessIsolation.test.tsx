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
});
