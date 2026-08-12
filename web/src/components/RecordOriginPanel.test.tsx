// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordOriginPanel } from "./RecordOriginPanel";
import type { RecordOrigin } from "../lib/types";

/**
 * The first test in this repo that renders a component.
 *
 * Everything about this panel had only ever been checked by hand — building a
 * throwaway page, screenshotting it in headless Chrome, and reading the
 * result. That works, but it is not repeatable and it does not run in CI, so
 * nothing stops a later change from silently undoing it.
 *
 * The tab strip is the right first subject: it holds real state, its whole
 * point is that only ONE view is on screen at a time, and it was added
 * precisely because a receipt photo and an item table stacked together buried
 * each other. That is a behavioural claim, which is exactly the kind a
 * typecheck cannot make.
 *
 * Queried by ROLE and accessible name throughout rather than by class or test
 * id: `getByRole("tab", { selected: true })` fails if the selected state is
 * only visual, which is the bug worth catching. A class-name assertion would
 * pass on markup no screen reader could interpret.
 */

const csvOrigin: RecordOrigin = {
  kind: "csv_import",
  batchId: 42,
  title: "finsight_sample_expenses",
  uploadDate: "2026-08-03T00:00:00.000Z",
  fileReference: "4/9f2e-expenses.csv",
  fileUrl: "https://example.test/signed.csv",
  status: "Completed",
  rowCount: 50,
};

// Narrowed to the receipt_scan member rather than typed as the whole union:
// against the union, TypeScript resolves the literal to the FIRST member it
// can and then reports every receipt-only field as unknown. `Extract` says
// which member this is, so the fields are checked against the right one.
const receiptOrigin: Extract<RecordOrigin, { kind: "receipt_scan" }> = {
  kind: "receipt_scan",
  scanId: 1,
  scannedAt: "2026-07-28T00:00:00.000Z",
  extractedVendor: "AROMA CAFE",
  imageUrl: "https://example.test/receipt.jpg",
  itemsSubtotal: 8.17,
  items: [
    {
      id: 1,
      lineNumber: 1,
      name: "Americano",
      quantity: 1,
      unitPrice: 3.19,
      amount: 3.19,
      categoryId: 1,
      categoryName: "Inventory",
      addedByOwner: false,
    },
    {
      id: 2,
      lineNumber: 2,
      name: "Almond Scone",
      quantity: 1,
      unitPrice: 1.99,
      amount: 1.99,
      categoryId: 1,
      categoryName: "Inventory",
      addedByOwner: false,
    },
  ],
  siblings: [],
};

describe("RecordOriginPanel — CSV import", () => {
  it("opens on the details, not the file rows", () => {
    render(<RecordOriginPanel origin={csvOrigin} recordAmount={1200} />);

    expect(screen.getByRole("tab", { name: /import details/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /file rows/i })).toHaveAttribute("aria-selected", "false");
    // The import's own facts are what's visible first.
    expect(screen.getByText("finsight_sample_expenses")).toBeVisible();
  });

  it("offers the download as a link, so it can be opened in a new tab", () => {
    render(<RecordOriginPanel origin={csvOrigin} recordAmount={1200} />);

    const link = screen.getByRole("link", { name: /download the file/i });
    expect(link).toHaveAttribute("href", "https://example.test/signed.csv");
  });

  it("says the file is unavailable rather than offering a dead link", () => {
    // sourceCleanup deletes the file once the last record from it goes, and a
    // signed URL can simply fail to mint. A link that downloads an XML error
    // page would be worse than an honest sentence.
    render(<RecordOriginPanel origin={{ ...csvOrigin, fileUrl: null }} recordAmount={1200} />);

    expect(screen.queryByRole("link", { name: /download the file/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no longer available/i)).toBeVisible();
  });

  it("switches to the file rows when that tab is chosen", async () => {
    // The rows are fetched on demand; this asserts the switch itself, so the
    // request is stubbed rather than exercised.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const user = userEvent.setup();
    render(<RecordOriginPanel origin={csvOrigin} recordAmount={1200} />);

    await user.click(screen.getByRole("tab", { name: /file rows/i }));

    expect(screen.getByRole("tab", { name: /file rows/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /import details/i })).toHaveAttribute("aria-selected", "false");
    vi.unstubAllGlobals();
  });
});

describe("RecordOriginPanel — scanned receipt", () => {
  it("opens on the items, because they explain the record's own figure", () => {
    render(<RecordOriginPanel origin={receiptOrigin} recordAmount={8.17} />);

    expect(screen.getByRole("tab", { name: /items/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Americano")).toBeVisible();
    // The photo is the OTHER view — not stacked underneath, which is the
    // entire reason the tab strip exists.
    expect(screen.queryByRole("img", { name: /scanned receipt/i })).not.toBeInTheDocument();
  });

  it("shows the photo only once its tab is chosen, and bounds its height", async () => {
    const user = userEvent.setup();
    render(<RecordOriginPanel origin={receiptOrigin} recordAmount={8.17} />);

    await user.click(screen.getByRole("tab", { name: /receipt photo/i }));

    const photo = screen.getByRole("img", { name: /scanned receipt/i });
    expect(photo).toBeVisible();
    /*
     * The height cap is the fix for a real defect: the image was `w-full`
     * with no height limit, so a till receipt — tall and narrow — rendered
     * thousands of pixels long and pushed the edit form off the page.
     * Asserted because losing it would reintroduce exactly that.
     */
    expect(photo.className).toMatch(/max-h-/);
    // Items are the other view now, not both at once.
    expect(screen.queryByText("Americano")).not.toBeInTheDocument();
  });

  it("offers no photo tab when the image link could not be minted", () => {
    render(<RecordOriginPanel origin={{ ...receiptOrigin, imageUrl: null }} recordAmount={8.17} />);

    // A lone tab pretending to be a choice is worse than no strip at all.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("Americano")).toBeVisible();
  });
});
