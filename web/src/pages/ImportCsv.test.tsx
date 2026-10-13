// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ImportCsv } from "./ImportCsv";
import type { BusinessProfile } from "../lib/types";
import { subscribeToServerState } from "../lib/serverStateCache";

/**
 * WHAT THIS FILE GUARDS.
 *
 *   1. THERE IS NO MAPPING STEP. Upload goes straight to a review of what the
 *      server detected, and the owner corrects a column or a cell in place.
 *   2. NOTHING IS WRITTEN BEFORE CONFIRM, and every edit, removal and category
 *      choice reaches the confirm exactly as the owner left it.
 *   3. THE IDEMPOTENCY KEY IS REUSED ON RETRY. A key regenerated per attempt
 *      makes every retry a brand-new import and doubles a month of records.
 *   4. A 202 IS NOT A SUMMARY. A large file finishes on the worker; its zero
 *      counts must not be rendered as "imported nothing".
 */

const profile = {
  id: 1,
  name: "Sari-sari",
  availableFundsBaselineAt: "2026-04-13T01:00:00.000Z",
  availableFundsBaselineDate: "2026-04-13",
} as unknown as BusinessProfile;

const STAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function stagedBody() {
  return {
    stagedUploadId: STAGE_ID,
    headers: ["date", "description", "amount", "category", "posted", "payment"],
    previewRows: [{ date: "13/04/2026", description: "Rice sack", amount: "2400", category: "", posted: "04/13/2026", payment: "Cash" }],
    totalRows: 1,
    detectedTypeColumn: null,
    columnsWithNegatives: [],
    detectedDateFormat: "dmy",
    dateFormatAmbiguous: false,
    suggestedMapping: { date: "date", description: "description", amount: "amount", category: "category" },
    columnDetection: { unmapped: [{ header: "payment", field: "paymentMethod" }], suggestedRecordType: "expense" },
  };
}

const VALID = { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false, possibleDuplicateRows: 0, duplicateRows: [] };

interface PostCall {
  url: string;
  fields: Record<string, string>;
  transport: "multipart" | "json";
}

let posts: PostCall[];
let deletes: string[];
let deleteShouldFail: boolean;
let nextCheckError: unknown | null;
let confirmResponses: (() => { status: number; data: unknown })[];
let deferredConfirm: Promise<{ status: number; data: unknown }> | null;
let statusResponses: unknown[];
/** Overrides for the staged upload response. */
let stagedExtra: Record<string, unknown>;
/** Overrides for every full-file check response. */
let checkExtra: Record<string, unknown>;

function fieldsOf(body: FormData | Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (body instanceof FormData) {
    body.forEach((value, key) => {
      out[key] = value instanceof File ? value.name : String(value);
    });
  } else {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      out[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  return out;
}

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/records/months") return { status: 200, data: { months: [] } };
      if (url.includes("/status")) {
        const next = statusResponses.shift() ?? statusResponses.at(-1);
        return { status: 200, data: next };
      }
      throw new Error(`unmocked GET ${url}`);
    },
    post: async (url: string, body: FormData | Record<string, unknown>) => {
      const transport = body instanceof FormData ? "multipart" : "json";
      posts.push({ url, fields: fieldsOf(body), transport });
      if (url.endsWith("/preview")) {
        if (transport === "multipart") return { status: 200, data: { ...stagedBody(), ...stagedExtra } };
        if (nextCheckError) {
          const error = nextCheckError;
          nextCheckError = null;
          throw error;
        }
        return { status: 200, data: { ...stagedBody(), validation: VALID, ...stagedExtra, ...checkExtra } };
      }
      if (deferredConfirm) return deferredConfirm;
      const next = confirmResponses.shift();
      if (!next) throw new Error("no queued confirm response");
      const result = next();
      if (result.status >= 400) throw new Error("Request failed with status code 500");
      return result;
    },
    delete: async (url: string) => {
      deletes.push(url);
      if (deleteShouldFail) throw new Error("cleanup failed");
      return { status: 204, data: undefined };
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }], refresh: async () => {} }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ImportCsv />
    </MemoryRouter>,
  );
}

