// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAddRecordPopups } from "./useAddRecordPopups";

let selected: { id: number } | null = null;
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected }) }));
vi.mock("./AddExpenseModal", () => ({
  AddExpenseModal: ({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Add expense">
      <button type="button" onClick={() => { onSaved(); onClose(); }}>Save</button>
    </div>
  ),
}));
vi.mock("./AddSalesModal", () => ({ AddSalesModal: () => <div role="dialog" aria-label="Add sales" /> }));

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

describe("add-record popups on any page", () => {
  beforeEach(() => { selected = null; });

  it("opens one popup at a time in place, and closes it after a save", () => {
    selected = { id: 10 };
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
  });

  it("goes to the full-page form when no business is selected", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add sale" }));
    expect(screen.getByRole("heading", { name: "Sales page" })).toBeInTheDocument();
  });
});
