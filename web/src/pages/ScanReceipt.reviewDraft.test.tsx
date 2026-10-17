// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanReceipt } from "./ScanReceipt";
import type { ReceiptHistoryItem, ReceiptScanResult } from "./scanReceipt/types";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  confirm: vi.fn(),
  selected: { id: 1 },
  history: [] as unknown[],
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

const receipt: ReceiptScanResult = {
  id: 10, scanRevision: 0, processingStatus: "Complete", extractedDate: "2026-09-01", extractedDescription: "Paper supplies",
  extractedVendor: "Paper shop", extractedAmount: 500, items: [], ocrConfidence: 98,
};
const historyRow: ReceiptHistoryItem = {
  id: 10,
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
  extractedDescription: null,
  extractedAmount: 500,
  createdAt: "2026-09-01T00:00:00.000Z",
  pageCount: 1,
  allowedActions: { retryProcessing: false, reviewResult: true },
} as ReceiptHistoryItem;
const noDuplicateCandidates = {
  sourceFingerprint: null, candidateSetHash: null, candidateCount: 0, candidatesTruncated: false, candidates: [], nextCursor: null,
};
const draftKey = (owner: string, business: number, scanId = 10) => `finsight.receiptReviewDraft.${owner}.${business}.${scanId}`;
const photo = () => new File(["receipt image"], "receipt.png", { type: "image/png" });

function CurrentPath() {
  return <span data-testid="current-path">{useLocation().pathname}</span>;
}
function ProgrammaticNavigation() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate("/dashboard")}>Open dashboard</button>;
}
function page() {
  return (
    <MemoryRouter>
      <ScanReceipt />
      <CurrentPath />
      <ProgrammaticNavigation />
    </MemoryRouter>
  );
}

async function scanReceipt(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText(/Receipt photo/), photo());
  await user.click(screen.getByRole("button", { name: "Scan receipt" }));
  await screen.findByRole("heading", { name: "Review receipt" });
}

async function editVendor(user: ReturnType<typeof userEvent.setup>, value = "Paper shop Manila") {
  await user.clear(screen.getByLabelText(/^Vendor/));
  await user.type(screen.getByLabelText(/^Vendor/), value);
}

beforeEach(() => {
  sessionStorage.clear();
  beginServerStateSession("user-a");
  mocks.selected = { id: 1 };
  mocks.history = [];
  mocks.post.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.delete.mockReset();
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  mocks.get.mockImplementation(async (url: string) =>
    url === "/records/receipts"
      ? { data: { items: mocks.history, nextCursor: null } }
      : /^\/records\/receipts\/\d+\/duplicate-candidates$/.test(url)
      ? { data: noDuplicateCandidates }
      : url.startsWith("/records/receipts/provider-consent/")
      ? { data: { available: false, provider: null, consent: null, activeConsents: [] } }
      : { data: receipt },
  );
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(value: Blob) { return `blob:${(value as File).name}`; }
    static revokeObjectURL() {}
  });
  mocks.post.mockResolvedValue({ data: receipt });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  endServerStateSession();
  sessionStorage.clear();
});

describe("unsaved receipt review guard", () => {
  it("lets a clean review navigate and unload without a prompt", async () => {
    const user = userEvent.setup();
    const confirmNavigation = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(page());
    await scanReceipt(user);

    const unload = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await user.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/dashboard");
    expect(confirmNavigation).not.toHaveBeenCalled();
  });

  it("keeps the edits and the draft when the owner chooses to keep editing", async () => {
    const user = userEvent.setup();
    render(page());
    await scanReceipt(user);
    await editVendor(user);

    const confirmNavigation = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(confirmNavigation).toHaveBeenCalledOnce();
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
    expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop Manila");
    expect(sessionStorage.getItem(draftKey("user-a", 1))).not.toBeNull();
  });

  it("drops the draft when the owner confirms leaving", async () => {
    const user = userEvent.setup();
    render(page());
    await scanReceipt(user);
    await editVendor(user);
    expect(sessionStorage.getItem(draftKey("user-a", 1))).not.toBeNull();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/dashboard");
    expect(sessionStorage.getItem(draftKey("user-a", 1))).toBeNull();
  });
});

