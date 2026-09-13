import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Image } from "react-native";
import * as fixtures from "./support/fixtures";
import { RECEIPT_UPLOAD_MAX_OBJECT_BYTES } from "../../src/lib/receiptUploadContract";

const upload = vi.fn();
const post = vi.fn();
const get = vi.fn();
const put = vi.fn();
const remove = vi.fn();
const poll = vi.fn();
const gallery = vi.fn();
const document = vi.fn();
const localFileByteSize = vi.fn();
let selectedBusiness = fixtures.businessProfile;
vi.mock("../../src/lib/api", () => ({ api: { upload, post, get, put, delete: remove } }));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: gallery }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: document }));
vi.mock("../../src/lib/analysisImage", () => ({ analysisImageUri: async (uri: string) => uri }));
vi.mock("../../src/lib/localFileSize", () => ({ localFileByteSize }));
vi.mock("../../src/components/receipt-camera", async () => {
  const ReactRuntime = await import("react");
  const { Pressable, Text } = await import("react-native");
  return {
    ReceiptCamera: ({ onDone }: any) => ReactRuntime.createElement(
      Pressable,
      {
        accessibilityRole: "button",
        accessibilityLabel: "Finish mocked camera with unsupported evidence",
        onPress: () => onDone([{
          localId: "mocked-unsupported",
          originalUri: "file:///converted.gif",
          originalMimeType: "image/gif",
          processedUri: "file:///converted.gif",
          processedMimeType: "image/gif",
          width: 600,
          height: 1000,
          quality: null,
          captureSource: "gallery",
          processingMode: "original",
        }]),
      },
      ReactRuntime.createElement(Text, null, "Finish mocked camera with unsupported evidence"),
    ),
  };
});
vi.mock("@react-navigation/native", () => ({ useFocusEffect: (effect: () => (() => void)) => React.useEffect(effect, [effect]) }));
vi.mock("../../src/context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: selectedBusiness, categories: fixtures.categories, createCategory: vi.fn(), refreshCategories: vi.fn() }),
}));
vi.mock("../../src/screens/records/scanReceipt/helpers", async (importOriginal) => ({ ...(await importOriginal<object>()), pollUntilRead: poll }));
vi.mock("../../src/components/DateField", async () => {
  const { Field } = await import("../../src/components/ui");
  return { DateField: ({ label, value, onChange }: any) => <Field label={label} value={value} onChangeText={onChange} /> };
});
const { ThemeProvider } = await import("../../src/context/ThemeContext");
const { ScanReceiptScreen } = await import("../../src/screens/records/ScanReceiptScreen");
const { ImportCsvScreen } = await import("../../src/screens/records/ImportCsvScreen");
const { AddExpenseScreen } = await import("../../src/screens/records/AddExpenseScreen");
const navigation = { navigate: vi.fn(), goBack: vi.fn() };
const wrapInMode = (node: React.ReactNode, mode: "light" | "dark") => <ThemeProvider initialMode={mode}>{node}</ThemeProvider>;
const wrap = (node: React.ReactNode) => wrapInMode(node, "light");
const accepted = { id: 41, processingStatus: "Processing" };
const complete = { id: 41, processingStatus: "Complete", extractedDate: "2026-09-01", extractedVendor: "Supplier", extractedDescription: "Coffee beans", extractedAmount: 250, items: [{ id: 5, name: "Coffee beans", amount: 250, categoryId: 10 }], warnings: [], ocrConfidence: 96 };
const unavailableConsent = { available: false, provider: null, consent: null, activeConsents: [] };
const providerTerms = {
  key: "gemini",
  label: "Google Gemini",
  version: "gemini-3.5-flash-lite",
  region: "global",
  policyVersion: "receipt-provider-policy-v1",
  purpose: "RECEIPT_EXTRACTION",
  dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
  retentionHours: 0,
  trainingAllowed: false,
  revocable: true,
};
const availableConsent = { available: true, provider: providerTerms, consent: null, activeConsents: [] };
const grantedConsent = {
  ...availableConsent,
  consent: { reference: "consent:9", grantedAt: "2026-09-13T08:00:00.000Z", revokedAt: null },
  activeConsents: [{
    reference: "consent:9",
    provider: "gemini",
    policyVersion: providerTerms.policyVersion,
    purpose: providerTerms.purpose,
    dataClasses: providerTerms.dataClasses,
    region: providerTerms.region,
    retentionHours: providerTerms.retentionHours,
    trainingAllowed: false,
    grantedAt: "2026-09-13T08:00:00.000Z",
    revocable: true,
  }],
};

