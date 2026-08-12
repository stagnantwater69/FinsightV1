import { describe, expect, it } from "vitest";
import { pickHeadline } from "../src/lib/homeInsight";
import type { DashboardSummary, Notification, RecoveryTargets } from "../src/lib/types";

/**
 * This used to be four bullet points shown together ("At a glance"); folded
 * into the greeting, Fin has room for exactly one line, so WHICH one is
 * chosen is now a real decision rather than a display-order preference.
 *
 * The case worth guarding most: an owner with records needing review should
 * be told that, not handed a cheerful "your biggest cost is X" while three
 * receipts sit unresolved. That priority inversion — actionable before
 * informational — is the whole reason this file exists rather than just
 * reusing the old card's line order.
 */

const RECOVERY: RecoveryTargets = {
  expectedMonthlyExpenses: 30000,
  operatingDays: 26,
  dailyNeededTarget: 1000,
  salesThisMonth: 10000,
  remainingTarget: 0,
  daysInMonth: 30,
  calendarDaysLeftInMonth: 10,
  remainingOperatingDays: 0,
  remainingOperatingDaysIsApproximated: false,
  adjustedDailyTarget: 0,
  todaysTarget: 0,
  todaysSales: 0,
  todaysGap: 0,
  todaysStatus: "at",
  monthCoveragePercent: 100,
  onTrack: true,
};

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    businessProfileId: 1,
    message: "A notification",
    type: "duplicate",
    dateCreated: "2026-08-01",
    readStatus: false,
    ...overrides,
  };
}

function summary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    periodDays: 30,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    overview: { availableFunds: 5000, totalExpenses: 0, totalSalesReference: 0 },
    expenseCategoryBreakdown: [],
    recoveryStatus: RECOVERY,
    recordsNeedingReview: 0,
    alerts: [],
    ...overrides,
  };
}

