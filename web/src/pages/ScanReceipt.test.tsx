// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanReceipt } from "./ScanReceipt";
import type { ScanResult } from "./scanReceipt/types";

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), selected: { id: 1 } }));
vi.mock("../lib/api", () => ({ api: { post: mocks.post, get: mocks.get } }));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({
  categories: [{ id: 2, name: "Supplies" }, { id: 3, name: "Uncategorized" }],
  refresh: async () => {}, createCategory: vi.fn(), loading: false,
}) }));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));

const receipt: ScanResult = {
  id: 10, processingStatus: "Complete", extractedDate: "2026-09-01", extractedDescription: "Paper supplies",
  extractedVendor: "Paper shop", extractedAmount: 500, items: [], ocrConfidence: 98,
};
const photo = (name = "receipt.png", contents = "receipt image") => new File([contents], name, { type: "image/png" });
function page() { return <MemoryRouter><ScanReceipt /></MemoryRouter>; }

beforeEach(() => {
  mocks.selected = { id: 1 };
  mocks.post.mockReset();
  mocks.get.mockReset();
  mocks.get.mockImplementation(async (url: string) =>
    url.startsWith("/records/receipts/provider-consent/")
      ? { data: { available: false, provider: null, consent: null, activeConsents: [] } }
      : { data: receipt },
  );
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:receipt"; }
    static revokeObjectURL() {}
  });
  mocks.post.mockResolvedValue({ data: receipt });
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

  it("resumes an accepted scan after a failed poll without uploading again", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValueOnce({ data: { ...receipt, processingStatus: "Processing" } });
    let pollCount = 0;
    mocks.get.mockImplementation(async (url: string) => {
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
