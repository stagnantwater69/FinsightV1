// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Records } from "./Records";
import type { BusinessProfile, RecordItem } from "../lib/types";
import { routeDataRequests } from "../lib/routeDataRequests";
import { cachedApiGet } from "../lib/serverStateApi";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ profile: { id: 17 } }) }));

/**
 * WHAT THIS FILE GUARDS: the Records table does not sort. The server does.
 *
 * The table used to sort whatever page it had already fetched while drawing an
 * ordinary sort arrow over it. On a real ledger that turns "Amount, highest
 * first" into "the highest amount among the 100 most recent records" — a
 * confidently wrong answer to "what was my biggest spend?", which then changes
 * as more pages load. `GET /records/search` takes `sort=` now, so the ordering
 * is a property of the query.
 *
 * Three things have to hold, and each is a separate way to reintroduce the bug:
 *   1. the chosen sort is SENT, and the rows come back in the server's order;
 *   2. the cursor is DROPPED on a sort change — the API rejects a cursor under
 *      any sort other than the one it was minted for;
 *   3. a column the server can't order by offers no sort affordance at all,
 *      rather than quietly sorting the loaded page.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

function record(id: number, description: string, amount: number, date: string): RecordItem {
  return {
    id,
    type: "expense",
    businessProfileId: 1,
    categoryId: 1,
    duplicateOfRecordId: null,
    date: `${date}T00:00:00.000Z`,
    description,
    vendor: "Vendor",
    amount,
    source: "MANUAL_ENTRY",
    reviewStatus: "Reviewed",
    duplicateStatus: "Not Duplicate",
  } as unknown as RecordItem;
}

/** Deliberately in no amount order at all — the server's order is the order. */
const SERVER_ORDER = [
  record(1, "Rice sack", 40, "2025-01-03"),
  record(2, "Generator", 900, "2025-01-01"),
  record(3, "Load card", 5, "2025-01-02"),
];

let searchResponses: { items: RecordItem[]; nextCursor: string | null }[];
let failNextSearch = false;
let searchHandler: ((params: Record<string, unknown>) => Promise<{ data: { items: RecordItem[]; nextCursor: string | null } }>) | null;
let importHandler: (params: Record<string, unknown>) => unknown;
const importCalls: Record<string, unknown>[] = [];
const searchCalls: Record<string, unknown>[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === "/records/search") {
        searchCalls.push(config?.params ?? {});
        if (failNextSearch) {
          failNextSearch = false;
          throw new Error("Request failed with status code 500");
        }
        if (searchHandler) return searchHandler(config?.params ?? {});
        return { data: searchResponses.shift() ?? { items: SERVER_ORDER, nextCursor: null } };
      }
      if (url === "/records/flagged/count") return { data: { expenses: 0, sales: 0, total: 0 } };
      if (url === "/records/csv-imports/batches") {
        importCalls.push(config?.params ?? {});
        return { data: await importHandler(config?.params ?? {}) };
      }
      throw new Error(`unmocked GET ${url}`);
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Supplies" }] }),
}));
vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));
vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("../components/AddExpenseModal", () => ({ AddExpenseModal: () => null }));
vi.mock("../components/AddSalesModal", () => ({ AddSalesModal: () => null }));
vi.mock("../components/DuplicateReviewModal", () => ({ DuplicateReviewModal: () => null }));

function renderPage(entry = "/records") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Records />
    </MemoryRouter>,
  );
}

/** The desktop table's data rows, in the order they are painted. */
function renderedDescriptions() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1) // the header row
    .map((row) => within(row).getAllByRole("cell")[2].textContent?.trim());
}

const lastSearch = () => searchCalls[searchCalls.length - 1];

beforeEach(() => {
  searchCalls.length = 0;
  searchResponses = [];
  failNextSearch = false;
  searchHandler = null;
  importCalls.length = 0;
  importHandler = () => ({ items: [], nextCursor: null });
  window.localStorage.clear();
});

