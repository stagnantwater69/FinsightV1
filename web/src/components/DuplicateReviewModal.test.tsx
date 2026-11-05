// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { DuplicateReviewModal } from "./DuplicateReviewModal";
import type { RecordItem } from "../lib/types";

const copy = {
  id: 2, type: "sales", businessProfileId: 1, date: "2026-11-04T00:00:00.000Z", description: "Daily sales",
  amount: 10, source: "MANUAL_ENTRY", duplicateStatus: "Flagged", reviewStatus: "Reviewed",
  duplicateOfRecordId: 1, createdAt: "2026-11-04T07:12:00.000Z",
} as unknown as RecordItem;
const original = { ...copy, id: 1, duplicateStatus: "Not Checked", duplicateOfRecordId: null, createdAt: "2026-11-04T07:10:00.000Z" };

vi.mock("../lib/api", () => ({
  api: { get: async (url: string) => ({ data: url.endsWith("/2") ? copy : original }), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("./Toast", () => ({ useToast: () => () => {} }));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => async () => false }));

// jsdom has no <dialog> showModal()/close(); Modal only needs the open attribute.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

describe("the duplicate compare window", () => {
  it("lines the two records up and says how far apart they were added", async () => {
    render(<DuplicateReviewModal recordId={2} recordType="sales" open onClose={() => {}} onResolved={() => {}} />);

    const table = await screen.findByRole("table", { name: /compared with the record it matches/ });
    expect(within(table).getByRole("columnheader", { name: "Earlier record" })).toBeInTheDocument();
    expect(within(table).getAllByText("+PHP 10.00")).toHaveLength(2);
    expect(screen.getByText("Added 2 minutes apart.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep both" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete this copy" })).toBeInTheDocument();
  });
});
