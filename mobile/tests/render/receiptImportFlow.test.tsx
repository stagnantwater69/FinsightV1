import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert, Image } from "react-native";
import * as fixtures from "./support/fixtures";
import { RECEIPT_UPLOAD_MAX_OBJECT_BYTES } from "../../src/lib/receiptUploadContract";

const upload = vi.fn();
const post = vi.fn();
const get = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const remove = vi.fn();
const poll = vi.fn();
const gallery = vi.fn();
const document = vi.fn();
const localFileByteSize = vi.fn();
const deleteScannerFiles = vi.fn();
let selectedBusiness = fixtures.businessProfile;
let cameraSections: any[] = [];
vi.mock("../../src/lib/api", () => ({ api: { upload, post, get, put, patch, delete: remove } }));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: gallery }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: document }));
vi.mock("../../src/lib/analysisImage", () => ({ analysisImageUri: async (uri: string) => uri }));
vi.mock("../../src/lib/localFileSize", () => ({ localFileByteSize }));
vi.mock("../../src/lib/receiptScannerCache", () => ({ deleteReceiptScannerFiles: deleteScannerFiles, clearReceiptScannerCache: vi.fn(async () => 0) }));
vi.mock("../../src/components/receipt-camera", async () => {
  const ReactRuntime = await import("react");
  const { Pressable, Text } = await import("react-native");
  return {
    ReceiptCamera: ({ onDone }: any) => ReactRuntime.createElement(
      Pressable,
      {
        accessibilityRole: "button",
        accessibilityLabel: "Finish mocked camera with unsupported evidence",
        onPress: () => onDone(cameraSections.length > 0 ? cameraSections : [{
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
const { ReceiptReadFailure } = await import("../../src/screens/records/scanReceipt/helpers");
const { takeFlash } = await import("../../src/lib/flash");
const { ImportCsvScreen } = await import("../../src/screens/records/ImportCsvScreen");
const { AddExpenseScreen } = await import("../../src/screens/records/AddExpenseScreen");
const navigation = { navigate: vi.fn(), goBack: vi.fn() };
const wrapInMode = (node: React.ReactNode, mode: "light" | "dark") => <ThemeProvider initialMode={mode}>{node}</ThemeProvider>;
const wrap = (node: React.ReactNode) => wrapInMode(node, "light");
const accepted = { id: 41, businessProfileId: 1, receiptBatchId: null, receiptOrdinal: null, scanRevision: 0, processingStatus: "Processing", confirmationStatus: "Pending" };
const complete = { id: 41, businessProfileId: 1, receiptBatchId: null, receiptOrdinal: null, scanRevision: 0, processingStatus: "Complete", confirmationStatus: "Pending", extractedDate: "2026-09-01", extractedVendor: "Supplier", extractedDescription: "Coffee beans", extractedAmount: 250, items: [{ id: 5, name: "Coffee beans", amount: 250, categoryId: 10 }], warnings: [], ocrConfidence: 96 };
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
  upload.mockReset(); post.mockReset(); get.mockReset(); put.mockReset(); patch.mockReset(); remove.mockReset(); poll.mockReset(); gallery.mockReset(); document.mockReset(); localFileByteSize.mockReset(); deleteScannerFiles.mockReset(); navigation.navigate.mockReset(); navigation.goBack.mockReset();
  cameraSections = [];
  gallery.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///receipt.jpg", width: 600, height: 1000, fileName: "receipt.jpg", mimeType: "image/jpeg", fileSize: 2048 }] });
  document.mockResolvedValue({ canceled: false, assets: [{ uri: "file:///records.csv", name: "records.csv", size: 1024, mimeType: "text/csv" }] });
  upload.mockImplementation(async (path: string, form?: FormData) => {
    if (path.endsWith("quality-check")) return { sharpness: 50, brightness: 150, tooBlurredToTrust: false };
    const ordinal = Number(form?.get("receiptOrdinal"));
    const batchId = Number(form?.get("receiptBatchId"));
    return {
      ...accepted,
      id: Number.isInteger(ordinal) && ordinal > 0 ? 40 + ordinal : accepted.id,
      receiptBatchId: Number.isInteger(batchId) && batchId > 0 ? batchId : null,
      receiptOrdinal: Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null,
    };
  });
  get.mockImplementation(async (path: string) => {
    if (path.includes("provider-consent")) return unavailableConsent;
    if (path === "/records/receipts") return { items: [], nextCursor: null };
    return complete;
  });
  put.mockResolvedValue(grantedConsent);
  remove.mockResolvedValue(availableConsent);
  localFileByteSize.mockResolvedValue(2048);
  deleteScannerFiles.mockResolvedValue(0);
  takeFlash();
  poll.mockImplementation(async (initial: typeof accepted) => ({
    ...complete,
    id: initial.id,
    receiptBatchId: initial.receiptBatchId,
    receiptOrdinal: initial.receiptOrdinal,
  }));
  post.mockResolvedValue({});
  patch.mockResolvedValue(complete);
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
    await waitFor(() => expect(q.getByRole("button", { name: "Review result" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Review result" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith("/records/receipts/41", undefined, expect.any(AbortSignal));
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("250.00");
  });

  it("retries a failed scan from its stored images without uploading again", async () => {
    poll.mockRejectedValueOnce(new ReceiptReadFailure("failed", "This receipt could not be read."));
    post.mockImplementation(async (path: string) => path.endsWith("/retry") ? accepted : {});
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Retry processing" })).toBeEnabled());
    expect(q.getByRole("button", { name: "Delete stored scan" })).toBeEnabled();
    await fireEvent.press(q.getByRole("button", { name: "Retry processing" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/records/receipts/41/retry");
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(1);
  });

  it("discovers every accepted batch child after the scanner screen reloads without local files", async () => {
    const storedComplete = {
      ...complete,
      id: 82,
      receiptBatchId: 70,
      receiptOrdinal: 2,
      pageEvidence: [{
        pageNumber: 1,
        captureMode: "standard",
        processingMode: "clear-colour",
        ocrInput: "derived",
        source: { variant: "source", label: "Unenhanced scan", width: 3024, height: 4032 },
        derived: { variant: "derived", label: "Enhanced color", width: 1800, height: 3000 },
      }],
    };
    const summary = (id: number, processingStatus: "Processing" | "Complete" | "Failed", ordinal: number) => ({
      id,
      businessProfileId: 1,
      receiptBatchId: 70,
      receiptOrdinal: ordinal,
      scanRevision: 0,
      processingStatus,
      confirmationStatus: "Pending",
      processingError: processingStatus === "Failed" ? "The receipt could not be read." : null,
      processingErrorCode: processingStatus === "Failed" ? "OCR_FAILED" : null,
      extractedDate: processingStatus === "Complete" ? "2026-09-01" : null,
      extractedVendor: processingStatus === "Complete" ? "Supplier" : null,
      extractedDescription: null,
      extractedAmount: processingStatus === "Complete" ? 250 : null,
      createdAt: "2026-09-13T10:00:00.000Z",
      pageCount: 1,
      allowedActions: {
        retryProcessing: processingStatus === "Failed",
        reviewResult: processingStatus === "Complete",
      },
    });
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [summary(81, "Processing", 1), summary(82, "Complete", 2), summary(83, "Failed", 3)], nextCursor: null };
      if (path === "/records/receipts/82") return storedComplete;
      if (path === "/records/receipts/82/pages/1/image/source") return {
        pageNumber: 1,
        variant: "source",
        label: "Unenhanced scan",
        width: 3024,
        height: 4032,
        url: "https://storage.test/receipt-82-source",
        expiresInSeconds: 600,
      };
      throw new Error(`Unexpected GET ${path}`);
    });
    poll.mockResolvedValue(storedComplete);
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));

    await waitFor(() => expect(q.getByRole("button", { name: /^Review result for Supplier/ })).toBeEnabled());
    expect(q.getByRole("button", { name: /^Continue waiting for Stored receipt 81/ })).toBeEnabled();
    expect(q.getByRole("button", { name: /^Retry processing for Stored receipt 83/ })).toBeEnabled();
    expect(get).toHaveBeenCalledWith(
      "/records/receipts",
      { businessProfileId: 1, status: "active", take: 50, cursor: undefined },
      expect.any(AbortSignal),
    );

    await fireEvent.press(q.getByRole("button", { name: /^Review result for Supplier/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Inspect receipt image" })).toBeEnabled());
    expect(get).toHaveBeenCalledWith("/records/receipts/82", undefined, expect.any(AbortSignal));
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(0);

    await fireEvent.press(q.getByRole("button", { name: "Inspect receipt image" }));
    await waitFor(() => {
      expect(q.getByRole("image", { name: "Receipt page 1, Unenhanced scan" }).props.source.uri)
        .toBe("https://storage.test/receipt-82-source");
    });
  });

  it("retries a discovered failed receipt using its stored bytes", async () => {
    const failedSummary = {
      id: 83,
      businessProfileId: 1,
      receiptBatchId: null,
      receiptOrdinal: null,
      scanRevision: 0,
      processingStatus: "Failed" as const,
      confirmationStatus: "Pending" as const,
      processingError: "The receipt could not be read.",
      processingErrorCode: "OCR_FAILED",
      extractedDate: null,
      extractedVendor: null,
      extractedDescription: null,
      extractedAmount: null,
      createdAt: "2026-09-13T10:00:00.000Z",
      pageCount: 1,
      allowedActions: { retryProcessing: true, reviewResult: false },
    };
    const failed = { ...complete, id: 83, processingStatus: "Failed" as const, processingError: failedSummary.processingError };
    const processing = { ...failed, processingStatus: "Processing" as const, processingError: null };
    const retried = { ...complete, id: 83 };
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [failedSummary], nextCursor: null };
      if (path === "/records/receipts/83") return failed;
      throw new Error(`Unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string) => path === "/records/receipts/83/retry" ? processing : {});
    poll.mockResolvedValue(retried);
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));

    await waitFor(() => expect(q.getByRole("button", { name: /^Retry processing for Stored receipt 83/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: /^Retry processing for Stored receipt 83/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    expect(post).toHaveBeenCalledWith("/records/receipts/83/retry");
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(0);
  });

  it("retains a discovered receipt's batch binding across a transient poll failure", async () => {
    const batchSummary = {
      id: 84,
      businessProfileId: 1,
      receiptBatchId: 70,
      receiptOrdinal: 2,
      scanRevision: 0,
      processingStatus: "Complete" as const,
      confirmationStatus: "Pending" as const,
      processingError: null,
      processingErrorCode: null,
      extractedDate: "2026-09-01",
      extractedVendor: "Second Supplier",
      extractedDescription: "Milk",
      extractedAmount: 90,
      createdAt: "2026-09-13T10:00:00.000Z",
      pageCount: 1,
      allowedActions: { retryProcessing: false, reviewResult: true },
    };
    const batchedResult = {
      ...complete,
      id: 84,
      receiptBatchId: 70,
      receiptOrdinal: 2,
      extractedVendor: "Second Supplier",
      extractedDescription: "Milk",
      extractedAmount: 90,
      items: [{ id: 8, name: "Milk", amount: 90, categoryId: 10 }],
    };
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [batchSummary], nextCursor: null };
      if (path === "/records/receipts/84") return batchedResult;
      throw new Error(`Unexpected GET ${path}`);
    });
    poll
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(batchedResult);
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));

    await waitFor(() => expect(q.getByRole("button", { name: /^Review result for Second Supplier/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: /^Review result for Second Supplier/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Review result" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Review result" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    expect(get.mock.calls.filter(([path]) => path === "/records/receipts/84")).toHaveLength(2);
    expect(q.getByLabelText("Amount (PHP)").props.value).toBe("90.00");
  });

  it("deletes an unfinished stored scan with one stable replay key", async () => {
    const failedSummary = {
      id: 83,
      businessProfileId: 1,
      receiptBatchId: null,
      receiptOrdinal: null,
      scanRevision: 0,
      processingStatus: "Failed" as const,
      confirmationStatus: "Pending" as const,
      processingError: "The receipt could not be read.",
      processingErrorCode: "OCR_FAILED",
      extractedDate: null,
      extractedVendor: null,
      extractedDescription: null,
      extractedAmount: null,
      createdAt: "2026-09-13T10:00:00.000Z",
      pageCount: 1,
      allowedActions: { retryProcessing: true, reviewResult: false },
    };
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [failedSummary], nextCursor: null };
      throw new Error(`Unexpected GET ${path}`);
    });
    remove
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({
        id: 501,
        receiptScanId: 83,
        reason: "OWNER_REQUESTED",
        status: "PENDING",
        stage: "QUEUED",
        storageObjectsExpected: 2,
        storageObjectsDeleted: 0,
        requestedAt: "2026-09-13T10:10:00.000Z",
        completedAt: null,
        lastErrorCode: null,
      });
    const alert = vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === "destructive")?.onPress?.();
    });
    try {
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      const deleteButton = await waitFor(() => q.getByRole("button", { name: /^Delete scan for Stored receipt 83/ }));

      await fireEvent.press(deleteButton);
      await waitFor(() => expect(q.getByText(/have not been deleted/i)).toBeTruthy());
      await fireEvent.press(q.getByRole("button", { name: /^Delete scan for Stored receipt/ }));
      await waitFor(() => expect(q.queryByRole("button", { name: /^Delete scan for Stored receipt/ })).toBeNull());

      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove.mock.calls[0]![0]).toBe("/records/receipts/83");
      expect(remove.mock.calls[0]![1]).toBeUndefined();
      expect(remove.mock.calls[0]![2]["Idempotency-Key"]).toMatch(/^[-\w]{8,100}$/);
      expect(remove.mock.calls[1]![2]["Idempotency-Key"]).toBe(remove.mock.calls[0]![2]["Idempotency-Key"]);
      expect(get.mock.calls.some(([path]) => String(path).includes("/image/"))).toBe(false);
    } finally {
      alert.mockRestore();
    }
  });

  it("accepts every durable batch child before polling or reviewing receipt 1", async () => {
    cameraSections = [{
      localId: "receipt-two",
      originalUri: "file:///receipt-two.jpg",
      originalMimeType: "image/jpeg",
      processedUri: "file:///receipt-two.jpg",
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    }];
    post.mockImplementation(async (path: string, body?: any) => path === "/records/receipt-batches" ? {
      id: 70,
      businessProfileId: 1,
      expectedReceiptCount: body.expectedReceiptCount,
      status: "COLLECTING",
      uploadedReceiptCount: 0,
      createdAt: "2026-09-13T10:00:00.000Z",
      finishedAt: null,
      receipts: [],
    } : {});
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    const start = q.getByRole("button", { name: "Scan 2 separate receipts" });
    expect(q.getByText(/2 separate receipts are ready/)).toBeTruthy();

    poll.mockImplementation(async (initial: typeof accepted) => {
      expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(2);
      return {
        ...complete,
        id: initial.id,
        receiptBatchId: initial.receiptBatchId,
        receiptOrdinal: initial.receiptOrdinal,
      };
    });

    await fireEvent.press(start);
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    let receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads).toHaveLength(2);
    expect(post).toHaveBeenCalledWith("/records/receipt-batches", expect.objectContaining({
      businessProfileId: 1,
      expectedReceiptCount: 2,
      clientBatchKey: expect.any(String),
    }));
    expect(receiptUploads[0]![1].get("receiptBatchId")).toBe("70");
    expect(receiptUploads[0]![1].get("receiptOrdinal")).toBe("1");
    expect(receiptUploads[1]![1].get("receiptBatchId")).toBe("70");
    expect(receiptUploads[1]![1].get("receiptOrdinal")).toBe("2");

    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeTruthy());
    receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads).toHaveLength(2);
  });

  it("starts one batch recovery attempt for one Continue batch upload action", async () => {
    cameraSections = [{
      localId: "receipt-two",
      originalUri: "file:///receipt-two.jpg",
      originalMimeType: "image/jpeg",
      processedUri: "file:///receipt-two.jpg",
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    }];
    post.mockImplementation(async (path: string, body?: any) => path === "/records/receipt-batches" ? {
      id: 70,
      businessProfileId: 1,
      expectedReceiptCount: body.expectedReceiptCount,
      status: "COLLECTING",
      uploadedReceiptCount: 0,
      createdAt: "2026-09-13T10:00:00.000Z",
      finishedAt: null,
      receipts: [],
    } : {});
    let ordinalTwoAttempts = 0;
    upload.mockImplementation(async (path: string, form?: FormData) => {
      if (path.endsWith("quality-check")) return { sharpness: 50, brightness: 150, tooBlurredToTrust: false };
      const ordinal = Number(form?.get("receiptOrdinal"));
      if (ordinal === 2 && ++ordinalTwoAttempts === 1) {
        throw Object.assign(new Error("Connection interrupted"), { status: 0 });
      }
      return {
        ...accepted,
        id: 40 + ordinal,
        receiptBatchId: 70,
        receiptOrdinal: ordinal,
      };
    });

    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    await fireEvent.press(q.getByRole("button", { name: "Scan 2 separate receipts" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Continue batch upload" })).toBeEnabled());

    const beforeRecovery = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(beforeRecovery).toHaveLength(2);
    await fireEvent.press(q.getByRole("button", { name: "Continue batch upload" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    const receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads).toHaveLength(3);
    expect(receiptUploads.map(([, form]) => form.get("receiptOrdinal"))).toEqual(["1", "2", "2"]);
    expect(receiptUploads[2]![1].get("idempotencyKey")).toBe(receiptUploads[1]![1].get("idempotencyKey"));
    expect(post.mock.calls.filter(([path]) => path === "/records/receipt-batches")).toHaveLength(1);
  });

  it("continues a batch after an accepted middle child's local files were released", async () => {
    // Children 1 and 2 are accepted (child 2's files are then deleted on
    // device); child 3 fails once. Continue must re-send child 3 only, and
    // must not re-inspect the files child 2 no longer has.
    const section = (name: string) => ({
      localId: name,
      originalUri: `file:///${name}.jpg`,
      originalMimeType: "image/jpeg",
      processedUri: `file:///${name}.jpg`,
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    });
    post.mockImplementation(async (path: string, body?: any) => path === "/records/receipt-batches" ? {
      id: 70,
      businessProfileId: 1,
      expectedReceiptCount: body.expectedReceiptCount,
      status: "COLLECTING",
      uploadedReceiptCount: 0,
      createdAt: "2026-09-13T10:00:00.000Z",
      finishedAt: null,
      receipts: [],
    } : {});
    let childTwoAccepted = false;
    let ordinalThreeAttempts = 0;
    localFileByteSize.mockImplementation(async (uri: string) => {
      if (childTwoAccepted && uri === "file:///receipt-two.jpg") throw new Error("Receipt file is unavailable");
      return 2048;
    });
    upload.mockImplementation(async (path: string, form?: FormData) => {
      if (path.endsWith("quality-check")) return { sharpness: 50, brightness: 150, tooBlurredToTrust: false };
      const ordinal = Number(form?.get("receiptOrdinal"));
      if (ordinal === 3 && ++ordinalThreeAttempts === 1) {
        throw Object.assign(new Error("Connection interrupted"), { status: 0 });
      }
      if (ordinal === 2) childTwoAccepted = true;
      return {
        ...accepted,
        id: 40 + ordinal,
        receiptBatchId: 70,
        receiptOrdinal: ordinal,
      };
    });

    const q = await readyReceipt();
    cameraSections = [section("receipt-two")];
    await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    cameraSections = [section("receipt-three")];
    await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    await fireEvent.press(q.getByRole("button", { name: "Scan 3 separate receipts" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Continue batch upload" })).toBeEnabled());
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(3);

    await fireEvent.press(q.getByRole("button", { name: "Continue batch upload" }));
    await waitFor(() => expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(4));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    const receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads.map(([, form]) => form.get("receiptOrdinal"))).toEqual(["1", "2", "3", "3"]);
    expect(receiptUploads[3]![1].get("idempotencyKey")).toBe(receiptUploads[2]![1].get("idempotencyKey"));
    expect(q.queryByText(/unavailable/i)).toBeNull();
  });

  it("replaces a cancelled create-batch replay before uploading any receipt", async () => {
    cameraSections = [{
      localId: "receipt-two",
      originalUri: "file:///receipt-two.jpg",
      originalMimeType: "image/jpeg",
      processedUri: "file:///receipt-two.jpg",
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    }];
    let batchCreates = 0;
    post.mockImplementation(async (path: string, body?: any) => {
      if (path !== "/records/receipt-batches") return {};
      batchCreates += 1;
      return {
        id: batchCreates === 1 ? 70 : 71,
        businessProfileId: 1,
        expectedReceiptCount: body.expectedReceiptCount,
        status: batchCreates === 1 ? "CANCELLED" : "COLLECTING",
        uploadedReceiptCount: 0,
        createdAt: "2026-09-13T10:00:00.000Z",
        finishedAt: batchCreates === 1 ? "2026-09-13T10:01:00.000Z" : null,
        receipts: [],
      };
    });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    await fireEvent.press(q.getByRole("button", { name: "Scan 2 separate receipts" }));

    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    const batchCalls = post.mock.calls.filter(([path]) => path === "/records/receipt-batches");
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[1]![1].clientBatchKey).not.toBe(batchCalls[0]![1].clientBatchKey);
    const receiptUpload = upload.mock.calls.find(([path]) => path === "/records/receipts")!;
    expect(receiptUpload[1].get("receiptBatchId")).toBe("71");
    expect(receiptUpload[1].get("receiptOrdinal")).toBe("1");
  });

  it("keeps other accepted batch children in receipt history after deleting the current child", async () => {
    cameraSections = [{
      localId: "receipt-two",
      originalUri: "file:///receipt-two.jpg",
      originalMimeType: "image/jpeg",
      processedUri: "file:///receipt-two.jpg",
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    }];
    post.mockImplementation(async (path: string, body?: any) => path === "/records/receipt-batches" ? {
      id: 70,
      businessProfileId: 1,
      expectedReceiptCount: body.expectedReceiptCount,
      status: "COLLECTING",
      uploadedReceiptCount: 0,
      createdAt: "2026-09-13T10:00:00.000Z",
      finishedAt: null,
      receipts: [],
    } : {});
    remove.mockResolvedValue({
      id: 502,
      receiptScanId: 41,
      reason: "OWNER_REQUESTED",
      status: "PENDING",
      stage: "QUEUED",
      storageObjectsExpected: 2,
      storageObjectsDeleted: 0,
      requestedAt: "2026-09-13T10:10:00.000Z",
      completedAt: null,
      lastErrorCode: null,
    });
    const alert = vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === "destructive")?.onPress?.();
    });
    try {
      const q = await readyReceipt();
      await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
      await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
      await fireEvent.press(q.getByRole("button", { name: "Scan 2 separate receipts" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
      const first = upload.mock.calls.find(([path]) => path === "/records/receipts")!;
      expect(first[1].get("receiptBatchId")).toBe("70");

      await fireEvent.press(q.getByRole("button", { name: "Delete scan" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Scan receipt" })).toBeEnabled());
      expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(2);
      expect(post.mock.calls.filter(([path]) => path === "/records/receipt-batches")).toHaveLength(1);
      expect(takeFlash()).toBe("Receipt scan deletion started. The other stored receipts from this batch are still in Receipts to finish.");
    } finally {
      alert.mockRestore();
    }
  });

  it("keeps a batch's never-uploaded receipt and its local files after deleting the stored current child", async () => {
    cameraSections = [{
      localId: "receipt-two",
      originalUri: "file:///receipt-two.jpg",
      originalMimeType: "image/jpeg",
      processedUri: "file:///receipt-two.jpg",
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    }];
    post.mockImplementation(async (path: string, body?: any) => path === "/records/receipt-batches" ? {
      id: 70,
      businessProfileId: 1,
      expectedReceiptCount: body.expectedReceiptCount,
      status: "COLLECTING",
      uploadedReceiptCount: 0,
      createdAt: "2026-09-13T10:00:00.000Z",
      finishedAt: null,
      receipts: [],
    } : {});
    upload.mockImplementation(async (path: string, form?: FormData) => {
      if (path.endsWith("quality-check")) return { sharpness: 50, brightness: 150, tooBlurredToTrust: false };
      const ordinal = Number(form?.get("receiptOrdinal"));
      if (ordinal === 2) throw Object.assign(new Error("Connection interrupted"), { status: 0 });
      return { ...accepted, id: Number.isInteger(ordinal) && ordinal > 0 ? 40 + ordinal : accepted.id, receiptBatchId: ordinal === 1 ? 70 : null, receiptOrdinal: ordinal === 1 ? 1 : null };
    });
    remove.mockResolvedValue({
      id: 503,
      receiptScanId: 41,
      reason: "OWNER_REQUESTED",
      status: "PENDING",
      stage: "QUEUED",
      storageObjectsExpected: 2,
      storageObjectsDeleted: 0,
      requestedAt: "2026-09-13T10:10:00.000Z",
      completedAt: null,
      lastErrorCode: null,
    });
    const alert = vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === "destructive")?.onPress?.();
    });
    try {
      const q = await readyReceipt();
      await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
      await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
      await fireEvent.press(q.getByRole("button", { name: "Scan 2 separate receipts" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Continue batch upload" })).toBeEnabled());
      expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(2);

      await fireEvent.press(q.getByRole("button", { name: "Delete stored scan" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toBe("/records/receipts/41");
      expect(takeFlash()).toBe("Receipt scan deletion started. The receipts you haven't sent yet are still here, ready to scan.");
      expect(deleteScannerFiles.mock.calls.flatMap(([uris]) => uris)).not.toContain("file:///receipt-two.jpg");
      expect(q.queryByRole("button", { name: "Continue batch upload" })).toBeNull();

      const inspectionsBefore = localFileByteSize.mock.calls.length;
      await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
      const receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
      expect(receiptUploads).toHaveLength(3);
      expect(receiptUploads[2]![1].get("receiptBatchId")).toBeNull();
      expect(receiptUploads[2]![1].get("receiptOrdinal")).toBeNull();
      expect(localFileByteSize.mock.calls.slice(inspectionsBefore).map(([uri]) => uri)).toContain("file:///receipt-two.jpg");
      expect(localFileByteSize.mock.calls.slice(inspectionsBefore).map(([uri]) => uri)).not.toContain("file:///receipt.jpg");
      expect(post.mock.calls.filter(([path]) => path === "/records/receipt-batches")).toHaveLength(1);
    } finally {
      alert.mockRestore();
    }
  });

  it("edits an extracted item with the current scan revision and confirms the returned revision", async () => {
    const itemised = {
      ...complete,
      extractedAmount: 300,
      items: [
        { id: 5, name: "Coffee beans", amount: 250, categoryId: 10 },
        { id: 6, name: "Sugar", amount: 50, categoryId: 10 },
      ],
    };
    const updated = {
      ...itemised,
      scanRevision: 1,
      items: [{ ...itemised.items[0]!, name: "Arabica beans" }, itemised.items[1]!],
    };
    poll.mockResolvedValue(itemised);
    patch.mockResolvedValue(updated);
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Edit Coffee beans" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Edit Coffee beans" }));
    await fireEvent.changeText(q.getByLabelText("Edit item name for Coffee beans"), "Arabica beans");
    await fireEvent.press(q.getByRole("button", { name: "Save item changes" }));
    await waitFor(() => expect(q.getByText("Arabica beans")).toBeTruthy());
    expect(patch).toHaveBeenCalledWith("/records/receipts/41/items/5", {
      name: "Arabica beans",
      amount: 250,
      expectedScanRevision: 0,
    });

    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    expect(post).toHaveBeenCalledWith("/records/receipts/41/confirm", expect.objectContaining({ expectedScanRevision: 1 }));
  });

  it("keeps a typed item correction when a stale edit reloads the latest receipt", async () => {
    const itemised = {
      ...complete,
      extractedAmount: 300,
      items: [
        { id: 5, name: "Coffee beans", amount: 250, categoryId: 10 },
        { id: 6, name: "Sugar", amount: 50, categoryId: 10 },
      ],
    };
    poll.mockResolvedValue(itemised);
    patch.mockRejectedValue(Object.assign(new Error("Receipt scan changed"), { status: 409 }));
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [], nextCursor: null };
      return { ...itemised, scanRevision: 1 };
    });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Edit Coffee beans" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Edit Coffee beans" }));
    await fireEvent.changeText(q.getByLabelText("Edit item name for Coffee beans"), "Keep my correction");
    await fireEvent.press(q.getByRole("button", { name: "Save item changes" }));
    await waitFor(() => expect(q.getByText(/typed correction is still here/)).toBeTruthy());
    expect(q.getByLabelText("Edit item name for Coffee beans").props.value).toBe("Keep my correction");
    expect(q.getByRole("button", { name: "Save item changes" })).toBeEnabled();
  });

  it("shows profile-safe duplicate candidates and saves only after an explicit override", async () => {
    const duplicateBody = {
      error: "Review possible duplicates before saving.",
      code: "DUPLICATE_REVIEW_REQUIRED",
      sourceFingerprint: "a".repeat(64),
      candidateSetHash: "b".repeat(64),
      candidates: [{
        id: 501,
        target: { kind: "expense", id: 301 },
        vendor: "Supplier",
        date: "2026-09-01T00:00:00.000Z",
        total: 250,
        scoreBand: "EXACT",
        reasons: ["SAME_VENDOR", "SAME_DATE", "SAME_TOTAL"],
      }],
      candidateCount: 1,
      candidatesTruncated: false,
      nextCursor: null,
    };
    post
      .mockRejectedValueOnce(Object.assign(new Error(duplicateBody.error), {
        status: 409,
        code: duplicateBody.code,
        responseBody: duplicateBody,
      }))
      .mockResolvedValueOnce({});
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save anyway" })).toBeEnabled());
    expect(q.getByText("Possible duplicate")).toBeTruthy();
    expect(q.getByText("2026-09-01 · Exact match")).toBeTruthy();
    expect(q.getByText("Same vendor · Same date · Same total")).toBeTruthy();
    expect(navigation.goBack).not.toHaveBeenCalled();

    await fireEvent.press(q.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual([
      "/records/receipts/41/confirm",
      expect.not.objectContaining({ duplicateDecision: expect.anything() }),
    ]);
    expect(post.mock.calls[1]).toEqual([
      "/records/receipts/41/confirm",
      expect.objectContaining({
        expectedScanRevision: 0,
        duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: "b".repeat(64) },
      }),
    ]);
  });

  it("blocks Save anyway until every paginated duplicate candidate has loaded", async () => {
    const sourceFingerprint = "c".repeat(64);
    const candidateSetHash = "d".repeat(64);
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      id: 600 + index,
      target: { kind: "expense", id: 700 + index },
      vendor: `Prior supplier ${index + 1}`,
      date: "2026-09-01T00:00:00.000Z",
      total: 250,
      scoreBand: "EXACT",
      reasons: ["SAME_VENDOR", "SAME_DATE", "SAME_TOTAL"],
    }));
    const duplicateBody = {
      error: "Review possible duplicates before saving.",
      code: "DUPLICATE_REVIEW_REQUIRED",
      sourceFingerprint,
      candidateSetHash,
      candidates: candidates.slice(0, 20),
      candidateCount: candidates.length,
      candidatesTruncated: true,
      nextCursor: "candidate-cursor-20",
    };
    post
      .mockRejectedValueOnce(Object.assign(new Error(duplicateBody.error), {
        status: 409,
        code: duplicateBody.code,
        responseBody: duplicateBody,
      }))
      .mockResolvedValueOnce({});
    let remainingCandidateAttempts = 0;
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [], nextCursor: null };
      if (path === "/records/receipts/41/duplicate-candidates") {
        remainingCandidateAttempts += 1;
        if (remainingCandidateAttempts === 1) throw Object.assign(new Error("Connection unavailable"), { status: 0 });
        return {
          sourceFingerprint,
          candidateSetHash,
          candidates: candidates.slice(20),
          nextCursor: null,
        };
      }
      return complete;
    });

    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));

    await waitFor(() => expect(q.getByRole("button", { name: "Load remaining matches" })).toBeEnabled());
    expect(q.getByRole("button", { name: "Save anyway" })).toBeDisabled();
    expect(q.getByText("Showing 20 of 21 possible matches.")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);

    await fireEvent.press(q.getByRole("button", { name: "Load remaining matches" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Try loading remaining matches again" })).toBeEnabled());
    expect(q.getByRole("button", { name: "Save anyway" })).toBeDisabled();
    expect(q.getByText(/matches already shown are still here/i)).toBeTruthy();

    await fireEvent.press(q.getByRole("button", { name: "Try loading remaining matches again" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save anyway" })).toBeEnabled());
    expect(q.getByText("Showing 21 of 21 possible matches.")).toBeTruthy();
    expect(get).toHaveBeenCalledWith(
      "/records/receipts/41/duplicate-candidates",
      { cursor: "candidate-cursor-20", take: 20 },
      expect.any(AbortSignal),
    );

    await fireEvent.press(q.getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash },
    }));
  });

  it("resolves an unknown confirm response by reading confirmation state", async () => {
    post.mockRejectedValueOnce(Object.assign(new Error("Connection interrupted"), { status: 0 }));
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [], nextCursor: null };
      if (path === "/records/receipts/41") return { ...complete, confirmationStatus: "Confirmed" };
      throw new Error(`Unexpected GET ${path}`);
    });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    await fireEvent.press(q.getByRole("button", { name: "Save this expense" }));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/records/receipts/41", undefined, expect.any(AbortSignal));
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
      get.mockImplementation((path: string) => path === "/records/receipts"
        ? Promise.resolve({ items: [], nextCursor: null })
        : new Promise(() => {}));
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
      get.mockImplementation(async (path: string) => path === "/records/receipts" ? { items: [], nextCursor: null } : availableConsent);
      const q = await render(wrapInMode(<ScanReceiptScreen navigation={navigation} />, mode));
      await waitFor(() => expect(q.getByText(/Processing region: global/)).toBeTruthy());
      expect(q.getByText(/processed copy when one exists/)).toBeTruthy();
      expect(q.getByRole("checkbox", { name: "I allow FinSight to send these receipt images to Google Gemini under the terms above" })).toBeTruthy();
    });

    it("requires an unchecked deliberate choice and echoes the advertised terms", async () => {
      get.mockImplementation(async (path: string) => path === "/records/receipts" ? { items: [], nextCursor: null } : availableConsent);
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
      let consentRequests = 0;
      get.mockImplementation(async (path: string) => {
        if (path === "/records/receipts") return { items: [], nextCursor: null };
        if (consentRequests++ === 0) throw new Error("offline");
        return availableConsent;
      });
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(q.getByText("Optional cloud receipt settings could not be checked. Receipt capture and the standard reader remain available.")).toBeTruthy());
      expect(q.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
      await fireEvent.press(q.getByRole("button", { name: "Check optional settings again" }));
      await waitFor(() => expect(q.getByRole("checkbox", { name: "I allow FinSight to send these receipt images to Google Gemini under the terms above" })).toBeTruthy());
    });

    it("ignores mocked consent terms returned after the active business changes", async () => {
      let finishFirst!: (value: unknown) => void;
      get.mockImplementation((path: string) => {
        if (path === "/records/receipts") return Promise.resolve({ items: [], nextCursor: null });
        return path.endsWith("/1")
          ? new Promise((resolve) => { finishFirst = resolve; })
          : Promise.resolve(unavailableConsent);
      });
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(get).toHaveBeenCalledWith("/records/receipts/provider-consent/1"));
      selectedBusiness = { ...fixtures.businessProfile, id: 2 };
      await q.rerender(wrap(<ScanReceiptScreen navigation={navigation} />));
      await waitFor(() => expect(get).toHaveBeenCalledWith("/records/receipts/provider-consent/2"));
      await act(() => finishFirst(availableConsent));
      expect(q.queryByRole("button", { name: "Allow optional cloud help" })).toBeNull();
    });

    it("keeps revoke available for an earlier consent after the provider is disabled", async () => {
      get.mockImplementation(async (path: string) => path === "/records/receipts"
        ? { items: [], nextCursor: null }
        : { ...unavailableConsent, activeConsents: grantedConsent.activeConsents });
      remove.mockResolvedValue(unavailableConsent);
      const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));
      const revoke = await waitFor(() => q.getByRole("button", { name: "Revoke future cloud sends" }));
      expect(q.queryByRole("button", { name: "Allow optional cloud help" })).toBeNull();
      await fireEvent.press(revoke);
      await waitFor(() => expect(q.getByText(/Cloud receipt permission was revoked/)).toBeTruthy());
      expect(remove).toHaveBeenCalledWith("/records/receipts/provider-consent/1");
    });

    it("keeps an accessible revoke retry after a failed revocation", async () => {
      get.mockImplementation(async (path: string) => path === "/records/receipts" ? { items: [], nextCursor: null } : grantedConsent);
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

  it("starts a fresh single-receipt upload after rejecting a foreign-currency result", async () => {
    poll
      .mockImplementationOnce(async (initial: typeof accepted) => ({
        ...complete,
        id: initial.id,
        requiresManualCurrencyConversion: true,
        receiptDetails: { currency: "USD" },
      }))
      .mockImplementationOnce(async (initial: typeof accepted) => ({ ...complete, id: initial.id }));
    const q = await readyReceipt();

    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Choose another receipt" })).toBeEnabled());
    const firstUpload = upload.mock.calls.find(([path]) => path === "/records/receipts")!;

    await fireEvent.press(q.getByRole("button", { name: "Choose another receipt" }));
    gallery.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///replacement.jpg", width: 600, height: 1000, fileName: "replacement.jpg", mimeType: "image/jpeg", fileSize: 2048 }],
    });
    await fireEvent.press(q.getByRole("button", { name: "Choose a photo from your gallery" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    const receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads).toHaveLength(2);
    expect(receiptUploads[1]![1].get("idempotencyKey")).not.toBe(firstUpload[1].get("idempotencyKey"));
    expect(receiptUploads[1]![1].get("receiptBatchId")).toBeNull();
    expect(receiptUploads[1]![1].get("receiptOrdinal")).toBeNull();
  });

  it("clears batch replay state before replacing a batched foreign-currency result", async () => {
    cameraSections = [{
      localId: "receipt-two",
      originalUri: "file:///receipt-two.jpg",
      originalMimeType: "image/jpeg",
      processedUri: "file:///receipt-two.jpg",
      processedMimeType: "image/jpeg",
      width: 600,
      height: 1000,
      quality: null,
      captureSource: "manual-camera",
      captureMode: "standard",
      processingMode: "original",
    }];
    post.mockImplementation(async (path: string, body?: any) => path === "/records/receipt-batches" ? {
      id: 70,
      businessProfileId: 1,
      expectedReceiptCount: body.expectedReceiptCount,
      status: "COLLECTING",
      uploadedReceiptCount: 0,
      createdAt: "2026-09-13T10:00:00.000Z",
      finishedAt: null,
      receipts: [],
    } : {});
    poll.mockImplementation(async (initial: typeof accepted) => initial.receiptBatchId === 70 ? {
      ...complete,
      id: initial.id,
      receiptBatchId: initial.receiptBatchId,
      receiptOrdinal: initial.receiptOrdinal,
      requiresManualCurrencyConversion: true,
      receiptDetails: { currency: "USD" },
    } : { ...complete, id: initial.id });
    const q = await readyReceipt();

    await fireEvent.press(q.getByRole("button", { name: "Capture a separate receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Finish mocked camera with unsupported evidence" }));
    await fireEvent.press(q.getByRole("button", { name: "Scan 2 separate receipts" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Choose another receipt" })).toBeEnabled());
    const batchUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(batchUploads).toHaveLength(2);

    await fireEvent.press(q.getByRole("button", { name: "Choose another receipt" }));
    gallery.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///replacement-after-batch.jpg", width: 600, height: 1000, fileName: "replacement-after-batch.jpg", mimeType: "image/jpeg", fileSize: 2048 }],
    });
    await fireEvent.press(q.getByRole("button", { name: "Choose a photo from your gallery" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    const receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads).toHaveLength(3);
    expect(receiptUploads[2]![1].get("receiptBatchId")).toBeNull();
    expect(receiptUploads[2]![1].get("receiptOrdinal")).toBeNull();
    expect(receiptUploads.slice(0, 2).map(([, form]) => form.get("idempotencyKey")))
      .not.toContain(receiptUploads[2]![1].get("idempotencyKey"));
    expect(post.mock.calls.filter(([path]) => path === "/records/receipt-batches")).toHaveLength(1);
  });

  it("clears a resumed receipt's stored batch binding before a new capture", async () => {
    const storedSummary = {
      id: 84,
      businessProfileId: 1,
      receiptBatchId: 70,
      receiptOrdinal: 2,
      scanRevision: 0,
      processingStatus: "Complete" as const,
      confirmationStatus: "Pending" as const,
      processingError: null,
      processingErrorCode: null,
      extractedDate: "2026-09-01",
      extractedVendor: "Foreign Supplier",
      extractedDescription: "Imported stock",
      extractedAmount: 90,
      createdAt: "2026-09-13T10:00:00.000Z",
      pageCount: 1,
      allowedActions: { retryProcessing: false, reviewResult: true },
    };
    const storedForeignResult = {
      ...complete,
      id: 84,
      receiptBatchId: 70,
      receiptOrdinal: 2,
      extractedVendor: "Foreign Supplier",
      requiresManualCurrencyConversion: true,
      receiptDetails: { currency: "USD" },
    };
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: [storedSummary], nextCursor: null };
      if (path === "/records/receipts/84") return storedForeignResult;
      throw new Error(`Unexpected GET ${path}`);
    });
    poll.mockImplementation(async (initial: typeof accepted) => initial.id === 84
      ? storedForeignResult
      : { ...complete, id: initial.id });
    const q = await render(wrap(<ScanReceiptScreen navigation={navigation} />));

    await waitFor(() => expect(q.getByRole("button", { name: /^Review result for Foreign Supplier/ })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: /^Review result for Foreign Supplier/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Choose another receipt" })).toBeEnabled());

    await fireEvent.press(q.getByRole("button", { name: "Choose another receipt" }));
    await fireEvent.press(q.getByRole("button", { name: "Choose a photo from your gallery" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Scan this receipt" })).toBeEnabled());
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());

    const receiptUploads = upload.mock.calls.filter(([path]) => path === "/records/receipts");
    expect(receiptUploads).toHaveLength(1);
    expect(receiptUploads[0]![1].get("receiptBatchId")).toBeNull();
    expect(receiptUploads[0]![1].get("receiptOrdinal")).toBeNull();
    expect(poll.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ id: 41, receiptBatchId: null, receiptOrdinal: null }));
  });

  it("lists an abandoned pending scan under Receipts to finish after Retake photo even when the refresh fails", async () => {
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") throw Object.assign(new Error("Connection interrupted"), { status: 0 });
      return complete;
    });

    await fireEvent.press(q.getByRole("button", { name: "Retake photo" }));

    await waitFor(() => expect(q.getByRole("button", { name: "Check again" })).toBeTruthy());
    expect(q.getAllByRole("button", { name: /^Delete scan for Supplier/ })).toHaveLength(1);
    expect(q.getByRole("button", { name: /^Review result for Supplier/ })).toBeEnabled();
  });

  it("lists an accepted scan whose read failed after Choose another image", async () => {
    poll.mockRejectedValueOnce(new Error("Network interrupted"));
    const alert = vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === "destructive")?.onPress?.();
    });
    try {
      const q = await readyReceipt();
      await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
      await waitFor(() => expect(q.getByRole("button", { name: "Choose another image" })).toBeEnabled());
      get.mockImplementation(async (path: string) => {
        if (path.includes("provider-consent")) return unavailableConsent;
        if (path === "/records/receipts") throw Object.assign(new Error("Connection interrupted"), { status: 0 });
        return complete;
      });

      await fireEvent.press(q.getByRole("button", { name: "Choose another image" }));

      await waitFor(() => expect(q.getByRole("button", { name: "Check again" })).toBeTruthy());
      expect(q.getAllByRole("button", { name: /^Delete scan for Stored receipt 41$/ })).toHaveLength(1);
    } finally {
      alert.mockRestore();
    }
  });

  it("does not duplicate an abandoned scan the refresh also returns, and reopens it from the queue", async () => {
    let uploaded = false;
    const summary = {
      id: 41,
      businessProfileId: 1,
      receiptBatchId: null,
      receiptOrdinal: null,
      scanRevision: 0,
      processingStatus: "Complete" as const,
      confirmationStatus: "Pending" as const,
      processingError: null,
      processingErrorCode: null,
      extractedDate: "2026-09-01",
      extractedVendor: "Supplier",
      extractedDescription: "Coffee beans",
      extractedAmount: 250,
      createdAt: "2026-09-13T10:00:00.000Z",
      pageCount: 1,
      allowedActions: { retryProcessing: false, reviewResult: true },
    };
    get.mockImplementation(async (path: string) => {
      if (path.includes("provider-consent")) return unavailableConsent;
      if (path === "/records/receipts") return { items: uploaded ? [summary] : [], nextCursor: null };
      return complete;
    });
    const q = await readyReceipt();
    await fireEvent.press(q.getByRole("button", { name: "Scan this receipt" }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    uploaded = true;
    const listCallsBefore = get.mock.calls.filter(([path]) => path === "/records/receipts").length;

    await fireEvent.press(q.getByRole("button", { name: "Retake photo" }));
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/records/receipts").length).toBeGreaterThan(listCallsBefore));
    await waitFor(() => expect(q.queryByText("Checking for unfinished receipts…")).toBeNull());
    expect(q.getAllByRole("button", { name: /^Delete scan for Supplier/ })).toHaveLength(1);
    expect(q.queryByRole("button", { name: "Check again" })).toBeNull();

    await fireEvent.press(q.getByRole("button", { name: /^Review result for Supplier/ }));
    await waitFor(() => expect(q.getByRole("button", { name: "Save this expense" })).toBeEnabled());
    expect(upload.mock.calls.filter(([path]) => path === "/records/receipts")).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/records/receipts/41", undefined, expect.any(AbortSignal));
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