describe("pickHeadline", () => {
  it("puts records needing review ahead of everything else", () => {
    const h = pickHeadline(
      summary({
        recordsNeedingReview: 2,
        overview: { availableFunds: 0, totalExpenses: 5000, totalSalesReference: 0 },
        expenseCategoryBreakdown: [{ categoryId: 1, categoryName: "Rent", total: 5000, percent: 100 }],
        alerts: [notification({ readStatus: false })],
      }),
    );
    expect(h).toEqual({ text: "You have 2 records waiting for a second look.", tone: "warn" });
  });

  it("singularises a lone record needing review", () => {
    const h = pickHeadline(summary({ recordsNeedingReview: 1 }));
    expect(h?.text).toBe("You have 1 record waiting for a second look.");
  });

  it("never mentions unread alerts — the bell's badge already counts them", () => {
    /*
     * This branch used to exist and ranked SECOND. It was removed when Fin's
     * line moved onto the header's bell: the badge on that very icon shows the
     * unread count as a number, so the sentence hanging off it was reading its
     * own badge back to the owner, and spending the screen's one line to do it.
     *
     * Guarded rather than simply deleted, because the pull to re-add it is
     * real — unread alerts are actionable, and "actionable first" is this
     * module's own rule. The reason it stays out is about WHERE the sentence is
     * shown, which is not visible from inside this file.
     */
    const h = pickHeadline(
      summary({ alerts: [notification({ readStatus: false }), notification({ readStatus: false })] }),
    );
    expect(h?.text).not.toMatch(/alert/i);
    // Falls through to the next branch rather than going quiet.
    expect(h).toEqual({ text: "This month's expenses are already covered — nice work!", tone: "plain" });
  });

  it("says the same thing whether or not there are unread alerts", () => {
    // The strongest form of the rule above: alerts must not influence the line
    // at all, not merely fail to be its subject.
    const withAlerts = pickHeadline(
      summary({
        overview: { availableFunds: 0, totalExpenses: 800, totalSalesReference: 0 },
        recoveryStatus: null as unknown as RecoveryTargets,
        expenseCategoryBreakdown: [{ categoryId: 1, categoryName: "Rent", total: 800, percent: 100 }],
        alerts: [notification({ readStatus: false }), notification({ readStatus: false })],
      }),
    );
    const withoutAlerts = pickHeadline(
      summary({
        overview: { availableFunds: 0, totalExpenses: 800, totalSalesReference: 0 },
        recoveryStatus: null as unknown as RecoveryTargets,
        expenseCategoryBreakdown: [{ categoryId: 1, categoryName: "Rent", total: 800, percent: 100 }],
        alerts: [],
      }),
    );
    expect(withAlerts).toEqual(withoutAlerts);
  });

  it("falls to the recovery gap when there is nothing actionable", () => {
    const h = pickHeadline(
      summary({
        recoveryStatus: { ...RECOVERY, remainingTarget: 2000, remainingOperatingDays: 4 },
      }),
    );
    expect(h?.tone).toBe("plain");
    expect(h?.text).toContain("You still need PHP 2,000 more this month");
    expect(h?.text).toContain("PHP 500 a day");
  });

  it("says the month is covered when the gap is closed", () => {
    const h = pickHeadline(summary({ recoveryStatus: { ...RECOVERY, remainingTarget: 0 } }));
    expect(h).toEqual({ text: "This month's expenses are already covered — nice work!", tone: "plain" });
  });

  it("falls to the biggest category once nothing else applies", () => {
    const h = pickHeadline(
      summary({
        // remainingTarget <= 0 but no recoveryStatus branch fires past it
        // unless spending exists — set totalExpenses so the category branch
        // is reached instead of "covered".
        recoveryStatus: null as unknown as RecoveryTargets,
        overview: { availableFunds: 0, totalExpenses: 1000, totalSalesReference: 0 },
        expenseCategoryBreakdown: [
          { categoryId: 1, categoryName: "Supplies", total: 750, percent: 75 },
          { categoryId: 2, categoryName: "Utilities", total: 250, percent: 25 },
        ],
      }),
    );
    expect(h).toEqual({
      text: "Supplies is your biggest cost so far, at 75% of what you've spent.",
      tone: "plain",
    });
  });

  it("says nothing was recorded yet when the period is empty", () => {
    const h = pickHeadline(
      summary({
        recoveryStatus: null as unknown as RecoveryTargets,
        overview: { availableFunds: 0, totalExpenses: 0, totalSalesReference: 0 },
      }),
    );
    expect(h).toEqual({
      text: "Nothing's been recorded yet this period — add your first expense or sale.",
      tone: "plain",
    });
  });

  it("returns null rather than force a sentence out of no data", () => {
    // Money moved (so "nothing recorded" does not fire) but nothing broke it
    // down by category, no recovery status, nothing needing review or unread
    // — a shape the dashboard should not normally produce, but pickHeadline
    // must not invent a sentence for it either.
    const h = pickHeadline(
      summary({
        recoveryStatus: null as unknown as RecoveryTargets,
        overview: { availableFunds: 0, totalExpenses: 500, totalSalesReference: 0 },
        expenseCategoryBreakdown: [],
      }),
    );
    expect(h).toBeNull();
  });

  it("writes a real sentence, not a bare fragment — one clause, one idea", () => {
    const cases = [
      summary({ recordsNeedingReview: 3 }),
      summary({ recoveryStatus: { ...RECOVERY, remainingTarget: 500, remainingOperatingDays: 2 } }),
      summary({ recoveryStatus: { ...RECOVERY, remainingTarget: 0 } }),
      summary({
        recoveryStatus: null as unknown as RecoveryTargets,
        overview: { availableFunds: 0, totalExpenses: 100, totalSalesReference: 0 },
        expenseCategoryBreakdown: [{ categoryId: 1, categoryName: "Rent", total: 100, percent: 100 }],
      }),
      summary({
        recoveryStatus: null as unknown as RecoveryTargets,
        overview: { availableFunds: 0, totalExpenses: 0, totalSalesReference: 0 },
      }),
    ];
    for (const s of cases) {
      const h = pickHeadline(s);
      expect(h).not.toBeNull();
      // Long enough to be a real sentence rather than a label like "3 unread
      // alerts." — the exact bug this test guards against, per the module
      // header's "one sentence, not a fragment" note.
      expect(h!.text.length).toBeGreaterThanOrEqual(30);
      // Still one spoken line, not a paragraph: at most one full stop. Some
      // of these end in "!" instead and have none at all, hence the ?? 0.
      expect(h!.text.match(/\./g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(h!.text.length).toBeLessThanOrEqual(110);
    }
  });
});
