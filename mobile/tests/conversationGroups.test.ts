import { describe, expect, it } from "vitest";
import { groupConversations } from "../src/lib/conversationGroups";
import type { Conversation } from "../src/lib/types";

/**
 * The five headings the chat history list is read through.
 *
 * The boundaries are the whole risk here: both headings name a window that
 * INCLUDES today, so "Previous 7 Days" must not be allowed to hold an eighth
 * day. The cases below sit exactly on each edge, plus the midnight case that
 * calendar-day bucketing exists for.
 *
 * That the app and the website agree about all of this is pinned separately,
 * in webParity.test.ts — the two files are deliberate copies.
 */

const NOW = new Date(2026, 7, 23, 9, 30); // 23 Aug 2026, local time

function at(date: Date, id = date.getTime()): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    originModule: "Dashboard",
    createdAt: date.toISOString(),
    lastMessageAt: date.toISOString(),
  };
}

const daysBefore = (days: number, hours = 12) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days, hours);

describe("date bucketing", () => {
  it("uses the five labels in order, omitting the empty ones", () => {
    const groups = groupConversations([at(daysBefore(0)), at(daysBefore(40))], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Older"]);
  });

  it("files last night at 23:59 under Yesterday, not Today", () => {
    // Twelve minutes old at 00:11 and still Yesterday: this is why the bucket
    // counts calendar days rather than elapsed hours.
    const justBeforeMidnight = new Date(2026, 7, 22, 23, 59);
    const earlyMorning = new Date(2026, 7, 23, 0, 11);
    const groups = groupConversations([at(justBeforeMidnight)], earlyMorning);
    expect(groups.map((g) => g.label)).toEqual(["Yesterday"]);
  });

  it("keeps the seven-day window seven days wide", () => {
    expect(groupConversations([at(daysBefore(6))], NOW)[0]?.label).toBe("Previous 7 Days");
    expect(groupConversations([at(daysBefore(7))], NOW)[0]?.label).toBe("Previous 30 Days");
  });

  it("keeps the thirty-day window thirty days wide", () => {
    expect(groupConversations([at(daysBefore(29))], NOW)[0]?.label).toBe("Previous 30 Days");
    expect(groupConversations([at(daysBefore(30))], NOW)[0]?.label).toBe("Older");
  });

  it("treats a future-dated row as today rather than inventing a sixth bucket", () => {
    const groups = groupConversations([at(daysBefore(-2))], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today"]);
  });

  it("sorts newest first inside a bucket", () => {
    const older = at(daysBefore(3, 8), 1);
    const newer = at(daysBefore(3, 20), 2);
    const groups = groupConversations([older, newer], NOW);
    expect(groups[0]?.conversations.map((c) => c.id)).toEqual([2, 1]);
  });

  /** A bad timestamp is not a reason to make someone's conversation unreachable. */
  it("keeps an unparseable date at the end instead of dropping it", () => {
    const broken = { ...at(daysBefore(0)), id: 99, lastMessageAt: "not a date" };
    const groups = groupConversations([at(daysBefore(0), 1), broken], NOW);
    expect(groups.at(-1)?.label).toBe("Older");
    expect(groups.at(-1)?.conversations.map((c) => c.id)).toEqual([99]);
  });
});
