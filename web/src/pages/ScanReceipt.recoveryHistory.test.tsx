// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError, AxiosHeaders } from "axios";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanReceipt } from "./ScanReceipt";
import type { ReceiptHistoryPage, ReceiptHistoryItem, ReceiptScanResult } from "./scanReceipt/types";

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

const receipt: ReceiptScanResult = {
  id: 10, scanRevision: 0, processingStatus: "Complete", extractedDate: "2026-09-01", extractedDescription: "Paper supplies",
  extractedVendor: "Paper shop", extractedAmount: 500, items: [], ocrConfidence: 98,
};
const photo = () => new File(["receipt image"], "receipt.png", { type: "image/png" });
function page() { return <MemoryRouter><ScanReceipt /></MemoryRouter>; }

/** Newest first: a higher id is a later createdAt, matching the server's keyset order. */
function summary(id: number, vendor: string | null, overrides: Partial<ReceiptHistoryItem> = {}): ReceiptHistoryItem {
  return {
    id,
    businessProfileId: 1,
    receiptBatchId: null,
    receiptOrdinal: null,
    scanRevision: 0,
    processingStatus: "Complete",
    confirmationStatus: "Pending",
    processingError: null,
    processingErrorCode: null,
    extractedDate: "2026-09-01",
    extractedVendor: vendor,
    extractedDescription: null,
    extractedAmount: 100,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, id)).toISOString(),
    pageCount: 1,
    allowedActions: { retryProcessing: false, reviewResult: true },
    ...overrides,
  };
}
function range(from: number, to: number): ReceiptHistoryItem[] {
  const rows: ReceiptHistoryItem[] = [];
  for (let id = from; id >= to; id -= 1) rows.push(summary(id, `Shop ${id}`));
  return rows;
}

type HistoryParams = { businessProfileId: number; status: string; take: number; cursor?: string };
type HistoryHandler = (params: HistoryParams) => ReceiptHistoryPage | Promise<ReceiptHistoryPage>;
let history: HistoryHandler;
function historyCalls(): HistoryParams[] {
  return mocks.get.mock.calls
    .filter(([url]) => url === "/records/receipts")
    .map(([, config]) => (config as { params: HistoryParams }).params);
}

beforeEach(() => {
  mocks.selected = { id: 1 };
  mocks.post.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.delete.mockReset();
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  history = () => ({ items: [], nextCursor: null });
  mocks.get.mockImplementation(async (url: string, config?: { params?: HistoryParams }) => {
    if (url === "/records/receipts") return { data: await history(config!.params!) };
    if (url.startsWith("/records/receipts/provider-consent/")) {
      return { data: { available: false, provider: null, consent: null, activeConsents: [] } };
    }
    return { data: receipt };
  });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(value: Blob) { return `blob:${(value as File).name}`; }
    static revokeObjectURL() {}
  });
  mocks.post.mockResolvedValue({ data: receipt });
  mocks.patch.mockResolvedValue({ data: receipt });
  mocks.delete.mockResolvedValue({ data: receipt });
});
afterEach(() => { vi.unstubAllGlobals(); });

function rowTitles(): string[] {
  const list = screen.getByRole("list", { name: "Unfinished scans" });
  return within(list).getAllByRole("listitem").map((item) => item.querySelector("p")!.textContent!);
}