describe("receipt review draft", () => {
  it("never writes a draft for an unedited review", async () => {
    const user = userEvent.setup();
    render(page());
    await scanReceipt(user);
    expect(sessionStorage.getItem(draftKey("user-a", 1))).toBeNull();
  });

  it("stores only the owner's edits, never images or upload keys", async () => {
    const user = userEvent.setup();
    render(page());
    await scanReceipt(user);
    await editVendor(user);
    const stored = sessionStorage.getItem(draftKey("user-a", 1))!;
    expect(stored).toContain("Paper shop Manila");
    expect(stored).not.toMatch(/blob:|receipt\.png|idempotency/i);
  });

  it("restores the edits after a remount and tells the owner, with a way to discard", async () => {
    const user = userEvent.setup();
    const first = render(page());
    await scanReceipt(user);
    await editVendor(user);
    await user.clear(screen.getByLabelText(/^Description/));
    await user.type(screen.getByLabelText(/^Description/), "Printer paper");
    first.unmount();

    render(page());
    await scanReceipt(user);
    expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop Manila");
    expect(screen.getByLabelText(/^Description/)).toHaveValue("Printer paper");
    expect(screen.getByText("Your unsaved changes to this receipt were restored.")).toBeVisible();

    const unload = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop"));
    expect(screen.getByLabelText(/^Description/)).toHaveValue("Paper supplies");
    expect(screen.queryByText("Your unsaved changes to this receipt were restored.")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(draftKey("user-a", 1))).toBeNull();
  });

  it("keeps restored edits when the owner cancels the discard", async () => {
    const user = userEvent.setup();
    const first = render(page());
    await scanReceipt(user);
    await editVendor(user);
    first.unmount();

    render(page());
    await scanReceipt(user);
    mocks.confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop Manila");
    expect(sessionStorage.getItem(draftKey("user-a", 1))).not.toBeNull();
  });

  it("offers a kept draft from unfinished scans after a reload", async () => {
    const user = userEvent.setup();
    const first = render(page());
    await scanReceipt(user);
    await editVendor(user);
    first.unmount();

    mocks.history = [historyRow];
    render(page());
    expect(await screen.findByText("You have unsaved changes to Paper shop.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue reviewing" }));
    await screen.findByRole("heading", { name: "Review receipt" });
    expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop Manila");
    expect(screen.getByText("Your unsaved changes to this receipt were restored.")).toBeVisible();
  });

  it("discards a kept draft from the upload stage", async () => {
    const user = userEvent.setup();
    const first = render(page());
    await scanReceipt(user);
    await editVendor(user);
    first.unmount();

    mocks.history = [historyRow];
    render(page());
    await screen.findByText("You have unsaved changes to Paper shop.");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByText("You have unsaved changes to Paper shop.")).not.toBeInTheDocument());
    expect(sessionStorage.getItem(draftKey("user-a", 1))).toBeNull();
  });

  it("does not restore another account's draft", async () => {
    const user = userEvent.setup();
    const first = render(page());
    await scanReceipt(user);
    await editVendor(user);
    first.unmount();

    beginServerStateSession("user-b");
    render(page());
    await scanReceipt(user);
    expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop");
    expect(screen.queryByText("Your unsaved changes to this receipt were restored.")).not.toBeInTheDocument();
  });

  it("does not restore a draft in another business profile", async () => {
    const user = userEvent.setup();
    const first = render(page());
    await scanReceipt(user);
    await editVendor(user);
    first.unmount();

    mocks.selected = { id: 2 };
    render(page());
    await scanReceipt(user);
    expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Paper shop");
    expect(screen.queryByText("Your unsaved changes to this receipt were restored.")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(draftKey("user-a", 1))).not.toBeNull();
  });

  it("clears the draft once the receipt is confirmed", async () => {
    const user = userEvent.setup();
    mocks.post.mockImplementation(async (url: string) => (
      url.endsWith("/confirm") ? { data: [{ id: 501 }] } : { data: receipt }
    ));
    render(page());
    await scanReceipt(user);
    await editVendor(user);
    await user.selectOptions(screen.getByLabelText(/^Category/), "2");
    expect(sessionStorage.getItem(draftKey("user-a", 1))).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm & save expense" }));
    await waitFor(() => expect(screen.getByTestId("current-path")).toHaveTextContent("/records"));
    expect(sessionStorage.getItem(draftKey("user-a", 1))).toBeNull();
  });

  it("clears the draft when the owner discards the review for another image", async () => {
    const user = userEvent.setup();
    render(page());
    await scanReceipt(user);
    await editVendor(user);

    await user.click(screen.getByRole("button", { name: "Choose another image" }));
    await screen.findByRole("heading", { name: "Scan a receipt" });
    expect(sessionStorage.getItem(draftKey("user-a", 1))).toBeNull();
  });
});
