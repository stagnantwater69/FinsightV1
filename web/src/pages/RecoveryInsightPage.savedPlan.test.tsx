// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RecoveryInsightPage } from "./RecoveryInsightPage";
import type { BusinessProfile, RecoveryInsight, RecoveryPlan, RecoveryScenario } from "../lib/types";

/**
 * Saved Recovery Plan — plan §7.5/§10.7/§11 Phase 6.
 *
 * CRITICAL invariant under test: a saved plan is a purely separate,
 * owner-visible artifact. This suite never touches — and explicitly checks
 * it never has to touch — `simulateRecoveryScenario`'s own math; the real
 * displayed Recovery Target figures come only from the `/insights/recovery`
 * fixture below and must stay exactly as fixture'd regardless of what gets
 * saved as a plan.
 */

const profile = { id: 1, name: "Sari-sari" } as unknown as BusinessProfile;

const recovery: RecoveryInsight = {
  expectedMonthlyExpenses: 20000,
  operatingDays: 26,
  dailyNeededTarget: 769.23,
  salesThisMonth: 10000,
  remainingTarget: 10000,
  daysInMonth: 31,
  calendarDaysLeftInMonth: 10,
  remainingOperatingDays: 8,
  remainingOperatingDaysIsApproximated: false,
  adjustedDailyTarget: 1250,
  todaysTarget: 769.23,
  todaysSales: 500,
  todaysGap: -269.23,
  todaysStatus: "below",
  monthCoveragePercent: 50,
  onTrack: false,
  monthStart: "2026-01-01T00:00:00.000Z",
  today: "2026-01-20T00:00:00.000Z",
  coverageDays: 20,
  dailyCoverage: [],
};

function scenarioResult(): RecoveryScenario {
  return {
    assumedExpectedMonthlyExpenses: 15000,
    current: {
      expectedMonthlyExpenses: 20000,
      operatingDays: 26,
      dailyNeededTarget: 769.23,
      salesThisMonth: 10000,
      remainingTarget: 10000,
      daysInMonth: 31,
      calendarDaysLeftInMonth: 10,
      remainingOperatingDays: 8,
      remainingOperatingDaysIsApproximated: false,
      adjustedDailyTarget: 1250,
      todaysTarget: 769.23,
      todaysSales: 500,
      todaysGap: -269.23,
      todaysStatus: "below",
      monthCoveragePercent: 50,
      onTrack: false,
    },
    hypothetical: {
      expectedMonthlyExpenses: 15000,
      operatingDays: 26,
      dailyNeededTarget: 576.92,
      salesThisMonth: 10000,
      remainingTarget: 5000,
      daysInMonth: 31,
      calendarDaysLeftInMonth: 10,
      remainingOperatingDays: 8,
      remainingOperatingDaysIsApproximated: false,
      adjustedDailyTarget: 625,
      todaysTarget: 576.92,
      todaysSales: 500,
      todaysGap: -76.92,
      todaysStatus: "below",
      monthCoveragePercent: 66.7,
      onTrack: false,
    },
    persisted: false,
  };
}

let getPlanResponse: RecoveryPlan[];
let putCalls: { url: string; body: unknown }[];
let deleteCalls: string[];

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/insights/recovery") return { data: recovery };
      if (url.startsWith("/business-profiles/1/recovery-plans")) return { data: getPlanResponse };
      throw new Error(`unmocked GET ${url}`);
    },
    post: async (url: string) => {
      if (url === "/insights/recovery-scenario") return { data: scenarioResult() };
      throw new Error(`unmocked POST ${url}`);
    },
    put: async (url: string, body: unknown) => {
      putCalls.push({ url, body });
      const saved: RecoveryPlan = {
        month: url.split("/").pop()!,
        bufferPercent: (body as RecoveryPlan).bufferPercent ?? null,
        deadline: (body as RecoveryPlan).deadline ?? null,
        ownerTargetAmount: (body as RecoveryPlan).ownerTargetAmount ?? null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      return { data: saved };
    },
    delete: async (url: string) => {
      deleteCalls.push(url);
      return { data: null };
    },
  },
}));

