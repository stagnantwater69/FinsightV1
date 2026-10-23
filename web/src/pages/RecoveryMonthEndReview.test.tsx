// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RecoveryMonthEndReviewPage } from "./RecoveryMonthEndReview";
import type { BusinessProfile, RecoveryMonthEndReview } from "../lib/types";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";

/**
 * Plan §10.9/§11 Phase 7 — month-end review. The non-negotiable invariant
 * tested repeatedly here: `suggestedQuestionsForNextMonth` is plain,
 * read-only text. Nothing on this page may offer a one-click way to change
 * `expectedMonthlyExpenses`, `operatingDays`, or any other setting — see
 * insights.service.ts `computeMonthEndReview`'s doc comment.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

let currentResponse: RecoveryMonthEndReview;
let getCalls: { url: string; params: Record<string, unknown> }[] = [];
let failNextCall = false;
let monthsResponse: string[] | Error = [];
let hangReview = false;

function monthKey(offset: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === "/records/months") {
        if (monthsResponse instanceof Error) throw monthsResponse;
        return { data: { months: monthsResponse } };
      }
      getCalls.push({ url, params: config?.params ?? {} });
      if (url === "/insights/recovery/month-end-review") {
        if (hangReview) return new Promise(() => {});
        if (failNextCall) {
          failNextCall = false;
          throw new Error("network down");
        }
        return { data: currentResponse };
      }
      throw new Error(`unmocked GET ${url}`);
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <RecoveryMonthEndReviewPage />
    </MemoryRouter>,
  );
}

function reviewable(overrides: Partial<Extract<RecoveryMonthEndReview, { status: "reviewable" }>> = {}) {
  return {
    status: "reviewable" as const,
    month: "2026-06",
    monthlyExpenseBasis: {
      amount: 20_000,
      source: "owner_estimate" as const,
      sourceMonth: null,
      ownerEstimate: 20_000,
      recordsCompleteThroughMonth: null,
      recordsCompleteThroughConfirmedAt: null,
      eligibleRecordCount: 0,
    },
    coveragePercent: 82,
    surplusOrShortfall: -3600,
    strongestOpenDay: { date: "2026-06-14", sales: 4200 },
    weakestOpenDay: { date: "2026-06-02", sales: 150 },
    missingOrProvisionalDayCount: 3,
    openDayCount: 26,
    originalDailyTarget: 769.23,
    finalAdjustedDailyTarget: 800,
    baselineAppearsOffFromPattern: false,
    suggestedQuestionsForNextMonth: [
      "Did any single week account for most of this month's sales?",
      "Were there open days with no sales reference recorded at all?",
    ],
    operatingScheduleConfigured: true,
    ...overrides,
  };
}

beforeEach(() => {
  getCalls = [];
  failNextCall = false;
  currentResponse = reviewable();
  // The business has records this month, last month, and two older months.
  monthsResponse = [monthKey(0), monthKey(-1), "2026-05", "2025-11"];
});

describe("Recovery Target — month-end review (plan §10.9)", () => {
  it("offers only ended months with records, newest first, and opens on the newest", async () => {
    renderPage();
    await waitFor(() => expect(getCalls.length).toBeGreaterThan(0));
    expect(getCalls[0].params.month).toBe(monthKey(-1));
    const select = screen.getByLabelText("Month to review") as HTMLSelectElement;
    expect(select.value).toBe(monthKey(-1));
    // The current month has records but has not ended, so it is not offered.
    expect([...select.options].map((option) => option.value)).toEqual([monthKey(-1), "2026-05", "2025-11"]);
  });

  it("falls back to last month when the business has no ended months with records", async () => {
    monthsResponse = [monthKey(0)];
    renderPage();
    await waitFor(() => expect(getCalls.length).toBeGreaterThan(0));
    expect(getCalls[0].params.month).toBe(monthKey(-1));
  });

  it("shows a non-alarming message for a not-yet-reviewable month", async () => {
    currentResponse = { status: "not_yet_reviewable", month: "2026-08" };
    renderPage();
    expect(await screen.findByText(/hasn.t ended yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it("frames a shortfall in non-negative peso text", async () => {
    currentResponse = reviewable({ surplusOrShortfall: -3600 });
    renderPage();
    expect(await screen.findByText(/shortfall/i)).toBeInTheDocument();
    expect(screen.queryByText(/-₱|₱-/)).not.toBeInTheDocument();
  });

  it("frames a surplus with surplus wording", async () => {
    currentResponse = reviewable({ surplusOrShortfall: 2100 });
    renderPage();
    expect(await screen.findByText(/surplus/i)).toBeInTheDocument();
  });

  it("shows the owner-estimate basis and explains its provenance", async () => {
    renderPage();
    expect(await screen.findByText("PHP 20,000")).toBeInTheDocument();
    expect(screen.getByText(/using your starting estimate/i)).toBeInTheDocument();
  });

  it("shows the complete-month basis and source month", async () => {
    currentResponse = reviewable({
      monthlyExpenseBasis: {
        amount: 80_000,
        source: "previous_complete_month",
        sourceMonth: "2026-05",
        ownerEstimate: 50_000,
        recordsCompleteThroughMonth: "2026-05",
        recordsCompleteThroughConfirmedAt: "2026-06-01T02:30:00.000Z",
        eligibleRecordCount: 14,
      },
    });
    renderPage();
    expect(await screen.findByText("PHP 80,000")).toBeInTheDocument();
    expect(screen.getByText(/14 eligible expense records from May 2026/i)).toBeInTheDocument();
  });

  it("shows the missing/provisional day count as a fraction of open days", async () => {
    currentResponse = reviewable({ missingOrProvisionalDayCount: 3, openDayCount: 26 });
    renderPage();
    await screen.findByText("3");
    expect(screen.getByText("26")).toBeInTheDocument();
  });

  it("explains a null final adjusted daily target rather than leaving it blank", async () => {
    currentResponse = reviewable({ finalAdjustedDailyTarget: null });
    renderPage();
    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
    expect(screen.getByText(/last day of the month was closed/i)).toBeInTheDocument();
  });

  it("shows the final adjusted daily target when present", async () => {
    currentResponse = reviewable({ finalAdjustedDailyTarget: 800 });
    renderPage();
    expect(await screen.findByText("PHP 800")).toBeInTheDocument();
  });

  it("only shows the baseline-off-from-pattern callout when true", async () => {
    currentResponse = reviewable({ baselineAppearsOffFromPattern: false });
    renderPage();
    await screen.findByText(/questions to consider/i);
    expect(screen.queryByText(/may not match/i)).not.toBeInTheDocument();

    currentResponse = reviewable({ baselineAppearsOffFromPattern: true });
    fireEvent.change(screen.getByLabelText("Month to review"), { target: { value: "2025-11" } });
    expect(await screen.findByText(/may not match/i)).toBeInTheDocument();
  });

  it("renders suggested questions as plain read-only text, with no per-question control", async () => {
    renderPage();
    await screen.findByText(/questions to consider/i);
    for (const question of reviewable().suggestedQuestionsForNextMonth) {
      expect(screen.getByText(question)).toBeInTheDocument();
    }
    // No button anywhere on the page that could mutate a setting from a
    // suggestion — the only interactive controls are the month picker and
    // the generic "Edit business profile" link.
    const buttons = screen.queryAllByRole("button");
    for (const button of buttons) {
      expect(button.textContent).not.toMatch(/apply|use this|update settings/i);
    }
    const editLink = screen.getByRole("link", { name: /edit business profile/i });
    expect(editLink).toHaveAttribute("href", "/business-profiles/1/edit");
  });

  it("shows a real day+₱0 pair rather than a blank when both open days are zero-sales", async () => {
    currentResponse = reviewable({
      strongestOpenDay: { date: "2026-06-01", sales: 0 },
      weakestOpenDay: { date: "2026-06-01", sales: 0 },
    });
    renderPage();
    await screen.findByText(/questions to consider/i);
    expect(screen.getAllByText("PHP 0").length).toBeGreaterThan(0);
    expect(screen.queryByText(/no open days recorded/i)).not.toBeInTheDocument();
  });

  it("shows the null-equivalent message when there were no open days at all", async () => {
    currentResponse = reviewable({ strongestOpenDay: null, weakestOpenDay: null });
    renderPage();
    const messages = await screen.findAllByText(/no open days recorded that month/i);
    expect(messages.length).toBe(2);
  });

  it("re-fetches when the month picker changes", async () => {
    renderPage();
    await waitFor(() => expect(getCalls.length).toBe(1));
    fireEvent.change(screen.getByLabelText("Month to review"), { target: { value: "2026-05" } });
    await waitFor(() => expect(getCalls.length).toBe(2));
    expect(getCalls[1].params.month).toBe("2026-05");
  });

  it("surfaces a retryable error state and recovers on Retry", async () => {
    failNextCall = true;
    renderPage();
    expect(await screen.findByText(/review couldn.t load/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await screen.findByText(/questions to consider/i);
    expect(screen.queryByText(/review couldn.t load/i)).not.toBeInTheDocument();
  });
});

describe("returning to a reviewed month", () => {
  afterEach(() => {
    hangReview = false;
    vi.restoreAllMocks();
    endServerStateSession();
  });

  it("shows the recap it left at once, while the refresh is still on its way", async () => {
    beginServerStateSession(17);
    monthsResponse = [monthKey(-1)];
    currentResponse = reviewable({ month: monthKey(-1) });
    const first = renderPage();
    expect(await screen.findByText("Strongest")).toBeInTheDocument();
    first.unmount();

    // Past the 30-second freshness window, so the return visit refreshes; the
    // refresh never answers, so the recap on screen came from the saved copy.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    hangReview = true;
    renderPage();

    expect(await screen.findByText("Strongest")).toBeInTheDocument();
  });
});
