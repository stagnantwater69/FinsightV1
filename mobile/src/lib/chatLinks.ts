import type { ChatPageKey } from "./types";
import type { TabScreenTarget } from "../navigation/types";

/**
 * Where Ask FinSight's page buttons go on mobile: a tab and the screen inside
 * its stack, in the `navigate(tab, { screen })` form React Navigation needs to
 * reach a nested screen.
 *
 * The server only ever sends a page KEY from a fixed catalogue, so the model
 * can never steer the app anywhere this table does not list.
 * tests/chatLinks.test.ts checks every target is a registered screen.
 */
export const CHAT_PAGE_TARGETS: Record<ChatPageKey, TabScreenTarget> = {
  dashboard: { tab: "Dashboard", screen: "DashboardHome" },
  records: { tab: "Records", screen: "RecordsList" },
  "review-queue": { tab: "Records", screen: "FlaggedRecords" },
  "expense-insights": { tab: "Insights", screen: "ExpenseBehavior" },
  recovery: { tab: "Insights", screen: "RecoveryTarget" },
  "spending-impact": { tab: "Insights", screen: "SpendingImpact" },
  categories: { tab: "Records", screen: "Categories" },
  "add-expense": { tab: "Records", screen: "AddExpense" },
  "add-sales": { tab: "Records", screen: "AddSales" },
  "scan-receipt": { tab: "Records", screen: "ScanReceipt" },
};

/** The single-record endpoint a reference is loaded from before EditRecord opens. */
export function recordPath(recordType: "expense" | "sales", id: number): string {
  return recordType === "expense" ? `/records/expenses/${id}` : `/records/sales/${id}`;
}

/** The `**bold**`, `- ` list subset Fin writes, as plain data a renderer can map. */
export type ChatBlock = { kind: "p"; lines: string[] } | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Same parse as web's ChatMarkdown, kept pure here so it can be tested
 * without a renderer. Produces data, never markup — model text cannot become
 * anything but text.
 */
export function parseChatBlocks(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    const last = blocks.at(-1);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const item = (bullet ?? numbered)![1]!;
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (line.trim() === "") {
      if (last && last.kind === "p" && last.lines.length > 0) blocks.push({ kind: "p", lines: [] });
    } else if (last && last.kind === "p") {
      last.lines.push(line);
    } else {
      blocks.push({ kind: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}

/** Splits a line into plain and `**bold**` runs. An unmatched `**` stays as typed. */
export function inlineRuns(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*\n]+\*\*)/g)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4
        ? { text: part.slice(2, -2), bold: true }
        : { text: part, bold: false },
    );
}
