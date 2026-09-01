// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { RecoveryInsightPage } from "./RecoveryInsightPage";
import type {
  BusinessProfile,
  RecoveryCheckpoint,
  RecoveryInsight,
  RecoveryScenario,
} from "../lib/types";

/**
 * Recovery Target hypothetical scenario — plan §13.2/§15 Phase 5.
 *
 * The three non-negotiable display requirements: the real target stays
 * unchanged and primary, the hypothetical is visually distinct and labeled
 * as not saved, and the assumed input is shown alongside the result. Plus
 * the invariant that nothing here can persist the hypothetical value.
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

function scenario(overrides: Partial<RecoveryScenario> = {}): RecoveryScenario {
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
    delta: {
      totalCoverageGoal: -5000,
      remainingTarget: -5000,
      adjustedDailyTarget: -625,
      estimatedTransactionsPerDay: null,
      estimatedTransactionsPerDayUnavailableReason:
        "transaction_provenance_unknown",
    },
    persisted: false,
    ...overrides,
  };
}

let postCalls: { url: string; body: unknown }[];
let postHandler: (body: unknown) => unknown;
// Lets individual tests swap in a different recovery payload (e.g. a
// different `status`) without redefining the whole mock module.
let currentRecovery: RecoveryInsight = recovery;

vi.mock("../lib/api", () => ({
  api: {
    get: async (url: string) => {
      if (url === "/insights/recovery") return { data: currentRecovery };
      throw new Error(`unmocked GET ${url}`);
    },
    post: async (url: string, body: unknown) => {
      postCalls.push({ url, body });
      return postHandler(body);
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
  postCalls = [];
  postHandler = () => ({ data: scenario() });
  currentRecovery = recovery;
});

describe("Recovery Target — terminology and freshness (plan §6/§8.1)", () => {
  it("shows the required Sales Coverage Target definition before/beside the status", () => {
    renderPage();
    expect(
      screen.getByText(
        /Your Sales Coverage Target compares recorded sales references with your expected monthly/,
      ),
    ).toBeInTheDocument();
  });

  it("shows the as-of date and timezone when the server sends them", async () => {
    currentRecovery = {
      ...recovery,
      asOfDate: "2026-01-20",
      timezone: "Asia/Manila",
    };
    renderPage();
    expect(
      await screen.findByText(/As of Jan 20, 2026, Asia\/Manila time/),
    ).toBeInTheDocument();
  });

  it('falls back to the plain "Today" label when asOfDate/timezone are missing', async () => {
    renderPage();
    // "Today" also appears as the Recovery Meter's own section header, so
    // this asserts the fallback text renders at all rather than picking one
    // specific occurrence out of two.
    expect((await screen.findAllByText("Today")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^As of /)).not.toBeInTheDocument();
  });

  it("renders the distinct informational treatment for no_current_month_data", async () => {
    currentRecovery = { ...recovery, status: "no_current_month_data" };
    renderPage();
    expect(
      await screen.findByText("No sales recorded yet this month"),
    ).toBeInTheDocument();
  });

  it("renders the covered treatment with its own copy", async () => {
    currentRecovery = { ...recovery, status: "covered" };
    renderPage();
    expect(
      await screen.findByText("Sales coverage target reached"),
    ).toBeInTheDocument();
  });

  it("renders the ahead treatment with its own copy", async () => {
    currentRecovery = { ...recovery, status: "ahead" };
    renderPage();
    expect(await screen.findByText("Ahead of pace")).toBeInTheDocument();
  });

  it("provides direct navigation through the long recovery workflow", async () => {
    renderPage();
    await screen.findByText("Month-to-date pace");

    expect(
      screen.getByRole("navigation", { name: "Recovery target sections" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "#recovery-overview",
    );
    expect(screen.getByRole("link", { name: "Daily plan" })).toHaveAttribute(
      "href",
      "#remaining-recovery-target",
    );
    expect(screen.getByRole("link", { name: "Scenario" })).toHaveAttribute(
      "href",
      "#recovery-scenario",
    );
    expect(screen.getByRole("link", { name: "Daily history" })).toHaveAttribute(
      "href",
      "#daily-coverage",
    );
  });

  it("keeps an over-covered month within the progress bar's accessible range", async () => {
    currentRecovery = {
      ...recovery,
      monthCoveragePercent: 160,
      salesThisMonth: 32000,
      remainingTarget: 0,
      status: "covered",
    };
    renderPage();

    const progress = await screen.findByRole("progressbar", {
      name: "Month-to-date coverage of expected monthly expenses",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("Recovery Target — hypothetical scenario", () => {
  it("keeps the real target's own figures unchanged when no scenario is active", async () => {
    renderPage();
    // Appears more than once (the Inputs panel and the Remaining recovery
    // target panel both show it) — any occurrence proves the real figure
    // rendered untouched.
    expect((await screen.findAllByText("PHP 20,000")).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByText("Hypothetical — not saved."),
    ).not.toBeInTheDocument();
  });

  it("shows the hypothetical result distinctly, labeled as not saved, alongside the assumed value used", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Try a scenario" }),
    );

    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    await userEvent.clear(input);
    await userEvent.type(input, "15000");
    await userEvent.click(
      screen.getByRole("button", { name: "See hypothetical target" }),
    );

    expect(
      await screen.findByText("Hypothetical — not saved."),
    ).toBeInTheDocument();
    // The assumed value is shown alongside the result — also repeated in the
    // new current-vs-hypothetical comparison row, so more than one match is expected.
    expect(screen.getAllByText("PHP 15,000").length).toBeGreaterThan(0);
    // The hypothetical figures, distinct from (and not overwriting) the real ones.
    expect(screen.getByText("PHP 577")).toBeInTheDocument(); // hypothetical daily needed target, rounded
    // The real, unchanged target is still readable for comparison.
    expect(
      screen.getByText(/your current \(real, saved\) daily needed target is/),
    ).toBeInTheDocument();
  });

  it("sends only businessProfileId and the assumed value — never persists anything", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Try a scenario" }),
    );

    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    await userEvent.clear(input);
    await userEvent.type(input, "15000");
    await userEvent.click(
      screen.getByRole("button", { name: "See hypothetical target" }),
    );

    await screen.findByText("Hypothetical — not saved.");

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]).toEqual({
      url: "/insights/recovery-scenario",
      body: {
        businessProfileId: profile.id,
        assumedExpectedMonthlyExpenses: 15000,
      },
    });
    // No PATCH/PUT to the business profile exists on this mocked client at
    // all — the only write surface offered is `api.post`, and it was only
    // ever called against the scenario endpoint above.
  });

  it("shows a validation error and does not call the API for a negative assumption", async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Try a scenario" }),
    );

    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    // fireEvent rather than userEvent.type: a number input strips a bare "-"
    // keystroke-by-keystroke under userEvent's simulated typing, so it never
    // reaches a negative value the way a real browser's autofill/paste would.
    fireEvent.change(input, { target: { value: "-5" } });
    await userEvent.click(
      screen.getByRole("button", { name: "See hypothetical target" }),
    );

    expect(
      await screen.findByText("Enter a number greater than or equal to 0."),
    ).toBeInTheDocument();
    expect(postCalls).toHaveLength(0);
  });

  it("ignores a re-submit attempt while a request is already in flight, and keeps only that one call's result", async () => {
    // Guards against the exact race Phase 4 QA flagged: native form
    // submission via Enter in the money input isn't blocked by the submit
    // button's `disabled` attribute, so a rapid re-submit with a different
    // typed value could previously fire a second overlapping request. The
    // `if (submitting) return` re-entry guard means a re-submit attempted
    // while the first is still pending must not issue a second call at
    // all — and the eventual result must reflect only the request that was
    // actually sent, not whatever was later typed into the (still-editable)
    // input.
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Try a scenario" }),
    );

    const input = screen.getByLabelText(
      /Assumed expected monthly expenses/,
    ) as HTMLInputElement;
    const form = input.closest("form")!;

    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    postHandler = () => first;

    await userEvent.clear(input);
    await userEvent.type(input, "10000");
    fireEvent.submit(form);
    expect(postCalls).toHaveLength(1);

    // While the first request is still pending, the owner edits the value
    // and tries to re-submit (e.g. hitting Enter again) — this must be a
    // no-op, not a second in-flight request.
    fireEvent.change(input, { target: { value: "20000" } });
    fireEvent.submit(form);
    expect(postCalls).toHaveLength(1);

    await act(async () => {
      resolveFirst({
        data: scenario({ assumedExpectedMonthlyExpenses: 10000 }),
      });
    });

    expect(
      await screen.findByText("Hypothetical — not saved."),
    ).toBeInTheDocument();
    // Only the one request that was actually sent (10000) is reflected —
    // the blocked re-submit attempt (20000) never overwrote it.
    expect(screen.getAllByText("PHP 10,000").length).toBeGreaterThan(0);
  });

  it("shows a fresh submission's own result normally once a prior request has fully resolved", async () => {
    // Sanity check alongside the guard test above: the `submitSeq` ref
    // must not somehow "get stuck" and block/mis-tag legitimate later
    // submissions once the in-flight one they follow has actually
    // completed — only *overlapping* requests are meant to be affected.
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "Try a scenario" }),
    );

    const input = screen.getByLabelText(
      /Assumed expected monthly expenses/,
    ) as HTMLInputElement;

    await userEvent.clear(input);
    await userEvent.type(input, "10000");
    await userEvent.click(
      screen.getByRole("button", { name: "See hypothetical target" }),
    );
    await screen.findByText("Hypothetical — not saved.");
    expect(screen.getAllByText("PHP 10,000").length).toBeGreaterThan(0);

    postHandler = () => ({
      data: scenario({ assumedExpectedMonthlyExpenses: 20000 }),
    });
    await userEvent.clear(input);
    await userEvent.type(input, "20000");
    await userEvent.click(
      screen.getByRole("button", { name: "See hypothetical target" }),
    );

    await screen.findByText(/Assumed value used:/);
    expect(document.body.textContent).toContain("PHP 20,000");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]).toEqual({
      url: "/insights/recovery-scenario",
      body: {
        businessProfileId: profile.id,
        assumedExpectedMonthlyExpenses: 20000,
      },
    });
  });
});

describe("Recovery Target — state-specific primary action (plan §10.1/§10.2)", () => {
  it('shows "Complete setup" linking to the business profile edit page for needs_setup', async () => {
    currentRecovery = { ...recovery, status: "needs_setup" };
    renderPage();
    const link = await screen.findByRole("link", { name: "Complete setup" });
    expect(link).toHaveAttribute(
      "href",
      `/business-profiles/${profile.id}/edit`,
    );
  });

  it('shows "Record or import sales" linking to /records for no_current_month_data', async () => {
    currentRecovery = { ...recovery, status: "no_current_month_data" };
    renderPage();
    const link = await screen.findByRole("link", {
      name: "Record or import sales",
    });
    expect(link).toHaveAttribute("href", "/records");
  });

  it('shows "Review sales" linking to /records for data_incomplete', async () => {
    currentRecovery = { ...recovery, status: "data_incomplete" };
    renderPage();
    const link = await screen.findByRole("link", { name: "Review sales" });
    expect(link).toHaveAttribute("href", "/records");
  });

  it('shows "View today\'s plan" anchored to the remaining-target panel for behind', async () => {
    currentRecovery = { ...recovery, status: "behind" };
    renderPage();
    const link = await screen.findByRole("link", { name: "View today's plan" });
    expect(link).toHaveAttribute("href", "#remaining-recovery-target");
  });

  it('moves keyboard focus to the remaining-target section when "View today\'s plan" is activated (WCAG 2.4.3)', async () => {
    currentRecovery = { ...recovery, status: "behind" };
    renderPage();
    const link = await screen.findByRole("link", { name: "View today's plan" });
    const target = document.getElementById("remaining-recovery-target");
    expect(target).not.toBeNull();
    expect(document.activeElement).not.toBe(target);
    // jsdom doesn't implement scrollIntoView; stub it so the click handler
    // (which calls it before .focus()) doesn't throw.
    target!.scrollIntoView = vi.fn();
    fireEvent.click(link);
    expect(document.activeElement).toBe(target);
  });

  it('shows "Record today\'s sales" linking to the add-sales-record route for on_pace', async () => {
    currentRecovery = { ...recovery, status: "on_pace" };
    renderPage();
    const link = await screen.findByRole("link", {
      name: "Record today's sales",
    });
    expect(link).toHaveAttribute("href", "/records/sales/new");
  });

  it('shows "Maintain current pace" as plain text, not a link, for ahead', async () => {
    currentRecovery = { ...recovery, status: "ahead" };
    renderPage();
    expect(
      await screen.findByText("Maintain current pace"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Maintain current pace" }),
    ).not.toBeInTheDocument();
  });

  it('shows "Review month summary" anchored to the daily-coverage table for covered', async () => {
    currentRecovery = { ...recovery, status: "covered" };
    renderPage();
    const link = await screen.findByRole("link", {
      name: "Review month summary",
    });
    expect(link).toHaveAttribute("href", "#daily-coverage");
  });

  it('moves keyboard focus to the "Daily coverage" heading when "Review month summary" is activated (WCAG 2.4.3)', async () => {
    currentRecovery = { ...recovery, status: "covered" };
    renderPage();
    const link = await screen.findByRole("link", {
      name: "Review month summary",
    });
    const heading = await screen.findByRole("heading", {
      name: "Daily coverage",
    });
    expect(heading.id).toBe("daily-coverage");
    expect(document.activeElement).not.toBe(heading);
    heading.scrollIntoView = vi.fn();
    fireEvent.click(link);
    expect(document.activeElement).toBe(heading);
  });

  it("renders no primary action when status is absent (older/cached response)", async () => {
    renderPage();
    await screen.findByText(/Sales Coverage Target compares/);
    expect(
      screen.queryByRole("link", { name: "Complete setup" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Record or import sales" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Maintain current pace")).not.toBeInTheDocument();
  });
});

describe('Recovery Target — "Why your target changed" (plan §10.3)', () => {
  it("shows the increased wording, reason, and sales-added line when present", async () => {
    currentRecovery = {
      ...recovery,
      changeSincePreviousDay: {
        adjustedDailyTargetDelta: 600,
        salesAdded: 500,
        remainingOpenDaysDelta: -1,
        primaryReason: "sales_added",
      },
    };
    renderPage();
    expect(
      await screen.findByText(/Your adjusted daily target increased by/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Recorded sales are helping close the gap\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/You recorded/)).toBeInTheDocument();
    expect(
      screen.getByText("Composed from your records, not AI-written."),
    ).toBeInTheDocument();
  });

  it("shows the decreased wording for a negative delta", async () => {
    currentRecovery = {
      ...recovery,
      changeSincePreviousDay: {
        adjustedDailyTargetDelta: -300,
        salesAdded: 0,
        remainingOpenDaysDelta: -1,
        primaryReason: "open_day_elapsed",
      },
    };
    renderPage();
    expect(
      await screen.findByText(/Your adjusted daily target decreased by/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /A day has passed, and the remaining amount is now spread across fewer days\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/You recorded/)).not.toBeInTheDocument();
  });

  it("shows decimals for a sub-peso delta and sales-added figure, never rounding to PHP 0", async () => {
    currentRecovery = {
      ...recovery,
      changeSincePreviousDay: {
        adjustedDailyTargetDelta: 0.01,
        salesAdded: 500.5,
        remainingOpenDaysDelta: 0,
        primaryReason: "sales_added",
      },
    };
    renderPage();
    expect(
      await screen.findByText(/Your adjusted daily target increased by/),
    ).toBeInTheDocument();
    // The delta is a fraction of a peso — must render with centavos, not
    // round down to the confusing/empty-feeling "PHP 0".
    expect(screen.getByText("PHP 0.01")).toBeInTheDocument();
    expect(screen.queryByText("PHP 0")).not.toBeInTheDocument();
    // The sales-added figure also carries decimals now.
    expect(screen.getByText("PHP 500.50")).toBeInTheDocument();
  });

  it("renders nothing when changeSincePreviousDay is null", async () => {
    currentRecovery = { ...recovery, changeSincePreviousDay: null };
    renderPage();
    await screen.findByText(/Sales Coverage Target compares/);
    expect(
      screen.queryByText("Why your target changed"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the reason is no_material_change", async () => {
    currentRecovery = {
      ...recovery,
      changeSincePreviousDay: {
        adjustedDailyTargetDelta: 0,
        salesAdded: 0,
        remainingOpenDaysDelta: 0,
        primaryReason: "no_material_change",
      },
    };
    renderPage();
    await screen.findByText(/Sales Coverage Target compares/);
    expect(
      screen.queryByText("Why your target changed"),
    ).not.toBeInTheDocument();
  });
});

describe("Recovery Target — data-quality warning note (plan §8.2/§10.5)", () => {
  it("shows the pending-review/possible-duplicate disclosure when dataWarnings is non-empty", async () => {
    currentRecovery = {
      ...recovery,
      dataWarnings: ["records_pending_review"],
      confirmedSalesThisMonth: 8000,
      provisionalSalesThisMonth: 2000,
    };
    renderPage();
    expect(
      await screen.findByText(
        /Includes PHP 2,000 pending review or flagged as a possible duplicate\./,
      ),
    ).toBeInTheDocument();
  });

  it("does not show the disclosure when dataWarnings is empty", async () => {
    currentRecovery = { ...recovery, dataWarnings: [] };
    renderPage();
    await screen.findByText(/Sales Coverage Target compares/);
    expect(
      screen.queryByText(/pending review or flagged as a possible duplicate/),
    ).not.toBeInTheDocument();
  });
});

describe("Recovery Target — operating calendar (plan §7.2-§7.4/§8.3/§11 Phase 2)", () => {
  it("renders a closed day neutrally, without a target/gap figure or a below/above tone", async () => {
    currentRecovery = {
      ...recovery,
      dailyCoverage: [
        {
          date: "2026-01-19",
          neededTarget: null,
          sales: 0,
          gap: null,
          status: "closed",
          isOperatingDay: false,
        },
        {
          date: "2026-01-18",
          neededTarget: 500,
          sales: 500,
          gap: 0,
          status: "at",
          isOperatingDay: true,
        },
      ],
    };
    renderPage();

    // "Closed" is the pill's text alongside its glyph, so it can't be matched
    // by exact string — the pill's own textContent is "—Closed".
    expect((await screen.findAllByText(/Closed/)).length).toBeGreaterThan(0);
    // Two dashes for the closed row: one in "Needed target", one in "Gap" —
    // rendered as their own plain span, distinct from the pill's glyph dash.
    const dashSpans = screen.getAllByText("—", {
      selector: "span.text-ink-400",
    });
    expect(dashSpans.length).toBeGreaterThanOrEqual(2);
  });

  it('offers "Edit operating schedule" when remaining operating days is approximated', async () => {
    currentRecovery = {
      ...recovery,
      remainingOperatingDaysIsApproximated: true,
    };
    renderPage();

    const link = await screen.findByRole("link", {
      name: /Edit operating schedule/,
    });
    expect(link).toHaveAttribute(
      "href",
      `/business-profiles/${profile.id}/operating-schedule`,
    );
  });

  it('does not offer "Edit operating schedule" once a schedule is configured, and drops the estimate wording', async () => {
    currentRecovery = {
      ...recovery,
      remainingOperatingDaysIsApproximated: false,
      operatingScheduleConfigured: true,
      operatingDaysThisMonth: 24,
    };
    renderPage();

    await screen.findByText(/Based on your configured operating days/);
    expect(
      screen.queryByRole("link", { name: /Edit operating schedule/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Remaining operating days is an estimate/),
    ).not.toBeInTheDocument();
  });
});

describe("Recovery Target — scenario deltas (plan §10.7, Phase 4)", () => {
  async function openScenarioWith(value: string) {
    await userEvent.click(
      await screen.findByRole("button", { name: "Try a scenario" }),
    );
    const input = screen.getByLabelText(/Assumed expected monthly expenses/);
    await userEvent.clear(input);
    await userEvent.type(input, value);
    await userEvent.click(
      screen.getByRole("button", { name: "See hypothetical target" }),
    );
    await screen.findByText("Hypothetical — not saved.");
  }

  it("shows peso and percentage deltas for expected monthly expenses, remaining target, and adjusted daily target", async () => {
    renderPage();
    await openScenarioWith("15000");

    // Expected monthly expenses and remaining target both move by -5000 (one
    // -25%, one -50%), so the peso figure appears twice.
    expect(screen.getAllByText(/−PHP 5,000/).length).toBe(2);
    expect(screen.getByText(/-25%/)).toBeInTheDocument();
    // Adjusted daily target's own -50% delta appears alongside remaining target's.
    expect(screen.getAllByText(/-50%/).length).toBe(2);
    // Adjusted daily target: 1250 -> 625, -625.
    expect(screen.getByText(/−PHP 625/)).toBeInTheDocument();
  });

  it("shows the peso delta only, without a percentage, when the current figure is 0", async () => {
    // A zero current remaining target (fully covered already) must not divide by zero.
    postHandler = () =>
      ({
        data: scenario({
          current: { ...scenario().current, remainingTarget: 0 },
          hypothetical: { ...scenario().hypothetical, remainingTarget: 2000 },
        }),
      }) as unknown as ReturnType<typeof postHandler>;
    renderPage();
    await openScenarioWith("15000");

    // The peso delta for remaining target renders...
    expect(screen.getByText(/\+PHP 2,000/)).toBeInTheDocument();
    // ...but nowhere does a NaN%/Infinity% leak through.
    expect(screen.queryByText(/NaN%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Infinity%/)).not.toBeInTheDocument();
  });

  it("shows the peso delta only, without a percentage, when the current figure is a fraction of a peso", async () => {
    // A near-zero (but nonzero) current remaining target — plausible near
    // month-end as sales approach the coverage goal — must not produce a
    // technically-finite but meaningless percentage like "+99999900%".
    // Distinct from the current === 0 case above: this exercises the
    // Math.abs(current) < 1 floor itself.
    postHandler = () =>
      ({
        data: scenario({
          current: { ...scenario().current, remainingTarget: 0.5 },
          hypothetical: { ...scenario().hypothetical, remainingTarget: 300.5 },
        }),
      }) as unknown as ReturnType<typeof postHandler>;
    renderPage();
    await openScenarioWith("15000");

    // The peso delta for remaining target renders...
    expect(screen.getByText(/\+PHP 300/)).toBeInTheDocument();
    // ...but no percentage accompanies it — a delta of 300 over a 0.5
    // denominator would otherwise render a technically-finite but
    // meaningless "+60000%".
    expect(screen.queryByText(/60000%/)).not.toBeInTheDocument();
    // The "Remaining target" row's own value cell has no "%" in it at all —
    // scoped to that row specifically, since the other rows in this
    // scenario (expected monthly expenses, adjusted daily target) still
    // have normal-sized denominators and legitimately show a percentage.
    const comparisonHeading = screen.getByText("Current vs. hypothetical");
    const comparisonSection = comparisonHeading.parentElement!;
    const remainingTargetLabel =
      within(comparisonSection).getByText("Remaining target");
    const remainingTargetRow = remainingTargetLabel.closest("div")!;
    expect(remainingTargetRow.textContent).not.toMatch(/%/);
  });

  it("shows an explicit, non-alarming note that estimated transactions per day is not available", async () => {
    renderPage();
    await openScenarioWith("15000");

    expect(
      screen.getByText(
        /Not available — FinSight can't yet tell whether your sales records represent/,
      ),
    ).toBeInTheDocument();
  });
});

describe("Recovery Target — weekly checkpoints (plan §10.4, Phase 4)", () => {
  function checkpoint(
    overrides: Partial<RecoveryCheckpoint> = {},
  ): RecoveryCheckpoint {
    return {
      endDate: "2026-01-07",
      cumulativeTarget: 5000,
      recordedAmount: 4500,
      variance: -500,
      status: "behind",
      ...overrides,
    };
  }

  it("shows the current and next checkpoint prominently", async () => {
    currentRecovery = {
      ...recovery,
      asOfDate: "2026-01-10",
      weeklyCheckpoints: [
        checkpoint({ endDate: "2026-01-07", status: "behind" }),
        checkpoint({
          endDate: "2026-01-14",
          recordedAmount: null,
          variance: null,
          status: "pending",
        }),
        checkpoint({
          endDate: "2026-01-21",
          recordedAmount: null,
          variance: null,
          status: "pending",
        }),
      ],
    };
    renderPage();

    expect(await screen.findByText("Current checkpoint")).toBeInTheDocument();
    expect(screen.getByText("Next checkpoint")).toBeInTheDocument();
    // The full list stays secondary — a third checkpoint (21st) is not shown
    // prominently anywhere until the list is expanded.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it('shows "Not yet reached" rather than a null/blank amount for a pending future checkpoint', async () => {
    currentRecovery = {
      ...recovery,
      asOfDate: "2026-01-10",
      weeklyCheckpoints: [
        checkpoint({ endDate: "2026-01-07", status: "behind" }),
        checkpoint({
          endDate: "2026-01-14",
          recordedAmount: null,
          variance: null,
          status: "pending",
        }),
      ],
    };
    renderPage();

    expect(await screen.findAllByText("Not yet reached")).not.toHaveLength(0);
  });

  it("expands to show the full checkpoint list, and collapses again", async () => {
    currentRecovery = {
      ...recovery,
      asOfDate: "2026-01-10",
      weeklyCheckpoints: [
        checkpoint({ endDate: "2026-01-07", status: "behind" }),
        checkpoint({
          endDate: "2026-01-14",
          recordedAmount: null,
          variance: null,
          status: "pending",
        }),
        checkpoint({
          endDate: "2026-01-21",
          recordedAmount: null,
          variance: null,
          status: "pending",
        }),
      ],
    };
    renderPage();

    await userEvent.click(
      await screen.findByRole("button", { name: "Show all checkpoints" }),
    );
    expect(await screen.findByRole("table")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Hide full list" }),
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders nothing when weeklyCheckpoints is absent (older server)", async () => {
    renderPage();
    await screen.findByText(/Sales Coverage Target compares/);
    expect(screen.queryByText("Weekly checkpoints")).not.toBeInTheDocument();
  });
});
