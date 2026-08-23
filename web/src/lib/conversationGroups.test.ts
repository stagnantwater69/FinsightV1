import { describe, expect, it } from "vitest";
import { groupConversations } from "./conversationGroups";
import type { Conversation } from "./types";

/**
 * The boundaries are the whole point of this file. Every bug a date bucketer
 * has is at an edge: something recorded twelve minutes ago filed under
 * "Yesterday", or an eighth day showing up under a heading that says seven.
 *
 * "Now" is fixed at mid-morning rather than at midnight so the calendar-day
 * arithmetic is actually exercised — with `now` at 00:00 the local-midnight
 * flattening is a no-op and a broken implementation would still pass.
 */
const NOW = new Date(2026, 7, 23, 10, 30); // 23 Aug 2026, local

function at(date: Date, id = date.getTime()): Conversation {
  return {
    id,
    title: date.toISOString(),
    originModule: "Dashboard",
    createdAt: date.toISOString(),
    lastMessageAt: date.toISOString(),
  };
}

/** `days` calendar days before NOW, at the given local time of day. */
function daysBefore(days: number, hours = 12, minutes = 0): Date {
  return new Date(2026, 7, 23 - days, hours, minutes);
}

function labels(conversations: Conversation[]) {
  return groupConversations(conversations, NOW).map((g) => g.label);
}

describe("groupConversations", () => {
  it("omits empty buckets rather than showing a heading with nothing under it", () => {
    expect(groupConversations([], NOW)).toEqual([]);
    expect(labels([at(daysBefore(0))])).toEqual(["Today"]);
  });

  it("keeps the five headings in their fixed order, newest bucket first", () => {
    const conversations = [
      at(daysBefore(45)),
      at(daysBefore(0)),
      at(daysBefore(10)),
      at(daysBefore(1)),
      at(daysBefore(3)),
    ];
    expect(labels(conversations)).toEqual([
      "Today",
      "Yesterday",
      "Previous 7 Days",
      "Previous 30 Days",
      "Older",
    ]);
  });

  it("files 23:59 yesterday under Yesterday, not Today", () => {
    // Twelve hours of elapsed time, but a different page of the calendar —
    // and "yesterday" is a statement about the calendar.
    expect(labels([at(daysBefore(1, 23, 59))])).toEqual(["Yesterday"]);
  });

  it("files 00:01 today under Today even when it is minutes old", () => {
    expect(labels([at(new Date(2026, 7, 23, 0, 1))])).toEqual(["Today"]);
  });

  it("puts exactly 7 days ago in Previous 30 Days, and 6 days ago in Previous 7 Days", () => {
    // The heading says seven; the seventh day back is the first one outside
    // the window it names.
    expect(labels([at(daysBefore(6))])).toEqual(["Previous 7 Days"]);
    expect(labels([at(daysBefore(7))])).toEqual(["Previous 30 Days"]);
  });

  it("puts exactly 30 days ago in Older, and 29 days ago in Previous 30 Days", () => {
    expect(labels([at(daysBefore(29))])).toEqual(["Previous 30 Days"]);
    expect(labels([at(daysBefore(30))])).toEqual(["Older"]);
  });

  it("sorts newest first inside a bucket, whatever order the API returned", () => {
    const morning = at(daysBefore(0, 8), 1);
    const noon = at(daysBefore(0, 12), 2);
    const evening = at(daysBefore(0, 20), 3);

    const [today] = groupConversations([morning, evening, noon], NOW);
    expect(today!.conversations.map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it("treats a future-dated row as Today rather than inventing a bucket", () => {
    // Clock skew between the server and the browser is the realistic source.
    expect(labels([at(new Date(2026, 7, 24, 9, 0))])).toEqual(["Today"]);
  });

  it("keeps an unparseable date reachable at the end instead of dropping it", () => {
    const broken: Conversation = { ...at(daysBefore(0)), id: 99, lastMessageAt: "not a date" };
    const groups = groupConversations([broken], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Older");
    expect(groups[0]!.conversations[0]!.id).toBe(99);
  });

  it("does not mutate or reorder the array it was given", () => {
    const input = [at(daysBefore(0, 8), 1), at(daysBefore(0, 20), 2)];
    groupConversations(input, NOW);
    expect(input.map((c) => c.id)).toEqual([1, 2]);
  });
});
