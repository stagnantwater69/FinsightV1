// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError } from "axios";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddExpense } from "./AddExpense";
import { AddSalesRecord } from "./AddSalesRecord";
import { EditExpense } from "./EditExpense";
import { AddExpenseModal } from "../components/AddExpenseModal";
import { FUTURE_DATE_MESSAGE, todayIso } from "../lib/dates";

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

/**
 * Expense and sales forms refuse a date after the business's today: the picker
 * stops at today, a typed date is checked as it changes, the save button stays
 * disabled while it is wrong, and a refusal from the server lands on the field.
 */

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  selected: { id: 1, timezone: "Asia/Manila" } as { id: number; timezone?: string },
}));
vi.mock("../lib/api", () => ({ api: { post: mocks.post, get: mocks.get, patch: mocks.patch } }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ profile: { id: 17 } }) }));
vi.mock("../lib/useManualRecordCreate", () => ({ useManualRecordCreate: () => ({
  loading: false, busy: false, frozen: false, pending: null, error: null, ownerId: 17,
  save: async (payload: Record<string, unknown>) => (await mocks.post(payload.categoryId ? "/records/expenses" : "/records/sales", payload)).data,
}) }));
vi.mock("../context/BusinessProfileContext", () => ({ useBusinessProfiles: () => ({ selected: mocks.selected }) }));
vi.mock("../context/ExpenseCategoryContext", () => ({ useExpenseCategories: () => ({
  categories: [{ id: 2, name: "Supplies" }], loading: false, recentCategoryIds: [], rememberCategory: vi.fn(),
}) }));
vi.mock("../components/Toast", () => ({ useToast: () => vi.fn() }));

function shiftDay(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const today = () => todayIso("Asia/Manila");
const tomorrow = () => shiftDay(today(), 1);
const yesterday = () => shiftDay(today(), -1);

function futureDateRefusal() {
  return new AxiosError("Bad Request", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 400,
    data: { error: FUTURE_DATE_MESSAGE, code: "FUTURE_DATE", field: "date" },
  } as never);
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.selected = { id: 1, timezone: "Asia/Manila" };
  mocks.post.mockResolvedValue({ data: { id: 9 } });
  mocks.get.mockResolvedValue({ data: { items: [{}, {}], nextCursor: null } });
});

async function fillExpense(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText(/^Category/), "2");
  await user.type(screen.getByLabelText(/^Description/), "Rice");
  await user.type(screen.getByLabelText(/^Amount/), "100");
}

describe("Add expense date", () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={["/records/expenses/new"]}>
        <Routes>
          <Route path="/records/expenses/new" element={<AddExpense />} />
          <Route path="/records" element={<p>Records list</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("starts at the business's today and stops the picker there", () => {
    renderPage();
    const date = screen.getByLabelText(/^Date/);
    expect(date).toHaveValue(today());
    expect(date).toHaveAttribute("max", today());
  });

  it("accepts yesterday and today", async () => {
    const user = userEvent.setup();
    renderPage();
    await fillExpense(user);
    for (const value of [yesterday(), today()]) {
      fireEvent.change(screen.getByLabelText(/^Date/), { target: { value } });
      expect(screen.queryByText(FUTURE_DATE_MESSAGE)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save expense/ })).toBeEnabled();
    }
    await user.click(screen.getByRole("button", { name: /Save expense/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/records/expenses", expect.objectContaining({ date: today() })));
  });

  it("refuses a typed tomorrow: inline error tied to the field, save disabled, nothing sent", async () => {
    const user = userEvent.setup();
    renderPage();
    await fillExpense(user);
    const date = screen.getByLabelText(/^Date/);
    fireEvent.change(date, { target: { value: tomorrow() } });

    const message = screen.getByText(FUTURE_DATE_MESSAGE);
    expect(message.closest("[role=alert]")).not.toBeNull();
    expect(date).toHaveAttribute("aria-invalid", "true");
    expect(date.getAttribute("aria-describedby")).toBe(message.closest("[role=alert]")!.id);
    expect(screen.getByRole("button", { name: /Save expense/ })).toBeDisabled();

    // Enter in another field cannot submit around the disabled button.
    fireEvent.submit(date.closest("form")!);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(date).toHaveFocus();
  });

  it("puts the server's refusal on the date field", async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValueOnce(futureDateRefusal());
    renderPage();
    await fillExpense(user);
    await user.click(screen.getByRole("button", { name: /Save expense/ }));
    expect(await screen.findByText(FUTURE_DATE_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^Date/)).toHaveFocus());
    // Changing the date clears it.
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: yesterday() } });
    expect(screen.queryByText(FUTURE_DATE_MESSAGE)).not.toBeInTheDocument();
  });
});

describe("Add sales date", () => {
  it("refuses tomorrow and saves today", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddSalesRecord />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/^Amount/), "500");
    const date = screen.getByLabelText(/^Date/);
    expect(date).toHaveAttribute("max", today());
    fireEvent.change(date, { target: { value: tomorrow() } });
    expect(screen.getByText(FUTURE_DATE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();

    fireEvent.change(date, { target: { value: today() } });
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/records/sales", expect.objectContaining({ date: today() })));
  });
});

describe("Quick add expense date", () => {
  it("shows the error as soon as a future date is entered and keeps Save disabled", async () => {
    const user = userEvent.setup();
    render(<AddExpenseModal businessProfileId={1} open onClose={vi.fn()} onSaved={vi.fn()} />);
    await fillExpense(user);
    const date = screen.getByLabelText(/^Date/);
    expect(date).toHaveAttribute("max", today());
    fireEvent.change(date, { target: { value: tomorrow() } });
    expect(screen.getByText(FUTURE_DATE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save expense" })).toBeDisabled();

    fireEvent.change(date, { target: { value: yesterday() } });
    await user.click(screen.getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/records/expenses", expect.objectContaining({ date: yesterday() })));
  });
});

describe("Edit expense date", () => {
  it("flags a record that is already future-dated until its date is corrected", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({
      data: { id: 7, date: `${tomorrow()}T00:00:00.000Z`, description: "Tablet", vendor: null, amount: 5000, categoryId: 2, origin: null },
    });
    mocks.patch.mockResolvedValue({ data: null });
    render(
      <MemoryRouter initialEntries={["/records/expenses/7/edit"]}>
        <Routes>
          <Route path="/records/expenses/:id/edit" element={<EditExpense />} />
          <Route path="/records" element={<p>Records list</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(FUTURE_DATE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: today() } });
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith(
      "/records/expenses/7",
      expect.objectContaining({ date: today() }),
      { serverStateScope: { businessProfileId: 1 } },
    ));
    expect(await screen.findByText("Records list")).toBeInTheDocument();
  });
});
