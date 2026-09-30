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
  stagedUploadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
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
  transport: "multipart" | "json";
}

let posts: PostCall[];
let deletes: string[];
let deleteShouldFail: boolean;
let nextJsonPreviewError: unknown | null;
/** Queued responses for POST /confirm, consumed in order. */
let confirmResponses: (() => { status: number; data: unknown })[];
let statusResponses: unknown[];
let previewExtra: Record<string, unknown>;
let deferredPreview: Promise<unknown> | null;

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
        if (transport === "json" && nextJsonPreviewError) {
          const error = nextJsonPreviewError;
          nextJsonPreviewError = null;
          throw error;
        }
        return { status: 200, data: deferredPreview ? await deferredPreview : { ...previewBody, ...previewExtra } };
      }
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
  useExpenseCategories: () => ({ categories: [{ id: 1, name: "Inventory" }] }),
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

/** Walks the picker and preview so the test starts on column mapping. */
async function reachMappingScreen(user: ReturnType<typeof userEvent.setup>) {
  const file = new File(["date,description,amount,category\n"], "march.csv", { type: "text/csv" });
  await user.upload(screen.getByLabelText(/CSV file/i), file);
  await user.click(screen.getByRole("button", { name: "Preview file" }));
  await screen.findByRole("heading", { level: 1, name: "Map and review columns" });
}

async function continueToReview(
  user: ReturnType<typeof userEvent.setup>,
  validation: PreviewResultValidation = {
    validRows: 1,
    invalidRows: 0,
    skipped: [],
    skippedTruncated: false,
  },
) {
  previewExtra.validation = validation;
  await user.click(screen.getByRole("button", { name: "Continue to review" }));
  await screen.findByRole("heading", { level: 1, name: "Review and import" });
}

interface PreviewResultValidation {
  validRows: number;
  invalidRows: number;
  skipped: { row: number; reason: string }[];
  skippedTruncated: boolean;
  possibleDuplicateRows?: number;
  duplicateRows?: number[];
  duplicateRowsTruncated?: boolean;
}

function importButton() {
  return screen.getByRole("button", { name: /^Import \d/ });
}