// Same handler lookup that RN Testing Library uses for composite Pressables,
// invoked within a single act so React cannot render between the two taps.
function pressHandler(button: ReturnType<Awaited<ReturnType<typeof render>>["getByRole"]>): () => void {
  let fiber = button.unstable_fiber;
  while (fiber) {
    if (typeof fiber.memoizedProps?.onPress === "function") return fiber.memoizedProps.onPress;
    fiber = fiber.return;
  }
  throw new Error("Button has no press handler");
}
beforeEach(() => {
  selectedBusiness = fixtures.businessProfile;
  upload.mockReset(); post.mockReset(); get.mockReset(); put.mockReset(); remove.mockReset(); poll.mockReset(); gallery.mockReset(); document.mockReset(); localFileByteSize.mockReset(); navigation.navigate.mockReset(); navigation.goBack.mockReset();
  gallery.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///receipt.jpg", width: 600, height: 1000, fileName: "receipt.jpg", mimeType: "image/jpeg", fileSize: 2048 }] });
  document.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///records.csv", name: "records.csv", size: 1024, mimeType: "text/csv" }] });
  upload.mockImplementation(async (path: string) => path.endsWith("quality-check") ? { sharpness: 50, brightness: 150, tooBlurredToTrust: false } : accepted);
  get.mockResolvedValue(unavailableConsent);
  put.mockResolvedValue(grantedConsent);
  remove.mockResolvedValue(availableConsent);
  localFileByteSize.mockResolvedValue(2048);
  poll.mockResolvedValue(complete);
  post.mockResolvedValue({});
});

async function readyReceipt() {
  const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
  await fireEvent.press(q.getByRole("button", { name: "Choose a photo from your gallery" }));
  await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
  return q;
}

