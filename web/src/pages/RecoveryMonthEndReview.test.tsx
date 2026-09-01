// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RecoveryMonthEndReviewPage } from "./RecoveryMonthEndReview";
import type { BusinessProfile, RecoveryMonthEndReview } from "../lib/types";

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

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      getCalls.push({ url, params: config?.params ?? {} });
      if (url === "/insights/recovery/month-end-review") {
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
});

describe("Recovery Target — month-end review (plan §10.9)", () => {
  it("defaults the month picker to last month", async () => {
    renderPage();
    await waitFor(() => expect(getCalls.length).toBeGreaterThan(0));
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const expected = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
    expect(getCalls[0].params.month).toBe(expected);
    const input = screen.getByLabelText("Month to review") as HTMLInputElement;
    expect(input.value).toBe(expected);
  });

  it("shows a non-alarming message for a not-yet-reviewable month", async () => {
    currentResponse = { status: "not_yet_reviewable", month: "2026-08" };
    renderPage();
    expect(await screen.findByText(/hasn't ended yet/i)).toBeInTheDocument();
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
    expect(screen.getByText(/closed day/i)).toBeInTheDocument();
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
    expect(screen.queryByText(/may not closely match/i)).not.toBeInTheDocument();

    currentResponse = reviewable({ baselineAppearsOffFromPattern: true });
    fireEvent.change(screen.getByLabelText("Month to review"), { target: { value: "2025-11" } });
    expect(await screen.findByText(/may not closely match/i)).toBeInTheDocument();
  });

  it("renders suggested questions as plain read-only text, with no per-question control", async () => {
    renderPage();
    await screen.findByText(/questions to consider/i);
    for (const question of reviewable().suggestedQuestionsForNextMonth) {
      expect(screen.getByText(question)).toBeInTheDocument();
    }
    // No button anywhere on the page that could mutate a setting from a
    // suggestion — the only interactive control besides the month
    // picker/submit is the generic "Edit business profile" link.
    const buttons = screen.getAllByRole("button");
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
    expect(await screen.findByText(/couldn't load this month's review/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await screen.findByText(/questions to consider/i);
    expect(screen.queryByText(/couldn't load this month's review/i)).not.toBeInTheDocument();
  });
});
