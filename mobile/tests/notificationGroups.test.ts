import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, relativeTime } from "../src/lib/notificationGroups";

// Noon local time, so whole-day offsets never cross a midnight by accident.
const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
const at = (daysAgo: number, hours = 0) => new Date(now - daysAgo * 86_400_000 - hours * 3_600_000).toISOString();

describe("notification grouping", () => {
  it("labels days the way the web list does", () => {
    expect(dayLabel(at(0), now)).toBe("Today");
    expect(dayLabel(at(1), now)).toBe("Yesterday");
    expect(dayLabel(at(3), now)).toBe("Earlier this week");
    expect(dayLabel(at(12), now)).toBe("Earlier this month");
    expect(dayLabel("not a date", now)).toBe("Earlier");
  });

  it("states recent times relatively", () => {
    expect(relativeTime(new Date(now - 20_000).toISOString(), now)).toBe("just now");
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(relativeTime(at(0, 3), now)).toBe("3h ago");
    expect(relativeTime(at(2), now)).toBe("2d ago");
  });

  it("keeps newest-first order inside and across groups", () => {
    const items = [
      { id: 1, dateCreated: at(0, 1) },
      { id: 2, dateCreated: at(0, 2) },
      { id: 3, dateCreated: at(1) },
      { id: 4, dateCreated: at(4) },
    ];
    expect(groupByDay(items, now).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", [1, 2]],
      ["Yesterday", [3]],
      ["Earlier this week", [4]],
    ]);
  });
});