vi.mock("../context/BusinessProfileContext", () => ({
  useBusinessProfiles: () => ({ selected: profile }),
}));

vi.mock("../context/AiChatContext", () => ({
  useAiChat: () => ({ openChat: vi.fn() }),
}));

vi.mock("../components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));

const toastCalls: string[] = [];
vi.mock("../components/Toast", () => ({ useToast: () => (msg: string) => toastCalls.push(msg) }));

function renderPage() {
  return render(
    <MemoryRouter>
      <RecoveryInsightPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  putCalls = [];
  deleteCalls = [];
  toastCalls.length = 0;
  getPlanResponse = [];
});

describe("Recovery Target — saved plan (plan §7.5/§10.7)", () => {
  it("renders nothing about a saved plan when none exists yet", async () => {
    renderPage();
    await screen.findByText(/Try a scenario/);
    expect(screen.queryByText(/This month's saved plan/)).not.toBeInTheDocument();
  });

  it("offers 'Save this as a plan' only after a scenario result exists", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Try a scenario" }));
    expect(screen.queryByText(/Save this as a plan/)).not.toBeInTheDocument();

    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    await userEvent.clear(input);
    await userEvent.type(input, "15000");
    await userEvent.click(screen.getByRole("button", { name: "See hypothetical target" }));

    expect(await screen.findByText(/Save this as a plan/)).toBeInTheDocument();
  });

  it("saves the scenario's assumed value as this month's plan and shows the non-mutation confirmation", async () => {
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Try a scenario" }));
    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    await userEvent.clear(input);
    await userEvent.type(input, "15000");
    await userEvent.click(screen.getByRole("button", { name: "See hypothetical target" }));

    await userEvent.click(await screen.findByRole("button", { name: /Save this as a plan/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));

    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]!.url).toMatch(/^\/business-profiles\/1\/recovery-plans\/\d{4}-\d{2}$/);
    expect((putCalls[0]!.body as { ownerTargetAmount: number }).ownerTargetAmount).toBe(15000);

    expect(
      await screen.findByText(/Saved for reference — this doesn't change your business profile or recorded sales\./),
    ).toBeInTheDocument();
  });

  it("does not change any displayed Recovery Target figure after saving a plan", async () => {
    renderPage();
    await screen.findByText(/Try a scenario/);
    // The real, saved daily needed target from the /insights/recovery fixture.
    expect(screen.getAllByText(/PHP\s*769/).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Try a scenario" }));
    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    await userEvent.clear(input);
    await userEvent.type(input, "15000");
    await userEvent.click(screen.getByRole("button", { name: "See hypothetical target" }));
    await userEvent.click(await screen.findByRole("button", { name: /Save this as a plan/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(putCalls).toHaveLength(1));

    // Real figures, unchanged — only ever sourced from `recovery` above.
    expect(screen.getAllByText(/PHP\s*769/).length).toBeGreaterThan(0);
  });

  it("shows an existing saved plan for the current month with edit and delete", async () => {
    getPlanResponse = [
      {
        month: "2026-01",
        bufferPercent: 10,
        deadline: "2026-01-31",
        ownerTargetAmount: 18000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    renderPage();

    expect(await screen.findByText(/This month's saved plan/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("deletes the saved plan after confirmation", async () => {
    getPlanResponse = [
      {
        month: "2026-01",
        bufferPercent: null,
        deadline: null,
        ownerTargetAmount: 18000,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    renderPage();
    await screen.findByText(/This month's saved plan/);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    expect(deleteCalls[0]).toMatch(/^\/business-profiles\/1\/recovery-plans\/\d{4}-\d{2}$/);
    await waitFor(() => expect(screen.queryByText(/This month's saved plan/)).not.toBeInTheDocument());
  });
});