function expectCurrentStep(label: string) {
  const progress = screen.getByRole("list", { name: "CSV import progress" });
  const current = progress.querySelector('[aria-current="step"]');
  expect(current).not.toBeNull();
  expect(current).toHaveTextContent(label);
}

const previews = () => posts.filter((post) => post.url.endsWith("/preview"));
const checks = () => previews().filter((post) => post.transport === "json");
const confirms = () => posts.filter((post) => post.url.endsWith("/confirm"));

/** Uploads a file and waits for the review and its first full-file check. */
async function reachReview(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(["date,description,amount,category\n"], "march.csv", { type: "text/csv" });
  await user.upload(screen.getByLabelText(/CSV file/i), file);
  await user.click(screen.getByRole("button", { name: "Upload and review" }));
  await screen.findByRole("heading", { level: 1, name: "Review import" });
  await waitFor(() => expect(checks().length).toBeGreaterThan(0));
}

function importButton() {
  return screen.getByRole("button", { name: /^Import( \d|$)/ });
}

const COMPLETE = {
  batchId: 3, title: "march", status: "Reviewed", processingStatus: "COMPLETE",
  totalRows: 1, imported: 1, skipped: [], flagged: 0, largeExpenseFlagged: 0,
};

beforeEach(() => {
  posts = [];
  deletes = [];
  deleteShouldFail = false;
  nextCheckError = null;
  confirmResponses = [];
  deferredConfirm = null;
  statusResponses = [];
  stagedExtra = {};
  checkExtra = {};
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "11111111-2222-3333-4444-555555555555" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CSV import: upload, review, import", () => {
  it("goes from upload straight to the review, with no mapping step, and writes nothing yet", async () => {
    const user = userEvent.setup();
    renderPage();

    expectCurrentStep("Upload");
    await reachReview(user);
    expectCurrentStep("Review and edit");
    expect(screen.queryByText(/map columns/i)).not.toBeInTheDocument();

    expect(confirms()).toHaveLength(0);
    expect(previews()[0]).toMatchObject({
      transport: "multipart",
      fields: { file: "march.csv", businessProfileId: "1", idempotencyKey: "11111111-2222-3333-4444-555555555555" },
    });
    // The first check uses what the server detected, unchanged.
    expect(checks()[0]).toMatchObject({ transport: "json", fields: { stagedUploadId: STAGE_ID, recordType: "expense" } });
    expect(JSON.parse(checks()[0]!.fields.columnMapping!)).toEqual({ date: "date", description: "description", amount: "amount", category: "category" });
    expect(previews().filter((post) => post.fields.file !== undefined)).toHaveLength(1);
  });

  it("shows the detected columns, names the ones it will not import, and lets the owner correct one", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachReview(user);

    expect(screen.getByRole("combobox", { name: "Date" })).toHaveValue("date");
    expect(screen.getByRole("combobox", { name: /^Amount/ })).toHaveValue("amount");
    expect(screen.getByText(/payment \(Payment method\)/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Date" }), "posted");
    await waitFor(() => expect(JSON.parse(checks().at(-1)!.fields.columnMapping!).date).toBe("posted"), { timeout: 3000 });
  });

  it("will not import while two fields use the same column", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachReview(user);

    await user.selectOptions(screen.getByRole("combobox", { name: /^Amount/ }), "description");
    expect(screen.getAllByText("Used twice")).toHaveLength(2);
    expect(importButton()).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: /^Amount/ }), "amount");
    expect(importButton()).toBeEnabled();
    expect(confirms()).toHaveLength(0);
  });

  it("keeps focus on each stage heading moving forward and when starting over", async () => {
    const user = userEvent.setup();
    renderPage();
    const file = new File(["date,description,amount\n"], "a-very-long-import-file-name-for-september.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText(/CSV file/i), file);
    expect(screen.getByRole("status")).toHaveTextContent(`Selected file: ${file.name}`);

    await user.click(screen.getByRole("button", { name: "Upload and review" }));
    const review = await screen.findByRole("heading", { level: 1, name: "Review import" });
    await waitFor(() => expect(review.closest('[tabindex="-1"]')).toHaveFocus());

    await user.click(screen.getAllByRole("button", { name: "Change file" })[0]!);
    const upload = await screen.findByRole("heading", { level: 1, name: "Import CSV" });
    await waitFor(() => expect(upload.closest('[tabindex="-1"]')).toHaveFocus());
  });

  it("returns focus to the CSV chooser after removing the selected file", async () => {
    const user = userEvent.setup();
    renderPage();
    const chooser = screen.getByLabelText(/CSV file/i);
    await user.upload(chooser, new File(["date,description,amount\n"], "march.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(chooser).toHaveFocus());
  });

  it("confirms with the same staged upload and never sends the CSV bytes again", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    renderPage();
    await reachReview(user);
    await user.click(importButton());
    await screen.findByText("Import complete");

    expect(confirms()[0]).toMatchObject({
      transport: "json",
      fields: { stagedUploadId: STAGE_ID, businessProfileId: "1", idempotencyKey: "11111111-2222-3333-4444-555555555555", title: "march" },
    });
    expect(posts.filter((post) => post.fields.file !== undefined)).toHaveLength(1);
  });

  it("uses the reviewed preview token instead of the selected profile token", async () => {
    const user = userEvent.setup();
    const previewToken = "2026-04-13T02:00:00.000Z";
    stagedExtra = {
      availableFundsBaseline: {
        baselineAt: previewToken,
        baselineDate: "2026-04-13",
        matchingRowCount: 1,
      },
    };
    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    renderPage();
    await reachReview(user);

    await user.click(screen.getByRole("radio", { name: "No, apply it after the balance" }));
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await screen.findByText("Import complete");

    expect(confirms()[0]!.fields).toMatchObject({
      includedInAvailableFundsBaseline: "false",
      availableFundsBaselineAt: previewToken,
    });
  });

  it("treats a reviewed null baseline summary as authoritative", async () => {
    const user = userEvent.setup();
    stagedExtra = {
      availableFundsBaseline: {
        baselineAt: "2026-04-13T02:00:00.000Z",
        baselineDate: "2026-04-13",
        matchingRowCount: 1,
      },
    };
    checkExtra = { availableFundsBaseline: null };
    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    renderPage();
    await reachReview(user);

    expect(screen.queryByRole("radio", { name: "No, apply it after the balance" })).not.toBeInTheDocument();
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(confirms()[0]!.fields).not.toHaveProperty("includedInAvailableFundsBaseline");
    expect(confirms()[0]!.fields).not.toHaveProperty("availableFundsBaselineAt");
  });

  it("fails closed when the upload response has no stage handle", async () => {
    const user = userEvent.setup();
    stagedExtra = { stagedUploadId: undefined };
    renderPage();
    await user.upload(screen.getByLabelText(/CSV file/i), new File(["date,description,amount\n"], "march.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "Upload and review" }));

    expect(await screen.findByText("This file couldn't be prepared. Try again.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Import CSV" })).toBeVisible();
    expect(checks()).toHaveLength(0);
  });

  it("clears the picker immediately even if the staged upload cleanup fails", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachReview(user);
    deleteShouldFail = true;

    await user.click(screen.getAllByRole("button", { name: "Change file" })[0]!);
    expect(screen.getByRole("heading", { level: 1, name: "Import CSV" })).toBeVisible();
    await waitFor(() => expect(deletes).toEqual([`/records/csv-imports/stages/${STAGE_ID}`]));
    await user.upload(screen.getByLabelText(/CSV file/i), new File(["date,description,amount\n"], "april.csv", { type: "text/csv" }));
    expect(screen.getByText("april.csv")).toBeVisible();
  });

  it("recovers an expired upload without losing the owner's edits", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachReview(user);
    nextCheckError = {
      isAxiosError: true,
      message: "Request failed with status code 410",
      response: { status: 410, data: { code: "CSV_STAGE_EXPIRED" } },
    };

    await user.click(screen.getAllByRole("button", { name: "Remove row 2" })[0]!);

    expect(await screen.findByText("This upload expired. Upload the file again to continue.", undefined, { timeout: 3000 })).toBeVisible();
    expect(screen.getByText("march.csv")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Upload and review" }));
    await screen.findByRole("heading", { level: 1, name: "Review import" });
    expect(screen.getAllByRole("button", { name: "Restore row 2" }).length).toBeGreaterThan(0);
    expect(posts.filter((post) => post.fields.file !== undefined)).toHaveLength(2);
  });

  it("will not import a file that has headings but no rows", async () => {
    const user = userEvent.setup();
    stagedExtra = { previewRows: [], totalRows: 0 };
    renderPage();
    await user.upload(screen.getByLabelText(/CSV file/i), new File(["date,description,amount\n"], "march.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "Upload and review" }));
    await screen.findByRole("heading", { level: 1, name: "Review import" });

    expect(screen.getByText("No data rows in this file.")).toBeVisible();
    expect(importButton()).toBeDisabled();
    expect(confirms()).toHaveLength(0);
  });

  it("locks every control while the import is being written", async () => {
    const user = userEvent.setup();
    let finish!: (value: { status: number; data: unknown }) => void;
    deferredConfirm = new Promise((resolve) => { finish = resolve; });
    renderPage();
    await reachReview(user);

    await user.click(importButton());
    const dateColumn = screen.getByRole("combobox", { name: "Date" });
    expect(dateColumn).toBeDisabled();
    for (const remove of screen.getAllByRole("button", { name: "Remove row 2" })) expect(remove).toBeDisabled();
    expectCurrentStep("Import");

    await act(async () => { finish({ status: 201, data: COMPLETE }); });
    await screen.findByText("Import complete");
    expect(confirms()).toHaveLength(1);
  });
});

describe("CSV import: editing the rows", () => {
  it("flags a missing amount in a few words, and a fixed cell reaches the check and the confirm", async () => {
    const user = userEvent.setup();
    stagedExtra = {
      previewRows: [{ date: "13/04/2026", description: "Rice sack", amount: "", category: "", posted: "", payment: "" }],
    };
    checkExtra = { validation: { ...VALID, validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: 'Invalid amount: ""' }] } };
    renderPage();
    await reachReview(user);

    expect(screen.getAllByText("Amount required").length).toBeGreaterThan(0);
    expect(importButton()).toBeDisabled();

    await user.click(screen.getAllByRole("button", { name: "Fix row 2" })[0]!);
    checkExtra = {};
    await user.type(screen.getAllByRole("textbox", { name: "Amount, row 2" })[0]!, "500");
    await waitFor(() => expect(JSON.parse(checks().at(-1)!.fields.corrections ?? "{}")).toEqual({ "2": { amount: "500" } }), { timeout: 3000 });
    await waitFor(() => expect(importButton()).toBeEnabled());

    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(JSON.parse(confirms()[0]!.fields.corrections!)).toEqual({ "2": { amount: "500" } });
  });

  it("shows FinSight's category suggestion, and the owner's choice replaces it on import", async () => {
    const user = userEvent.setup();
    checkExtra = {
      rowCategories: [{ row: 2, name: "Office Supplies", source: "suggested", isNew: true, confidence: "medium" }],
      categorySummary: { fromFile: 0, suggested: 1, uncategorised: 0, newCategories: [{ name: "Office Supplies", rows: 1 }] },
    };
    renderPage();
    await reachReview(user);

    const category = screen.getAllByRole("combobox", { name: "Category for row 2" })[0]!;
    expect(category).toHaveValue("Office Supplies");
    expect(screen.getByText(/New categories:/).parentElement).toHaveTextContent("New categories: Office Supplies (1). Created when you import.");

    await user.selectOptions(category, "Inventory");
    await waitFor(() => expect(JSON.parse(checks().at(-1)!.fields.corrections ?? "{}")).toEqual({ "2": { category: "Inventory" } }), { timeout: 3000 });
    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(JSON.parse(confirms()[0]!.fields.corrections!)).toEqual({ "2": { category: "Inventory" } });
  });

  it("removes a row from the import and can restore it", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachReview(user);

    await user.click(screen.getAllByRole("button", { name: "Remove row 2" })[0]!);
    await waitFor(() => expect(JSON.parse(checks().at(-1)!.fields.corrections ?? "{}")).toEqual({ "2": { exclude: true } }), { timeout: 3000 });
    expect(screen.getAllByText("Removed").length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole("button", { name: "Restore row 2" })[0]!);
    await waitFor(() => expect(checks().at(-1)!.fields.corrections).toBeUndefined(), { timeout: 3000 });
  });

  it("shows a possible duplicate against its row before anything is written", async () => {
    const user = userEvent.setup();
    checkExtra = { validation: { ...VALID, possibleDuplicateRows: 1, duplicateRows: [2] } };
    renderPage();
    await reachReview(user);
    expect(screen.getAllByText("Possible duplicate").length).toBeGreaterThan(0);
    expect(confirms()).toHaveLength(0);
  });

  it("offers rows past the sample that need review", async () => {
    const user = userEvent.setup();
    stagedExtra = { totalRows: 900 };
    checkExtra = {
      validation: { ...VALID, validRows: 899, invalidRows: 1, skipped: [{ row: 850, reason: 'Invalid date: ""' }] },
      reviewRows: [{ row: 850, values: { date: "", description: "Load", amount: "100", category: "", posted: "", payment: "" } }],
    };
    renderPage();
    await reachReview(user);

    await user.click(screen.getByRole("button", { name: /Needs review/ }));
    expect(screen.getAllByText("Date required").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Fix row 850" }).length).toBeGreaterThan(0);
  });

  it("will not import when no row is ready", async () => {
    const user = userEvent.setup();
    checkExtra = { validation: { ...VALID, validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Invalid date" }] } };
    renderPage();
    await reachReview(user);
    expect(importButton()).toBeDisabled();
    expect(confirms()).toHaveLength(0);
  });

  it("fails closed when the check omits its validation result", async () => {
    const user = userEvent.setup();
    checkExtra = { validation: undefined };
    renderPage();
    await reachReview(user);
    await user.click(importButton());
    expect(await screen.findByText("This file couldn't be checked. Try again.")).toBeVisible();
    expect(confirms()).toHaveLength(0);
  });
});

describe("CSV import: review settings", () => {
  /*
   * The review screen does not ask for the import type, batch name or how a
   * mixed file is split: detection decides them and the batch is named after
   * the file.
   */
  it("asks for no import settings and names the batch after the file", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachReview(user);

    expect(screen.queryByRole("combobox", { name: /Import as/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Batch name/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Rows are split by/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Type column/ })).not.toBeInTheDocument();

    await user.click(importButton());
    await waitFor(() => expect(confirms()).toHaveLength(1));
    expect(confirms()[0]!.fields.title).toBe("march");
  });
});

describe("CSV import: sales", () => {
  it("opens a sales file as sales, with no category to choose, naming the columns it cannot store", async () => {
    const user = userEvent.setup();
    stagedExtra = {
      headers: ["date", "product", "revenue", "customer"],
      previewRows: [{ date: "2026-09-01", product: "Iced coffee", revenue: "240", customer: "Ana" }],
      suggestedMapping: { date: "date", description: "product", amount: "revenue" },
      columnDetection: { unmapped: [{ header: "customer", field: "customer" }], suggestedRecordType: "sales" },
      detectedDateFormat: "iso",
    };
    renderPage();
    await reachReview(user);

    expect(screen.queryByRole("combobox", { name: /Category for row/ })).not.toBeInTheDocument();
    expect(screen.getByText(/customer \(Customer\)/)).toBeInTheDocument();
    expect(checks()[0]!.fields.recordType).toBe("sales");
  });
});

describe("CSV import: idempotent confirm", () => {
  it("sends the same idempotency key on a retry after a failure", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 500, data: null }), () => ({ status: 201, data: COMPLETE })];
    renderPage();
    await reachReview(user);

    await user.click(importButton());
    await screen.findByText(/status code 500/);
    await user.click(importButton());
    await screen.findByText("Import complete");

    expect(confirms()).toHaveLength(2);
    expect(confirms()[0]!.fields.idempotencyKey).toBe("11111111-2222-3333-4444-555555555555");
    // THE ASSERTION THIS BLOCK EXISTS FOR: the same key, not a fresh one.
    expect(confirms()[1]!.fields.idempotencyKey).toBe(confirms()[0]!.fields.idempotencyKey);
  });

  it("does not send a date format for a file that is unambiguous", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    renderPage();
    await reachReview(user);
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(confirms()[0]!.fields.dateFormat).toBeUndefined();
  });
});