describe("recovery history pagination (P2-10)", () => {
  it("forwards the cursor to load a second page and appends it without duplicates", async () => {
    const user = userEvent.setup();
    history = (params) => params.cursor === undefined
      ? { items: range(40, 21), nextCursor: "after-21" }
      // Overlaps on 21 on purpose: a row returned twice must render once.
      : { items: range(21, 1), nextCursor: null };
    render(page());

    await screen.findByRole("heading", { name: "Continue an unfinished scan" });
    expect(rowTitles()).toHaveLength(20);
    expect(screen.queryByText("No more unfinished scans.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show older scans" }));

    await waitFor(() => expect(rowTitles()).toHaveLength(40));
    expect(historyCalls()).toEqual([
      { businessProfileId: 1, status: "active", take: 20 },
      { businessProfileId: 1, status: "active", take: 20, cursor: "after-21" },
    ]);
    expect(rowTitles()).toEqual(range(40, 1).map((row) => row.extractedVendor));
    expect(screen.queryByRole("button", { name: "Show older scans" })).not.toBeInTheDocument();
    expect(screen.getByText("No more unfinished scans.")).toBeVisible();
  });

  it("keeps the same cursor for a repeated attempt after loading older scans fails", async () => {
    const user = userEvent.setup();
    let olderAttempts = 0;
    history = (params) => {
      if (params.cursor === undefined) return { items: range(40, 21), nextCursor: "after-21" };
      olderAttempts += 1;
      if (olderAttempts === 1) throw new Error("Connection lost");
      return { items: range(20, 15), nextCursor: null };
    };
    render(page());
    await screen.findByRole("button", { name: "Show older scans" });

    await user.click(screen.getByRole("button", { name: "Show older scans" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(rowTitles()).toHaveLength(20);

    await user.click(screen.getByRole("button", { name: "Show older scans" }));
    await waitFor(() => expect(rowTitles()).toHaveLength(26));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(historyCalls().slice(1).map((params) => params.cursor)).toEqual(["after-21", "after-21"]);
  });

  it("sends one request for a double click and announces the loading state", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    history = (params) => params.cursor === undefined
      ? { items: range(40, 21), nextCursor: "after-21" }
      : new Promise((resolve) => { release = () => resolve({ items: range(20, 1), nextCursor: null }); });
    render(page());
    const older = await screen.findByRole("button", { name: "Show older scans" });

    await user.click(older);
    expect(screen.getByRole("status")).toHaveTextContent("Loading older scans…");
    expect(older).toBeDisabled();
    await user.click(older);
    release();

    await waitFor(() => expect(rowTitles()).toHaveLength(40));
    expect(historyCalls()).toHaveLength(2);
  });

  it("starts from the first page again after a business profile change", async () => {
    history = (params) => params.businessProfileId === 1
      ? { items: range(40, 21), nextCursor: "after-21" }
      : { items: [summary(7, "Other business shop")], nextCursor: null };
    const view = render(page());
    await screen.findByRole("button", { name: "Show older scans" });

    mocks.selected = { id: 2 };
    view.rerender(page());

    await screen.findByText("Other business shop");
    expect(rowTitles()).toEqual(["Other business shop"]);
    expect(screen.queryByRole("button", { name: "Show older scans" })).not.toBeInTheDocument();
    expect(historyCalls().at(-1)).toEqual({ businessProfileId: 2, status: "active", take: 20 });
  });
});

describe("recovery history across a business profile change (QA adversarial)", () => {
  it("never carries the previous profile's rows or cursor into a profile whose first page has more pages", async () => {
    // Profile 2's rows are newer than every profile-1 row, so if the form
    // ever stopped remounting on a profile change (ScanReceipt keys it by
    // profile id), reconcileFirstPage would keep profile 1's rows and cursor.
    history = (params) => params.businessProfileId === 1
      ? { items: range(40, 21), nextCursor: "profile-1-after-21" }
      : params.cursor === undefined
        ? { items: range(100, 81).map((row) => ({ ...row, businessProfileId: 2 })), nextCursor: "profile-2-after-81" }
        : { items: range(80, 75).map((row) => ({ ...row, businessProfileId: 2 })), nextCursor: null };
    const view = render(page());
    await screen.findByRole("button", { name: "Show older scans" });
    expect(rowTitles()).toHaveLength(20);

    mocks.selected = { id: 2 };
    view.rerender(page());

    await screen.findByText("Shop 100");
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({ businessProfileId: 2, status: "active", take: 20 }));
    expect(rowTitles()).toEqual(range(100, 81).map((row) => row.extractedVendor));
    expect(screen.queryByText("Shop 40")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show older scans" }));
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({
      businessProfileId: 2, status: "active", take: 20, cursor: "profile-2-after-81",
    }));
    await waitFor(() => expect(rowTitles()).toHaveLength(26));
  });
});

