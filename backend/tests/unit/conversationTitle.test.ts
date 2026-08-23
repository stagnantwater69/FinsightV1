import { describe, expect, it } from "vitest";
import { deriveTitle, TITLE_MAX_LENGTH } from "../../src/services/conversation.service";

/**
 * A conversation's name comes from its first question — no extra model call,
 * because a title is navigation rather than analysis. What matters is that it
 * is never empty, never longer than the column, and never cut mid-word.
 */
describe("deriveTitle", () => {
  it("uses a short question verbatim", () => {
    expect(deriveTitle("Why were my utilities so high last month?")).toBe(
      "Why were my utilities so high last month?",
    );
  });

  it("collapses whitespace and trims", () => {
    expect(deriveTitle("  what\n\nchanged   this   week? ")).toBe("what changed this week?");
  });

  it("never returns an empty title, even for whitespace-only input", () => {
    expect(deriveTitle("   \n\t ")).toBe("New conversation");
  });

  it("truncates at a word boundary and stays inside the column limit", () => {
    const question = `${"word ".repeat(60)}end`;
    const title = deriveTitle(question);

    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    // Cut between words, not through one.
    expect(title.endsWith("word")).toBe(true);
    expect(title.endsWith(" ")).toBe(false);
  });

  it("keeps a question of exactly the limit intact", () => {
    const exact = "a".repeat(TITLE_MAX_LENGTH);
    expect(deriveTitle(exact)).toBe(exact);
    expect(deriveTitle(exact)).toHaveLength(TITLE_MAX_LENGTH);
  });

  it("hard-cuts a single unbroken word rather than collapsing it to nothing", () => {
    // No usable space, so the word-boundary rule must not win here — a
    // 200-character token would otherwise leave an almost empty title.
    const runOn = "x".repeat(200);
    const title = deriveTitle(runOn);
    expect(title).toHaveLength(TITLE_MAX_LENGTH);
  });

  it("does not let a late space produce a stub title", () => {
    // The only space is near the very start; the boundary rule is skipped and
    // the title is cut at the limit instead.
    const question = `a ${"b".repeat(300)}`;
    expect(deriveTitle(question)).toHaveLength(TITLE_MAX_LENGTH);
  });
});
