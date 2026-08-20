// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  RecurringAgenda,
  agendaGroupOf,
  formatDueDate,
  groupSchedulesByDueState,
  overdueScheduleCount,
} from "./RecurringAgenda";
import type { RecurringSchedule } from "../lib/types";

/**
 * The grouping is the whole feature: a payment in the wrong bucket is worse
 * than no agenda at all, because it says "this can wait" about something that
 * is already late.
 *
 * Every case here drives `dueState` straight from the payload and never from
 * `nextDueDate` — that is the contract with the server, and a test that
 * derived the group from the date would happily pass an implementation that
 * had started recomputing it client-side.
 */

function schedule(over: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    id: 1,
    businessProfileId: 1,
    categoryId: 3,
    categoryName: "Rent",
    label: "Shop rent",
    vendor: null,
    intervalDays: 30,
    expectedAmount: 12000,
    amountTolerance: 0.15,
    nextDueDate: "2026-08-31T00:00:00.000Z",
    lastRecordedDate: null,
    isActive: true,
    sourcePatternId: null,
    dueState: "SCHEDULED",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function renderAgenda(schedules: RecurringSchedule[]) {
  return render(
    <MemoryRouter>
      <RecurringAgenda schedules={schedules} />
    </MemoryRouter>,
  );
}

describe("groupSchedulesByDueState", () => {
  it("puts a schedule in each dueState into its own group, in reading order", () => {
    const groups = groupSchedulesByDueState([
      schedule({ id: 1, dueState: "SCHEDULED" }),
      schedule({ id: 2, dueState: "OVERDUE" }),
      schedule({ id: 3, dueState: "DUE_SOON" }),
    ]);

    expect(groups.map((g) => g.label)).toEqual(["Overdue", "Due soon", "Scheduled"]);
    expect(groups.map((g) => g.items.map((s) => s.id))).toEqual([[2], [3], [1]]);
  });

  it("drops groups with nothing in them rather than showing empty headings", () => {
    const groups = groupSchedulesByDueState([schedule({ dueState: "OVERDUE" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("OVERDUE");
  });

  it("keeps the server's order inside a group", () => {
    const groups = groupSchedulesByDueState([
      schedule({ id: 7, dueState: "OVERDUE" }),
      schedule({ id: 4, dueState: "OVERDUE" }),
    ]);
    expect(groups[0]!.items.map((s) => s.id)).toEqual([7, 4]);
  });

  /*
   * The paused rules below mirror mobile/src/lib/recurringAgenda.ts one for
   * one, including the name of the count test. The server returns a real
   * `dueState` for a paused row too, so anything grouping on `dueState` alone
   * files a switched-off rent under Overdue in alarm colours — and the two
   * clients disagreeing about that is worse than either behaviour on its own.
   */
  it("files a paused schedule under Paused, whatever its dueState says", () => {
    expect(agendaGroupOf(schedule({ isActive: false, dueState: "OVERDUE" }))).toBe("PAUSED");
    expect(agendaGroupOf(schedule({ isActive: true, dueState: "OVERDUE" }))).toBe("OVERDUE");

    const groups = groupSchedulesByDueState([
      schedule({ id: 1, isActive: false, dueState: "OVERDUE" }),
      schedule({ id: 2, isActive: true, dueState: "OVERDUE" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Overdue", "Paused"]);
    expect(groups[0]!.items.map((s) => s.id)).toEqual([2]);
    expect(groups[1]!.items.map((s) => s.id)).toEqual([1]);
  });

  it("does not count a paused schedule, however late it looks", () => {
    expect(
      overdueScheduleCount([
        schedule({ id: 1, isActive: false, dueState: "OVERDUE" }),
        schedule({ id: 2, isActive: true, dueState: "OVERDUE" }),
        schedule({ id: 3, isActive: true, dueState: "DUE_SOON" }),
      ]),
    ).toBe(1);
  });
});

describe("RecurringAgenda", () => {
  it("renders an overdue schedule under the Overdue heading", () => {
    renderAgenda([
      schedule({ id: 1, label: "Staff salary", dueState: "OVERDUE" }),
      schedule({ id: 2, label: "Internet", dueState: "SCHEDULED" }),
    ]);

    const overdue = screen.getByRole("region", { name: "Overdue" });
    // getAllByText, because the label also appears in the Edit link's
    // screen-reader suffix — which is itself worth having: a list of "Edit"
    // links is unnavigable by voice.
    expect(within(overdue).getAllByText("Staff salary").length).toBeGreaterThan(0);
    expect(within(overdue).queryAllByText("Internet")).toHaveLength(0);
    expect(
      within(screen.getByRole("region", { name: "Scheduled" })).getAllByText("Internet").length,
    ).toBeGreaterThan(0);
  });

  it("renders a date-only due date in UTC, not the previous day", () => {
    // 00:00 UTC on the 31st is the 30th anywhere west of UTC. Formatting
    // without timeZone: "UTC" is a real defect class in this codebase, so it
    // is pinned rather than left to review.
    //
    // CI runs on ubuntu-latest, i.e. UTC, where an unforced format agrees with
    // a UTC one and the assertion proves nothing. The process is pushed behind
    // UTC for the duration, exactly as mobile/tests/recurringAgenda.test.ts
    // does, so the missing `timeZone: "UTC"` actually shows up.
    // vi.stubEnv rather than a raw process.env write: the web tsconfig has no
    // node types, and unstubAllEnvs restores the original value either way.
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      // Asserted on the day and month parts rather than on the whole string:
      // the order of the parts is the locale's business.
      expect(formatDueDate("2026-08-31T00:00:00.000Z")).toContain("31");
      expect(formatDueDate("2026-08-31T00:00:00.000Z")).toContain("Aug");
      expect(formatDueDate("2026-08-31T00:00:00.000Z")).not.toContain("30");
      renderAgenda([schedule({ nextDueDate: "2026-08-31T00:00:00.000Z" })]);
      expect(screen.getByText(/\b31\b/)).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says when a schedule is paused instead of quietly hiding it", () => {
    renderAgenda([schedule({ label: "Shop rent", isActive: false })]);
    const paused = screen.getByRole("region", { name: "Paused" });
    expect(within(paused).getAllByText("Shop rent").length).toBeGreaterThan(0);
    expect(
      within(paused).getByText("Kept on file, but FinSight is not watching these."),
    ).toBeInTheDocument();
  });

  it("keeps a paused schedule out of Overdue and out of the overdue badge", () => {
    renderAgenda([
      schedule({ id: 1, label: "Paused rent", isActive: false, dueState: "OVERDUE" }),
      schedule({ id: 2, label: "Staff salary", isActive: true, dueState: "OVERDUE" }),
    ]);
    const overdue = screen.getByRole("region", { name: "Overdue" });
    expect(within(overdue).queryAllByText("Paused rent")).toHaveLength(0);
    expect(screen.getByText("1 overdue")).toBeInTheDocument();
  });

  it("counts overdue schedules on the panel, because that is the decision count", () => {
    renderAgenda([
      schedule({ id: 1, dueState: "OVERDUE" }),
      schedule({ id: 2, dueState: "OVERDUE" }),
      schedule({ id: 3, dueState: "DUE_SOON" }),
    ]);
    expect(screen.getByText("2 overdue")).toBeInTheDocument();
  });

  it("invites the owner to declare one when there are none", () => {
    renderAgenda([]);
    expect(screen.getByText("Nothing scheduled yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a recurring payment" })).toHaveAttribute(
      "href",
      "/insights/recurring-schedules/new",
    );
  });
});
