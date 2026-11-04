// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { PaymentCalendarPage } from "./PaymentCalendar";
import type { BusinessProfile, RecurringPattern, RecurringSchedule } from "../lib/types";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";

const profile = { id: 1, name: "Burger stall" } as unknown as BusinessProfile;

let schedulesResponse: RecurringSchedule[] | "404";
let patternsResponse: RecurringPattern[];
const posts: string[] = [];
const patches: { url: string; body: unknown }[] = [];

vi.mock("../lib/api", async () => {
  const { AxiosError } = await import("axios");
  return {
    api: {
      get: async (url: string) => {
        if (url === "/insights/recurring-schedules") {
          if (schedulesResponse === "404") {
            throw new AxiosError("Not found", "ERR_BAD_REQUEST", undefined, undefined, {
              status: 404,
            } as never);
          }
          return { data: schedulesResponse };
        }
        if (url === "/insights/recurring-patterns") return { data: patternsResponse };
        if (url === "/business-profiles/1/operating-schedule") {
          // Closed on Sundays.
          return { data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, isOpen: weekday !== 7 })) };
        }
        if (url === "/business-profiles/1/operating-overrides") return { data: { items: [], nextCursor: null } };
        throw new Error(`unmocked GET ${url}`);
      },
      post: async (url: string) => {
        posts.push(url);
        return { data: {} };
      },
      patch: async (url: string, body: unknown) => {
        patches.push({ url, body });
        return { data: {} };
      },
    },
  };
});

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