describe("Records sorting", () => {
  it("retains an older import deep link even when the first history page does not contain it", async () => {
    importHandler = () => ({ items: [{ id: 1, title: "Newest import", uploadDate: "2026-10-13T00:00:00Z" }], nextCursor: "older" });
    renderPage("/records?source=CSV_UPLOAD&importBatchId=999");
    const selected = await screen.findByLabelText("Which import");
    await waitFor(() => expect(importCalls).toHaveLength(1));
    expect(selected).toHaveValue("999");
    expect(within(selected).getByRole("option", { name: "Import #999" })).toBeInTheDocument();
    expect(lastSearch()).toMatchObject({ source: "CSV_UPLOAD", importBatchId: "999" });
    expect(screen.getByRole("button", { name: "Older imports" })).toBeInTheDocument();
  });

  it("makes older and searched import options reachable while preserving the selected filter", async () => {
    importHandler = (params) => params.search ? { items: [{ id: 7, title: "March sales", uploadDate: "2026-03-01T00:00:00Z" }], nextCursor: null }
      : params.cursor ? { items: [{ id: 2, title: "Earlier import", uploadDate: "2026-09-13T00:00:00Z" }], nextCursor: null }
      : { items: [{ id: 1, title: "Newest import", uploadDate: "2026-10-13T00:00:00Z" }], nextCursor: "older" };
    renderPage("/records?source=CSV_UPLOAD&importBatchId=999");
    await userEvent.click(await screen.findByRole("button", { name: "Older imports" }));
    expect(await screen.findByRole("option", { name: /Earlier import/ })).toBeInTheDocument();
    expect(importCalls[1]).toMatchObject({ pageSize: 50, cursor: "older" });
    await userEvent.type(screen.getByLabelText("Find an import"), "March");
    expect(await screen.findByRole("option", { name: /March sales/ })).toBeInTheDocument();
    expect(importCalls.at(-1)).toEqual({ businessProfileId: 1, pageSize: 50, search: "March" });
    expect(screen.getByLabelText("Which import")).toHaveValue("999");
    expect(lastSearch()).toMatchObject({ importBatchId: "999" });
  });

  it("asks the server for the default order on first load", async () => {
    renderPage();
    await screen.findByRole("table");

    expect(searchCalls[0]).toMatchObject({ businessProfileId: 1, sort: "date_desc" });
    expect(searchCalls[0].cursor).toBeUndefined();
  });

  it("sends sort=amount_desc when Amount is chosen, and leaves the rows alone", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: /Amount/ }));

    await waitFor(() => expect(lastSearch()).toMatchObject({ sort: "amount_desc" }));
    // The rows came back in the server's order and stay in it. If the table
    // re-sorted them locally, 900 would have jumped to the top.
    expect(renderedDescriptions()).toEqual(["Rice sack", "Generator", "Load card"]);

    // Second click flips the direction rather than un-sorting: the server
    // always returns some order, so "no sort" is not one of the answers.
    await user.click(screen.getByRole("button", { name: /Amount/ }));
    await waitFor(() => expect(lastSearch()).toMatchObject({ sort: "amount_asc" }));
  });

  it("drops the cursor on a sort change instead of carrying it across", async () => {
    const user = userEvent.setup();
    searchResponses = [
      { items: SERVER_ORDER, nextCursor: "cursor-minted-under-date_desc" },
      { items: [record(4, "Ice", 20, "2024-12-30")], nextCursor: null },
    ];
    renderPage();
    await screen.findByRole("table");

    // Paging under the current sort does use the cursor…
    await user.click(screen.getByRole("button", { name: /Load more records/ }));
    await waitFor(() =>
      expect(lastSearch()).toMatchObject({
        sort: "date_desc",
        cursor: "cursor-minted-under-date_desc",
      }),
    );

    // …but changing the sort restarts from page 1. A cursor is only valid for
    // the sort it was minted under; reusing it here is an invalid-cursor 400.
    searchResponses = [{ items: SERVER_ORDER, nextCursor: null }];
    await user.click(screen.getByRole("button", { name: /Amount/ }));

    await waitFor(() => expect(lastSearch()).toMatchObject({ sort: "amount_desc" }));
    expect(lastSearch().cursor).toBeUndefined();
  });

  it("offers a sort affordance on exactly the columns the server can order by", async () => {
    renderPage();
    await screen.findByRole("table");

    const headers = screen.getAllByRole("columnheader");
    const byName = (label: string) => headers.find((h) => h.textContent?.trim().startsWith(label))!;

    for (const label of ["Date", "Amount"]) {
      const header = byName(label);
      expect(within(header).getByRole("button")).toBeInTheDocument();
      expect(header).toHaveAttribute("aria-sort");
    }

    // Nothing here can be ordered server-side, so nothing here pretends it
    // can: no button to press, and no aria-sort telling a screen-reader user
    // the column is sortable.
    for (const label of ["Type", "Description", "Category", "Vendor", "Source", "Status"]) {
      const header = byName(label);
      expect(within(header).queryByRole("button")).toBeNull();
      expect(header).not.toHaveAttribute("aria-sort");
    }
  });

  it("keeps the empty state and the pager honest across a sort change", async () => {
    const user = userEvent.setup();
    searchResponses = [
      { items: SERVER_ORDER, nextCursor: "cursor-minted-under-date_desc" },
      // The same filters under a different sort still match nothing here —
      // contrived, but it is the state the old code left a stale pager and
      // stale rows in.
      { items: [], nextCursor: null },
    ];
    renderPage();
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: /Load more records/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Amount/ }));

    // This page renders with no filters applied, so the correct empty state is
    // the onboarding one. (It previously read "No records match these filters"
    // only because `hasFilters` was permanently true — see Records.filters.test.ts.)
    expect(await screen.findByText(/No records yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /Load more records/ })).toBeNull();
  });

  it("surfaces a failed sort request without stranding the old order on screen", async () => {
    const user = userEvent.setup();
    searchResponses = [{ items: SERVER_ORDER, nextCursor: "cursor-minted-under-date_desc" }];
    renderPage();
    await screen.findByRole("table");

    failNextSearch = true;
    await user.click(screen.getByRole("button", { name: /Amount/ }));

    expect(await screen.findByText(/status code 500/)).toBeInTheDocument();
    // The cursor went with the sort change, so nothing offers to page a list
    // that failed to load.
    expect(screen.queryByRole("button", { name: /Load more records/ })).toBeNull();
  });

  it("never paints a late response from a superseded type filter", async () => {
    const user = userEvent.setup();
    let releaseExpense!: (value: { data: { items: RecordItem[]; nextCursor: null } }) => void;
    const heldExpense = new Promise<{ data: { items: RecordItem[]; nextCursor: null } }>((resolve) => {
      releaseExpense = resolve;
    });
    const sales = { ...record(9, "Sales-new", 1_200, "2025-01-04"), type: "sales" as const };
    searchHandler = async (params) => {
      if (params.type === "expense") return heldExpense;
      if (params.type === "sales") return { data: { items: [sales], nextCursor: null } };
      return { data: { items: SERVER_ORDER, nextCursor: null } };
    };

    renderPage();
    await screen.findByRole("table");
    await user.selectOptions(screen.getByLabelText("Type"), "expense");
    await user.selectOptions(screen.getByLabelText("Type"), "sales");

    expect(await screen.findAllByText("Sales-new")).not.toHaveLength(0);
    releaseExpense({ data: { items: [record(8, "Expense-old", 800, "2025-01-02")], nextCursor: null } });
    await waitFor(() => expect(screen.queryByText("Expense-old")).not.toBeInTheDocument());
    expect(screen.getAllByText("Sales-new").length).toBeGreaterThan(0);
  });
});

describe("opening on the navigation's warm-up", () => {
  afterEach(() => endServerStateSession());

  it("reads the list the nav link started, instead of asking again", async () => {
    beginServerStateSession(17);
    const warmed = routeDataRequests("/records", profile.id, [], "ready");
    expect(warmed.map((request) => request.url)).toEqual(["/records/search", "/records/flagged/count"]);
    await Promise.all(warmed.map((request) => cachedApiGet(request.url, { params: request.params }, request.scope)));
    expect(searchCalls).toHaveLength(1);

    renderPage();

    await waitFor(() => expect(renderedDescriptions()).toEqual(["Rice sack", "Generator", "Load card"]));
    // A key that differed in any field would have sent a second search here.
    expect(searchCalls).toHaveLength(1);
  });

  it("warms nothing for a filtered link, which the bare request would not match", () => {
    expect(routeDataRequests("/records?type=expense", profile.id, [], "ready")).toEqual([]);
  });
});
