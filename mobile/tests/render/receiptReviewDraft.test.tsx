import { testScreen } from "./support/screen";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert, type AlertButton } from "react-native";
import * as fixtures from "./support/fixtures";

const memory = vi.hoisted(() => ({ values: new Map<string, string>(), failSet: false }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "deviceOnly",
  getItemAsync: async (key: string) => memory.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (memory.failSet && key.startsWith("finsight.receiptReview.")) throw new Error("Synthetic storage failure");
    memory.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => { memory.values.delete(key); },
}));

const upload = vi.fn();
const post = vi.fn();
const get = vi.fn();
const poll = vi.fn();
const gallery = vi.fn();
let selectedBusiness = fixtures.businessProfile;
let ownerId = 17;
vi.mock("../../src/lib/api", () => ({
  api: { upload, post, get, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getFieldErrors: () => ({}),
}));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: gallery }));
vi.mock("../../src/lib/analysisImage", () => ({ analysisImageUri: async (uri: string) => uri }));
vi.mock("../../src/lib/localFileSize", () => ({ localFileByteSize: async () => 2048 }));
vi.mock("../../src/lib/receiptScannerCache", () => ({ deleteReceiptScannerFiles: vi.fn(async () => 0), clearReceiptScannerCache: vi.fn(async () => 0) }));
vi.mock("../../src/components/receipt-camera", () => ({ ReceiptCamera: () => null }));
vi.mock("@react-navigation/native", () => ({ useFocusEffect: (effect: () => (() => void)) => React.useEffect(effect, [effect]) }));
vi.mock("../../src/context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedBusiness, categories: fixtures.categories, createCategory: vi.fn(), refreshCategories: vi.fn() }),
}));
vi.mock("../../src/context/AuthContext", () => ({ useAuth: () => ({ profile: { id: ownerId } }) }));
vi.mock("../../src/screens/records/scanReceipt/helpers", async (importOriginal) => ({ ...(await importOriginal<object>()), pollUntilRead: poll }));
vi.mock("../../src/components/DateField", async () => {
  const { Field } = await import("../../src/components/ui");
  return { DateField: ({ label, value, onChange }: any) => <Field label={label} value={value} onChangeText={onChange} /> };
});
const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { ScanReceiptScreen: TypedScanReceiptScreen } = await import("../../src/screens/records/ScanReceiptScreen");
const ScanReceiptScreen = testScreen(TypedScanReceiptScreen);
const { saveReceiptReviewDraft, readReceiptReviewDraft } = await import("../../src/lib/receiptReviewDraft");

const accepted = { id: 41, businessProfileId: 1, receiptBatchId: null, receiptOrdinal: null, scanRevision: 0, processingStatus: "Processing", confirmationStatus: "Pending", items: [] };
const complete = { ...accepted, processingStatus: "Complete", extractedDate: "2026-09-01", extractedVendor: "Supplier", extractedDescription: "Coffee beans", extractedAmount: 250, items: [{ id: 5, name: "Coffee beans", amount: 250, categoryId: 10 }], warnings: [], ocrConfidence: 96 };
const draftKey = (owner = 17, business = 1, scan = 41) => `finsight.receiptReview.${owner}.${business}.${scan}`;

