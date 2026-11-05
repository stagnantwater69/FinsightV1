// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useAddRecordPopups } from "./useAddRecordPopups";

let selected: { id: number } | null = { id: 1 };
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected }) }));
let expenseMounts = 0;
vi.mock("./AddExpenseModal", async () => {
  const { useEffect } = await import("react");
  return {
    AddExpenseModal: ({ open, recordId, onSaved, onClose }: { open: boolean; recordId?: number; onSaved: () => void; onClose: () => void }) => {
      useEffect(() => { expenseMounts += 1; }, []);
      return open ? (
        <div role="dialog" aria-label="Add expense">
          expense popup {recordId ?? "new"}
          <button type="button" onClick={() => { onSaved(); onClose(); }}>Save</button>
        </div>
      ) : null;
    },
  };
});
vi.mock("./AddSalesModal", () => ({
  AddSalesModal: ({ open, recordId }: { open: boolean; recordId?: number }) =>
    open ? <div role="dialog" aria-label="Add sales">sales popup {recordId ?? "new"}</div> : null,
}));

function Page({ onSaved }: { onSaved: () => void }) {
  const add = useAddRecordPopups(onSaved);
  return (
    <>
      <button type="button" onClick={add.openExpense}>Add expense</button>
      <button type="button" onClick={add.openSales}>Add sale</button>
      {add.popups}
    </>
  );
}

function renderPage(onSaved = () => {}) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="/dashboard" element={<Page onSaved={onSaved} />} />
        <Route path="/records/expenses/new" element={<h1>Expense page</h1>} />
        <Route path="/records/sales/new" element={<h1>Sales page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { selected = { id: 1 }; expenseMounts = 0; });

function Harness() {
  const popups = useAddRecordPopups();
  return (
    <>
      <button onClick={() => popups.openEdit("sales", 7)}>edit sale</button>
      <button onClick={popups.openSales}>add sale</button>
      {popups.popups}
    </>
  );
}

describe("useAddRecordPopups", () => {
  it("opens a saved record for editing, then a fresh form for adding", () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);

    fireEvent.click(screen.getByText("edit sale"));
    expect(screen.getByText("sales popup 7")).toBeInTheDocument();

    // Adding after an edit must not reopen the old record.
    fireEvent.click(screen.getByText("add sale"));
    expect(screen.getByText("sales popup new")).toBeInTheDocument();
  });

  it("opens one popup at a time in place, and closes it after a save", () => {
    const onSaved = vi.fn();
    renderPage(onSaved);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add sale" }));
    expect(screen.getByRole("dialog", { name: "Add sales" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Stays mounted once used, so closing can fade out and reopening is instant.
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    expect(screen.getByRole("dialog", { name: "Add expense" })).toBeInTheDocument();
    expect(expenseMounts).toBe(1);
  });

  it("mounts no form until the owner opens one", () => {
    renderPage();
    expect(expenseMounts).toBe(0);
  });

  it("goes to the full-page form when no business is selected", () => {
    selected = null;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add sale" }));
    expect(screen.getByRole("heading", { name: "Sales page" })).toBeInTheDocument();
  });
});
