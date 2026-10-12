// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";
import type { BusinessProfile, RecoveryInsight } from "../lib/types";
import { RecoveryInsightPage } from "./RecoveryInsightPage";

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

type RequestParams = Record<string, string | number | undefined>;

function recoveryFor(params: RequestParams): RecoveryInsight {
  const isWeek = params.period === "week";
  const month = typeof params.month === "string" ? params.month : "2026-10";
  const historical = !isWeek && month === "2026-09";
  const start = isWeek ? "2026-09-28" : `${month}-01`;
  const end = isWeek ? "2026-10-04" : historical ? "2026-09-30" : "2026-10-31";
  const target = isWeek ? 5000 : 20000;
  const sales = isWeek ? 2400 : historical ? 21000 : 10000;

  return {
    expectedMonthlyExpenses: 20000,
    operatingDays: 26,
    dailyNeededTarget: 769.23,
    salesThisMonth: sales,
    remainingTarget: Math.max(target - sales, 0),
    daysInMonth: historical ? 30 : 31,
    calendarDaysLeftInMonth: historical ? 0 : 30,
    remainingOperatingDays: historical ? 0 : isWeek ? 3 : 20,
    remainingOperatingDaysIsApproximated: false,
    adjustedDailyTarget: historical ? 0 : isWeek ? 866.67 : 500,
    todaysTarget: 769.23,
    todaysSales: 500,
    todaysGap: -269.23,
    todaysStatus: "below",
    monthCoveragePercent: (sales / target) * 100,
    onTrack: historical,
    status: historical ? "covered" : "behind",
    monthStart: `${month}-01T00:00:00.000Z`,
    today: "2026-10-01T00:00:00.000Z",
    asOfDate: historical ? "2026-09-30" : "2026-10-01",
    timezone: "Asia/Manila",
    coverageDays: 31,
    dailyCoverage: [],
    weeklyCheckpoints: [],
    changeSincePreviousDay: null,
    reportingPeriod: {
      kind: isWeek ? "week" : "month",
      month: isWeek ? null : month,
      start,
      end,
      asOfDate: historical ? end : "2026-10-01",
      timezone: "Asia/Manila",
      isCurrent: !historical,
      isComplete: historical,
      targetBasis: isWeek ? "prorated_monthly_expenses" : "monthly_expenses",
      target,
      sales,
      confirmedSales: sales,
      provisionalSales: 0,
      remainingTarget: Math.max(target - sales, 0),
      coveragePercent: (sales / target) * 100,
      dailyTarget: 769.23,
      adjustedDailyTarget: historical ? null : isWeek ? 866.67 : 500,
      operatingDays: isWeek ? 5.8666666667 : 26,
      elapsedOperatingDays: historical ? 26 : isWeek ? 2.3333333333 : 1,
      remainingOperatingDays: historical ? 0 : isWeek ? 3.5333333334 : 25,
      operatingScheduleConfigured: !isWeek,
      operatingDaysIsApproximated: isWeek,
      expectedSalesToDate: isWeek ? 1538.46 : historical ? 20000 : 769.23,
      paceVarianceAmount: isWeek ? 861.54 : historical ? 1000 : 9230.77,
      status: historical ? "covered" : "behind",
      confidence: "strong",
      recordCount: sales > 0 ? 1 : 0,
      dataWarnings: [],
    },
  };
}