type RemovalListener = (event: { preventDefault: () => void; data: { action: unknown } }) => void;
function makeNavigation() {
  const listeners = new Set<RemovalListener>();
  return {
    navigate: vi.fn(),
    goBack: vi.fn(),
    dispatch: vi.fn(),
    addListener: vi.fn((name: string, listener: RemovalListener) => {
      if (name === "beforeRemove") listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    /** What React Navigation does when the owner presses back. */
    attemptRemoval() {
      const event = { preventDefault: vi.fn(), data: { action: { type: "POP" } } };
      for (const listener of listeners) listener(event);
      return event;
    },
  };
}

function lastAlertButton(text: string): AlertButton {
  const calls = vi.mocked(Alert.alert).mock.calls;
  const buttons = calls[calls.length - 1]?.[2] ?? [];
  const button = buttons.find((candidate) => candidate.text === text);
  if (!button) throw new Error(`No alert button "${text}"`);
  return button;
}

async function openReview(navigation = makeNavigation()) {
  const q = await render(<ThemeProvider initialMode="light"><ScanReceiptScreen navigation={navigation} /></ThemeProvider>);
  await fireEvent.press(q.getByRole("button", { name: "Choose a photo from your gallery" }));
  await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
  await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
  await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
  return { q, navigation };
}

beforeEach(() => {
  memory.values.clear();
  memory.failSet = false;
  selectedBusiness = fixtures.businessProfile;
  ownerId = 17;
  upload.mockReset(); post.mockReset(); get.mockReset(); poll.mockReset(); gallery.mockReset();
  vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
  vi.mocked(Alert.alert).mockClear();
  gallery.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///receipt.jpg", width: 600, height: 1000, fileName: "receipt.jpg", mimeType: "image/jpeg", fileSize: 2048 }] });
  upload.mockImplementation(async (path: string) => path.endsWith("quality-check") ? { sharpness: 50, brightness: 150, tooBlurredToTrust: false } : accepted);
  get.mockImplementation(async (path: string) => {
    if (path.includes("provider-consent")) return { available: false, provider: null, consent: null, activeConsents: [] };
    if (path === "/records/receipts") return { items: [], nextCursor: null };
    return complete;
  });
  poll.mockImplementation(async () => complete);
  post.mockResolvedValue({});
});

describe("unsaved receipt review changes", () => {
  it("lets the owner leave without a prompt when nothing was changed", async () => {
    const { navigation } = await openReview();
    const event = navigation.attemptRemoval();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("holds navigation while there are edits, and Keep editing leaves the form as typed", async () => {
    const { q, navigation } = await openReview();
    await fireEvent.changeText(q.getByLabelText("Description"), "Coffee beans, 2 bags");
    const event = navigation.attemptRemoval();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(vi.mocked(Alert.alert).mock.calls[0]![0]).toBe("Discard your receipt changes?");
    await act(() => { lastAlertButton("Keep editing").onPress?.(); });
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(q.getByLabelText("Description").props.value).toBe("Coffee beans, 2 bags");
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(true));
  });

  it("Discard changes clears the stored draft and lets the removal through", async () => {
    const { q, navigation } = await openReview();
    await fireEvent.changeText(q.getByLabelText("Vendor"), "Corner Store");
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(true));
    const event = navigation.attemptRemoval();
    await act(() => { lastAlertButton("Discard changes").onPress?.(); });
    expect(navigation.dispatch).toHaveBeenCalledWith(event.data.action);
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(false));
  });

  it("restores the owner's changes after the screen is remounted, says so, and can discard them", async () => {
    const first = await openReview();
    await fireEvent.changeText(first.q.getByLabelText("Description"), "Coffee beans, 2 bags");
    await fireEvent.changeText(first.q.getByLabelText("Amount (PHP)"), "260.00");
    await waitFor(async () => expect((await readReceiptReviewDraft({ ownerId: 17, businessProfileId: 1, scanId: 41 }))?.amount).toBe("260.00"));
    await first.q.unmount();

    const { q } = await openReview();
    await waitFor(() => expect(q.getByText("Your unsaved changes were restored")).toBeTruthy());
    expect(q.getByLabelText("Description").props.value).toBe("Coffee beans, 2 bags");
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("260.00");

    await fireEvent.press(q.getByRole("button", { name: "Discard restored changes and show the scanned values" }));
    expect(q.getByLabelText("Description").props.value).toBe("Coffee beans");
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.00");
    expect(q.queryByText("Your unsaved changes were restored")).toBeNull();
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(false));
  });

  it("does not restore another account's or another business's draft for the same scan", async () => {
    const edits = { date: "2026-09-01", description: "Someone else's change", vendor: "Supplier", amount: "999.00", categoryId: 10, itemCategories: { 5: 10 }, addedItems: [], plan: null, gapCategoryId: null, editingItem: null };
    await saveReceiptReviewDraft({ ownerId: 18, businessProfileId: 1, scanId: 41 }, edits);
    await saveReceiptReviewDraft({ ownerId: 17, businessProfileId: 2, scanId: 41 }, edits);
    const { q } = await openReview();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(q.getByLabelText("Description").props.value).toBe("Coffee beans");
    expect(q.queryByText("Your unsaved changes were restored")).toBeNull();
  });

  it("clears the draft once the receipt is confirmed and leaves without prompting", async () => {
    const { q, navigation } = await openReview();
    await fireEvent.changeText(q.getByLabelText("Description"), "Coffee beans, 2 bags");
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(true));
    navigation.goBack.mockImplementation(() => { navigation.attemptRemoval(); });
    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(Alert.alert).not.toHaveBeenCalled();
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(false));
  });

  it("starts empty on the next visit when leaving after a confirm keeps the screen mounted", async () => {
    // From the plus button the screen can be alone on the Records stack, and
    // goBack then switches tabs without unmounting it.
    const { q, navigation } = await openReview();
    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(q.queryByRole("button", { name: "Save this expense" })).toBeNull());
    expect(q.getByRole("button", { name: "Choose a photo from your gallery" })).toBeTruthy();
  });

  it("asks before Retake photo throws edits away, and keeps them on Keep editing", async () => {
    const { q } = await openReview();
    await fireEvent.changeText(q.getByLabelText("Description"), "Coffee beans, 2 bags");
    await fireEvent.press(q.getByRole("button", { name: "Retake photo" }));
    await act(() => { lastAlertButton("Keep editing").onPress?.(); });
    expect(q.getByLabelText("Description").props.value).toBe("Coffee beans, 2 bags");
    await fireEvent.press(q.getByRole("button", { name: "Retake photo" }));
    await act(() => { lastAlertButton("Discard changes").onPress?.(); });
    await waitFor(() => expect(q.getByRole("button", { name: "Scan receipt" })).toBeTruthy());
    await waitFor(() => expect(memory.values.has(draftKey())).toBe(false));
  });

  it("keeps on-screen input and says so when device storage refuses the draft", async () => {
    memory.failSet = true;
    const { q } = await openReview();
    await fireEvent.changeText(q.getByLabelText("Description"), "Coffee beans, 2 bags");
    await waitFor(() => expect(q.getByText(/couldn't keep a copy of your changes/)).toBeTruthy());
    expect(q.getByLabelText("Description").props.value).toBe("Coffee beans, 2 bags");
    expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled();
  });
});
