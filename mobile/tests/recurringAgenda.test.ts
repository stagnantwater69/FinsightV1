import { describe, expect, it } from "vitest";
import {
  agendaGroupOf,
  dueDateISO,
  formatDueDate,
  groupSchedules,
  intervalDaysError,
  MAX_INTERVAL_DAYS,
  overdueScheduleCount,
  recurringAvailability,
} from "../src/lib/recurringAgenda";
import type { RecurringSchedule } from "../src/lib/types";

/**
 * The recurring agenda's arrangement rules.
 *
 * WHY THESE ARE WORTH PINNING. The agenda replaced a panel that showed only
 * candidates, and the two defects it existed to fix are both arrangement
 * defects rather than visual ones: an owner with confirmed schedules was told
 * none had been found, and nothing anywhere said which payments were late. A
 * render test cannot be written for this — mobile has no render harness — so
 * the parts that CAN be checked were pulled into pure functions and are held
 * here.
 *
 * The most important assertion in the file is the last one: nothing in this
 * module may work out `dueState` for itself. It is computed server-side so web
 * and mobile cannot disagree about the boundary.
 */

function schedule(over: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 1,
    businessProfileId: 1,
    categoryId: 3,
    categoryName: "Utilities",
    label: "Shop rent",
    vendor: null,
    intervalDays: 30,
    expectedAmount: 12000,
    amountTolerance: 0.15,
    nextDueDate: "2026-05-31T00:00:00.000Z",
    lastRecordedDate: null,
    isActive: true,
    sourcePatternId: null,
    dueState: "SCHEDULED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("recurring agenda grouping", () => {
  it("puts an overdue schedule in the Overdue group", () => {
    const groups = groupSchedules([schedule({ id: 7, dueState: "OVERDUE" })]);
    expect(groups[0]!.key).toBe("OVERDUE");
    expect(groups[0]!.title).toBe("Overdue");
    expect(groups[0]!.items.map((s) => s.id)).toEqual([7]);
  });

  it("reads Overdue, then Due soon, then Scheduled, then Paused", () => {
    const groups = groupSchedules([
      schedule({ id: 1, dueState: "SCHEDULED" }),
      schedule({ id: 2, dueState: "OVERDUE" }),
      schedule({ id: 3, dueState: "OVERDUE", isActive: false }),
      schedule({ id: 4, dueState: "DUE_SOON" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["OVERDUE", "DUE_SOON", "SCHEDULED", "PAUSED"]);
    expect(groups.map((g) => g.items.map((s) => s.id))).toEqual([[2], [4], [1], [3]]);
  });

  it("drops empty groups rather than heading an empty list", () => {
    const groups = groupSchedules([schedule({ dueState: "DUE_SOON" })]);
    expect(groups.map((g) => g.key)).toEqual(["DUE_SOON"]);
  });

  it("returns nothing at all for no schedules, so the caller can say so once", () => {
    expect(groupSchedules([])).toEqual([]);
  });

  it("keeps the server's order within a group", () => {
    // The list arrives sorted soonest-due first. Re-sorting here would be a
    // second opinion about the same question.
    const groups = groupSchedules([
      schedule({ id: 10, dueState: "OVERDUE" }),
      schedule({ id: 11, dueState: "OVERDUE" }),
      schedule({ id: 12, dueState: "OVERDUE" }),
    ]);
    expect(groups[0]!.items.map((s) => s.id)).toEqual([10, 11, 12]);
  });

  it("sends a paused schedule to Paused whatever its due state says", () => {
    // The server still computes a due state for a paused row. Left in place it
    // would be listed under "Overdue" in alarm colours while FinSight is
    // deliberately not watching it.
    for (const dueState of ["OVERDUE", "DUE_SOON", "SCHEDULED"] as const) {
      expect(agendaGroupOf(schedule({ dueState, isActive: false }))).toBe("PAUSED");
    }
  });
});

describe("the section badge", () => {
  it("counts overdue schedules", () => {
    expect(
      overdueScheduleCount([
        schedule({ id: 1, dueState: "OVERDUE" }),
        schedule({ id: 2, dueState: "OVERDUE" }),
        schedule({ id: 3, dueState: "DUE_SOON" }),
        schedule({ id: 4, dueState: "SCHEDULED" }),
      ]),
    ).toBe(2);
  });

  it("does not count a paused schedule, however late it looks", () => {
    expect(overdueScheduleCount([schedule({ dueState: "OVERDUE", isActive: false })])).toBe(0);
  });

  it("is zero when nothing is late, so no badge is drawn", () => {
    expect(overdueScheduleCount([schedule({ dueState: "SCHEDULED" })])).toBe(0);
    expect(overdueScheduleCount([])).toBe(0);
  });
});

/**
 * WHAT THE RECURRING SECTION MAY SHOW WHEN THE SERVER WILL NOT ANSWER.
 *
 * `GET /insights/recurring-schedules` is behind the backend's
 * ANOMALY_RECURRING_ENABLED flag, which defaults OFF and answers 404 while it
 * is — so a failed read is this endpoint's ORDINARY behaviour today, not an
 * edge case. The screen previously turned that into `data ?? []`, which drew
 * two wrong things at once: the server's bare "Not found" in an error note, and
 * the "No repeating payments yet" empty state, which tells an owner FinSight
 * looked and found nothing about THEIR business. It looked at nothing.
 *
 * These pin the three consequences the screen leans on, all of which can be
 * checked without a render harness: the agenda is hidden rather than emptied,
 * the badge counts nothing, and Confirm is off because the endpoint behind it
 * is behind the same gate.
 */
describe("the recurring section when the schedules endpoint will not answer", () => {
  it("hides the agenda rather than reporting an empty one", () => {
    // Null, not []. [] is the screen's cue to say "no repeating payments yet",
    // which is a claim about the owner's business we have no basis for.
    const view = recurringAvailability({ data: null, error: "Not found" });
    expect(view.schedules).toBeNull();
  });

  it("shows no badge, since it counted overdue schedules it never received", () => {
    expect(recurringAvailability({ data: null, error: "Not found" }).overdueCount).toBe(0);
  });

  it("withholds Confirm, whose endpoint sits behind the same server gate", () => {
    // POST /insights/recurring-patterns/:id/confirm creates a schedule, so it
    // 404s exactly when the read does. Leaving the button would be a control
    // that can only fail.
    expect(recurringAvailability({ data: null, error: "Not found" }).canConfirm).toBe(false);
  });

  it("hides the agenda for ANY failure, not only the feature flag's 404", () => {
    // Nothing here asks WHY the read failed. A 500 or a dead connection leaves
    // us knowing exactly as much about the owner's schedules as a 404 does, and
    // sniffing for one status would leave the same lie in place for the rest.
    for (const error of [
      "FinSight's server had a problem with that. Please try again in a moment.",
      "Couldn't reach FinSight. Check your internet connection",
      "Your session has expired. Please log in again.",
    ]) {
      expect(recurringAvailability({ data: null, error }).schedules).toBeNull();
    }
  });

  it("drops schedules already on screen when a later read fails", () => {
    // useInsight keeps the previous payload on a failed refetch. Right for a
    // screen's main read, wrong here: the flag being switched off mid-session
    // would leave an agenda up whose rows all 404 when opened.
    const view = recurringAvailability({
      data: [schedule({ id: 1, dueState: "OVERDUE" })],
      error: "Not found",
    });
    expect(view.schedules).toBeNull();
    expect(view.overdueCount).toBe(0);
    expect(view.canConfirm).toBe(false);
  });
});

describe("the recurring section when the schedules endpoint answers", () => {
  it("passes the agenda through and counts its overdue rows", () => {
    const view = recurringAvailability({
      data: [
        schedule({ id: 1, dueState: "OVERDUE" }),
        schedule({ id: 2, dueState: "SCHEDULED" }),
      ],
      error: null,
    });
    expect(view.schedules?.map((s) => s.id)).toEqual([1, 2]);
    expect(view.overdueCount).toBe(1);
    expect(view.canConfirm).toBe(true);
  });

  it("distinguishes a genuinely empty agenda from an unread one", () => {
    // THE EMPTY LIST IS STILL AN ANSWER. An owner who has declared nothing gets
    // the empty state and its "add a repeating payment" button, which is the
    // one case where "nothing here" is true.
    const view = recurringAvailability({ data: [], error: null });
    expect(view.schedules).toEqual([]);
    expect(view.canConfirm).toBe(true);
  });

  it("treats a read still in flight as available, so the tab does not flicker away", () => {
    // Before the first response there is no error yet. Reporting unavailable
    // here would pull the Recurring tab off screen and put it back a moment
    // later on every visit.
    expect(recurringAvailability({ data: null, error: null }).schedules).toEqual([]);
  });
});

describe("due dates", () => {
  /*
   * `nextDueDate` is a @db.Date. It serializes as midnight UTC, so formatting
   * it in the device's own zone shows the previous day anywhere behind UTC —
   * the same silent off-by-one DateField's header describes from the other
   * direction. Asserted by forcing the process into a zone behind UTC.
   */
  it("renders the stored day, not the day before, behind UTC", () => {
    const original = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      // Asserted on the day and month rather than on the whole string: the
      // order of the parts is the locale's business, and pinning it here would
      // fail the day en-PH's rules are updated without anything being wrong.
      expect(formatDueDate("2026-05-31T00:00:00.000Z")).toContain("31");
      expect(formatDueDate("2026-05-31T00:00:00.000Z")).toContain("May");
      expect(formatDueDate("2026-01-01T00:00:00.000Z")).toContain("1");
      expect(formatDueDate("2026-01-01T00:00:00.000Z")).toContain("Jan");
      expect(formatDueDate("2026-01-01T00:00:00.000Z")).not.toContain("Dec");
    } finally {
      process.env.TZ = original;
    }
  });

  it("says nothing rather than 'Invalid Date' for an unusable value", () => {
    expect(formatDueDate("")).toBe("");
    expect(formatDueDate("not a date")).toBe("");
  });

  it("hands the form a plain YYYY-MM-DD, sliced rather than re-parsed", () => {
    expect(dueDateISO("2026-05-31T00:00:00.000Z")).toBe("2026-05-31");
    expect(dueDateISO("2026-05-31")).toBe("2026-05-31");
  });
});

describe("what this module refuses to do", () => {
  it("never decides for itself whether something is due", () => {
    // `dueState` is computed server-side precisely so the two clients cannot
    // drift on the boundary. A schedule dated years ago is still SCHEDULED
    // here if that is what the server said — this module arranges, it does not
    // judge.
    const stale = schedule({ nextDueDate: "2020-01-01T00:00:00.000Z", dueState: "SCHEDULED" });
    expect(agendaGroupOf(stale)).toBe("SCHEDULED");
    expect(overdueScheduleCount([stale])).toBe(0);
  });
});

/**
 * The interval ceiling, which the server states as
 * `intervalDays: z.number().int().positive().max(366)` and web mirrors as
 * `max={366}` on its number input. Mobile had only the lower bound, so an
 * over-long interval was posted and came back as a bare "Validation failed".
 */
describe("the interval a schedule may repeat on", () => {
  it("agrees with the server's ceiling of 366 days", () => {
    expect(MAX_INTERVAL_DAYS).toBe(366);
  });

  it("accepts everything from one day up to the ceiling", () => {
    expect(intervalDaysError(1)).toBeNull();
    expect(intervalDaysError(30)).toBeNull();
    expect(intervalDaysError(366)).toBeNull();
  });

  it("turns back an interval longer than the ceiling, naming the limit", () => {
    const message = intervalDaysError(400);
    expect(message).not.toBeNull();
    // Not the generic lower-bound sentence — the owner is told what the
    // ceiling is, which the server's "Validation failed" never says.
    expect(message).toContain("366");
    expect(message).not.toContain("whole number");
  });

  it("still turns back zero, negatives and fractions", () => {
    expect(intervalDaysError(0)).toContain("whole number");
    expect(intervalDaysError(-7)).toContain("whole number");
    expect(intervalDaysError(1.5)).toContain("whole number");
    expect(intervalDaysError(Number.NaN)).toContain("whole number");
  });
});
