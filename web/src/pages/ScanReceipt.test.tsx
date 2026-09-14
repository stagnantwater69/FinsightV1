// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanReceipt } from "./ScanReceipt";
import type { ScanResult } from "./scanReceipt/types";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  confirm: vi.fn(),
  selected: { id: 1 },
}));
vi.mock("../lib/api", () => ({
  api: { post: mocks.post, get: mocks.get, patch: mocks.patch, delete: mocks.delete },
}));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({
  categories: [{ id: 2, name: "Supplies" }, { id: 3, name: "Uncategorized" }],
  refresh: async () => {}, createCategory: vi.fn(), loading: false,
}) }));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));

const receipt: ScanResult = {
  id: 10, scanRevision: 0, processingStatus: "Complete", extractedDate: "2026-09-01", extractedDescription: "Paper supplies",
  extractedVendor: "Paper shop", extractedAmount: 500, items: [], ocrConfidence: 98,
};
const photo = (name = "receipt.png", contents = "receipt image") => new File([contents], name, { type: "image/png" });
function CurrentPath() {
  return <span data-testid="current-path">{useLocation().pathname}</span>;
}
function page() { return <MemoryRouter><ScanReceipt /><CurrentPath /></MemoryRouter>; }

beforeEach(() => {
  mocks.selected = { id: 1 };
  mocks.post.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.delete.mockReset();
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.get.mockImplementation(async (url: string) =>
    url === "/records/receipts"
      ? { data: { items: [], nextCursor: null } }
      : url.startsWith("/records/receipts/provider-consent/")
      ? { data: { available: false, provider: null, consent: null, activeConsents: [] } }
      : { data: receipt },
  );
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(value: Blob) { return `blob:${(value as File).name}`; }
    static revokeObjectURL() {}
  });
  mocks.post.mockResolvedValue({ data: receipt });
  mocks.patch.mockResolvedValue({ data: receipt });
  mocks.delete.mockResolvedValue({ data: receipt });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("receipt upload and review", () => {
  it.each([
    ["no extracted items", []],
    [
      "one unmatched item",
      [{ id: 41, lineNumber: 1, name: "Unknown supply", quantity: 1, unitPrice: 500, amount: 500, categoryId: 3 }],
    ],
  ])("never requests a network category suggestion for %s", async (_case, items) => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({ data: { ...receipt, items } });
    render(page());

    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));

    await screen.findByRole("heading", { name: "Check what FinSight read" });
    expect(screen.getByLabelText(/^Category/)).toHaveValue("");
    expect(mocks.post.mock.calls.some(([url]) => url === "/ai/suggest-category")).toBe(false);
  });

  it("uses a single item's confirmed-history category without a network suggestion", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({
      data: {
        ...receipt,
        items: [
          { id: 42, lineNumber: 1, name: "Printer paper", quantity: 1, unitPrice: 500, amount: 500, categoryId: 2 },
        ],
      },
    });
    render(page());

    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));

    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await waitFor(() => expect(screen.getByLabelText(/^Category/)).toHaveValue("2"));
    expect(mocks.post.mock.calls.some(([url]) => url === "/ai/suggest-category")).toBe(false);
  });

  it("retains an invalid photo for correction and never uploads the selection", async () => {
    const user = userEvent.setup();
    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    fireEvent.drop(screen.getByText("Add more photos").closest("label")!, {
      dataTransfer: {
        files: [
          {
            name: "too-large.png",
            type: "image/png",
            size: 10 * 1024 * 1024 + 1,
            lastModified: 2,
          },
        ],
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/larger than 10 MiB/);
    expect(screen.getByRole("img", { name: "Page 1" })).toBeVisible();
    expect(screen.getByText("too-large.png")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove page 2" })).toBeEnabled();
    const scanButton = screen.getByRole("button", { name: "Fix selected photos to continue" });
    expect(scanButton).toBeDisabled();

    fireEvent.submit(scanButton.closest("form")!);
    expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipts")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Remove page 2" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
  });

  it("retains a failed file and reuses its upload key on retry", async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValueOnce(new Error("Connection lost"));
    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
    const first = mocks.post.mock.calls[0][1] as FormData;
    expect(first.get("idempotencyKey")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    const uploads = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts");
    expect(uploads).toHaveLength(2);
    expect((uploads[1][1] as FormData).get("idempotencyKey")).toBe(first.get("idempotencyKey"));
  });

  it("counts and appends every selected page in one long-receipt request", async () => {
    const user = userEvent.setup();
    render(page());
    const input = screen.getByLabelText(/Receipt photo/);
    const first = photo("page-1.png", "first page");
    const second = photo("page-2.png", "second receipt page");
    await user.upload(input, first);
    await user.upload(input, second);
    await user.click(screen.getByRole("radio", { name: /One long receipt/ }));
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));

    const upload = mocks.post.mock.calls.find(([url]) => url === "/records/receipts");
    expect(upload).toBeDefined();
    const appended = (upload![1] as FormData).getAll("files") as File[];
    expect(appended.map((file) => file.name)).toEqual(["page-1.png", "page-2.png"]);
    expect(appended.reduce((total, file) => total + file.size, 0)).toBe(first.size + second.size);
  });

  it("accepts every separate receipt in order before opening the first review", async () => {
    const user = userEvent.setup();
    mocks.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === "/records/receipt-batches") {
        return { data: {
          id: 77,
          businessProfileId: 1,
          expectedReceiptCount: 2,
          status: "COLLECTING",
          uploadedReceiptCount: 0,
          createdAt: "2026-09-13T00:00:00.000Z",
          finishedAt: null,
          receipts: [],
        } };
      }
      if (url === "/records/receipts") {
        const ordinal = Number((body as FormData).get("receiptOrdinal"));
        return { data: { ...receipt, id: 10 + ordinal, receiptBatchId: 77, receiptOrdinal: ordinal } };
      }
      if (url.endsWith("/confirm")) return { data: [{ id: url.includes("/11/") ? 901 : 902 }] };
      return { data: receipt };
    });

    render(page());
    const input = screen.getByLabelText(/Receipt photo/);
    await user.upload(input, photo("first.png", "first"));
    await user.upload(input, photo("second.png", "second"));
    await user.click(screen.getByRole("button", { name: "Scan 2 receipts" }));

    await screen.findByRole("heading", { name: "Check what FinSight read" });
    let uploads = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts");
    expect(uploads).toHaveLength(2);
    expect((uploads[0]![1] as FormData).get("receiptBatchId")).toBe("77");
    expect((uploads[0]![1] as FormData).get("receiptOrdinal")).toBe("1");
    expect((uploads[1]![1] as FormData).get("receiptBatchId")).toBe("77");
    expect((uploads[1]![1] as FormData).get("receiptOrdinal")).toBe("2");

    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));

    await screen.findByText(/Receipt 2.*Reviewing now/);
    uploads = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts");
    expect(uploads).toHaveLength(2);
    expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipt-batches")).toHaveLength(1);
  });

  it("replaces a cancelled batch replay once and validates the replacement before upload", async () => {
    const user = userEvent.setup();
    const batchKeys: string[] = [];
    mocks.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === "/records/receipt-batches") {
        batchKeys.push((body as { clientBatchKey: string }).clientBatchKey);
        if (batchKeys.length === 1) {
          return { data: {
            id: 77, businessProfileId: 1, expectedReceiptCount: 2, status: "CANCELLED",
            uploadedReceiptCount: 0, createdAt: "2026-09-13T00:00:00.000Z", finishedAt: null, receipts: [],
          } };
        }
        return { data: {
          id: 78, businessProfileId: 1, expectedReceiptCount: 2, status: "COLLECTING",
          uploadedReceiptCount: 0, createdAt: "2026-09-13T00:00:00.000Z", finishedAt: null, receipts: [],
        } };
      }
      if (url === "/records/receipts") {
        const ordinal = Number((body as FormData).get("receiptOrdinal"));
        return { data: { ...receipt, id: 80 + ordinal, receiptBatchId: 78, receiptOrdinal: ordinal } };
      }
      return { data: receipt };
    });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo("first.png"));
    await user.upload(screen.getByLabelText(/Receipt photo/), photo("second.png"));
    await user.click(screen.getByRole("button", { name: "Scan 2 receipts" }));

    await screen.findByRole("heading", { name: "Check what FinSight read" });
    expect(batchKeys).toHaveLength(2);
    expect(batchKeys[1]).not.toBe(batchKeys[0]);
    const uploads = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts");
    expect(uploads).toHaveLength(2);
    expect(uploads.every(([, body]) => (body as FormData).get("receiptBatchId") === "78")).toBe(true);
  });

  it("does not upload when a new batch response is not an empty collecting batch", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValueOnce({ data: {
      id: 77, businessProfileId: 2, expectedReceiptCount: 2, status: "COLLECTING",
      uploadedReceiptCount: 0, createdAt: "2026-09-13T00:00:00.000Z", finishedAt: null, receipts: [],
    } });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo("first.png"));
    await user.upload(screen.getByLabelText(/Receipt photo/), photo("second.png"));
    await user.click(screen.getByRole("button", { name: "Scan 2 receipts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This receipt batch no longer matches the selected images.");
    expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipts")).toHaveLength(0);
  });

  it("mints a new upload key when a cancelled single upload is re-sent as a batch child", async () => {
    const user = userEvent.setup();
    mocks.post.mockImplementation(async (url: string, body: unknown, config?: { signal?: AbortSignal }) => {
      if (url === "/records/receipt-batches") {
        return { data: {
          id: 7, businessProfileId: 1, expectedReceiptCount: 2, status: "COLLECTING",
          uploadedReceiptCount: 0, createdAt: "2026-09-13T00:00:00.000Z", finishedAt: null, receipts: [],
        } };
      }
      if (url === "/records/receipts") {
        const form = body as FormData;
        if (!form.has("receiptBatchId")) {
          // The single upload stays in flight until the owner cancels it.
          return new Promise((_, reject) => {
            config?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
          });
        }
        const ordinal = Number(form.get("receiptOrdinal"));
        return { data: { ...receipt, id: 10 + ordinal, receiptBatchId: 7, receiptOrdinal: ordinal } };
      }
      return { data: receipt };
    });

    render(page());
    const input = screen.getByLabelText(/Receipt photo/);
    await user.upload(input, photo("a.png", "photo a"));
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await user.click(await screen.findByRole("button", { name: "Cancel upload" }));
    await user.upload(screen.getByLabelText(/Receipt photo/), photo("b.png", "photo b"));
    await user.click(screen.getByRole("button", { name: "Scan 2 receipts" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });

    const uploads = mocks.post.mock.calls
      .filter(([url]) => url === "/records/receipts")
      .map(([, body]) => body as FormData);
    expect(uploads).toHaveLength(3);
    expect(uploads[0]!.has("receiptBatchId")).toBe(false);
    expect(uploads[1]!.get("receiptBatchId")).toBe("7");
    expect((uploads[1]!.get("files") as File).name).toBe("a.png");
    expect(uploads[1]!.get("idempotencyKey")).not.toBe(uploads[0]!.get("idempotencyKey"));
    expect(uploads[2]!.get("idempotencyKey")).not.toBe(uploads[0]!.get("idempotencyKey"));
  });

  it("re-accepts cached children under a re-planned batch instead of reusing another batch's scans", async () => {
    const user = userEvent.setup();
    let batchNumber = 0;
    let failedOnce = false;
    mocks.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === "/records/receipt-batches") {
        batchNumber += 1;
        const request = body as { expectedReceiptCount: number };
        return { data: {
          id: 900 + batchNumber, businessProfileId: 1, expectedReceiptCount: request.expectedReceiptCount,
          status: "COLLECTING", uploadedReceiptCount: 0, createdAt: "2026-09-13T00:00:00.000Z",
          finishedAt: null, receipts: [],
        } };
      }
      if (url === "/records/receipts") {
        const form = body as FormData;
        const ordinal = Number(form.get("receiptOrdinal"));
        if (ordinal === 3 && !failedOnce) {
          failedOnce = true;
          throw new Error("Connection lost");
        }
        const batchId = Number(form.get("receiptBatchId"));
        return { data: { ...receipt, id: batchId * 10 + ordinal, receiptBatchId: batchId, receiptOrdinal: ordinal } };
      }
      return { data: receipt };
    });

    render(page());
    const input = screen.getByLabelText(/Receipt photo/);
    await user.upload(input, photo("one.png", "one"));
    await user.upload(input, photo("two.png", "two"));
    await user.upload(input, photo("three.png", "three"));
    await user.click(screen.getByRole("button", { name: "Scan 3 receipts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");

    await user.click(screen.getByRole("button", { name: "Remove page 3" }));
    await user.click(screen.getByRole("button", { name: "Scan 2 receipts" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });

    const uploads = mocks.post.mock.calls
      .filter(([url]) => url === "/records/receipts")
      .map(([, body]) => body as FormData);
    const bindings = uploads.map((form) => `${form.get("receiptBatchId")}:${form.get("receiptOrdinal")}`);
    expect(bindings).toEqual(["901:1", "901:2", "901:3", "902:1", "902:2"]);
    expect(uploads[3]!.get("idempotencyKey")).not.toBe(uploads[0]!.get("idempotencyKey"));
    expect(uploads[4]!.get("idempotencyKey")).not.toBe(uploads[1]!.get("idempotencyKey"));
    expect(within(screen.getByRole("list", { name: "Receipts in this batch" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("lets the owner inspect every long-receipt page and reports which evidence OCR used", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValueOnce({
      data: {
        ...receipt,
        pageQualities: [
          { sharpness: 90, brightness: 0.5, tooBlurredToTrust: false },
          { sharpness: 20, brightness: 0.4, tooBlurredToTrust: true },
        ],
        pageProcessing: [
          { source: "original", hasProcessedVariant: false, captureMetadata: null },
          { source: "processed", hasProcessedVariant: true, captureMetadata: null },
        ],
        pageEvidence: [
          {
            pageNumber: 1, captureMode: "standard", processingMode: "original", ocrInput: "source",
            source: { variant: "source", label: "Source", width: 1200, height: 1800 }, derived: null,
          },
          {
            pageNumber: 2, captureMode: "standard", processingMode: "grayscale", ocrInput: "derived",
            source: { variant: "source", label: "Source", width: 1200, height: 1800 },
            derived: { variant: "derived", label: "Enhanced grayscale", width: 1100, height: 1700 },
          },
        ],
      },
    });
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") return { data: { items: [], nextCursor: null } };
      if (url.startsWith("/records/receipts/provider-consent/")) {
        return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
      }
      if (url === "/records/receipts/10/pages/2/image/derived") {
        return { data: {
          pageNumber: 2, variant: "derived", label: "Enhanced grayscale", width: 1100, height: 1700,
          url: "https://storage.example.test/signed-derived", expiresInSeconds: 600,
        } };
      }
      return { data: receipt };
    });
    render(page());
    const input = screen.getByLabelText(/Receipt photo/);
    await user.upload(input, photo("page-1.png", "first page"));
    await user.upload(input, photo("page-2.png", "second page"));
    await user.click(screen.getByRole("radio", { name: /One long receipt/ }));
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));

    await screen.findByRole("heading", { name: "Check what FinSight read" });
    expect(screen.getByRole("tablist", { name: "Receipt pages" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Source, receipt page 1 of 2" })).toHaveAttribute("src", "blob:page-1.png");
    const firstPage = screen.getByRole("tab", { name: "View page 1 of 2" });
    firstPage.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "View page 2 of 2, quality warning" })).toHaveFocus();
    expect(screen.getByRole("img", { name: "Source, receipt page 2 of 2" })).toHaveAttribute("src", "blob:page-2.png");
    expect(screen.getByText("Quality warning: check this page closely.")).toBeVisible();
    expect(screen.getByText("OCR used the enhanced grayscale copy. Your source image is retained.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Enhanced grayscale" }));
    const adjusted = await screen.findByRole("img", { name: "Enhanced grayscale, receipt page 2 of 2" });
    expect(adjusted).toHaveAttribute(
      "src",
      "https://storage.example.test/signed-derived",
    );
    expect(mocks.get).toHaveBeenCalledWith("/records/receipts/10/pages/2/image/derived");
    fireEvent.error(adjusted);
    expect(screen.getByRole("img", { name: "Source, receipt page 2 of 2" })).toHaveAttribute("src", "blob:page-2.png");
    expect(screen.getByRole("alert")).toHaveTextContent(/adjusted copy expired/i);
    await user.click(screen.getByRole("button", { name: "Enhanced grayscale" }));
    await waitFor(() => {
      expect(mocks.get.mock.calls.filter(([url]) => url === "/records/receipts/10/pages/2/image/derived")).toHaveLength(2);
    });
  });

  it("resumes an accepted scan after a failed poll without uploading again", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValueOnce({ data: { ...receipt, processingStatus: "Processing" } });
    let pollCount = 0;
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") return { data: { items: [], nextCursor: null } };
      if (url.startsWith("/records/receipts/provider-consent/")) {
        return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
      }
      pollCount += 1;
      if (pollCount === 1) throw new Error("Network interrupted");
      return { data: receipt };
    });
    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("alert", {}, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" }, { timeout: 3000 });
    expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipts")).toHaveLength(1);
  });

  it("deletes an unfinished scan with a stable idempotency key across a transport retry", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({
      data: {
        ...receipt,
        processingStatus: "Failed",
        processingError: "The image could not be read.",
      },
    });
    mocks.delete
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ data: { id: 501, receiptScanId: receipt.id, status: "PENDING" } });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Receipt needs another try" });

    await user.click(screen.getByRole("button", { name: "Delete scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    await user.click(screen.getByRole("button", { name: "Delete scan" }));

    await screen.findByRole("heading", { name: "Scan a receipt" });
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.delete).toHaveBeenCalledTimes(2);
    expect(mocks.delete.mock.calls[0]![0]).toBe("/records/receipts/10");
    expect(mocks.delete.mock.calls[0]![1].headers["Idempotency-Key"]).toBe(
      mocks.delete.mock.calls[1]![1].headers["Idempotency-Key"],
    );
  });

  it("abandons a deleted batch's local queue and resumes accepted children from history without reuploading", async () => {
    const user = userEvent.setup();
    let uploadNumber = 0;
    let includeAcceptedChildren = false;
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") {
        return { data: { items: includeAcceptedChildren ? [
          {
            id: 22, businessProfileId: 1, receiptBatchId: 77, receiptOrdinal: 2, scanRevision: 0,
            processingStatus: "Complete", confirmationStatus: "Pending", processingError: null, processingErrorCode: null,
            extractedDate: "2026-09-13T00:00:00.000Z", extractedVendor: "Accepted receipt 2", extractedDescription: null,
            extractedAmount: 100, createdAt: "2026-09-13T00:00:00.000Z", pageCount: 1,
            allowedActions: { retryProcessing: false, reviewResult: true },
          },
          {
            id: 23, businessProfileId: 1, receiptBatchId: 77, receiptOrdinal: 3, scanRevision: 0,
            processingStatus: "Complete", confirmationStatus: "Pending", processingError: null, processingErrorCode: null,
            extractedDate: "2026-09-13T00:00:00.000Z", extractedVendor: "Accepted receipt 3", extractedDescription: null,
            extractedAmount: 100, createdAt: "2026-09-13T00:00:00.000Z", pageCount: 1,
            allowedActions: { retryProcessing: false, reviewResult: true },
          },
        ] : [], nextCursor: null } };
      }
      if (url.startsWith("/records/receipts/provider-consent/")) {
        return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
      }
      return { data: receipt };
    });
    mocks.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === "/records/receipt-batches") {
        const request = body as { businessProfileId: number; clientBatchKey: string; expectedReceiptCount: number };
        return { data: {
          id: 77,
          businessProfileId: request.businessProfileId,
          expectedReceiptCount: request.expectedReceiptCount,
          status: "COLLECTING",
          uploadedReceiptCount: 0,
          createdAt: "2026-09-13T00:00:00.000Z",
          finishedAt: null,
          receipts: [],
        } };
      }
      if (url === "/records/receipts") {
        uploadNumber += 1;
        const form = body as FormData;
        return { data: {
          ...receipt,
          id: 20 + uploadNumber,
          receiptBatchId: Number(form.get("receiptBatchId")),
          receiptOrdinal: Number(form.get("receiptOrdinal")),
          extractedVendor: `Accepted receipt ${uploadNumber}`,
          ...(uploadNumber === 1
            ? { processingStatus: "Failed", processingError: "Unreadable photo" }
            : { processingStatus: "Complete" }),
        } };
      }
      return { data: receipt };
    });
    mocks.delete.mockImplementation(async () => {
      includeAcceptedChildren = true;
      return { data: { id: 601, receiptScanId: 21, status: "PENDING" } };
    });

    render(page());
    const input = screen.getByLabelText(/Receipt photo/);
    await user.upload(input, photo("first.png"));
    await user.upload(input, photo("second.png"));
    await user.upload(input, photo("third.png"));
    await user.click(screen.getByRole("button", { name: "Scan 3 receipts" }));
    await screen.findByRole("heading", { name: "Receipt needs another try" });

    await user.click(screen.getByRole("button", { name: "Delete scan" }));
    await screen.findByRole("heading", { name: "Scan a receipt" });
    await screen.findByRole("heading", { name: "Continue an unfinished scan" });
    expect(screen.getByText("Accepted receipt 2", { exact: true })).toBeVisible();
    expect(screen.getByText("Accepted receipt 3", { exact: true })).toBeVisible();

    expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipt-batches")).toHaveLength(1);
    const uploads = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts");
    expect(uploads).toHaveLength(3);
    expect(uploads.map(([, body]) => ({
      batchId: (body as FormData).get("receiptBatchId"),
      ordinal: (body as FormData).get("receiptOrdinal"),
    }))).toEqual([
      { batchId: "77", ordinal: "1" },
      { batchId: "77", ordinal: "2" },
      { batchId: "77", ordinal: "3" },
    ]);
  });

  it("discovers an unfinished scan and reviews its stored source without local files", async () => {
    const user = userEvent.setup();
    const stored = {
      ...receipt,
      id: 91,
      pageEvidence: [{
        pageNumber: 1,
        captureMode: "standard" as const,
        processingMode: "grayscale",
        ocrInput: "derived" as const,
        source: { variant: "source" as const, label: "Source" as const, width: 2400, height: 3600 },
        derived: {
          variant: "derived" as const,
          label: "Enhanced grayscale" as const,
          width: 1200,
          height: 1800,
        },
      }],
    };
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") return { data: { items: [{
        id: 91,
        businessProfileId: 1,
        receiptBatchId: null,
        receiptOrdinal: null,
        scanRevision: 0,
        processingStatus: "Complete",
        confirmationStatus: "Pending",
        processingError: null,
        processingErrorCode: null,
        extractedDate: "2026-09-01",
        extractedVendor: "Paper shop",
        extractedDescription: "Paper supplies",
        extractedAmount: 500,
        createdAt: "2026-09-13T00:00:00.000Z",
        pageCount: 1,
        allowedActions: { retryProcessing: false, reviewResult: true },
      }], nextCursor: null } };
      if (url.startsWith("/records/receipts/provider-consent/")) {
        return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
      }
      if (url === "/records/receipts/91") return { data: stored };
      if (url === "/records/receipts/91/pages/1/image/source") {
        return { data: {
          pageNumber: 1,
          variant: "source",
          label: "Source",
          width: 2400,
          height: 3600,
          url: "https://storage.example.test/source",
          expiresInSeconds: 600,
        } };
      }
      return { data: receipt };
    });

    render(page());
    await user.click(await screen.findByRole("button", { name: "Review result, Paper shop" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    expect(await screen.findByRole("img", { name: "Source, receipt page 1 of 1" })).toHaveAttribute(
      "src",
      "https://storage.example.test/source",
    );
    expect(mocks.get).toHaveBeenCalledWith("/records/receipts", expect.objectContaining({
      params: { businessProfileId: 1, status: "active", take: 20 },
    }));
  });

  it("ignores a late upload after switching businesses", async () => {
    const user = userEvent.setup();
    let finish!: (value: { data: ScanResult }) => void;
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    const signal = mocks.post.mock.calls[0][2].signal as AbortSignal;
    mocks.selected = { id: 99 };
    view.rerender(page());
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ data: receipt }); });
    expect(screen.queryByRole("heading", { name: "Check what FinSight read" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan receipt" })).toBeDisabled();
  });

  it("locks same-tick duplicate submits and saves reviewed values once", async () => {
    const user = userEvent.setup();
    let finish!: (value: { data: ScanResult }) => void;
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    const form = screen.getByRole("button", { name: "Scan receipt" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ data: receipt }); });
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    await user.clear(screen.getByLabelText(/^Amount/));
    await user.type(screen.getByLabelText(/^Amount/), "520");
    mocks.post.mockImplementationOnce(() => new Promise(() => {}));
    const confirm = screen.getByRole("button", { name: "Confirm & save expense" }).closest("form")!;
    fireEvent.submit(confirm);
    fireEvent.submit(confirm);
    const saves = mocks.post.mock.calls.filter(([url]) => url.endsWith("/confirm"));
    expect(saves).toHaveLength(1);
    expect(saves[0][1]).toMatchObject({ amount: 520 });
  });

  it("requires an explicit Save anyway decision for the current duplicate set", async () => {
    const user = userEvent.setup();
    const candidateSetHash = "a".repeat(64);
    let confirmAttempts = 0;
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") return { data: receipt };
      if (url === "/records/receipts/10/confirm") {
        confirmAttempts += 1;
        if (confirmAttempts === 1) {
          throw Object.assign(new Error("Possible duplicate receipt"), {
            isAxiosError: true,
            response: {
              status: 409,
              data: {
                error: "Review possible duplicate receipts before saving",
                code: "DUPLICATE_REVIEW_REQUIRED",
                sourceFingerprint: "b".repeat(64),
                candidateSetHash,
                candidateCount: 1,
                candidatesTruncated: false,
                nextCursor: null,
                candidates: [{
                  id: 81,
                  target: { kind: "expense", id: 501 },
                  vendor: "Paper shop",
                  date: "2026-09-01T00:00:00.000Z",
                  total: 500,
                  scoreBand: "EXACT",
                  reasons: ["SAME_VENDOR", "SAME_DATE", "SAME_TOTAL"],
                }],
              },
            },
          });
        }
        return { data: [{ id: 502 }] };
      }
      return { data: receipt };
    });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));

    expect(await screen.findByRole("heading", { name: "Possible duplicate receipt" })).toBeVisible();
    expect(screen.getByText(/same merchant, same date, same total/i)).toBeVisible();
    const saveAnyway = screen.getByRole("button", { name: "Save anyway" });
    expect(saveAnyway).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I reviewed these matches/ }));
    expect(saveAnyway).toBeEnabled();
    await user.click(saveAnyway);

    const saves = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm");
    expect(saves).toHaveLength(2);
    expect(saves[0]![1]).not.toHaveProperty("duplicateDecision");
    expect(saves[1]![1]).toMatchObject({
      duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash },
    });
  });

  it("cannot approve a truncated duplicate set until every page is loaded", async () => {
    const user = userEvent.setup();
    const candidateSetHash = "c".repeat(64);
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      id: 100 + index,
      target: { kind: "expense" as const, id: 500 + index },
      vendor: `Paper shop ${index + 1}`,
      date: "2026-09-01T00:00:00.000Z",
      total: 500,
      scoreBand: "EXACT" as const,
      reasons: ["SAME_VENDOR" as const, "SAME_DATE" as const, "SAME_TOTAL" as const],
    }));
    mocks.get.mockImplementation(async (url: string, config?: { params?: { cursor?: string } }) => {
      if (url === "/records/receipts") return { data: { items: [], nextCursor: null } };
      if (url.startsWith("/records/receipts/provider-consent/")) {
        return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
      }
      if (url === "/records/receipts/10/duplicate-candidates") {
        const finalPage = config?.params?.cursor === "next-duplicate-page";
        return { data: {
          sourceFingerprint: "d".repeat(64),
          candidateSetHash,
          candidateCount: 21,
          candidatesTruncated: !finalPage,
          candidates: finalPage ? candidates.slice(20) : candidates.slice(0, 20),
          nextCursor: finalPage ? null : "next-duplicate-page",
        } };
      }
      return { data: receipt };
    });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");

    expect(await screen.findByText("Showing 20 of 21 matches. Load the rest before deciding.")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /I reviewed these matches/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save anyway" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Load remaining matches" }));
    const acknowledgement = await screen.findByRole("checkbox", { name: /I reviewed these matches/ });
    expect(screen.getByText("Paper shop 21")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save anyway" })).toBeDisabled();
    await user.click(acknowledgement);
    expect(screen.getByRole("button", { name: "Save anyway" })).toBeEnabled();
  });

  describe("duplicate acknowledgement after a field edit (PR-2 review, open item 4)", () => {
    const candidate = (id: number, targetId: number) => ({
      id,
      target: { kind: "expense" as const, id: targetId },
      vendor: "Paper shop",
      date: "2026-09-01T00:00:00.000Z",
      total: 500,
      scoreBand: "EXACT" as const,
      reasons: ["SAME_VENDOR" as const, "SAME_DATE" as const, "SAME_TOTAL" as const],
    });
    const prefetchedHash = "a".repeat(64);
    const confirmTimeHash = "b".repeat(64);

    function changedResponse(candidates: ReturnType<typeof candidate>[]) {
      return Object.assign(new Error("Possible duplicate receipt"), {
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            error: "The possible duplicates changed",
            code: "DUPLICATE_REVIEW_CHANGED",
            sourceFingerprint: "e".repeat(64),
            candidateSetHash: confirmTimeHash,
            candidateCount: candidates.length,
            candidatesTruncated: false,
            nextCursor: null,
            candidates,
          },
        },
      });
    }

    async function reviewEditAndAcknowledge(user: ReturnType<typeof userEvent.setup>) {
      mocks.get.mockImplementation(async (url: string) => {
        if (url === "/records/receipts") return { data: { items: [], nextCursor: null } };
        if (url.startsWith("/records/receipts/provider-consent/")) {
          return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
        }
        if (url === "/records/receipts/10/duplicate-candidates") {
          return { data: {
            sourceFingerprint: "d".repeat(64),
            candidateSetHash: prefetchedHash,
            candidateCount: 1,
            candidatesTruncated: false,
            candidates: [candidate(81, 501)],
            nextCursor: null,
          } };
        }
        return { data: receipt };
      });
      render(page());
      await user.upload(screen.getByLabelText(/Receipt photo/), photo());
      await user.click(screen.getByRole("button", { name: "Scan receipt" }));
      await screen.findByRole("heading", { name: "Check what FinSight read" });
      await user.selectOptions(screen.getByLabelText(/^Category/), "2");
      await user.clear(screen.getByLabelText(/^Vendor/));
      await user.type(screen.getByLabelText(/^Vendor/), "Paper Shop Manila");
      await user.click(await screen.findByRole("checkbox", { name: /I reviewed these matches/ }));
      await user.click(screen.getByRole("button", { name: "Save anyway" }));
    }

    it("keeps the acknowledgement and saves with the confirm-time hash when the matches are the same", async () => {
      const user = userEvent.setup();
      let confirmAttempts = 0;
      mocks.post.mockImplementation(async (url: string) => {
        if (url === "/records/receipts/10/confirm") {
          confirmAttempts += 1;
          // Same target, new row id: the server re-persisted the set under the edited identity.
          if (confirmAttempts === 1) throw changedResponse([candidate(93, 501)]);
          return { data: [{ id: 502 }] };
        }
        return { data: receipt };
      });

      await reviewEditAndAcknowledge(user);

      await waitFor(() => expect(screen.getByTestId("current-path")).toHaveTextContent("/records"));
      const saves = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm");
      expect(saves).toHaveLength(2);
      expect(saves[0]![1]).toMatchObject({ duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: prefetchedHash } });
      expect(saves[1]![1]).toMatchObject({ duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: confirmTimeHash } });
      expect(saves[1]![1]).toMatchObject({ vendor: "Paper Shop Manila" });
    });

    it("retries at most once: a second same-target CHANGED answer is shown, not re-sent", async () => {
      const user = userEvent.setup();
      let confirmAttempts = 0;
      mocks.post.mockImplementation(async (url: string) => {
        if (url === "/records/receipts/10/confirm") {
          confirmAttempts += 1;
          // Same target set every time: retrying on "same targets" alone would post forever.
          throw changedResponse([candidate(90 + confirmAttempts, 501)]);
        }
        return { data: receipt };
      });

      await reviewEditAndAcknowledge(user);

      expect(await screen.findByText(/The matches changed while you were reviewing/)).toBeVisible();
      const saves = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm");
      expect(saves).toHaveLength(2);
      expect(saves[1]![1]).toMatchObject({ duplicateDecision: { action: "SAVE_ANYWAY", candidateSetHash: confirmTimeHash } });
      expect(screen.getByRole("checkbox", { name: /I reviewed these matches/ })).not.toBeChecked();
      expect(screen.getByTestId("current-path")).toHaveTextContent("/");
    });

    it("does not retry when the confirm-time list is truncated, even with the same visible targets", async () => {
      const user = userEvent.setup();
      mocks.post.mockImplementation(async (url: string) => {
        if (url === "/records/receipts/10/confirm") {
          const error = changedResponse([candidate(93, 501)]);
          throw Object.assign(error, {
            response: {
              ...error.response,
              data: { ...error.response.data, candidateCount: 2, candidatesTruncated: true, nextCursor: "next" },
            },
          });
        }
        return { data: receipt };
      });

      await reviewEditAndAcknowledge(user);

      expect(await screen.findByText(/The matches changed while you were reviewing/)).toBeVisible();
      expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm")).toHaveLength(1);
    });

    it("asks again when the confirm-time matches differ from the acknowledged list", async () => {
      const user = userEvent.setup();
      mocks.post.mockImplementation(async (url: string) => {
        if (url === "/records/receipts/10/confirm") throw changedResponse([candidate(93, 501), candidate(94, 777)]);
        return { data: receipt };
      });

      await reviewEditAndAcknowledge(user);

      expect(await screen.findByText(/The matches changed while you were reviewing/)).toBeVisible();
      expect(screen.getByRole("checkbox", { name: /I reviewed these matches/ })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Save anyway" })).toBeDisabled();
      expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm")).toHaveLength(1);
      expect(screen.getByTestId("current-path")).toHaveTextContent("/");
    });
  });

  it("resolves a lost confirmation response from the stored scan state without posting again", async () => {
    const user = userEvent.setup();
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") return { data: receipt };
      if (url === "/records/receipts/10/confirm") {
        throw Object.assign(new Error("Network Error"), { isAxiosError: true, code: "ERR_NETWORK" });
      }
      return { data: receipt };
    });
    mocks.get.mockImplementation(async (url: string) => {
      if (url === "/records/receipts") return { data: { items: [], nextCursor: null } };
      if (url === "/records/receipts/10/duplicate-candidates") {
        return { data: { sourceFingerprint: null, candidateSetHash: null, candidates: [], nextCursor: null } };
      }
      if (url === "/records/receipts/10") {
        return { data: { ...receipt, confirmationStatus: "Confirmed" } };
      }
      return { data: receipt };
    });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));

    await waitFor(() => expect(screen.getByTestId("current-path")).toHaveTextContent("/records"));
    expect(mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm")).toHaveLength(1);
    expect(mocks.get.mock.calls.some(([url]) => url === "/records/receipts/10")).toBe(true);
  });

  it("edits an extracted item with a revision guard and confirms the new revision", async () => {
    const user = userEvent.setup();
    const itemised = {
      ...receipt,
      scanRevision: 3,
      items: [
        { id: 41, lineNumber: 1, name: "Printer paper", quantity: 1, unitPrice: 250, amount: 250, categoryId: 2 },
        { id: 42, lineNumber: 2, name: "Pens", quantity: 5, unitPrice: 50, amount: 250, categoryId: 2 },
      ],
    };
    const corrected = {
      ...itemised,
      scanRevision: 4,
      items: [
        { ...itemised.items[0], name: "A4 printer paper", amount: 260, ownerEditedFields: ["name", "amount"] },
        itemised.items[1],
      ],
    } satisfies ScanResult;
    mocks.post.mockImplementation(async (url: string) =>
      url.endsWith("/confirm") ? { data: [{ id: 501 }] } : { data: itemised });
    mocks.patch.mockResolvedValue({ data: corrected });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });

    await user.click(screen.getByRole("button", { name: "Edit Printer paper" }));
    await user.clear(screen.getByLabelText("Item name"));
    await user.type(screen.getByLabelText("Item name"), "A4 printer paper");
    await user.clear(screen.getByLabelText("Item amount"));
    await user.type(screen.getByLabelText("Item amount"), "260");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Corrected by you");
    expect(mocks.patch).toHaveBeenCalledWith(
      "/records/receipts/10/items/41",
      { name: "A4 printer paper", amount: 260, expectedScanRevision: 3 },
      { signal: expect.any(AbortSignal) },
    );
    await user.click(screen.getByRole("radio", { name: /A discount on the whole receipt/ }));
    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));
    const save = mocks.post.mock.calls.find(([url]) => url === "/records/receipts/10/confirm");
    expect(save?.[1]).toMatchObject({ expectedScanRevision: 4 });
  });

  it("keeps an item draft and refreshes its revision after a stale edit", async () => {
    const user = userEvent.setup();
    const itemised = {
      ...receipt,
      scanRevision: 3,
      items: [
        { id: 41, lineNumber: 1, name: "Printer paper", quantity: 1, unitPrice: 250, amount: 250, categoryId: 2 },
        { id: 42, lineNumber: 2, name: "Pens", quantity: 5, unitPrice: 50, amount: 250, categoryId: 2 },
      ],
    };
    mocks.post.mockResolvedValue({ data: itemised });
    mocks.patch.mockRejectedValueOnce(Object.assign(new Error("Conflict"), {
      isAxiosError: true,
      response: { status: 409, data: { error: "Receipt changed" } },
    }));
    mocks.get.mockImplementation(async (url: string) =>
      url === "/records/receipts"
        ? { data: { items: [], nextCursor: null } }
        : url.startsWith("/records/receipts/provider-consent/")
        ? { data: { available: false, provider: null, consent: null, activeConsents: [] } }
        : { data: { ...itemised, scanRevision: 4 } });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.click(screen.getByRole("button", { name: "Edit Printer paper" }));
    await user.clear(screen.getByLabelText("Item name"));
    await user.type(screen.getByLabelText("Item name"), "A4 paper draft");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed in another request/i);
    expect(screen.getByLabelText("Item name")).toHaveValue("A4 paper draft");

    mocks.patch.mockResolvedValueOnce({
      data: {
        ...itemised,
        scanRevision: 5,
        items: [{ ...itemised.items[0], name: "A4 paper draft" }, itemised.items[1]],
      },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.patch.mock.calls[1]?.[1]).toMatchObject({
      name: "A4 paper draft",
      expectedScanRevision: 4,
    });
  });

  it("adopts the newer revision after a stale confirm so the next save can succeed", async () => {
    const user = userEvent.setup();
    const stale = { ...receipt, scanRevision: 3 };
    let confirms = 0;
    mocks.post.mockImplementation(async (url: string) => {
      if (url !== "/records/receipts/10/confirm") return { data: stale };
      confirms += 1;
      if (confirms === 1) {
        throw Object.assign(new Error("Conflict"), {
          isAxiosError: true,
          response: { status: 409, data: { error: "This receipt changed while you were reviewing it." } },
        });
      }
      return { data: [{ id: 501 }] };
    });
    mocks.get.mockImplementation(async (url: string) =>
      url === "/records/receipts"
        ? { data: { items: [], nextCursor: null } }
        : url === "/records/receipts/10/duplicate-candidates"
        ? { data: { sourceFingerprint: null, candidateSetHash: null, candidates: [], nextCursor: null } }
        : url.startsWith("/records/receipts/provider-consent/")
        ? { data: { available: false, provider: null, consent: null, activeConsents: [] } }
        : { data: { ...stale, scanRevision: 4 } });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/latest version is shown/i);
    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));
    await waitFor(() => expect(confirms).toBe(2));
    const [, first] = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm")[0]!;
    const [, second] = mocks.post.mock.calls.filter(([url]) => url === "/records/receipts/10/confirm")[1]!;
    expect(first).toMatchObject({ expectedScanRevision: 3 });
    expect(second).toMatchObject({ expectedScanRevision: 4 });
  });

  it("ignores a late item response after the owner has chosen another image", async () => {
    const user = userEvent.setup();
    const itemised = {
      ...receipt,
      scanRevision: 3,
      items: [
        { id: 41, lineNumber: 1, name: "Printer paper", quantity: 1, unitPrice: 250, amount: 250, categoryId: 2 },
        { id: 42, lineNumber: 2, name: "Pens", quantity: 5, unitPrice: 50, amount: 250, categoryId: 2 },
      ],
    };
    mocks.post.mockResolvedValue({ data: itemised });
    let settlePatch!: (value: { data: ScanResult }) => void;
    mocks.patch.mockImplementation(() => new Promise((resolve) => { settlePatch = resolve; }));

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.click(screen.getByRole("button", { name: "Edit Printer paper" }));
    await user.clear(screen.getByLabelText("Item amount"));
    await user.type(screen.getByLabelText("Item amount"), "260");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await user.click(screen.getByRole("button", { name: "Choose another image" }));
    expect(screen.queryByRole("heading", { name: "Check what FinSight read" })).toBeNull();

    settlePatch({ data: { ...itemised, scanRevision: 4, items: [{ ...itemised.items[0], amount: 260 }, itemised.items[1]] } });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "Check what FinSight read" })).toBeNull();
    expect(screen.getByLabelText(/Receipt photo/)).toBeInTheDocument();
  });

  it("does not move focus back to the attention field after an item save", async () => {
    const user = userEvent.setup();
    const itemised = {
      ...receipt,
      extractedDate: null,
      scanRevision: 3,
      items: [
        { id: 41, lineNumber: 1, name: "Printer paper", quantity: 1, unitPrice: 250, amount: 250, categoryId: 2 },
        { id: 42, lineNumber: 2, name: "Pens", quantity: 5, unitPrice: 50, amount: 250, categoryId: 2 },
      ],
    };
    mocks.post.mockResolvedValue({ data: itemised });
    mocks.patch.mockResolvedValue({ data: { ...itemised, scanRevision: 4, items: [{ ...itemised.items[0], amount: 260 }, itemised.items[1]] } });

    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await waitFor(() => expect(screen.getByLabelText(/^Date/)).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Edit Printer paper" }));
    await user.clear(screen.getByLabelText("Item amount"));
    await user.type(screen.getByLabelText("Item amount"), "260");
    const save = screen.getByRole("button", { name: "Save" });
    await user.click(save);
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText(/^Date/)).not.toHaveFocus();
  });

  it("keeps foreign receipt amounts out of the peso confirmation form", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValueOnce({ data: { ...receipt, receiptDetails: {
      currency: "USD", transactionTime: "12:30", subtotal: 450, tax: 50, tip: null,
      discount: null, paymentMethod: "Cash", receiptNumber: "A123",
    } } });
    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("link", { name: "Enter the PHP amount manually" });
    expect(screen.queryByRole("button", { name: /Confirm & save/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Amount/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("USD 450.00")).toBeVisible();
    await waitFor(() => expect(mocks.post.mock.calls.filter(([url]) => url.endsWith("/confirm"))).toHaveLength(0));
  });

  it("blocks a receipt with conflicting printed currencies even without a currency code", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValueOnce({ data: { ...receipt, requiresManualCurrencyConversion: true } });
    render(page());
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("link", { name: "Enter the PHP amount manually" });
    expect(screen.queryByRole("button", { name: /Confirm & save/ })).not.toBeInTheDocument();
  });
});
