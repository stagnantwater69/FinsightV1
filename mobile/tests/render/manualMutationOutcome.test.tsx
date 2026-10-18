import { testScreen } from "./support/screen";
import React from "react";
import { Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";
import type { BusinessProfile } from "../../src/lib/types";
import * as fixtures from "./support/fixtures";

const post = vi.fn(); const navigate = vi.fn(); const push = vi.fn(); const goBack = vi.fn();
let selected: BusinessProfile; let ownerId = 17;
const focusSetters = new Set<React.Dispatch<React.SetStateAction<boolean>>>();
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const [focused, setFocused] = React.useState(true);
    React.useEffect(() => { focusSetters.add(setFocused); return () => { focusSetters.delete(setFocused); }; }, []);
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));
vi.mock("../../src/context/AuthContext", () => ({ useAuth: () => ({ profile: { id: ownerId } }) }));
vi.mock("../../src/context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected, categories: fixtures.categories, refreshCategories: vi.fn() }) }));
vi.mock("../../src/lib/api", () => ({
  api: { get: vi.fn(async () => ({ origin: null })), post },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : "Request failed.",
}));
vi.mock("../../src/components/DateField", () => ({ DateField: () => null }));
const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { AddExpenseScreen: TypedAddExpenseScreen } = await import("../../src/screens/records/AddExpenseScreen");
const AddExpenseScreen = testScreen(TypedAddExpenseScreen);
const { AddSalesScreen: TypedAddSalesScreen } = await import("../../src/screens/records/AddSalesScreen");
const AddSalesScreen = testScreen(TypedAddSalesScreen);
const { prepareManualRecordIntent } = await import("../../src/lib/manualRecordRecovery");

const cases = [["expense", AddExpenseScreen, "Save expense"], ["sales", AddSalesScreen, "Save sales record"]] as const;
beforeEach(() => {
  selected = { ...fixtures.businessProfile, id: 1 }; ownerId = 17; focusSetters.clear();
  post.mockReset(); navigate.mockReset(); push.mockReset(); goBack.mockReset();
  (SecureStore as unknown as { __reset: () => void }).__reset();
});
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });
const result = (kind: string) => ({ id: 91, businessProfileId: 1, type: kind });

async function ready(kind: string, Component: typeof AddExpenseScreen) {
  const tree = () => <ThemeProvider initialMode="light"><Component navigation={{ navigate, push, goBack }} /></ThemeProvider>;
  const q = await render(tree());
  await waitFor(() => expect(q.getByLabelText("Description").props.editable).toBe(true));
  if (kind === "expense") {
    await fireEvent.press(q.getByRole("button", { name: "Choose a category, category" }));
    await fireEvent.press(q.getByRole("button", { name: "Stock" }));
  }
  await fireEvent.changeText(q.getByLabelText("Description"), "Synthetic owner reviewed record");
  await fireEvent.changeText(q.getByLabelText("Amount (PHP)"), "250.50");
  return { q, tree };
}
async function approveRetry(q: Awaited<ReturnType<typeof render>>, alert: ReturnType<typeof vi.spyOn>) {
  await fireEvent.press(q.getByRole("button", { name: "Retry previous save" }));
  const choices = alert.mock.calls.at(-1)![2] as NonNullable<Parameters<typeof Alert.alert>[2]>;
  await act(async () => choices.find((choice) => choice.text === "Retry previous save")!.onPress?.());
}

