// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginServerStateSession, endServerStateSession, invalidateServerState } from "../../lib/serverStateCache";
import type { RecurringSchedule } from "../../lib/types";
import { UpcomingExpenses } from "./UpcomingExpenses";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get } }));
vi.mock("../../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: { id: 1, name: "Burger stall" } }),
}));
vi.mock("../../context/ExpenseCategoryContext", () => ({
  useExpenseCategories: () => ({
    categories: [{ id: 3, name: "Rent" }],
    loading: false,
    loadingError: null,
    refresh: async () => {},
    createCategory: async () => ({ id: 4, name: "New" }),
    recentCategoryIds: [],
    rememberCategory: () => {},
  }),
}));

// jsdom has no <dialog> showModal()/close(); stubbed the way a browser behaves.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

function schedule(id: number, label: string, nextDueDate: string, dueState: RecurringSchedule["dueState"], isActive = true) {
  return {
    id, label, nextDueDate, dueState, isActive, expectedAmount: id * 1_000,
    categoryId: 3, vendor: null, intervalDays: 30, lastRecordedDate: null,
  } as RecurringSchedule;
}

function renderUpcoming() {
  return render(<MemoryRouter><UpcomingExpenses businessProfileId={1} /></MemoryRouter>);
}

beforeEach(() => {
  get.mockReset();
  beginServerStateSession("schedule-owner");
});
afterEach(endServerStateSession);

describe("dashboard upcoming expenses", () => {
  it("shows at most three active schedules in due order, with amounts, dates and names that open the schedule", async () => {
    get.mockResolvedValueOnce({ data: [
      schedule(5, "Paused rent", "2026-09-01", "OVERDUE", false),
      schedule(4, "Internet", "2026-10-01", "SCHEDULED"),
      schedule(3, "Water", "2026-09-20", "SCHEDULED"),
      schedule(2, "Electricity", "2026-09-18", "DUE_SOON"),
      schedule(1, "Rent", "2026-09-15", "OVERDUE"),
    ] });
    renderUpcoming();

    await screen.findByRole("button", { name: "Rent" });

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("RentPHP 1,000Past due date"),
      expect.stringContaining("ElectricityPHP 2,000Due soon"),
      expect.stringContaining("WaterPHP 3,000Scheduled"),
    ]);
    expect(screen.getByRole("link", { name: "Manage schedules" })).toHaveAttribute("href", "/insights/expense-behavior#expense-recurring");
    expect(screen.getByText(/Sep 15/)).toBeInTheDocument();
    expect(screen.getByText("No matching expense recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText("Paused rent")).not.toBeInTheDocument();
    expect(screen.queryByText("Internet")).not.toBeInTheDocument();
  });

  it("opens a schedule in a popup instead of leaving the dashboard", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [schedule(1, "Rent", "2026-09-15", "OVERDUE")] });
    renderUpcoming();
    await user.click(await screen.findByRole("button", { name: "Rent" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit recurring payment" });
    expect(within(dialog).getByLabelText(/Payment name/)).toHaveValue("Rent");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit recurring payment" })).not.toBeInTheDocument(),
    );
  });

  it("explains disabled scheduling without offering a broken management link or pretending the list is empty", async () => {
    get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    renderUpcoming();

    expect(await screen.findByText("Recurring expense schedules aren’t available for this business.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Manage schedules" })).not.toBeInTheDocument();
    expect(screen.queryByText("No active recurring expenses")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload upcoming expenses" })).not.toBeInTheDocument();
  });

  it("offers a retry after a temporary failure and an add action only after an empty result succeeds", async () => {
    const user = userEvent.setup();
    get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: [] });
    renderUpcoming();

    expect(await screen.findByText("Upcoming expenses couldn’t load.")).toBeVisible();
    expect(screen.queryByText("No active recurring expenses")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload upcoming expenses" }));

    expect(await screen.findByText("No active recurring expenses")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add a schedule" }));
    expect(await screen.findByRole("dialog", { name: "Add a recurring payment" })).toBeInTheDocument();
  });

  it("labels retained schedules as previously loaded when their refresh fails", async () => {
    get.mockResolvedValueOnce({ data: [schedule(1, "Rent", "2026-09-15", "OVERDUE")] })
      .mockRejectedValueOnce(new Error("offline"));
    renderUpcoming();
    await screen.findByRole("button", { name: "Rent" });

    act(() => invalidateServerState({ businessProfileId: 1, tags: ["recurring-schedules"] }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Upcoming expenses couldn’t refresh. Showing previously loaded figures."));
    expect(screen.getByRole("button", { name: "Rent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload upcoming expenses" })).toBeVisible();
  });
});
