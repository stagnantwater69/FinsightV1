import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Everything tappable says that it is tappable.
 *
 * WHY: a Pressable with no accessibilityRole is announced by VoiceOver and
 * TalkBack as plain text. The control is reachable — the reader lands on it —
 * but nothing says it can be activated, so it reads as a label and gets swiped
 * past. Six were in that state, including the card that opens the flagged
 * records list and the chips that map CSV columns.
 *
 * Most controls inherit the role from Button, SelectChip or SegmentedControl.
 * This catches the ones written by hand, which is where it goes missing.
 */

const ROOT = join(__dirname, "..");

/**
 * How far past `<Pressable` to look. Opening tags here run to about eight
 * lines with a style object inline; fourteen covers the longest without
 * reaching into the children, where a nested control's own role could
 * otherwise be miscredited to its parent.
 */
const TAG_WINDOW = 14;

function sourceFiles(): { name: string; lines: string[] }[] {
  const dirs = [join(ROOT, "src", "screens"), join(ROOT, "src", "components")];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => ({ name: f, lines: readFileSync(join(dir, f), "utf8").split("\n") })),
  );
}

function pressables(): { where: string; hasRole: boolean }[] {
  const found: { where: string; hasRole: boolean }[] = [];
  for (const { name, lines } of sourceFiles()) {
    lines.forEach((line, i) => {
      if (!line.includes("<Pressable")) return;
      const tag = lines.slice(i, i + TAG_WINDOW).join("\n");
      found.push({ where: `${name}:${i + 1}`, hasRole: tag.includes("accessibilityRole") });
    });
  }
  return found;
}

describe("pressable roles", () => {
  it("finds the pressables at all", () => {
    // Guards the test itself: an empty scan would pass the assertion below
    // while proving nothing.
    expect(pressables().length).toBeGreaterThanOrEqual(20);
  });

  it("gives every hand-written Pressable an accessibility role", () => {
    const bare = pressables().filter((p) => !p.hasRole);
    expect(
      bare.map((p) => p.where),
      `Pressables a screen reader will announce as plain text: ${bare.map((p) => p.where).join(", ")}. ` +
        `Add accessibilityRole (usually "button"), or use Button/SelectChip instead.`,
    ).toEqual([]);
  });
});
