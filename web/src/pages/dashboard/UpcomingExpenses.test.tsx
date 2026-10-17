// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginServerStateSession, endServerStateSession, invalidateServerState } from "../../lib/serverStateCache";
import type { RecurringSchedule } from "../../lib/types";
import { UpcomingExpenses } from "./UpcomingExpenses";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: { get } }));

function schedule(id: number, label: string, nextDueDate: string, dueState: RecurringSchedule["dueState"], isActive = true) {
  return { id, label, nextDueDate, dueState, isActive, expectedAmount: id * 1_000 } as RecurringSchedule;
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
  it("shows at most three active schedules in due order, with amounts, dates and usable edit links", async () => {
    get.mockResolvedValueOnce({ data: [
      schedule(5, "Paused rent", "2026-09-01", "OVERDUE", false),
      schedule(4, "Internet", "2026-10-01", "SCHEDULED"),
      schedule(3, "Water", "2026-09-20", "SCHEDULED"),
      schedule(2, "Electricity", "2026-09-18", "DUE_SOON"),
      schedule(1, "Rent", "2026-09-15", "OVERDUE"),
    ] });
    renderUpcoming();

    await screen.findByRole("link", { name: "Rent" });

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("RentPHP 1,000Past due date"),
      expect.stringContaining("ElectricityPHP 2,000Due soon"),
      expect.stringContaining("WaterPHP 3,000Scheduled"),
    ]);
    expect(screen.getByRole("link", { name: "Rent" })).toHaveAttribute("href", "/insights/recurring-schedules/1/edit");
    expect(screen.getByRole("link", { name: "Manage schedules" })).toHaveAttribute("href", "/insights/expense-behavior#expense-recurring");
    expect(screen.getByText(/Sep 15/)).toBeInTheDocument();
    expect(screen.getByText("No matching expense recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText("Paused rent")).not.toBeInTheDocument();
    expect(screen.queryByText("Internet")).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Add a schedule" })).toHaveAttribute("href", "/insights/recurring-schedules/new");
  });

  it("labels retained schedules as previously loaded when their refresh fails", async () => {
    get.mockResolvedValueOnce({ data: [schedule(1, "Rent", "2026-09-15", "OVERDUE")] })
      .mockRejectedValueOnce(new Error("offline"));
    renderUpcoming();
    await screen.findByRole("link", { name: "Rent" });

    act(() => invalidateServerState({ businessProfileId: 1, tags: ["recurring-schedules"] }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Upcoming expenses couldn’t refresh. Showing previously loaded figures."));
    expect(screen.getByRole("link", { name: "Rent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload upcoming expenses" })).toBeVisible();
  });
});