describe.each(cases)("durable %s creation", (kind, Component, saveLabel) => {
  it("retains its keyed request after blurring and restores it when focused again", async () => {
    let finish!: (value: unknown) => void;
    post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { q } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const first = post.mock.calls[0]![1]; const signal = post.mock.calls[0]![2].signal as AbortSignal;
    await act(() => { for (const focused of focusSetters) focused(false); });
    expect(signal.aborted).toBe(true);
    await act(() => finish(result(kind))); expect(goBack).not.toHaveBeenCalled();
    await act(() => { for (const focused of focusSetters) focused(true); });
    await waitFor(() => expect(q.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
    post.mockResolvedValueOnce(result(kind)); await approveRetry(q, alert);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2)); expect(post.mock.calls[1]![1]).toEqual(first);
  });

  it.each([0, 408, 500, 503, "unreadable"])("retries the immutable keyed request after unconfirmed %s without permitting edits", async (outcome) => {
    const error = outcome === "unreadable" ? new SyntaxError("Unexpected end of JSON input") : Object.assign(new Error("Request result unavailable"), { status: outcome });
    post.mockRejectedValueOnce(error).mockResolvedValueOnce(result(kind));
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { q } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    const first = post.mock.calls[0]![1]; expect(first.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(q.getByLabelText("Description").props.value).toBe("Synthetic owner reviewed record");
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
    expect(q.getByLabelText("Amount (PHP)").props.editable).toBe(false);
    expect(q.getByRole("button", { name: saveLabel })).toBeDisabled(); expect(goBack).not.toHaveBeenCalled();
    await approveRetry(q, alert);
    expect(alert).toHaveBeenCalledWith("Check records before saving again", expect.any(String), expect.any(Array), expect.objectContaining({ cancelable: true }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2)); expect(post.mock.calls[1]![1]).toEqual(first);
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1));
  });

  it.each([400, 429])("allows a definite first %s rejection to be corrected using a new key", async (status) => {
    const message = status === 429 ? "Too many requests. Try again in 9s." : "Amount is invalid";
    post.mockRejectedValueOnce(Object.assign(new Error(message), { status })).mockResolvedValueOnce(result(kind));
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { q } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => {
      expect(q.getByText(`${message} Everything you entered is still here.`)).toBeTruthy();
      expect(q.getByRole("button", { name: saveLabel })).toBeEnabled();
    });
    expect(q.getByLabelText("Description").props.value).toBe("Synthetic owner reviewed record");
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
    expect(q.getByLabelText("Amount (PHP)").props.editable).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(goBack).not.toHaveBeenCalled();
    await fireEvent.changeText(q.getByLabelText("Amount (PHP)"), "300"); await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2)); expect(post.mock.calls[1]![1].amount).toBe(300);
    expect(post.mock.calls[1]![1].idempotencyKey).not.toBe(post.mock.calls[0]![1].idempotencyKey); expect(alert).not.toHaveBeenCalled();
  });

  it("opens records and preserves entered values without dispatching another create", async () => {
    post.mockRejectedValueOnce(Object.assign(new Error("Unknown result"), { status: 0 }));
    const { q, tree } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check records" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Check records" }));
    expect(push).toHaveBeenCalledWith("RecordsList"); expect(post).toHaveBeenCalledTimes(1); await q.rerender(tree());
    expect(q.getByLabelText("Description").props.value).toBe("Synthetic owner reviewed record"); expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
  });

  it.each(["business", "owner"])("rejects an old retry dialog after changing %s", async (changed) => {
    post.mockRejectedValueOnce(Object.assign(new Error("Unknown result"), { status: 0 }));
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { q, tree } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Retry previous save" }));
    const retry = alert.mock.calls.at(-1)![2]!.find((choice) => choice.text === "Retry previous save")!;
    if (changed === "business") selected = { ...selected, id: 2 }; else ownerId = 18;
    await q.rerender(tree()); await act(async () => retry.onPress?.());
    expect(post).toHaveBeenCalledTimes(1); expect(goBack).not.toHaveBeenCalled(); expect(q.getByLabelText("Amount (PHP)").props.value).toBe("");
  });

  it("does not send a create when recovery persistence fails", async () => {
    vi.spyOn(SecureStore, "setItemAsync").mockRejectedValue(new Error("Synthetic storage unavailable"));
    const { q } = await ready(kind, Component); await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByText(/Nothing was sent/)).toBeTruthy()); expect(post).not.toHaveBeenCalled();
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
  });

  it("keeps a confirmed save confirmed after cleanup failure and retries cleanup with zero additional POST", async () => {
    const deletion = vi.spyOn(SecureStore, "deleteItemAsync").mockRejectedValueOnce(new Error("Synthetic cleanup unavailable"));
    post.mockResolvedValueOnce(result(kind)); const { q } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Clear previous request" })).toBeEnabled());
    expect(q.getByText(/Save confirmed/)).toBeTruthy(); expect(post).toHaveBeenCalledTimes(1); expect(goBack).not.toHaveBeenCalled();
    deletion.mockRestore(); await fireEvent.press(q.getByRole("button", { name: "Clear previous request" }));
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1)); expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps confirmed identity on focus return when pointer deletion succeeded but chunk cleanup failed", async () => {
    const remove = SecureStore.deleteItemAsync;
    let failed = false;
    vi.spyOn(SecureStore, "deleteItemAsync").mockImplementation(async (key, options) => {
      if (!failed && key.startsWith(`finsight.manual.17.1.${kind}.`) && key.endsWith(".0")) { failed = true; throw new Error("Synthetic chunk cleanup failure"); }
      return remove(key, options);
    });
    post.mockResolvedValueOnce(result(kind)); const { q } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Clear previous request" })).toBeEnabled());
    await act(() => { for (const focused of focusSetters) focused(false); });
    await act(() => { for (const focused of focusSetters) focused(true); });
    await waitFor(() => expect(q.getByRole("button", { name: "Clear previous request" })).toBeEnabled());
    expect(q.getByText(/Save confirmed/)).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Clear previous request" }));
    await waitFor(() => expect(goBack).toHaveBeenCalledTimes(1)); expect(post).toHaveBeenCalledTimes(1);
  });

  it("holds a later unsent draft when a pending request is discovered during preparation", async () => {
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { q } = await ready(kind, Component);
    const earlier = { businessProfileId: 1, date: "2026-10-10", description: "Earlier synthetic request", amount: 100, ...(kind === "expense" ? { categoryId: 10 } : {}) };
    await prepareManualRecordIntent({ ownerId: 17, businessProfileId: 1, kind }, earlier, { date: earlier.date, description: earlier.description, amount: "100", ...(kind === "expense" ? { categoryId: 10, vendor: "" } : {}) });
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    expect(post).not.toHaveBeenCalled(); expect(q.getByLabelText("Amount (PHP)").props.value).toBe("100");
    await fireEvent.press(q.getByRole("button", { name: "Start a new record" }));
    await act(async () => alert.mock.calls.at(-1)![2]!.find((choice) => choice.text === "I checked; start new")!.onPress?.());
    await waitFor(() => expect(q.getByRole("button", { name: saveLabel })).toBeEnabled());
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
    expect(q.getByLabelText("Description").props.value).toBe("Synthetic owner reviewed record"); expect(post).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429])("retains an unknown request across remount and later %s rejection", async (status) => {
    post.mockRejectedValueOnce(Object.assign(new Error("Lost response"), { status: 0 }));
    const alert = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    const { q, tree } = await ready(kind, Component); await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    const first = post.mock.calls[0]![1]; await q.unmount(); const restored = await render(tree());
    await waitFor(() => expect(restored.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    expect(restored.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
    post.mockRejectedValueOnce(Object.assign(new Error("Later rejection"), { status })); await approveRetry(restored, alert);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2)); expect(post.mock.calls[1]![1]).toEqual(first);
    await waitFor(() => expect(restored.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    await restored.unmount(); const again = await render(tree());
    await waitFor(() => expect(again.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    expect(again.getByLabelText("Amount (PHP)").props.value).toBe("250.50"); expect(post).toHaveBeenCalledTimes(2);
  });

  it("keeps a malformed successful response unconfirmed", async () => {
    post.mockResolvedValueOnce({ id: 91 }); const { q } = await ready(kind, Component);
    await fireEvent.press(q.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(q.getByRole("button", { name: "Retry previous save" })).toBeEnabled());
    expect(goBack).not.toHaveBeenCalled(); expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.50");
  });
});