describe("receipt scan review workflow", () => {
  it("does not navigate or retain a manual expense draft after a business switch during save", async () => {
    let finishSave!: (value: unknown) => void;
    post.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    const q = await render(wrap(<AddExpenseScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a category, category" }));
    await fireEvent.press(q.getByRole("button", { name: "Stock" }));
    await fireEvent.changeText(q.getByLabelText("Description"), "Coffee beans");
    await fireEvent.changeText(q.getByLabelText("Amount (PHP)"), "250");
    await act(() => { pressHandler(q.getByRole("button", { name: "Save expense" }))(); });
    expect(post).toHaveBeenCalledWith("/records/expenses", expect.objectContaining({ businessProfileId: 1, categoryId: 10 }));
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap(<AddExpenseScreen navigation={navigation} />));
    await act(() => finishSave({ id: 90 }));
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(q.getByLabelText("Description").props.value).toBe("");
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("");
    expect(q.getByRole("button", { name: "Choose a category, category" })).toBeTruthy();
  });

  it("blocks same-frame upload and save double taps", async () => {
    let finishUpload!: (value: unknown) => void;
    upload.mockImplementation(async (path: string) => path.endsWith("quality-check") ? {} : new Promise((resolve) => { finishUpload = resolve; }));
    const q = await readyReceipt();
    // Invoke the component's callback twice before React renders busy=true.
    // RN's host Pressable exposes responder callbacks, not onPress itself.
    const start = pressHandler(q.getByRole("button", { name: "Scan this receipt" }));
    await act(() => { start(); start(); });
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(1);
    await act(() => finishUpload(accepted));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    let finishSave!: () => void;
    post.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    const save = pressHandler(q.getByRole("button", { name: "Save this expense" }));
    await act(() => { save(); save(); });
    expect(post).toHaveBeenCalledTimes(1);
    await act(() => finishSave());
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it("cancels waiting and ignores the late upload result without losing photos", async () => {
    let finishUpload!: (value: unknown) => void;
    upload.mockImplementation(async (path: string) => path.endsWith("quality-check") ? {} : new Promise((resolve) => { finishUpload = resolve; }));
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Cancel upload" })).toBeTruthy());
    const task = upload.mock.calls.find(([path]) => path === "/records/receipts")!;
    await fireEvent.press(q.getByRole("button", { name: "Cancel upload" }));
    expect(task[2].aborted).toBe(true);
    await act(() => finishUpload(accepted));
    expect(poll).not.toHaveBeenCalled();
    expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled();
  });

  it("discards a late receipt upload when the active business changes", async () => {
    let finishUpload!: (value: unknown) => void;
    upload.mockImplementation(async (path: string) => path.endsWith("quality-check") ? {} : new Promise((resolve) => { finishUpload = resolve; }));
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    const task = upload.mock.calls.find(([path]) => path === "/records/receipts")!;
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap(<ScanReceiptScreen navigation={navigation} />));
    expect(task[2].aborted).toBe(true);
    await act(() => finishUpload(accepted));
    expect(poll).not.toHaveBeenCalled();
    expect(q.queryByRole("button", { name: "Save this expense" })).toBeNull();
    expect(q.getByRole("button", { name: "Choose a photo from your gallery" })).toBeEnabled();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it.each(["file:///cache/receipt.PNG", "content://documents/receipt/123"])("uploads a supported Files image from %s", async (uri) => {
    const size = vi.spyOn(Image, "getSize").mockImplementation(async () => ({ width: 600, height: 1000 }));
    const append = vi.spyOn(FormData.prototype, "append");
    document.mockResolvedValue({ canceled: false, assets: [{ uri, name: "receipt.PNG", mimeType: "application/octet-stream", size: 1500 }] });
    try {
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      await fireEvent.press(q.getByRole("button", { name: "Choose a receipt from Files" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
      expect(size).toHaveBeenCalledWith(uri);
      await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
      expect(append).toHaveBeenCalledWith("files", { uri, name: "receipt.PNG", type: "image/png" });
    } finally {
      size.mockRestore();
      append.mockRestore();
    }
  });

  it("resumes an accepted scan without uploading it again after polling fails", async () => {
    poll.mockRejectedValueOnce(new Error("Network interrupted"));
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.00");
  });

  it("reuses the same upload replay key after a lost upload response", async () => {
    let attempt = 0;
    upload.mockImplementation(async (path: string) => {
      if (path.endsWith("quality-check")) return {};
      if (++attempt === 1) throw new Error("Connection lost");
      return accepted;
    });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    const sends = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(sends).toHaveLength(2);
    expect(sends[0]![1].get("idempotencyKey")).toBeTruthy();
    expect(sends[0]![1].get("idempotencyKey")).toBe(sends[1]![1].get("idempotencyKey"));
  });

  it("never defaults an unreadable receipt date to today", async () => {
    poll.mockResolvedValue({ ...complete, extractedDate: null });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByLabelText("Date").props.value).toBe(""));
    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    expect(q.getByText("Enter the date printed on the receipt.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("blocks foreign-currency confirmation and offers manual PHP entry", async () => {
    poll.mockResolvedValue({ ...complete, receiptDetails: { currency: "USD", subtotal: 250, transactionTime: null, tax: null, tip: null, discount: null, paymentMethod: null, receiptNumber: null } });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByText(/This receipt is in USD/)).toBeTruthy());
    expect(q.queryByRole("button", { name: "Save this expense" })).toBeNull();
    expect(q.queryByLabelText("Amount (PHP)")).toBeNull();
    expect(q.getByText("As printed on the receipt")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Enter expense manually" }));
    expect(navigation.navigate).toHaveBeenCalledWith("AddExpense");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects unsupported receipt files before contacting the server", async () => {
    document.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///receipt.pdf", name: "receipt.pdf", mimeType: "application/pdf", size: 1500 }] });
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a receipt from Files" }));
    await waitFor(() => expect(q.getByText(/PDF receipts are not supported/)).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps mocked oversized gallery evidence available for review or removal and never uploads it", async () => {
    localFileByteSize.mockResolvedValue(RECEIPT_UPLOAD_MAX_OBJECT_BYTES + 1);
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a photo from your gallery" }));
    await waitFor(() => expect(q.getByText(/larger than 10 MiB/)).toBeTruthy());
    expect(q.getByRole("button", { name: "Remove page 1" })).toBeTruthy();
    expect(q.getByRole("button", { name: "Review photos" })).toBeTruthy();
    expect(q.getByText("⚠ Can't upload yet")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();

    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Remove page 1" })).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
    expect(localFileByteSize).toHaveBeenCalledWith("file:///receipt.jpg");

    await fireEvent.press(q.getByRole("button", { name: "Remove page 1" }));
    expect(q.getByRole("button", { name: "Choose a photo from your gallery" })).toBeEnabled();
  });

  it("keeps mocked converted evidence when its media type is unsupported", async () => {
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Scan receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByText(/not a JPG, PNG, or WebP/)).toBeTruthy());
    expect(q.getByText("⚠ Can't upload yet")).toBeTruthy();
    expect(q.getByRole("button", { name: "Review photos" })).toBeEnabled();
    expect(q.getByRole("button", { name: "Remove page 1" })).toBeEnabled();
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(0);
  });

  it("uploads mocked local evidence at the exact 10 MiB object boundary", async () => {
    localFileByteSize.mockResolvedValue(RECEIPT_UPLOAD_MAX_OBJECT_BYTES);
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(1);
  });

  describe("mocked optional provider consent UI, not physical camera evidence", () => {
    it("announces while optional settings load without blocking receipt capture", async () => {
      get.mockReturnValue(new Promise(() => {}));
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      const loadingText = q.getByText("Checking optional cloud receipt settings…");
      expect(loadingText.parent?.props.accessibilityLiveRegion).toBe("polite");
      expect(q.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
    });

    it("shows no grant control when the backend disables the optional provider", async () => {
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(q.queryByText("Checking optional cloud receipt settings…")).toBeNull());
      expect(q.queryByRole("button", { name: "Allow optional cloud help" })).toBeNull();
      expect(q.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
    });

    it.each(["light", "dark"] as const)("renders the exact disclosure in %s mode", async (mode) => {
      get.mockResolvedValue(availableConsent);
      const q = await render(wrapInMode(<ScanReceiptScreen navigation={navigation} />, mode));
      await waitFor(() => expect(q.getByText(/Processing region: global/)).toBeTruthy());
      expect(q.getByText(/processed copy when one exists/)).toBeTruthy();
      expect(q.getByRole("checkbox", { name: "I allow FinSight to send these receipt images to Google Gemini under the terms above" })).toBeTruthy();
    });

    it("requires an unchecked deliberate choice and echoes the advertised terms", async () => {
      get.mockResolvedValue(availableConsent);
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      const checkbox = await waitFor(() => q.getByRole("checkbox", { name: "I allow FinSight to send these receipt images to Google Gemini under the terms above" }));
      const allow = q.getByRole("button", { name: "Allow optional cloud help" });
      expect(checkbox.props.accessibilityState.checked).toBe(false);
      expect(allow).toBeDisabled();
      expect(q.getByText(/Processing region: global/)).toBeTruthy();
      expect(q.getByText(/not allowed to use it for model training/)).toBeTruthy();

      await fireEvent.press(checkbox);
      expect(q.getByRole("button", { name: "Allow optional cloud help" })).toBeEnabled();
      await fireEvent.press(q.getByRole("button", { name: "Allow optional cloud help" }));
      await waitFor(() => expect(q.getByText("Optional cloud receipt help is allowed for these terms.")).toBeTruthy());
      expect(put).toHaveBeenCalledWith(
        "/records/receipts/provider-consent/1",
        {
          provider: "gemini",
          policyVersion: "receipt-provider-policy-v1",
          purpose: "RECEIPT_EXTRACTION",
          dataClasses: ["RECEIPT_IMAGE", "DERIVED_RECEIPT_IMAGE"],
          region: "global",
          retentionHours: 0,
          trainingAllowed: false,
        },
      );
    });

    it("keeps local scanning usable when the optional settings request fails, then retries", async () => {
      get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(availableConsent);
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(q.getByText("Optional cloud receipt settings could not be checked. Receipt capture and the standard reader remain available.")).toBeTruthy());
      expect(q.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
      await fireEvent.press(q.getByRole("button", { name: "Check optional settings again" }));
      await waitFor(() => expect(q.getByRole("checkbox", { name: "I allow FinSight to send these receipt images to Google Gemini under the terms above" })).toBeTruthy());
    });

    it("ignores mocked consent terms returned after the active business changes", async () => {
      let finishFirst!: (value: unknown) => void;
      get.mockImplementation((path: string) => path.endsWith("/1")
        ? new Promise((resolve) => { finishFirst = resolve; })
        : Promise.resolve(unavailableConsent));
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(get).toHaveBeenCalledWith("/records/receipts/provider-consent/1"));
      selectedBusiness = { ...fixtures.businessProfile, id: 2 };
      await q.rerender(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(get).toHaveBeenCalledWith("/records/receipts/provider-consent/2"));
      await act(() => finishFirst(availableConsent));
      expect(q.queryByRole("button", { name: "Allow optional cloud help" })).toBeNull();
    });

    it("keeps revoke available for an earlier consent after the provider is disabled", async () => {
      get.mockResolvedValue({ ...unavailableConsent, activeConsents: grantedConsent.activeConsents });
      remove.mockResolvedValue(unavailableConsent);
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      const revoke = await waitFor(() => q.getByRole("button", { name: "Revoke future cloud sends" }));
      expect(q.queryByRole("button", { name: "Allow optional cloud help" })).toBeNull();
      await fireEvent.press(revoke);
      await waitFor(() => expect(q.getByText(/Cloud receipt permission was revoked/)).toBeTruthy());
      expect(remove).toHaveBeenCalledWith("/records/receipts/provider-consent/1");
    });

    it("keeps an accessible revoke retry after a failed revocation", async () => {
      get.mockResolvedValue(grantedConsent);
      remove.mockRejectedValue(new Error("Permission could not be changed."));
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      const revoke = await waitFor(() => q.getByRole("button", { name: "Revoke future cloud sends" }));
      await fireEvent.press(revoke);
      await waitFor(() => expect(q.getByText(/Permission could not be changed/)).toBeTruthy());
      expect(q.getByRole("button", { name: "Revoke future cloud sends" })).toBeEnabled();
      expect(q.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
    });
  });

  it("blocks mixed printed currencies even when the extracted currency is unknown", async () => {
    poll.mockResolvedValue({ ...complete, requiresManualCurrencyConversion: true, receiptDetails: { currency: null } });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByText("Enter this receipt manually with the amount paid in PHP.")).toBeTruthy());
    expect(q.queryByRole("button", { name: "Save this expense" })).toBeNull();
    expect(q.queryByLabelText("Amount (PHP)")).toBeNull();
  });
});

describe("CSV preflight and results", () => {
  const preview = { headers: ["date", "description", "amount", "category"], previewRows: [{ date: "2026-09-01", description: "Coffee", amount: "250", category: "Stock" }], totalRows: 10, suggestedMapping: { date: "date", description: "description", amount: "amount", category: "category" } };
  async function confirmCsv() {
    const q = await render(wrap(<ImportCsvScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check the rows" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Check the rows" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Review import" })).toBeTruthy());
    await fireEvent.press(q.getByRole("button", { name: "Review import" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Import" })).toBeTruthy());
    await act(() => { pressHandler(q.getByRole("button", { name: "Import" }))(); });
    return q;
  }

  it("uses aggregate skipped counts when the server returns only some row errors", async () => {
    upload.mockImplementation(async (path: string, form: FormData) => {
      if (path.endsWith("confirm")) return { imported: 50, totalRows: 200, skipped: [{ row: 2, reason: "Invalid date" }], skippedCount: 150, skippedTruncated: true };
      if (form.get("recordType")) return { validation: { validRows: 50, invalidRows: 150, skipped: [], skippedTruncated: true } };
      return { ...preview, totalRows: 200 };
    });
    const q = await confirmCsv();
    await waitFor(() => expect(q.getByText("150 row(s) were skipped")).toBeTruthy());
    expect(q.queryByText("Row 2: Invalid date")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Show more, import results" }));
    expect(q.getByText("Row 2: Invalid date")).toBeTruthy();
    expect(q.getByText("Some row details are unavailable here. Check the original file.")).toBeTruthy();
  });

  it("rejects stale preflight counts when an already-focused field changes during validation", async () => {
    let finishPreview!: (value: unknown) => void;
    let checks = 0;
    upload.mockImplementation(async (_path: string, form: FormData) => {
      if (!form.get("recordType")) return preview;
      if (++checks === 1) return { validation: { validRows: 10, invalidRows: 0, skipped: [], skippedTruncated: false } };
      return new Promise((resolve) => { finishPreview = resolve; });
    });
    const q = await render(wrap(<ImportCsvScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check the rows" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Check the rows" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Review import" })).toBeTruthy());
    await fireEvent.press(q.getByRole("button", { name: "Row 2, Coffee. Show its values" }));
    const amount = q.getByLabelText("Amount");
    await fireEvent.press(q.getByRole("button", { name: "Review import" }));
    await fireEvent.changeText(amount, "not a number");
    await act(() => finishPreview({ validation: { validRows: 10, invalidRows: 0, skipped: [], skippedTruncated: false } }));
    expect(q.queryByRole("button", { name: "Import" })).toBeNull();
    expect(q.getByText("Details changed. Check the rows again.")).toBeTruthy();
    expect(q.getByLabelText(/Amount, Invalid amount/).props.value).toBe("not a number");
  });

  it.each(["poll", "replay"])("reports committed rows after terminal failure from %s without offering a full-file retry", async (source) => {
    upload.mockImplementation(async (path: string, form: FormData) => {
      if (path.endsWith("confirm")) return source === "poll"
        ? { batchId: 12, processingStatus: "PENDING", totalRows: 10 }
        : { batchId: 12, processingStatus: "FAILED", totalRows: 10, imported: 4, skippedCount: 1 };
      if (form.get("recordType")) return { validation: { validRows: 9, invalidRows: 1, skipped: [], skippedTruncated: false } };
      return preview;
    });
    let finishStatus!: (value: unknown) => void;
    get.mockReturnValue(new Promise((resolve) => { finishStatus = resolve; }));
    const q = await confirmCsv();
    if (source === "poll") {
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1), { timeout: 4000 });
      await act(() => finishStatus({ processingStatus: "FAILED", totalRows: 10, processedRows: 5, importedRows: 4, skippedRows: 1, failureStage: "insert" }));
    }
    await waitFor(() => expect(q.getByText("Import stopped")).toBeTruthy(), { timeout: 4000 });
    expect(q.getByText("4 rows saved · 1 skipped")).toBeTruthy();
    expect(q.getByText("Review saved records before importing the remaining rows.")).toBeTruthy();
    expect(q.queryByText("Import complete")).toBeNull();
    expect(q.queryByRole("button", { name: "Check progress" })).toBeNull();
    expect(q.queryByText(/Nothing was half-saved/)).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Review saved records" }));
    expect(navigation.navigate).toHaveBeenCalledWith("RecordsList");
    expect(upload.mock.calls.filter(([path]) => path.endsWith("confirm"))).toHaveLength(1);
  });
  it("discards a late CSV preview when the active business changes", async () => {
    let finishPreview!: (value: unknown) => void;
    upload.mockReturnValue(new Promise((resolve) => { finishPreview = resolve; }));
    const q = await render(wrap(<ImportCsvScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const task = upload.mock.calls[0]!;
    selectedBusiness = { ...fixtures.businessProfile, id: 2 };
    await q.rerender(wrap(<ImportCsvScreen navigation={navigation} />));
    expect(task[2].aborted).toBe(true);
    await act(() => finishPreview(preview));
    expect(q.queryByRole("button", { name: "Check the rows" })).toBeNull();
    expect(q.getByRole("button", { name: "Choose a CSV file" })).toBeEnabled();
  });
  it("shows full-file skipped and duplicate counts before confirmation, with details collapsed", async () => {
    upload.mockImplementation(async (path: string, form: FormData) => {
      if (path.endsWith("confirm")) return { imported: 8, totalRows: 10, skipped: [{ row: 10, reason: "Invalid date" }, { row: 11, reason: "Missing description" }], flagged: 3 };
      if (form.get("recordType")) return { validation: { validRows: 8, invalidRows: 2, skipped: [{ row: 11, reason: "Missing description" }], skippedTruncated: false, possibleDuplicateRows: 3 } };
      return preview;
    });
    const q = await render(wrap(<ImportCsvScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check the rows" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Check the rows" }));
    await waitFor(() => expect(q.getByText(/8 rows ready · 2 will be skipped/)).toBeTruthy());
    expect(q.getByText(/3 possible duplicate/)).toBeTruthy();
    expect(q.queryByText("Row 11: Missing description")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Show more, row errors" }));
    expect(q.getByText("Row 11: Missing description")).toBeTruthy();
    const preflight = upload.mock.calls.find(([, form]) => form.get("recordType"));
    expect(preflight![1].get("businessProfileId")).toBe("1");
    await fireEvent.press(q.getByRole("button", { name: "Review import" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Import" })).toBeTruthy());
    await fireEvent.press(q.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(q.getByText("Import complete")).toBeTruthy());
    expect(q.getByText("2 row(s) were skipped")).toBeTruthy();
    expect(q.queryByText("Row 10: Invalid date")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Show more, import results" }));
    expect(q.getByText("Row 10: Invalid date")).toBeTruthy();
  });

  it("offers category history matches and sends corrections only after Apply", async () => {
    upload.mockImplementation(async (_path: string, form: FormData) => form.get("recordType") ? {
      validation: { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Missing category" }], skippedTruncated: false },
      categorySuggestions: [{ row: 2, categoryId: 10, categoryName: "Stock", source: "history" }],
      categorySuggestionsTruncated: true,
    } : { ...preview, totalRows: 1, previewRows: [{ date: "2026-09-01", description: "Coffee", amount: "250" }], suggestedMapping: { date: "date", description: "description", amount: "amount" } });
    const q = await render(wrap(<ImportCsvScreen navigation={navigation} />));
    await fireEvent.press(q.getByRole("button", { name: "Choose a CSV file" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Check the rows" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Check the rows" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Apply category suggestions" })).toBeTruthy());
    expect(JSON.parse(upload.mock.calls[1]![1].get("corrections"))).toEqual({});
    expect(q.queryByText("More rows may need categories. Apply these suggestions, then review the import again.")).toBeNull();
    await fireEvent.press(q.getByRole("button", { name: "Show more, suggested categories" }));
    expect(q.getByText("More rows may need categories. Apply these suggestions, then review the import again.")).toBeTruthy();
    await fireEvent.press(q.getByRole("button", { name: "Apply category suggestions" }));
    await fireEvent.press(q.getByRole("button", { name: "Review import" }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(JSON.parse(upload.mock.calls[2]![1].get("corrections"))).toEqual({ "2": { category: "Stock" } });
  });
});
