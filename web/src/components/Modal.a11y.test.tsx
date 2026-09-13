// @vitest-environment jsdom
import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddExpenseModal } from "./AddExpenseModal";
import { AddSalesModal } from "./AddSalesModal";

/**
 * WEB-F01. Records mounts its own Add expense / Add sales popups and AppShell
 * mounts Quick Add's copies of the same two, all at once, all always in the
 * DOM (a native <dialog> is rendered closed, not unmounted). With a fixed
 * `modal-title` id on every heading and fixed `modal-sales-*` ids on every
 * field, `aria-labelledby` resolved to the FIRST heading in the document —
 * so the open sales popup announced itself as "Add expense" — and each
 * label's htmlFor pointed at whichever hidden control came first, leaving the
 * visible money-entry controls with no accessible name at all.
 *
 * This test mounts the same composition and asks the accessibility tree the
 * questions a screen reader would.
 */

vi.mock("../lib/api", () => ({
  api: { get: async () => ({ data: {} }), post: async () => ({ data: {} }), patch: async () => ({ data: {} }) },
}));
vi.mock("../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({
    categories: [{ id: 2, name: "Supplies" }],
    loading: false,
    createCategory: vi.fn(),
    recentCategoryIds: [],
    rememberCategory: vi.fn(),
  }),
}));
vi.mock("./Toast", () => ({ useToast: () => vi.fn() }));

// jsdom does not implement <dialog>'s showModal()/close() (see Modal.tsx);
// toggling the `open` attribute is all Modal.tsx's own effect relies on.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

const noop = () => {};

/** Records' two popups plus Quick Add's two, in document order, one open. */
function renderComposition(open: "records-sales" | "quick-sales" | "quick-expense") {
  return render(
    <>
      <AddExpenseModal businessProfileId={10} open={false} onClose={noop} onSaved={noop} />
      <AddSalesModal businessProfileId={10} open={open === "records-sales"} onClose={noop} onSaved={noop} />
      <AddExpenseModal businessProfileId={10} open={open === "quick-expense"} onClose={noop} onSaved={noop} />
      <AddSalesModal businessProfileId={10} open={open === "quick-sales"} onClose={noop} onSaved={noop} />
    </>,
  );
}

function openDialog() {
  const dialogs = document.querySelectorAll("dialog[open]");
  expect(dialogs).toHaveLength(1);
  return dialogs[0] as HTMLDialogElement;
}

describe("several Modals mounted at once", () => {
  it("names the open sales dialog by ITS heading, not the first heading in the document", () => {
    renderComposition("quick-sales");
    const dialog = openDialog();
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent("Add sales reference");
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent("Add sales reference");
  });

  it("gives every money-entry control in the open dialog an accessible name", () => {
    renderComposition("quick-sales");
    const dialog = openDialog();
    // Each label's htmlFor must resolve to a control INSIDE this dialog.
    for (const label of Array.from(dialog.querySelectorAll("label[for]"))) {
      const control = document.getElementById(label.getAttribute("for")!);
      expect(control, `label "${label.textContent}" points at a control`).not.toBeNull();
      expect(dialog.contains(control), `label "${label.textContent}" points inside its own dialog`).toBe(true);
    }
    expect(within(dialog).getByLabelText(/^date/i)).toBeInstanceOf(HTMLInputElement);
    expect(within(dialog).getByLabelText(/^description/i)).toBeInstanceOf(HTMLInputElement);
    expect(within(dialog).getByLabelText(/^amount/i)).toBeInstanceOf(HTMLInputElement);
  });

  it("does the same for the expense form, including its category select", () => {
    renderComposition("quick-expense");
    const dialog = openDialog();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)).toHaveTextContent("Add expense");
    expect(within(dialog).getByLabelText(/^category/i)).toBeInstanceOf(HTMLSelectElement);
    expect(within(dialog).getByLabelText(/^vendor/i)).toBeInstanceOf(HTMLInputElement);
    expect(within(dialog).getByLabelText(/^amount/i)).toBeInstanceOf(HTMLInputElement);
  });

  it("renders no duplicate element ids across the whole composition", () => {
    renderComposition("records-sales");
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });
});
