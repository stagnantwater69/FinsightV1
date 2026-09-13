// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ImportCsv } from "./ImportCsv";
import type { BusinessProfile } from "../lib/types";

/**
 * WHAT THIS FILE GUARDS.
 *
 * Two behaviours whose failure modes are both about someone's real books:
 *
 *   1. THE IDEMPOTENCY KEY IS REUSED ON RETRY. A key regenerated per attempt
 *      makes every retry look like a brand-new import, so an impatient second
 *      click or a retried failure duplicates a month of records. The key is
 *      minted once per chosen file precisely so that cannot happen — and
 *      nothing about the UI shows it, which is exactly why it needs a test.
 *
 *   2. A 202 IS NOT A SUMMARY. A large file leaves the request with zero
 *      counts and finishes on the worker. Rendering that response as a result
 *      would tell the owner their 20,000-row file imported nothing.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

const previewBody = {
  headers: ["date", "description", "amount", "category"],
  previewRows: [{ date: "03/04/2026", description: "Rice sack", amount: "2400", category: "Inventory" }],
  totalRows: 1,
  detectedTypeColumn: null,
  columnsWithNegatives: [],
  detectedDateFormat: "dmy",
  dateFormatAmbiguous: false,
};

interface PostCall {
  url: string;
  fields: Record<string, string>;
}

let posts: PostCall[];
/** Queued responses for POST /confirm, consumed in order. */
let confirmResponses: (() => { status: number; data: unknown })[];
let statusResponses: unknown[];
let previewExtra: Record<string, unknown>;
let deferredPreview: Promise<unknown> | null;

function fieldsOf(body: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  body.forEach((value, key) => {
    out[key] = value instanceof File ? value.name : String(value);
  });
  return out;
}

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url.includes("/status")) {
        const next = statusResponses.shift() ?? statusResponses.at(-1);
        return { status: 200, data: next };
      }
      throw new Error(`unmocked GET ${url}`);
    },
    post: async (url: string, body: FormData) => {
      posts.push({ url, fields: fieldsOf(body) });
      if (url.endsWith("/preview")) return { status: 200, data: deferredPreview ? await deferredPreview : { ...previewBody, ...previewExtra } };
      const next = confirmResponses.shift();
      if (!next) throw new Error("no queued confirm response");
      const result = next();
      if (result.status >= 400) throw new Error("Request failed with status code 500");
      return result;
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }] }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ImportCsv />
    </MemoryRouter>,
  );
}

/** Walks the picker and the preview so the test starts at the Import button. */
async function reachMappingScreen(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(["date,description,amount,category\n"], "march.csv", { type: "text/csv" });
  await user.upload(screen.getByLabelText(/CSV file/i), file);
  await user.click(screen.getByRole("button", { name: "Preview" }));
  await screen.findByText("Map your columns");
}

