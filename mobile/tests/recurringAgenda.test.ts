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

function requestError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
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
 * A 404 disables the feature, an initial transient failure stays fail-closed,
 * and a transient refresh keeps the last verified agenda on screen.
 */
describe("recurring schedule availability failures", () => {
  it("hides an initially unavailable agenda rather than reporting an empty one", () => {
    const view = recurringAvailability({
      data: null,
      error: requestError(503, "Schedules are temporarily unavailable."),
    });
    expect(view.schedules).toBeNull();
    expect(view.overdueCount).toBe(0);
    expect(view.canConfirm).toBe(false);
    expect(view.failure).toBe("initial");
  });

  it("treats a 404 as definitive feature unavailability even with cached rows", () => {
    const view = recurringAvailability({
      data: [schedule({ id: 1, dueState: "OVERDUE" })],
      error: requestError(404, "Not found"),
    });
    expect(view).toEqual({
      schedules: null,
      canConfirm: false,
      overdueCount: 0,
      failure: null,
    });
  });

  it("retains cached rows after a transient refresh failure", () => {
    const view = recurringAvailability({
      data: [schedule({ id: 1, dueState: "OVERDUE" })],
      error: requestError(503, "Schedules are temporarily unavailable."),
    });
    expect(view.schedules?.map((item) => item.id)).toEqual([1]);
    expect(view.overdueCount).toBe(1);
    expect(view.canConfirm).toBe(true);
    expect(view.failure).toBe("refresh");
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
    expect(view.failure).toBeNull();
  });

  it("distinguishes a genuinely empty agenda from an unread one", () => {
    // THE EMPTY LIST IS STILL AN ANSWER. An owner who has declared nothing gets
    // the empty state and its "add a repeating payment" button, which is the
    // one case where "nothing here" is true.
    const view = recurringAvailability({ data: [], error: null });
    expect(view.schedules).toEqual([]);
    expect(view.canConfirm).toBe(true);
    expect(view.failure).toBeNull();
  });

  it("treats a read still in flight as available, so the tab does not flicker away", () => {
    // Before the first response there is no error yet. Reporting unavailable
    // here would pull the Recurring tab off screen and put it back a moment
    // later on every visit.
    expect(recurringAvailability({ data: null, error: null })).toEqual({
      schedules: [],
      canConfirm: true,
      overdueCount: 0,
      failure: null,
    });
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