let recoveryRequests: RequestParams[];
let recoveryHandler: (
  params: RequestParams,
) => RecoveryInsight | Promise<RecoveryInsight>;

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string, config?: { params?: RequestParams }) => {
      if (url === "/records/months") {
        return { data: { months: ["2026-10", "2026-09"] } };
      }
      if (url === "/insights/recovery") {
        const params = config?.params ?? {};
        recoveryRequests.push(params);
        return { data: await recoveryHandler(params) };
      }
      if (url === "/business-profiles/1/recovery-plans") {
        return { data: [] };
      }
      throw new Error(`unmocked GET ${url}`);
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

vi.mock("../context/AiChatContext", () => ({
  useAiChat: () => ({ openChat: vi.fn() }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <RecoveryInsightPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  beginServerStateSession("recovery-period-test-user");
  window.sessionStorage.clear();
  recoveryRequests = [];
  recoveryHandler = recoveryFor;
});

afterEach(() => {
  endServerStateSession();
});

describe("Recovery Target reporting period", () => {
  it("replaces the old header actions with the bounded shared period control", async () => {
    renderPage();
    await screen.findByText("Month-to-date pace");

    const group = screen.getByRole("group", { name: "Period" });
    expect(within(group).getByRole("button", { name: "This week" })).toBeInTheDocument();
    expect(within(group).getByRole("combobox", { name: "Month" })).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "All time" })).not.toBeInTheDocument();
    expect(screen.queryByText("View last month's summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage notifications")).not.toBeInTheDocument();
    expect(recoveryRequests.at(-1)).toMatchObject({
      businessProfileId: 1,
      coverageDays: 31,
      period: "month",
      month: "2026-10",
    });
  });

  it("loads week figures and hides current-month planning surfaces", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Month-to-date pace");

    await user.click(screen.getByRole("button", { name: "This week" }));

    expect(await screen.findByText("This week's pace")).toBeInTheDocument();
    await waitFor(() =>
      expect(recoveryRequests.at(-1)).toMatchObject({ period: "week" }),
    );
    expect(screen.getAllByText("This week's target").length).toBeGreaterThan(0);
    expect(screen.getAllByText("≈ 5.9").length).toBeGreaterThan(0);
    expect(screen.getByText("Open-day target")).toBeInTheDocument();
    expect(
      screen.getByText("Open-day target = period target ÷ estimated operating days."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/5\.8666666667/)).not.toBeInTheDocument();
    expect(screen.queryByText("Today's target")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Scenario" })).not.toBeInTheDocument();
    expect(screen.queryByText("Try a scenario")).not.toBeInTheDocument();
  });

  it("shows a completed historical month without a remaining-plan surface", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Month-to-date pace");

    await user.click(screen.getByRole("combobox", { name: "Month" }));
    await user.click(screen.getByRole("option", { name: "September 2026" }));

    expect(await screen.findByText("September 2026 result")).toBeInTheDocument();
    await waitFor(() =>
      expect(recoveryRequests.at(-1)).toMatchObject({
        period: "month",
        month: "2026-09",
      }),
    );
    expect(screen.queryByText("Remaining recovery target")).not.toBeInTheDocument();
    expect(screen.queryByText("Today's target")).not.toBeInTheDocument();
    expect(screen.queryByText("Try a scenario")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Targets use your current business profile settings/),
    ).toBeInTheDocument();
  });

  it("normalizes a shared All time selection to This week before requesting recovery", async () => {
    window.sessionStorage.setItem(
      "finsight.reportingPeriod.1",
      JSON.stringify({ kind: "all" }),
    );
    renderPage();

    expect(await screen.findByText("This week's pace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "This week" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(recoveryRequests.some((params) => params.period === "all")).toBe(false);
    expect(recoveryRequests.at(-1)).toMatchObject({ period: "week" });
  });

  it("ignores a slower response from the period that was left", async () => {
    let resolveMonth!: (data: RecoveryInsight) => void;
    const monthResponse = new Promise<RecoveryInsight>((resolve) => {
      resolveMonth = resolve;
    });
    recoveryHandler = (params) =>
      params.period === "month" ? monthResponse : recoveryFor(params);

    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(recoveryRequests.some((params) => params.period === "month")).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "This week" }));
    expect(await screen.findByText("This week's pace")).toBeInTheDocument();

    await act(async () => {
      resolveMonth(recoveryFor({ period: "month", month: "2026-10" }));
      await monthResponse;
    });

    expect(screen.getByText("This week's pace")).toBeInTheDocument();
    expect(screen.queryByText("Month-to-date pace")).not.toBeInTheDocument();
  });
});
