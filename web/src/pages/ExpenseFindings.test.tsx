// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ExpenseFindingsPage } from "./ExpenseFindings";
import type { AnomalyFinding, BusinessProfile } from "../lib/types";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";

const profile = { id: 1, name: "Burger stall" } as unknown as BusinessProfile;

let findingsResponse: { items: AnomalyFinding[]; nextCursor: null };
let failFindings = false;
const findingsCalls: Record<string, unknown>[] = [];
const patches: { url: string; body: unknown }[] = [];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === "/insights/findings") {
        findingsCalls.push(config?.params ?? {});
        if (failFindings) throw new Error("network down");
        return { data: findingsResponse };
      }
      throw new Error(`unmocked GET ${url}`);
    },
    patch: async (url: string, body: unknown) => {
      patches.push({ url, body });
      return { data: {} };
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

function finding(index: number): AnomalyFinding {
  return {
    id: 100 + index,
    expenseRecordId: 200 + index,
    type: "AMOUNT_OUTLIER",
    severity: "MEDIUM",
    score: 2,
    title: `Finding number ${index}`,
    reasons: ["Higher than usual"],
    status: "OPEN",
    detectedAt: "2026-10-20T00:00:00.000Z",
  } as AnomalyFinding;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/insights/expense-behavior/findings"]}>
      <ExpenseFindingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  beginServerStateSession("expense-findings-test");
  findingsCalls.length = 0;
  patches.length = 0;
  failFindings = false;
  findingsResponse = { items: Array.from({ length: 7 }, (_, i) => finding(i + 1)), nextCursor: null };
});

afterEach(() => endServerStateSession());

describe("Findings to review subpage", () => {
  it("lists every open finding with no paging, using the panel's request", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "7 open findings" })).toBeInTheDocument();
    expect(screen.getByText("Finding number 1")).toBeInTheDocument();
    expect(screen.getByText("Finding number 7")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
    expect(findingsCalls[0]).toEqual({ businessProfileId: 1, status: "OPEN", take: 20 });
    expect(screen.getAllByRole("link", { name: /Back to Expense insight/ })[0]).toHaveAttribute(
      "href",
      "/insights/expense-behavior#expense-review",
    );
  });

  it("removes a finding once it is reviewed", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Finding number 2");
    await user.click(screen.getByRole("button", { name: /Expected \/ dismiss\s*— Finding number 2/ }));
    await waitFor(() => expect(screen.queryByText("Finding number 2")).not.toBeInTheDocument());
    expect(patches[0]).toEqual({
      url: "/insights/findings/102/review",
      body: { status: "DISMISSED", feedback: "EXPECTED_TRANSACTION" },
    });
    expect(screen.getByRole("heading", { name: "6 open findings" })).toBeInTheDocument();
  });

  it("says so when nothing is open", async () => {
    findingsResponse = { items: [], nextCursor: null };
    renderPage();
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  });

  it("offers a retry when findings cannot load", async () => {
    failFindings = true;
    renderPage();
    expect(await screen.findByText(/Findings couldn.t load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