beforeEach(() => {
  posts = [];
  confirmResponses = [];
  statusResponses = [];
  previewExtra = {};
  deferredPreview = null;
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "11111111-2222-3333-4444-555555555555" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CSV full-file review", () => {
  it("locks mapping and row corrections while the server checks the reviewed values", async () => {
    const user = userEvent.setup();
    previewExtra.previewRows = [{ date: "03/04/2026", description: "Rice sack", amount: "invalid", category: "Inventory" }];
    renderPage();
    await reachMappingScreen(user);
    let finish!: (value: unknown) => void;
    deferredPreview = new Promise((resolve) => { finish = resolve; });
    const mapping = screen.getByRole("combobox", { name: "Which CSV column holds the amount?" });
    const correction = document.getElementById("fix-2-Amount") as HTMLInputElement;
    const title = screen.getByRole("textbox", { name: /Batch title/ });
    await user.click(screen.getByRole("button", { name: "Check all rows" }));
    expect(mapping).toBeDisabled();
    expect(correction).toBeDisabled();
    expect(title).toBeDisabled();
    await user.selectOptions(mapping, "description");
    await user.type(correction, "500");
    expect(mapping).toHaveValue("amount");
    expect(correction).toHaveValue("invalid");
    await act(async () => { finish({ ...previewBody, validation: { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Invalid amount" }], skippedTruncated: false } }); });
    expect(mapping).toBeEnabled();
    expect(correction).toBeEnabled();
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

  it("can check all rows without creating an import", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);
    previewExtra.validation = { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false };
    await user.click(screen.getByRole("button", { name: "Check all rows" }));
    await screen.findByText(/File checked/);
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });
  it("requires acknowledgement of skipped rows before writing and collapses details", async () => {
    const user = userEvent.setup();
    previewExtra = { totalRows: 3 };
    renderPage();
    await reachMappingScreen(user);
    previewExtra.validation = { validRows: 2, invalidRows: 1, skipped: [{ row: 4, reason: "Invalid amount" }], skippedTruncated: false };
    await user.click(screen.getByRole("button", { name: "Import 3 rows" }));
    await screen.findByText(/File check: 2 valid, 1 skipped/);
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
    expect(screen.getByText("Row 4: Invalid amount")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Row 4: Invalid amount")).toBeVisible();
    confirmResponses = [() => ({ status: 201, data: { batchId: 3, title: "march", status: "Reviewed", totalRows: 3, imported: 2, skipped: [{ row: 4, reason: "Invalid amount" }], flagged: 0, largeExpenseFlagged: 0 } })];
    await user.click(screen.getByRole("button", { name: "Import 2 of 3 rows" }));
    await screen.findByText("Import complete");
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(1);
    expect(screen.getByText("Row 4: Invalid amount")).not.toBeVisible();
  });

  it("shows suspected duplicates before confirming instead of silently importing", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);
    previewExtra.validation = { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false, possibleDuplicateRows: 1, duplicateRows: [2] };
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await screen.findByText(/possible duplicate will be included and flagged/);
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
    expect(screen.getByText(/Possible duplicate rows: 2/)).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText(/Possible duplicate rows: 2/)).toBeVisible();
  });

  it("does not confirm a file with no valid rows, including repeated attempts", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);
    previewExtra.validation = { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Invalid date" }], skippedTruncated: false };
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await screen.findByText(/No rows are ready/);
    await user.click(screen.getByRole("button", { name: "Import 0 of 1 rows" }));
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

  it("applies historical category suggestions only after an explicit action and rechecks", async () => {
    const user = userEvent.setup();
    previewExtra = { headers: ["date", "description", "amount"], previewRows: [{ date: "03/04/2026", description: "Rice sack", amount: "2400" }] };
    renderPage();
    await reachMappingScreen(user);
    previewExtra.validation = { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Missing category" }], skippedTruncated: false };
    previewExtra.categorySuggestions = [{ row: 2, categoryId: 1, categoryName: "Inventory", source: "history" }];
    await user.click(screen.getByRole("button", { name: "Import 0 of 1 rows" }));
    await screen.findByRole("button", { name: "Apply category suggestions" });
    const preflight = posts.filter((post) => post.url.endsWith("/preview")).at(-1)!;
    expect(preflight.fields.corrections).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Apply category suggestions" }));
    previewExtra.validation = { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false };
    previewExtra.categorySuggestions = [];
    confirmResponses = [() => ({ status: 201, data: { batchId: 3, title: "march", status: "Reviewed", totalRows: 1, imported: 1, skipped: [], flagged: 0, largeExpenseFlagged: 0 } })];
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await screen.findByText("Import complete");
    const confirm = posts.find((post) => post.url.endsWith("/confirm"))!;
    expect(JSON.parse(confirm.fields.corrections!)).toEqual({ "2": { category: "Inventory" } });
    expect(posts.filter((post) => post.url.endsWith("/preview"))).toHaveLength(3);
  });
});

describe("CSV import — idempotent confirm", () => {
  it("sends the same idempotency key on a retry after a failure", async () => {
    const user = userEvent.setup();
    confirmResponses = [
      () => ({ status: 500, data: null }),
      () => ({
        status: 201,
        data: {
          batchId: 3,
          title: "march",
          status: "Reviewed",
          processingStatus: "COMPLETE",
          totalRows: 1,
          imported: 1,
          skipped: [],
          flagged: 0,
          largeExpenseFlagged: 0,
        },
      }),
    ];
    renderPage();
    await reachMappingScreen(user);

    await user.click(screen.getByRole("button", { name: /^Import 1 row$/ }));
    await screen.findByText(/status code 500/);

    await user.click(screen.getByRole("button", { name: /^Import 1 row$/ }));
    await screen.findByText("Import complete");

    const confirms = posts.filter((p) => p.url.endsWith("/confirm"));
    expect(confirms).toHaveLength(2);
    expect(confirms[0]!.fields.idempotencyKey).toBe("11111111-2222-3333-4444-555555555555");
    // THE ASSERTION THIS FILE EXISTS FOR — the same key, not a fresh one.
    expect(confirms[1]!.fields.idempotencyKey).toBe(confirms[0]!.fields.idempotencyKey);
  });

  it("does not send a date format for a file that is unambiguous", async () => {
    const user = userEvent.setup();
    confirmResponses = [
      () => ({
        status: 201,
        data: {
          batchId: 3,
          title: "march",
          status: "Reviewed",
          processingStatus: "COMPLETE",
          totalRows: 1,
          imported: 1,
          skipped: [],
          flagged: 0,
          largeExpenseFlagged: 0,
        },
      }),
    ];
    renderPage();
    await reachMappingScreen(user);
    await user.click(screen.getByRole("button", { name: /^Import 1 row$/ }));
    await screen.findByText("Import complete");

    const confirm = posts.find((p) => p.url.endsWith("/confirm"))!;
    expect(confirm.fields.dateFormat).toBeUndefined();
  });
});

describe("CSV import — ambiguous dates", () => {
  it("blocks the import until the owner says which way round the dates are", async () => {
    const user = userEvent.setup();
    previewBody.dateFormatAmbiguous = true;
    confirmResponses = [
      () => ({
        status: 201,
        data: {
          batchId: 4,
          title: "march",
          status: "Reviewed",
          processingStatus: "COMPLETE",
          totalRows: 1,
          imported: 1,
          skipped: [],
          flagged: 0,
          largeExpenseFlagged: 0,
        },
      }),
    ];
    try {
      renderPage();
      await reachMappingScreen(user);

      expect(screen.getByText("Which way round are your dates?")).toBeInTheDocument();
      const importButton = screen.getByRole("button", { name: /^Import 1 row$/ });
      expect(importButton).toBeDisabled();

      await user.click(screen.getByRole("radio", { name: /Month first/ }));
      expect(importButton).toBeEnabled();

      await user.click(importButton);
      await screen.findByText("Import complete");

      const confirm = posts.find((p) => p.url.endsWith("/confirm"))!;
      expect(confirm.fields.dateFormat).toBe("mdy");
    } finally {
      previewBody.dateFormatAmbiguous = false;
    }
  });
});

describe("CSV import — a large file that finishes on the worker", () => {
  it("polls the status endpoint on a 202 and renders the summary from the final counts", async () => {
    const user = userEvent.setup();
    confirmResponses = [
      () => ({
        status: 202,
        data: {
          batchId: 9,
          title: "march",
          status: "Pending Review",
          processingStatus: "PENDING",
          totalRows: 0,
          imported: 0,
          skipped: [],
          flagged: 0,
          largeExpenseFlagged: 0,
        },
      }),
    ];
    statusResponses = [
      {
        batchId: 9,
        status: "Pending Review",
        processingStatus: "PROCESSING",
        totalRows: 1000,
        processedRows: 400,
        importedRows: 380,
        skippedRows: 20,
        flaggedRows: 0,
        failureStage: null,
        resultSummary: null,
      },
      {
        batchId: 9,
        status: "Reviewed",
        processingStatus: "COMPLETE",
        totalRows: 1000,
        processedRows: 1000,
        importedRows: 970,
        skippedRows: 30,
        flaggedRows: 4,
        failureStage: null,
        resultSummary: {
          importedExpenses: 970,
          importedSales: 0,
          largeExpenseFlagged: 2,
          uncategorised: 0,
          skipped: [{ row: 5, reason: "Invalid amount" }],
          skippedTruncated: true,
        },
      },
    ];

    renderPage();
    await reachMappingScreen(user);
    await user.click(screen.getByRole("button", { name: /^Import 1 row$/ }));

    // Real progress, from the server's own count — not an animation.
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "400");
    expect(bar).toHaveAttribute("aria-valuemax", "1000");
    expect(bar).toHaveAttribute("aria-valuetext", "400 of 1000 rows processed");
    expect(screen.getByText("400 of 1,000 rows")).toBeInTheDocument();

    // …then the ordinary summary, built from the final status.
    await screen.findByText("Import complete", undefined, { timeout: 5000 });
    expect(screen.getByText("970")).toBeInTheDocument();
    // The COUNT of skipped rows, not the length of the capped list.
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 30 skipped rows.")).toBeInTheDocument();
  }, 10000);

  it("reports committed rows after terminal worker failure without offering a same-file retry", async () => {
    const user = userEvent.setup();
    const accepted = { batchId: 9, title: "march", status: "Pending Review", processingStatus: "PENDING", totalRows: 1000, imported: 0, skipped: [], flagged: 0 };
    confirmResponses = [() => ({ status: 202, data: accepted })];
    statusResponses = [
      { batchId: 9, status: "Pending Review", processingStatus: "FAILED", totalRows: 1000, processedRows: 400, importedRows: 380, skippedRows: 20, flaggedRows: 0, failureStage: "insert", resultSummary: null },
    ];
    renderPage();
    await reachMappingScreen(user);
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await screen.findByText("Import stopped");
    expect(screen.getByText("380")).toBeVisible();
    expect(screen.getByText("20")).toBeVisible();
    expect(screen.getByText("Review the saved records, then import only the remaining rows.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Review saved records" })).toHaveAttribute("href", "/records?source=CSV_UPLOAD&importBatchId=9");
    expect(screen.queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Import complete")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    const confirms = posts.filter((post) => post.url.endsWith("/confirm"));
    expect(confirms).toHaveLength(1);
  });

  it("does not celebrate a terminal FAILED replay returned directly by confirm", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 200, data: {
      batchId: 9, title: "march", status: "Pending Review", processingStatus: "FAILED", totalRows: 1000,
      imported: 380, skippedCount: 20, skipped: [], flagged: 0,
    } })];
    renderPage();
    await reachMappingScreen(user);
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await screen.findByText("Import stopped");
    expect(screen.getByText("380")).toBeVisible();
    expect(screen.getByRole("link", { name: "Review saved records" })).toBeVisible();
    expect(screen.queryByText("Import complete")).not.toBeInTheDocument();
  });

  it("uses the aggregate skipped count when a completed replay has a capped error list", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 200, data: {
      batchId: 9, title: "march", status: "Reviewed", processingStatus: "COMPLETE", totalRows: 1000,
      imported: 970, skippedCount: 30, skippedTruncated: true, skipped: [{ row: 4, reason: "Invalid amount" }], flagged: 0,
    } })];
    renderPage();
    await reachMappingScreen(user);
    await user.click(screen.getByRole("button", { name: "Import 1 row" }));
    await screen.findByText("Import complete");
    expect(screen.getByText("30")).toBeVisible();
    expect(screen.getByText("Row 4: Invalid amount")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Showing 1 of 30 skipped rows.")).toBeVisible();
  });

  it("warns when the same file was imported before", async () => {
    const user = userEvent.setup();
    confirmResponses = [
      () => ({
        status: 201,
        data: {
          batchId: 12,
          title: "march",
          status: "Reviewed",
          processingStatus: "COMPLETE",
          totalRows: 1,
          imported: 1,
          skipped: [],
          flagged: 1,
          largeExpenseFlagged: 0,
          duplicateOfBatchId: 4,
        },
      }),
    ];
    renderPage();
    await reachMappingScreen(user);
    await user.click(screen.getByRole("button", { name: /^Import 1 row$/ }));

    await screen.findByText("Import complete");
    await waitFor(() =>
      expect(screen.getByText("This file was imported before.")).toBeInTheDocument(),
    );
  });
});
