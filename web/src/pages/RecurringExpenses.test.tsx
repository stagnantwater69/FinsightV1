// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RecurringExpensesPage } from "./RecurringExpenses";
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

function schedule(index: number): RecurringSchedule {
  return {
    id: index,
    businessProfileId: 1,
    categoryId: 3,
    categoryName: "Salaries",
    label: `Watched payment ${index}`,
    vendor: null,
    intervalDays: 31,
    expectedAmount: 9500,
    amountTolerance: 0.15,
    nextDueDate: "2026-10-31T00:00:00.000Z",
    lastRecordedDate: null,
    isActive: true,
    sourcePatternId: null,
    dueState: "OVERDUE",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function pattern(index: number): RecurringPattern {
  return {
    id: 50 + index,
    description: `Suggested payment ${index}`,
    vendor: null,
    intervalDays: 31,
    expectedAmount: 950,
    confidence: 0.9,
    nextExpectedDate: "2026-11-01T00:00:00.000Z",
    status: "CANDIDATE",
    category: { name: "Equipment" },
  } as RecurringPattern;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/insights/expense-behavior/recurring"]}>
      <RecurringExpensesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  beginServerStateSession("recurring-expenses-test");
  posts.length = 0;
  patches.length = 0;
  schedulesResponse = Array.from({ length: 9 }, (_, i) => schedule(i + 1));
  patternsResponse = Array.from({ length: 6 }, (_, i) => pattern(i + 1));
});

afterEach(() => endServerStateSession());

describe("Recurring expenses subpage", () => {
  it("shows every watched payment and every suggestion, with no Show all or See all", async () => {
    renderPage();
    expect((await screen.findAllByText("Watched payment 9")).length).toBeGreaterThan(0);
    expect(screen.getByText("Suggested payment 6")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /See all/ })).not.toBeInTheDocument();
    expect(screen.getByText("6 to answer")).toBeInTheDocument();
  });

  it("watches a suggestion through the confirm endpoint and dismisses one locally", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Suggested payment 1");
    await user.click(screen.getByRole("button", { name: /Watch this\s*— Suggested payment 1/ }));
    await waitFor(() => expect(posts).toEqual(["/insights/recurring-patterns/51/confirm"]));
    await user.click(screen.getByRole("button", { name: /Not recurring\s*— Suggested payment 2/ }));
    await waitFor(() => expect(screen.queryByText("Suggested payment 2")).not.toBeInTheDocument());
    expect(patches[0]).toEqual({
      url: "/insights/recurring-patterns/52",
      body: { status: "DISMISSED" },
    });
  });

  it("hides Watch this when schedules are switched off, but keeps Not recurring", async () => {
    schedulesResponse = "404";
    renderPage();
    const suggestions = await screen.findByRole("heading", { name: "Possible recurring expenses" });
    const panel = within(suggestions.closest("#recurring-suggestions") as HTMLElement);
    expect(panel.getAllByRole("button", { name: /Not recurring/ })).toHaveLength(6);
    expect(panel.queryByRole("button", { name: /Watch this/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Payments you asked FinSight to watch")).not.toBeInTheDocument();
  });
});
