// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanReceipt } from "./ScanReceipt";
import type { ReceiptScanResult } from "./scanReceipt/types";

/*
 * Reliability review 2026-09-17, items #5, #21 and #43.
 *
 * The × beside each scanned item fired an irreversible server-side DELETE with
 * no confirmation, left every other row's × live while that delete was in
 * flight (so a second click sent a stale scanRevision and came back as "this
 * receipt changed in another request"), and dropped keyboard focus onto
 * <body> when the row unmounted.
 */

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
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
vi.mock("../components/Toast", () => ({ useToast: () => mocks.toast }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => mocks.confirm }));

const base: ReceiptScanResult = {
  id: 10, scanRevision: 3, processingStatus: "Complete", extractedDate: "2026-09-01",
  extractedDescription: "Paper supplies", extractedVendor: "Paper shop", extractedAmount: 500,
  items: [], ocrConfidence: 98,
};

const itemised: ReceiptScanResult = {
  ...base,
  items: [
    { id: 41, lineNumber: 1, name: "Printer paper", quantity: 1, unitPrice: 200, amount: 200, categoryId: 2 },
    { id: 42, lineNumber: 2, name: "Pens", quantity: 5, unitPrice: 40, amount: 200, categoryId: 2 },
    { id: 43, lineNumber: 3, name: "Ink", quantity: 1, unitPrice: 100, amount: 100, categoryId: 2 },
  ],
};

/** The scan as the server returns it once item 41 is gone. */
const afterRemoval: ReceiptScanResult = {
  ...itemised,
  scanRevision: 4,
  items: [itemised.items[1]!, itemised.items[2]!],
};

const photo = () => new File(["receipt image"], "receipt.png", { type: "image/png" });
const page = () => <MemoryRouter><ScanReceipt /></MemoryRouter>;

/** Uploads a photo and waits for the item table to be on screen. */
async function openReview(user: ReturnType<typeof userEvent.setup>) {
  render(page());
  await user.upload(screen.getByLabelText(/Receipt photo/), photo());
  await user.click(screen.getByRole("button", { name: "Scan receipt" }));
  await screen.findByRole("heading", { name: "Check what FinSight read" });
}

beforeEach(() => {
  mocks.selected = { id: 1 };
  mocks.post.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.delete.mockReset();
  mocks.confirm.mockReset();
  mocks.toast.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.get.mockImplementation(async (url: string) =>
    url === "/records/receipts"
      ? { data: { items: [], nextCursor: null } }
      : url.startsWith("/records/receipts/provider-consent/")
      ? { data: { available: false, provider: null, consent: null, activeConsents: [] } }
      : { data: itemised },
  );
  mocks.post.mockImplementation(async (url: string) =>
    url.endsWith("/confirm") ? { data: [{ id: 501 }] } : { data: itemised });
  mocks.patch.mockResolvedValue({ data: itemised });
  mocks.delete.mockResolvedValue({ data: afterRemoval });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(value: Blob) { return `blob:${(value as File).name}`; }
    static revokeObjectURL() {}
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("removing a scanned item", () => {
  it("asks before deleting, and deletes nothing when the owner backs out", async () => {
    const user = userEvent.setup();
    mocks.confirm.mockResolvedValue(false);
    await openReview(user);

    await user.click(screen.getByRole("button", { name: /Remove Printer paper/ }));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({
      title: 'Remove "Printer paper"?',
      confirmLabel: "Remove item",
      tone: "danger",
    });
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.getByText("Printer paper")).toBeInTheDocument();
  });

  it("deletes once the owner approves and confirms it out loud", async () => {
    const user = userEvent.setup();
    await openReview(user);

    await user.click(screen.getByRole("button", { name: /Remove Printer paper/ }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith(
      "/records/receipts/10/items/41",
      { params: { expectedScanRevision: 3 }, signal: expect.any(AbortSignal) },
    ));
    await waitFor(() => expect(screen.queryByText("Printer paper")).not.toBeInTheDocument());
    expect(mocks.toast).toHaveBeenCalledWith("Item removed from this receipt.");
  });

  it("disables every item control while a removal is in flight, not just its own row", async () => {
    const user = userEvent.setup();
    let release: (value: { data: ReceiptScanResult }) => void = () => {};
    mocks.delete.mockImplementation(
      () => new Promise<{ data: ReceiptScanResult }>((resolve) => { release = resolve; }),
    );
    await openReview(user);

    await user.click(screen.getByRole("button", { name: /Remove Printer paper/ }));

    // The other row's × and Edit must not be able to send a second request
    // against the revision this delete is about to bump.
    await waitFor(() => expect(screen.getByRole("button", { name: /Remove Pens/ })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Edit Pens" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Remove Printer paper/ })).toBeDisabled();

    release({ data: afterRemoval });
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));
  });

  it("moves focus to the neighbouring row instead of dropping it on the body", async () => {
    const user = userEvent.setup();
    await openReview(user);

    const remove = screen.getByRole("button", { name: /Remove Printer paper/ });
    remove.focus();
    await user.click(remove);

    await waitFor(() => expect(screen.queryByText("Printer paper")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /Remove Pens/ })));
  });

  it("falls back to the Amount field when the item table itself goes away", async () => {
    const user = userEvent.setup();
    // Two items: removing one leaves a single line, and a single-line receipt
    // is reviewed as one category rather than item by item, so the table the
    // focused button lived in is gone entirely.
    const pair = { ...itemised, items: [itemised.items[0]!, itemised.items[1]!] };
    mocks.post.mockImplementation(async (url: string) =>
      url.endsWith("/confirm") ? { data: [{ id: 501 }] } : { data: pair });
    mocks.delete.mockResolvedValue({ data: { ...pair, scanRevision: 4, items: [pair.items[1]!] } });
    await openReview(user);

    const remove = screen.getByRole("button", { name: /Remove Printer paper/ });
    remove.focus();
    await user.click(remove);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Amount/)));
  });
});