describe("abandoned scans enter recovery history (P2-11)", () => {
  async function scanAndAbandon(user: ReturnType<typeof userEvent.setup>) {
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.click(screen.getByRole("button", { name: "Choose another image" }));
    await screen.findByRole("heading", { name: "Scan a receipt" });
  }

  it("shows the abandoned scan at once and refreshes history from the server", async () => {
    const user = userEvent.setup();
    let abandoned = false;
    history = () => ({ items: abandoned ? [summary(10, "Paper shop"), summary(5, "Older shop")] : [summary(5, "Older shop")], nextCursor: null });
    render(page());
    await screen.findByText("Older shop");
    abandoned = true;

    await scanAndAbandon(user);

    expect(rowTitles()).toEqual(["Paper shop", "Older shop"]);
    await waitFor(() => expect(historyCalls()).toHaveLength(2));
    expect(rowTitles()).toEqual(["Paper shop", "Older shop"]);
    expect(screen.getByRole("button", { name: "Review result, Paper shop" })).toBeEnabled();
  });

  it("keeps the local entry and offers a retry when the refresh fails", async () => {
    const user = userEvent.setup();
    let refreshes = 0;
    history = () => {
      refreshes += 1;
      if (refreshes === 2) throw new Error("History unavailable");
      return { items: refreshes > 2 ? [summary(10, "Paper shop")] : [], nextCursor: null };
    };
    render(page());
    await waitFor(() => expect(historyCalls()).toHaveLength(1));

    await scanAndAbandon(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(rowTitles()).toEqual(["Paper shop"]);
    await user.click(screen.getByRole("button", { name: "Reload unfinished scans" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(rowTitles()).toEqual(["Paper shop"]);
    expect(historyCalls()).toHaveLength(3);
  });

  it("keeps older loaded pages and their cursor when the refreshed first page arrives", async () => {
    const user = userEvent.setup();
    let abandoned = false;
    // Shop ids start above the abandoned receipt's id (10) so no row can collide with it.
    history = (params) => {
      if (params.cursor === "after-41") return { items: range(40, 21), nextCursor: null };
      if (params.cursor === "after-42") return { items: [summary(41, "Shop 41"), ...range(40, 21)], nextCursor: null };
      return abandoned
        ? { items: [summary(10, "Paper shop", { createdAt: "2026-09-02T00:00:00.000Z" }), ...range(60, 42)], nextCursor: "after-42" }
        : { items: range(60, 41), nextCursor: "after-41" };
    };
    render(page());
    await screen.findByRole("button", { name: "Show older scans" });
    abandoned = true;

    await scanAndAbandon(user);
    await waitFor(() => expect(rowTitles()).toEqual(["Paper shop", ...range(60, 41).map((row) => row.extractedVendor)]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show older scans" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Show older scans" }));
    await waitFor(() => expect(rowTitles()).toHaveLength(41));
    // The deeper cursor from the earlier load survives the refresh.
    expect(historyCalls().at(-1)?.cursor).toBe("after-41");
    expect(new Set(rowTitles()).size).toBe(41);
    expect(screen.getByText("No more unfinished scans.")).toBeVisible();
  });

  it("drops the local entry when the profile changes", async () => {
    const user = userEvent.setup();
    let abandoned = false;
    history = (params) => params.businessProfileId === 1
      ? { items: abandoned ? [summary(10, "Paper shop")] : [], nextCursor: null }
      : { items: [summary(7, "Other business shop")], nextCursor: null };
    const view = render(page());
    await waitFor(() => expect(historyCalls()).toHaveLength(1));
    abandoned = true;
    await scanAndAbandon(user);
    expect(rowTitles()).toEqual(["Paper shop"]);
    await waitFor(() => expect(historyCalls()).toHaveLength(2));

    mocks.selected = { id: 2 };
    view.rerender(page());

    await screen.findByText("Other business shop");
    expect(rowTitles()).toEqual(["Other business shop"]);
  });
});

describe("recovery row accessible names (P2-12)", () => {
  it("names every repeated action after its own receipt row", async () => {
    history = () => ({
      items: [
        summary(30, "Paper shop", { receiptBatchId: 9, receiptOrdinal: 2 }),
        summary(29, "Paper shop", { receiptBatchId: 9, receiptOrdinal: 1 }),
        summary(28, "Coffee stall"),
        summary(27, "Coffee stall"),
        summary(26, null, { extractedDescription: "Purchase from market" }),
        summary(25, null, { processingStatus: "Failed", allowedActions: { retryProcessing: true, reviewResult: false } }),
        summary(24, "Bus fare", { processingStatus: "Processing", allowedActions: { retryProcessing: false, reviewResult: false } }),
      ],
      nextCursor: null,
    });
    render(page());
    await screen.findByRole("heading", { name: "Continue an unfinished scan" });

    // The visible label stays short; the accessible name carries the row.
    const review = screen.getByRole("button", { name: "Review result, Paper shop, receipt 2" });
    expect(review).toHaveTextContent("Review result");
    expect(screen.getByRole("button", { name: "Delete scan, Paper shop, receipt 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review result, Coffee stall, scan 28" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete scan, Coffee stall, scan 27" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review result, Purchase from market" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry processing, Receipt scan 25" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue waiting, Bus fare" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete scan, Bus fare" })).toBeVisible();

    const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(14);
  });
});

describe("round 3: stop waiting, delete races, and focus", () => {
  function processingRow(id: number, vendor: string) {
    return summary(id, vendor, {
      processingStatus: "Processing",
      allowedActions: { retryProcessing: false, reviewResult: false },
    });
  }
  /** A request that stays open until its abort signal fires, the way axios behaves. */
  function untilAborted(config?: { signal?: AbortSignal }): Promise<never> {
    return new Promise((_, reject) => {
      config?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
    });
  }

  it("aborts a wait started after Stop waiting when the page unmounts", async () => {
    const user = userEvent.setup();
    history = () => ({ items: [processingRow(91, "Slow shop")], nextCursor: null });
    mocks.post.mockImplementation((_url: string, _body: unknown, config?: { signal?: AbortSignal }) => untilAborted(config));
    const baseGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (url: string, config?: { signal?: AbortSignal; params?: HistoryParams }) =>
      url === "/records/receipts/91" ? untilAborted(config) : baseGet(url, config));

    const view = render(page());
    await screen.findByText("Slow shop");
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await user.click(await screen.findByRole("button", { name: "Cancel upload" }));
    await user.click(screen.getByRole("button", { name: "Continue waiting, Slow shop" }));

    const wait = mocks.get.mock.calls.find(([url]) => url === "/records/receipts/91")!;
    const signal = (wait[1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("keeps the picked photo when Stop waiting ends a wait on a stored scan", async () => {
    const user = userEvent.setup();
    history = () => ({ items: [processingRow(91, "Slow shop")], nextCursor: null });
    const baseGet = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (url: string, config?: { signal?: AbortSignal; params?: HistoryParams }) =>
      url === "/records/receipts/91" ? untilAborted(config) : baseGet(url, config));

    render(page());
    await screen.findByText("Slow shop");
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Continue waiting, Slow shop" }));
    await user.click(await screen.findByRole("button", { name: "Stop waiting" }));

    expect(screen.getByRole("img", { name: "Page 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Scan receipt" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped waiting. Slow shop stays in unfinished scans.");
    expect(screen.getByRole("button", { name: "Continue waiting, Slow shop" })).toBeEnabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not resurrect a deleted row when the abandon-refresh lands after the delete", async () => {
    const user = userEvent.setup();
    let releaseRefresh!: () => void;
    let refreshes = 0;
    history = () => {
      refreshes += 1;
      if (refreshes === 1) return { items: [summary(5, "Older shop")], nextCursor: null };
      return new Promise<ReceiptHistoryPage>((resolve) => {
        releaseRefresh = () => resolve({ items: [summary(10, "Paper shop"), summary(5, "Older shop")], nextCursor: null });
      });
    };
    mocks.delete.mockResolvedValue({ data: { id: 601, receiptScanId: 10, status: "PENDING" } });

    render(page());
    await screen.findByText("Older shop");
    await user.upload(screen.getByLabelText(/Receipt photo/), photo());
    await user.click(screen.getByRole("button", { name: "Scan receipt" }));
    await screen.findByRole("heading", { name: "Check what FinSight read" });
    await user.click(screen.getByRole("button", { name: "Choose another image" }));
    await screen.findByRole("heading", { name: "Scan a receipt" });
    expect(rowTitles()).toEqual(["Paper shop", "Older shop"]);

    await user.click(screen.getByRole("button", { name: "Delete scan, Paper shop" }));
    await waitFor(() => expect(rowTitles()).toEqual(["Older shop"]));
    expect(mocks.delete).toHaveBeenCalledWith("/records/receipts/10", expect.anything());

    releaseRefresh();
    await waitFor(() => expect(screen.queryByText("Checking unfinished scans…")).not.toBeInTheDocument());
    expect(rowTitles()).toEqual(["Older shop"]);
  });

  it("drops the row when the server answers that the deletion is already underway", async () => {
    const user = userEvent.setup();
    history = () => ({ items: [summary(12, "First shop"), summary(11, "Second shop")], nextCursor: null });
    mocks.delete.mockRejectedValue(new AxiosError(
      "Request failed with status code 409", "ERR_BAD_REQUEST", undefined, undefined,
      { status: 409, statusText: "Conflict", headers: {}, config: { headers: new AxiosHeaders() },
        data: { error: "This receipt is already being deleted." } },
    ));

    render(page());
    await screen.findByText("Second shop");
    await user.click(screen.getByRole("button", { name: "Delete scan, Second shop" }));

    await waitFor(() => expect(rowTitles()).toEqual(["First shop"]));
    expect(screen.queryByText("This receipt is already being deleted.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review result, First shop" })).toHaveFocus();
  });

  it("keeps the row and shows the message for any other 409 on delete", async () => {
    const user = userEvent.setup();
    history = () => ({ items: [summary(12, "First shop"), summary(11, "Second shop")], nextCursor: null });
    mocks.delete.mockRejectedValue(new AxiosError(
      "Request failed with status code 409", "ERR_BAD_REQUEST", undefined, undefined,
      { status: 409, statusText: "Conflict", headers: {}, config: { headers: new AxiosHeaders() },
        data: { error: "This receipt already has financial records. Delete only its stored evidence." } },
    ));

    render(page());
    await screen.findByText("Second shop");
    await user.click(screen.getByRole("button", { name: "Delete scan, Second shop" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This receipt already has financial records.");
    expect(rowTitles()).toEqual(["First shop", "Second shop"]);
  });

  it("moves focus to the next row's action after deleting a recovery row", async () => {
    const user = userEvent.setup();
    history = () => ({ items: [summary(12, "First shop"), summary(11, "Second shop"), summary(10, "Third shop")], nextCursor: null });
    mocks.delete.mockImplementation(async (url: string) => ({
      data: { id: 700, receiptScanId: Number(url.split("/").at(-1)), status: "PENDING" },
    }));

    render(page());
    await screen.findByText("Second shop");
    await user.click(screen.getByRole("button", { name: "Delete scan, Second shop" }));
    await waitFor(() => expect(rowTitles()).toEqual(["First shop", "Third shop"]));
    expect(screen.getByRole("button", { name: "Review result, Third shop" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Delete scan, Third shop" }));
    await waitFor(() => expect(rowTitles()).toEqual(["First shop"]));
    expect(screen.getByRole("button", { name: "Review result, First shop" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Delete scan, First shop" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Unfinished scans" })).not.toBeInTheDocument());
    expect(screen.getByLabelText(/Receipt photo/)).toHaveFocus();
  });

  it("leaves focus alone when the owner moved to a form field while the delete was in flight", async () => {
    const user = userEvent.setup();
    history = () => ({ items: [summary(12, "First shop"), summary(11, "Second shop"), summary(10, "Third shop")], nextCursor: null });
    let releaseDelete!: () => void;
    mocks.delete.mockImplementation(() => new Promise((resolve) => {
      releaseDelete = () => resolve({ data: { id: 700, receiptScanId: 11, status: "PENDING" } });
    }));

    render(page());
    await screen.findByText("Second shop");
    await user.click(screen.getByRole("button", { name: "Delete scan, Second shop" }));
    expect(screen.getByRole("button", { name: "Deleting…, Second shop" })).toHaveFocus();

    const photoInput = screen.getByLabelText(/Receipt photo/);
    act(() => photoInput.focus());
    expect(photoInput).toHaveFocus();

    releaseDelete();
    await waitFor(() => expect(rowTitles()).toEqual(["First shop", "Third shop"]));
    expect(photoInput).toHaveFocus();
    expect(screen.getByRole("button", { name: "Review result, Third shop" })).not.toHaveFocus();
  });

  it("keeps the row in unfinished scans when Stop waiting ends a retry on a stored Failed scan", async () => {
    const user = userEvent.setup();
    history = () => ({
      items: [summary(25, "Broken shop", { processingStatus: "Failed", allowedActions: { retryProcessing: true, reviewResult: false } })],
      nextCursor: null,
    });
    const failed: ReceiptScanResult = {
      ...receipt, id: 25, extractedVendor: "Broken shop", processingStatus: "Failed", processingError: "OCR timed out.",
    };
    let retries = 0;
    mocks.post.mockImplementation(async (url: string, _body: unknown, config?: { signal?: AbortSignal }) => {
      if (url !== "/records/receipts/25/retry") throw new Error(`unexpected post ${url}`);
      retries += 1;
      return retries === 1 ? { data: failed } : untilAborted(config);
    });

    render(page());
    await screen.findByText("Broken shop");
    await user.click(screen.getByRole("button", { name: "Retry processing, Broken shop" }));
    await screen.findByRole("heading", { name: "Receipt needs another try" });

    await user.click(screen.getByRole("button", { name: "Retry processing" }));
    await user.click(await screen.findByRole("button", { name: "Stop waiting" }));

    expect(retries).toBe(2);
    expect(screen.getByRole("alert")).toHaveTextContent("Stopped waiting. Broken shop stays in unfinished scans.");
    expect(screen.queryByText("Upload cancelled. Your selected image is still here.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry processing" })).toBeEnabled();
  });
});
