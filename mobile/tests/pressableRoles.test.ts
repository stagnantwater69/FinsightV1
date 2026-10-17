import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

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
 * Every .tsx file under a directory, at any depth, named relative to it.
 *
 * Recursive because both screens and components now nest feature
 * subdirectories (screens/records/, components/receipt-camera/) — a flat
 * readdirSync would silently stop seeing an entire subdirectory's Pressables
 * the moment it was moved into one.
 */
function tsxFilesUnder(dir: string, prefix = ""): { name: string; full: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFilesUnder(full, `${prefix}${entry.name}/`);
    return entry.name.endsWith(".tsx") ? [{ name: `${prefix}${entry.name}`, full }] : [];
  });
}

function sourceFiles(): { name: string; src: string }[] {
  const dirs = [join(ROOT, "src", "screens"), join(ROOT, "src", "components")];
  return dirs.flatMap((dir) =>
    tsxFilesUnder(dir).map(({ name, full }) => ({ name, src: readFileSync(full, "utf8") })),
  );
}

function scanPressables(name: string, src: string): { where: string; hasRole: boolean }[] {
  const found: { where: string; hasRole: boolean }[] = [];
  // A line window truncates long tags and can borrow a nested child's role.
  const source = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "Pressable") {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const hidden = attributes.some((attribute) =>
        attribute.name.getText(source) === "accessible" && attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword,
      ) && attributes.some((attribute) =>
        attribute.name.getText(source) === "importantForAccessibility" && attribute.initializer &&
        ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === "no-hide-descendants",
      );
      // Hidden modal backdrops have an accessible close button elsewhere.
      if (hidden) return;
      const hasRole = attributes.some((attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "accessibilityRole",
      );
      found.push({ where: `${name}:${line}`, hasRole });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function pressables(): { where: string; hasRole: boolean }[] {
  return sourceFiles().flatMap(({ name, src }) => scanPressables(name, src));
}

describe("pressable roles", () => {
  it("reads the complete opening tag when comments precede its role", () => {
    const comments = Array.from({ length: 20 }, (_, i) => `// comment ${i}`).join("\n");
    expect(scanPressables("fixture.tsx", `<Pressable\n${comments}\naccessibilityRole="button">Label</Pressable>`))
      .toEqual([{ where: "fixture.tsx:1", hasRole: true }]);
  });

  it("does not borrow a nested child's role or a role mentioned in a comment", () => {
    expect(scanPressables("fixture.tsx", '<Pressable /* accessibilityRole="button" */>\n<Pressable accessibilityRole="button" />\n</Pressable>'))
      .toEqual([{ where: "fixture.tsx:1", hasRole: false }, { where: "fixture.tsx:2", hasRole: true }]);
  });

  it("finds separate self-closing tags and requires the exact role attribute", () => {
    expect(scanPressables("fixture.tsx", '<><Pressable accessibilityRole="button" /><Pressable accessibilityRoleHint="button" /></>'))
      .toEqual([{ where: "fixture.tsx:1", hasRole: true }, { where: "fixture.tsx:1", hasRole: false }]);
  });

  it("excludes only Pressables explicitly hidden from both platforms", () => {
    expect(scanPressables("fixture.tsx", '<>\n<Pressable accessible={false} importantForAccessibility="no-hide-descendants" />\n<Pressable accessible={false} />\n<Pressable importantForAccessibility="no-hide-descendants" />\n<Pressable accessible={true} importantForAccessibility="no-hide-descendants" />\n</>'))
      .toEqual([
        { where: "fixture.tsx:3", hasRole: false },
        { where: "fixture.tsx:4", hasRole: false },
        { where: "fixture.tsx:5", hasRole: false },
      ]);
  });

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