vi.mock("../context/ExpenseCategoryContext", () => ({
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

// The real popup needs the auth and recovery providers; the calendar only
// owns what it passes in and what it does after a save.
let onExpenseSave: () => void = () => {};
vi.mock("../components/AddExpenseModal", () => ({
  AddExpenseModal: (props: {
    open: boolean;
    title?: string;
    duplicateFrom?: unknown;
    onSaved: () => void;
    onClose: () => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        <pre data-testid="expense-seed">{JSON.stringify(props.duplicateFrom)}</pre>
        <button
          type="button"
          onClick={() => {
            onExpenseSave();
            props.onSaved();
            props.onClose();
          }}
        >
          Save expense
        </button>
      </div>
    ) : null,
}));

const confirms: string[] = [];
let confirmAnswer = true;
vi.mock("../components/ConfirmDialog", () => ({
  useConfirm: () => async ({ title }: { title: string }) => {
    confirms.push(title);
    return confirmAnswer;
  },
}));
vi.mock("../components/Toast", () => ({ useToast: () => () => {} }));

// jsdom does not implement <dialog>'s showModal()/close() (see Modal.tsx);
// stubbed the way a browser behaves, which is all Modal.tsx relies on.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

function schedule(over: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 1,
    businessProfileId: 1,
    categoryId: 3,
    categoryName: "Rent",
    label: "Stall rent",
    vendor: null,
    intervalDays: 30,
    expectedAmount: 4500,
    amountTolerance: 0.15,
    nextDueDate: "2026-11-10T00:00:00.000Z",
    lastRecordedDate: null,
    isActive: true,
    sourcePatternId: null,
    dueState: "SCHEDULED",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function pattern(over: Partial<RecurringPattern> = {}): RecurringPattern {
  return {
    id: 9,
    description: "LPG refill",
    vendor: null,
    intervalDays: 31,
    expectedAmount: 950,
    confidence: 0.8,
    nextExpectedDate: "2026-11-12T00:00:00.000Z",
    status: "CANDIDATE",
    category: { name: "Equipment" },
    ...over,
  } as RecurringPattern;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/calendar"]}>
      <PaymentCalendarPage />
    </MemoryRouter>,
  );
}

function day(key: string) {
  return screen.getByRole("button", { name: new RegExp(`^${key},`) });
}

beforeEach(() => {
  // Pinned to a known month so the grid and its dates are stable.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T09:00:00"));
  beginServerStateSession("payment-calendar-test");
  posts.length = 0;
  patches.length = 0;
  onExpenseSave = () => {};
  confirms.length = 0;
  confirmAnswer = true;
  schedulesResponse = [schedule()];
  patternsResponse = [pattern()];
});

afterEach(() => {
  endServerStateSession();
  vi.useRealTimers();
});

describe("Payment calendar", () => {
  it("places watched and suggested payments on their days, and marks closed days", async () => {
    renderPage();
    expect(await screen.findByText("November 2026")).toBeInTheDocument();
    await waitFor(() => expect(day("2026-11-10")).toHaveAccessibleName("2026-11-10, 1 payment"));
    expect(day("2026-11-12")).toHaveAccessibleName("2026-11-12, 1 payment");
    await waitFor(() => expect(day("2026-11-01")).toHaveAccessibleName("2026-11-01, closed, nothing due"));
  });

  it("shows a day's details, and lets the owner check a suggestion right there", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-12,/ }));
    const dayDialog = screen.getByRole("dialog", { name: /November 12/ });
    expect(within(dayDialog).getByText("Suggested by FinSight")).toBeInTheDocument();
    await user.click(within(dayDialog).getByRole("button", { name: /Watch this\s*— LPG refill/ }));
    await waitFor(() => expect(posts).toEqual(["/insights/recurring-patterns/9/confirm"]));
  });

  it("dismisses a suggestion and takes it off the calendar", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-12,/ }));
    await user.click(screen.getByRole("button", { name: /Not recurring\s*— LPG refill/ }));
    await waitFor(() => expect(day("2026-11-12")).toHaveAccessibleName("2026-11-12, nothing due"));
    expect(patches[0]).toEqual({ url: "/insights/recurring-patterns/9", body: { status: "DISMISSED" } });
  });

  it("labels a watched payment's later dates as expected and edits it in a popup", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [schedule({ intervalDays: 7 })];
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-17,/ }));
    expect(screen.getByText("Expected", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Edit schedule/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Edit schedule\s*Stall rent/ }));
    const dialog = await screen.findByRole("dialog", { name: "Edit recurring payment" });
    // The edit form replaces the day popup rather than stacking on it.
    expect(screen.queryByRole("dialog", { name: /November 17/ })).not.toBeInTheDocument();
    const label = within(dialog).getByLabelText(/Payment name/);
    expect(label).toHaveValue("Stall rent");
    // A 7-day schedule opens on the Weekly preset, with no custom input.
    expect(within(dialog).getByRole("button", { name: "Weekly" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByLabelText("Every")).not.toBeInTheDocument();
    await user.clear(label);
    await user.type(label, "Stall rent (new)");
    await user.click(within(dialog).getByRole("button", { name: "Monthly" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patches[0]?.url).toBe("/insights/recurring-schedules/1"));
    expect(patches[0]?.body).toMatchObject({ label: "Stall rent (new)", intervalDays: 30 });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit recurring payment" })).not.toBeInTheDocument(),
    );
  });

  it("adds a payment from the toolbar in a popup", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a recurring payment" });
    expect(within(dialog).getByLabelText(/Payment name/)).toHaveValue("");
    expect(within(dialog).queryByRole("button", { name: "Delete schedule" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add payment" })).toBeInTheDocument();
    // Custom reveals a day count; a preset hides it again.
    await user.click(within(dialog).getByRole("button", { name: "Custom" }));
    expect(within(dialog).getByLabelText("Every")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Quarterly" }));
    expect(within(dialog).queryByLabelText("Every")).not.toBeInTheDocument();
  });

  it("counts the month's payments and marks an overdue one on its day, with no overdue list", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [schedule({ nextDueDate: "2026-11-03T00:00:00.000Z", dueState: "OVERDUE" })];
    renderPage();
    const overdueStat = (await screen.findByText("Overdue", { selector: "dt" })).parentElement!;
    expect(overdueStat).toHaveTextContent("1");
    expect(screen.queryByText(/watched payments? (is|are) overdue/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^2026-11-03,/ }));
    expect(screen.getByText("Overdue", { selector: "span" })).toBeInTheDocument();
  });

  it("records a payment from the day, pre-filled from the schedule", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [schedule({ vendor: "Market office", dueState: "OVERDUE" })];
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-10,/ }));
    await user.click(screen.getByRole("button", { name: /Record payment\s*for Stall rent/ }));

    const dialog = await screen.findByRole("dialog", { name: "Record payment" });
    // The same words as the schedule, so the detector matches the expense.
    expect(JSON.parse(within(dialog).getByTestId("expense-seed").textContent!)).toEqual({
      description: "Stall rent",
      vendor: "Market office",
      categoryId: 3,
      amount: 4500,
    });
    expect(screen.queryByRole("dialog", { name: /November 10/ })).not.toBeInTheDocument();

    // Saved, but the server has not matched it yet: back on the day, it says so.
    await user.click(within(dialog).getByRole("button", { name: "Save expense" }));
    const dayDialog = await screen.findByRole("dialog", { name: /November 10/ });
    expect(within(dayDialog).getByRole("status")).toHaveTextContent("Payment recorded. Updating…");
    expect(within(dayDialog).queryByRole("button", { name: /Record payment/ })).not.toBeInTheDocument();
  });

  it("clears the day once the server has matched the payment", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-10,/ }));
    await user.click(screen.getByRole("button", { name: /Record payment/ }));
    onExpenseSave = () => {
      schedulesResponse = [schedule({ nextDueDate: "2026-12-10T00:00:00.000Z" })];
    };
    await user.click(await screen.findByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(day("2026-11-10")).toHaveAccessibleName("2026-11-10, nothing due"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("skips a cycle by moving the due date one interval on, without an expense", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-10,/ }));
    await user.click(screen.getByRole("button", { name: /Skip this time\s*Stall rent/ }));
    await waitFor(() =>
      expect(patches).toEqual([
        { url: "/insights/recurring-schedules/1", body: { nextDueDate: "2026-12-10" } },
      ]),
    );
    expect(posts).toEqual([]);
  });

  it("records from a projected date too, saying which payment it clears", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [
      schedule({ nextDueDate: "2026-10-11T00:00:00.000Z", intervalDays: 31, dueState: "OVERDUE" }),
    ];
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-11,/ }));
    expect(screen.getByText("Pays the overdue Oct 11 payment first.")).toBeInTheDocument();
    // Skip belongs to the payment due now, not to a projection.
    expect(screen.queryByRole("button", { name: /Skip this time/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Record payment\s*for Stall rent/ }));
    const dialog = await screen.findByRole("dialog", { name: "Record payment" });
    expect(JSON.parse(within(dialog).getByTestId("expense-seed").textContent!)).toEqual({
      description: "Stall rent",
      vendor: "",
      categoryId: 3,
      amount: 4500,
    });
  });

  it("flags two watched payments with the same name and category", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [schedule(), schedule({ id: 2, label: "stall rent " }), schedule({ id: 3, label: "Water" })];
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-10,/ }));
    const dayDialog = screen.getByRole("dialog", { name: /November 10/ });
    expect(within(dayDialog).getAllByText(/Another watched payment has this name/)).toHaveLength(2);
  });

  it("records a suggested payment filled in from the suggestion", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    patternsResponse = [pattern({ category: { name: "Rent" }, vendor: "Gas depot" })];
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-12,/ }));
    await user.click(screen.getByRole("button", { name: /Record payment\s*for LPG refill/ }));
    const dialog = await screen.findByRole("dialog", { name: "Record payment" });
    expect(JSON.parse(within(dialog).getByTestId("expense-seed").textContent!)).toEqual({
      description: "LPG refill",
      vendor: "Gas depot",
      categoryId: 3,
      amount: 950,
    });
  });

  it("asks before recording a second payment in the same cycle", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [schedule({ lastRecordedDate: "2026-10-25T00:00:00.000Z" })];
    confirmAnswer = false;
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-10,/ }));
    await user.click(screen.getByRole("button", { name: /Record payment\s*for Stall rent/ }));
    await waitFor(() => expect(confirms).toEqual(["Already paid?"]));
    // Declined: back on the day, no expense form.
    expect(await screen.findByRole("dialog", { name: /November 10/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Record payment" })).not.toBeInTheDocument();
  });

  it("does not ask when the last payment was a cycle ago", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = [schedule({ lastRecordedDate: "2026-10-10T00:00:00.000Z" })];
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-10,/ }));
    await user.click(screen.getByRole("button", { name: /Record payment\s*for Stall rent/ }));
    expect(await screen.findByRole("dialog", { name: "Record payment" })).toBeInTheDocument();
    expect(confirms).toEqual([]);
  });

  it("moves between months", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await screen.findByText("November 2026");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("December 2026")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("November 2026")).toBeInTheDocument();
  });

  it("opens on the business's month, not the device's", async () => {
    // 02:00 UTC on 1 Nov is still 31 Oct in Los Angeles, and 1 Nov in UTC and Manila.
    vi.setSystemTime(new Date("2026-11-01T02:00:00Z"));
    (profile as { timezone?: string }).timezone = "America/Los_Angeles";
    try {
      renderPage();
      expect(await screen.findByText("October 2026")).toBeInTheDocument();
    } finally {
      delete (profile as { timezone?: string }).timezone;
    }
  });

  it("hides Watch this when schedules are switched off", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    schedulesResponse = "404";
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^2026-11-12,/ }));
    expect(screen.getByRole("button", { name: /Not recurring/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Watch this/ })).not.toBeInTheDocument();
  });

  it("invites the owner to add a payment when there is nothing to show", async () => {
    schedulesResponse = [];
    patternsResponse = [];
    renderPage();
    expect(await screen.findByText("No payments to show yet")).toBeInTheDocument();
  });
});