describe("CSV import: ambiguous dates", () => {
  it("waits for the owner to say which way round the dates are", async () => {
    const user = userEvent.setup();
    stagedExtra = { dateFormatAmbiguous: true, previewRows: [{ date: "03/04/2026", description: "Rice sack", amount: "2400", category: "", posted: "", payment: "" }] };
    confirmResponses = [() => ({ status: 201, data: COMPLETE })];
    renderPage();
    await user.upload(screen.getByLabelText(/CSV file/i), new File(["date,description,amount\n"], "march.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "Upload and review" }));
    await screen.findByRole("heading", { level: 1, name: "Review import" });

    expect(screen.getByText("Date format")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    expect(checks()).toHaveLength(0);

    await user.click(screen.getByRole("radio", { name: /Month first/ }));
    stagedExtra = { ...stagedExtra, dateFormatAmbiguous: false };
    await waitFor(() => expect(checks().length).toBeGreaterThan(0));
    await waitFor(() => expect(importButton()).toBeEnabled());
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(confirms()[0]!.fields.dateFormat).toBe("mdy");
  });
});

describe("CSV import: a large file that finishes on the worker", () => {
  it("polls the status endpoint on a 202 and renders the summary from the final counts", async () => {
    const user = userEvent.setup();
    const invalidation = vi.fn();
    const unsubscribe = subscribeToServerState(invalidation);
    confirmResponses = [() => ({
      status: 202,
      data: { batchId: 9, title: "march", status: "Pending Review", processingStatus: "PENDING", totalRows: 0, imported: 0, skipped: [], flagged: 0, largeExpenseFlagged: 0 },
    })];
    statusResponses = [
      { batchId: 9, status: "Pending Review", processingStatus: "PROCESSING", totalRows: 1000, processedRows: 400, importedRows: 380, skippedRows: 20, flaggedRows: 0, failureStage: null, resultSummary: null },
      {
        batchId: 9, status: "Reviewed", processingStatus: "COMPLETE", totalRows: 1000, processedRows: 1000, importedRows: 970, skippedRows: 30, flaggedRows: 4, failureStage: null,
        resultSummary: { importedExpenses: 970, importedSales: 0, largeExpenseFlagged: 2, uncategorised: 0, skipped: [{ row: 5, reason: "Invalid amount" }], skippedTruncated: true },
      },
    ];
    renderPage();
    await reachReview(user);
    await user.click(importButton());

    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "400");
    expect(bar).toHaveAttribute("aria-valuemax", "1000");
    expect(screen.getByText("400 of 1,000 rows")).toBeInTheDocument();

    await screen.findByText("Import complete", undefined, { timeout: 5000 });
    expect(screen.getByText("970")).toBeInTheDocument();
    // The COUNT of skipped rows, not the length of the capped list.
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 30 skipped rows.")).toBeInTheDocument();
    expect(invalidation).toHaveBeenCalledWith({
      type: "invalidate",
      target: {
        businessProfileId: profile.id,
        tags: ["financial", "record-months", "notifications"],
      },
    });
    expect(invalidation).toHaveBeenCalledTimes(1);
    unsubscribe();
  }, 10000);

  it("reports committed rows after a terminal worker failure without offering a same-file retry", async () => {
    const user = userEvent.setup();
    const invalidation = vi.fn();
    const unsubscribe = subscribeToServerState(invalidation);
    confirmResponses = [() => ({ status: 202, data: { batchId: 9, title: "march", status: "Pending Review", processingStatus: "PENDING", totalRows: 1000, imported: 0, skipped: [], flagged: 0 } })];
    statusResponses = [{ batchId: 9, status: "Pending Review", processingStatus: "FAILED", totalRows: 1000, processedRows: 400, importedRows: 380, skippedRows: 20, flaggedRows: 0, failureStage: "insert", resultSummary: null }];
    renderPage();
    await reachReview(user);
    await user.click(importButton());

    await screen.findByText("Import stopped");
    expect(screen.getByText("380")).toBeVisible();
    expect(screen.getByText("Review the saved records, then import only the remaining rows.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Review saved records" })).toHaveAttribute("href", "/records?source=CSV_UPLOAD&importBatchId=9");
    expect(screen.queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(confirms()).toHaveLength(1);
    expect(invalidation).toHaveBeenCalledWith({
      type: "invalidate",
      target: {
        businessProfileId: profile.id,
        tags: ["financial", "record-months", "notifications"],
      },
    });
    expect(invalidation).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not claim records were saved when a worker fails before importing any rows", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 202, data: { batchId: 9, title: "march", status: "Pending Review", processingStatus: "PENDING", totalRows: 1000, imported: 0, skipped: [], flagged: 0 } })];
    statusResponses = [{ batchId: 9, status: "Pending Review", processingStatus: "FAILED", totalRows: 1000, processedRows: 0, importedRows: 0, skippedRows: 0, flaggedRows: 0, failureStage: "validate", resultSummary: null }];
    renderPage();
    await reachReview(user);
    await user.click(importButton());

    await screen.findByText("Import stopped");
    expect(screen.getByText("No records were saved. Check the source file, then import it again.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Review saved records" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import another file" })).toBeVisible();
  });

  it("does not celebrate a terminal FAILED replay returned directly by confirm", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 200, data: { batchId: 9, title: "march", status: "Pending Review", processingStatus: "FAILED", totalRows: 1000, imported: 380, skippedCount: 20, skipped: [], flagged: 0 } })];
    renderPage();
    await reachReview(user);
    await user.click(importButton());
    await screen.findByText("Import stopped");
    expect(screen.getByText("380")).toBeVisible();
    expect(screen.queryByText("Import complete")).not.toBeInTheDocument();
  });

  it("uses the aggregate skipped count when a completed replay has a capped error list", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 200, data: { batchId: 9, title: "march", status: "Reviewed", processingStatus: "COMPLETE", totalRows: 1000, imported: 970, skippedCount: 30, skippedTruncated: true, skipped: [{ row: 4, reason: "Invalid amount" }], flagged: 0 } })];
    renderPage();
    await reachReview(user);
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(screen.getByText("30")).toBeVisible();
    expect(screen.getByText("Row 4: Invalid amount")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Showing 1 of 30 skipped rows.")).toBeVisible();
  });

  it("warns when the same file was imported before", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 201, data: { ...COMPLETE, batchId: 12, flagged: 1, duplicateOfBatchId: 4 } })];
    renderPage();
    await reachReview(user);
    await user.click(importButton());
    await screen.findByText("Import complete");
    const warning = await screen.findByText("This file was imported before.");
    expect(within(warning.closest("div")!.parentElement!).getByRole("link", { name: "Review duplicates" })).toHaveAttribute("href", "/records/flagged");
  });
});