beforeEach(() => {
  posts = [];
  deletes = [];
  deleteShouldFail = false;
  nextJsonPreviewError = null;
  confirmResponses = [];
  statusResponses = [];
  previewExtra = {};
  deferredPreview = null;
  previewBody.dateFormatAmbiguous = false;
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "11111111-2222-3333-4444-555555555555" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CSV full-file review", () => {
  it("marks each current stage and never confirms before the review screen", async () => {
    const user = userEvent.setup();
    renderPage();

    expectCurrentStep("Upload file");
    await reachMappingScreen(user);
    expectCurrentStep("Map columns");

    await continueToReview(user);
    expectCurrentStep("Review and import");
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
    const previews = posts.filter((post) => post.url.endsWith("/preview"));
    expect(previews).toHaveLength(2);
    expect(previews[0]).toMatchObject({
      transport: "multipart",
      fields: {
        file: "march.csv",
        businessProfileId: "1",
        idempotencyKey: "11111111-2222-3333-4444-555555555555",
      },
    });
    expect(previews[1]).toMatchObject({
      transport: "json",
      fields: { stagedUploadId: previewBody.stagedUploadId },
    });
    expect(previews.filter((post) => post.fields.file !== undefined)).toHaveLength(1);
  });

  it("announces the selected file and keeps focus on each stage when moving forward or starting over", async () => {
    const user = userEvent.setup();
    renderPage();

    const file = new File(["date,description,amount,category\n"], "a-very-long-import-file-name-for-september-expenses.csv", {
      type: "text/csv",
    });
    await user.upload(screen.getByLabelText(/CSV file/i), file);
    const selectedFileStatus = screen.getByRole("status");
    expect(selectedFileStatus).toHaveTextContent(`Selected file: ${file.name}`);
    expect(selectedFileStatus).not.toContainElement(screen.getByRole("button", { name: "Remove file" }));

    await user.click(screen.getByRole("button", { name: "Preview file" }));
    const mapHeading = await screen.findByRole("heading", { level: 1, name: "Map and review columns" });
    await waitFor(() => expect(mapHeading.closest('[tabindex="-1"]')).toHaveFocus());

    await continueToReview(user);
    const reviewHeading = screen.getByRole("heading", { level: 1, name: "Review and import" });
    await waitFor(() => expect(reviewHeading.closest('[tabindex="-1"]')).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Back to mapping" }));
    await user.click(screen.getByRole("button", { name: "Change file" }));
    const uploadHeading = await screen.findByRole("heading", { level: 1, name: "Import CSV records" });
    await waitFor(() => expect(uploadHeading.closest('[tabindex="-1"]')).toHaveFocus());
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
    confirmResponses = [() => ({ status: 201, data: {
      batchId: 3, title: "march", status: "Reviewed", processingStatus: "COMPLETE",
      totalRows: 1, imported: 1, skipped: [], flagged: 0, largeExpenseFlagged: 0,
    } })];
    renderPage();
    await reachMappingScreen(user);
    await continueToReview(user);
    await user.click(importButton());
    await screen.findByText("Import complete");

    const confirm = posts.find((post) => post.url.endsWith("/confirm"));
    expect(confirm).toMatchObject({
      transport: "json",
      fields: {
        stagedUploadId: previewBody.stagedUploadId,
        businessProfileId: "1",
        idempotencyKey: "11111111-2222-3333-4444-555555555555",
      },
    });
    expect(posts.filter((post) => post.fields.file !== undefined)).toHaveLength(1);
  });

  it("fails closed when the upload response does not include a stage handle", async () => {
    const user = userEvent.setup();
    previewExtra = { stagedUploadId: undefined };
    renderPage();

    const file = new File(["date,description,amount\n"], "march.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText(/CSV file/i), file);
    await user.click(screen.getByRole("button", { name: "Preview file" }));

    expect(await screen.findByText(/couldn't prepare this upload for review/i)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Import CSV records" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1, name: "Map and review columns" })).not.toBeInTheDocument();
  });

  it("clears the picker immediately even if staged cleanup fails", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);
    deleteShouldFail = true;

    await user.click(screen.getByRole("button", { name: "Change file" }));

    expect(screen.getByRole("heading", { level: 1, name: "Import CSV records" })).toBeVisible();
    await waitFor(() => expect(deletes).toEqual([
      `/records/csv-imports/stages/${previewBody.stagedUploadId}`,
    ]));
    const replacement = new File(["date,description,amount\n"], "april.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText(/CSV file/i), replacement);
    expect(screen.getByText("april.csv")).toBeVisible();
  });

  it("recovers an expired stage without discarding mapping edits", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);
    const title = screen.getByRole("textbox", { name: /Batch title/ });
    await user.clear(title);
    await user.type(title, "March corrected");
    nextJsonPreviewError = {
      isAxiosError: true,
      message: "Request failed with status code 410",
      response: { status: 410, data: { code: "CSV_STAGE_EXPIRED" } },
    };

    await user.click(screen.getByRole("button", { name: "Continue to review" }));

    expect(await screen.findByText("This upload is no longer available. Preview the selected CSV file again to continue.")).toBeVisible();
    expect(screen.getByText("march.csv")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Preview file" }));
    await screen.findByRole("heading", { level: 1, name: "Map and review columns" });
    expect(screen.getByRole("textbox", { name: /Batch title/ })).toHaveValue("March corrected");
    expect(posts.filter((post) => post.fields.file !== undefined)).toHaveLength(2);
  });

  it("retains the batch title and mapping when returning from review", async () => {
    const user = userEvent.setup();
    previewExtra = {
      headers: ["date", "description", "amount", "category", "posted"],
      previewRows: [{ date: "03/04/2026", posted: "04/03/2026", description: "Rice sack", amount: "2400", category: "Inventory" }],
    };
    renderPage();
    await reachMappingScreen(user);

    const title = screen.getByRole("textbox", { name: /Batch title/ });
    const dateMapping = screen.getByRole("combobox", { name: "Which CSV column holds the date?" });
    await user.clear(title);
    await user.type(title, "March POS cleanup");
    await user.selectOptions(dateMapping, "posted");

    await continueToReview(user);
    expect(screen.getByText("March POS cleanup")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to mapping" }));

    expect(screen.getByRole("textbox", { name: /Batch title/ })).toHaveValue("March POS cleanup");
    expect(screen.getByRole("combobox", { name: "Which CSV column holds the date?" })).toHaveValue("posted");
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

  it("blocks review while two fields point to the same CSV column", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);

    const amountMapping = screen.getByRole("combobox", { name: "Which CSV column holds the amount?" });
    const continueButton = screen.getByRole("button", { name: "Continue to review" });
    await user.selectOptions(amountMapping, "description");

    expect(continueButton).toBeDisabled();
    expect(screen.getAllByText(/is already mapped to another field/)).toHaveLength(2);
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);

    await user.selectOptions(amountMapping, "amount");
    expect(continueButton).toBeEnabled();
  });

  it("blocks a header-only file before review", async () => {
    const user = userEvent.setup();
    previewExtra = { previewRows: [], totalRows: 0 };
    renderPage();
    await reachMappingScreen(user);

    expect(screen.getByText("This file has headings but no records.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

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
    await user.click(screen.getByRole("button", { name: "Continue to review" }));
    expect(mapping).toBeDisabled();
    expect(correction).toBeDisabled();
    expect(title).toBeDisabled();
    await user.selectOptions(mapping, "description");
    await user.type(correction, "500");
    expect(mapping).toHaveValue("amount");
    expect(correction).toHaveValue("invalid");
    await act(async () => { finish({ ...previewBody, validation: { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Invalid amount" }], skippedTruncated: false } }); });
    await screen.findByRole("heading", { level: 1, name: "Review and import" });
    await user.click(screen.getByRole("button", { name: "Back to mapping" }));
    expect(mapping).toBeEnabled();
    expect(correction).toBeEnabled();
    expect(title).toBeEnabled();
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

  it("shows skipped-row warnings for review before writing and collapses details", async () => {
    const user = userEvent.setup();
    previewExtra = { totalRows: 3 };
    renderPage();
    await reachMappingScreen(user);
    await continueToReview(user, { validRows: 2, invalidRows: 1, skipped: [{ row: 4, reason: "Invalid amount" }], skippedTruncated: false });
    await screen.findByText(/File check: 2 valid, 1 skipped/);
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
    expect(screen.getByText("Row 4: Invalid amount")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Row 4: Invalid amount")).toBeVisible();
    confirmResponses = [() => ({ status: 201, data: { batchId: 3, title: "march", status: "Reviewed", totalRows: 3, imported: 2, skipped: [{ row: 4, reason: "Invalid amount" }], flagged: 0, largeExpenseFlagged: 0 } })];
    await user.click(importButton());
    await screen.findByText("Import complete");
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(1);
    expect(screen.getByText("Row 4: Invalid amount")).not.toBeVisible();
  });

  it("shows suspected duplicates before confirming instead of silently importing", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);
    await continueToReview(user, { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false, possibleDuplicateRows: 1, duplicateRows: [2] });
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
    await continueToReview(user, { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Invalid date" }], skippedTruncated: false });
    expect(importButton()).toBeDisabled();
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

  it("fails closed when the full-file check omits its validation result", async () => {
    const user = userEvent.setup();
    renderPage();
    await reachMappingScreen(user);

    await user.click(screen.getByRole("button", { name: "Continue to review" }));
    expect(await screen.findByText("FinSight could not validate this file. Check the mapping and try again.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Map and review columns" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Continue to review" }));
    expect(screen.getByRole("heading", { level: 1, name: "Map and review columns" })).toBeVisible();
    expect(posts.filter((post) => post.url.endsWith("/preview"))).toHaveLength(3);
    expect(posts.filter((post) => post.url.endsWith("/confirm"))).toHaveLength(0);
  });

  it("uses the mapped column's date convention after the full-file check", async () => {
    const user = userEvent.setup();
    previewExtra = {
      headers: ["date", "posted", "description", "amount", "category"],
      previewRows: [{ date: "13/04/2026", posted: "04/13/2026", description: "Rice sack", amount: "2400", category: "Inventory" }],
      detectedDateFormat: "dmy",
    };
    renderPage();
    await reachMappingScreen(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "Which CSV column holds the date?" }), "posted");

    previewExtra.detectedDateFormat = "mdy";
    previewExtra.validation = { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false };
    await user.click(screen.getByRole("button", { name: "Continue to review" }));

    await screen.findByRole("heading", { level: 1, name: "Review and import" });
    expect(screen.getAllByText("Preview ready")).toHaveLength(2);
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
  });

  it("applies historical category suggestions only after an explicit action and rechecks", async () => {
    const user = userEvent.setup();
    previewExtra = {
      headers: ["date", "description", "amount"],
      previewRows: [{ date: "03/04/2026", description: "Rice sack", amount: "2400" }],
    };
    renderPage();
    await reachMappingScreen(user);
    previewExtra.validation = { validRows: 0, invalidRows: 1, skipped: [{ row: 2, reason: "Missing category" }], skippedTruncated: false };
    previewExtra.categorySuggestions = [{ row: 2, categoryId: 1, categoryName: "Inventory", source: "history" }];
    await user.click(screen.getByRole("button", { name: "Continue to review" }));
    await screen.findByRole("button", { name: "Apply category suggestions" });
    const preflight = posts.filter((post) => post.url.endsWith("/preview")).at(-1)!;
    expect(preflight.fields.corrections).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Apply category suggestions" }));
    previewExtra.validation = { validRows: 1, invalidRows: 0, skipped: [], skippedTruncated: false };
    previewExtra.categorySuggestions = [];
    confirmResponses = [() => ({ status: 201, data: { batchId: 3, title: "march", status: "Reviewed", totalRows: 1, imported: 1, skipped: [], flagged: 0, largeExpenseFlagged: 0 } })];
    await user.click(importButton());
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
    await continueToReview(user);

    await user.click(importButton());
    await screen.findByText(/status code 500/);

    await user.click(importButton());
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
    await continueToReview(user);
    await user.click(importButton());
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
      const continueButton = screen.getByRole("button", { name: "Continue to review" });
      expect(continueButton).toBeDisabled();

      await user.click(screen.getByRole("radio", { name: /Month first/ }));
      expect(continueButton).toBeEnabled();

      await continueToReview(user);
      await user.click(importButton());
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
    await continueToReview(user);
    await user.click(importButton());

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
    await continueToReview(user);
    await user.click(importButton());
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

  it("does not claim records were saved when a worker fails before importing any rows", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 202, data: {
      batchId: 9, title: "march", status: "Pending Review", processingStatus: "PENDING",
      totalRows: 1000, imported: 0, skipped: [], flagged: 0,
    } })];
    statusResponses = [{
      batchId: 9, status: "Pending Review", processingStatus: "FAILED", totalRows: 1000,
      processedRows: 0, importedRows: 0, skippedRows: 0, flaggedRows: 0,
      failureStage: "validate", resultSummary: null,
    }];
    renderPage();
    await reachMappingScreen(user);
    await continueToReview(user);
    await user.click(importButton());

    await screen.findByText("Import stopped");
    expect(screen.getByText("No records were saved. Check the source file, then import it again.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Review saved records" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import another file" })).toBeVisible();
  });

  it("does not celebrate a terminal FAILED replay returned directly by confirm", async () => {
    const user = userEvent.setup();
    confirmResponses = [() => ({ status: 200, data: {
      batchId: 9, title: "march", status: "Pending Review", processingStatus: "FAILED", totalRows: 1000,
      imported: 380, skippedCount: 20, skipped: [], flagged: 0,
    } })];
    renderPage();
    await reachMappingScreen(user);
    await continueToReview(user);
    await user.click(importButton());
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
    await continueToReview(user);
    await user.click(importButton());
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
    await continueToReview(user);
    await user.click(importButton());

    await screen.findByText("Import complete");
    await waitFor(() =>
      expect(screen.getByText("This file was imported before.")).toBeInTheDocument(),
    );
  });
});
