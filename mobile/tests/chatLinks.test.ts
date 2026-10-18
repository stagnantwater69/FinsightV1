import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { CHAT_PAGE_TARGETS, inlineRuns, parseChatBlocks, recordPath } from "../src/lib/chatLinks";

/**
 * Ask FinSight's page buttons navigate by name. React Navigation does nothing
 * at all for a name that is not registered (see navigationTargets.test.ts), so
 * every target here is checked against App.tsx the same way.
 */
function registered(): { tabs: Set<string>; screens: Set<string> } {
  const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
  const tabs = new Set<string>();
  const screens = new Set<string>();
  for (const m of app.matchAll(/<Tab\.Screen\s+name=["']([A-Za-z0-9_]+)["']/g)) tabs.add(m[1]!);
  for (const m of app.matchAll(/<(?:Stack|[A-Z][A-Za-z]*Nav)\.Screen\s+name=["']([A-Za-z0-9_]+)["']/g)) screens.add(m[1]!);
  return { tabs, screens };
}

describe("chat page targets", () => {
  it("point only at registered tabs and screens", () => {
    const { tabs, screens } = registered();
    for (const [key, target] of Object.entries(CHAT_PAGE_TARGETS)) {
      expect(tabs.has(target.tab), `${key} → tab ${target.tab}`).toBe(true);
      expect(screens.has(target.screen), `${key} → screen ${target.screen}`).toBe(true);
    }
  });

  it("loads records through the owner-scoped single-record endpoints", () => {
    expect(recordPath("expense", 343)).toBe("/records/expenses/343");
    expect(recordPath("sales", 9)).toBe("/records/sales/9");
  });
});

describe("chat markdown parse", () => {
  it("splits paragraphs and lists, and finds bold runs", () => {
    expect(parseChatBlocks("Here's why:\n- **Fries** cost more\n- Wrappers too\n\n1. First")).toEqual([
      { kind: "p", lines: ["Here's why:"] },
      { kind: "ul", items: ["**Fries** cost more", "Wrappers too"] },
      { kind: "ol", items: ["First"] },
    ]);
    expect(inlineRuns("**Fries** cost more")).toEqual([
      { text: "Fries", bold: true },
      { text: " cost more", bold: false },
    ]);
  });

  it("leaves markup-looking text as text", () => {
    expect(inlineRuns("<b>hi</b> ** odd")).toEqual([{ text: "<b>hi</b> ** odd", bold: false }]);
  });
});
