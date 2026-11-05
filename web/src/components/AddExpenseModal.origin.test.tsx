// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddExpenseModal } from "./AddExpenseModal";

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
}

/** The edit popup has no room for a record's source, so it links to the page that shows it. */

vi.mock("../lib/api", () => ({ api: { get: async () => ({ data: {
  id: 9, type: "expense", businessProfileId: 1, date: "2026-10-13T00:00:00.000Z", categoryId: 2,
  description: "Paper takeaway bags", vendor: null, amount: 240, source: "CSV_IMPORT",
  origin: { kind: "csv_import", batchId: 3, title: "October expenses", uploadDate: "2026-10-14T02:00:00.000Z",
    fileReference: "x.csv", fileUrl: null, status: "COMPLETED", rowCount: 150 },
} }) } }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ profile: { id: 17 } }) }));
vi.mock("../lib/useManualRecordCreate", () => ({ useManualRecordCreate: () => ({
  loading: false, busy: false, frozen: false, pending: null, error: null, ownerId: 17,
}) }));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: { id: 1, timezone: "Asia/Manila" } }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({
  categories: [{ id: 2, name: "Packaging" }], loading: false, recentCategoryIds: [], rememberCategory: vi.fn(),
}) }));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));

describe("edit expense popup", () => {
  it("links a CSV-imported record to its file rows", async () => {
    render(<AddExpenseModal businessProfileId={1} recordId={9} open onClose={vi.fn()} onSaved={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "See the file rows" });
    expect(link).toHaveAttribute("href", "/records/expenses/9/edit");
    expect(screen.getByText(/From a CSV import, October expenses/)).toBeInTheDocument();
  });
});
