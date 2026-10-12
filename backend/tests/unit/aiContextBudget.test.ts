import { describe, expect, it } from "vitest";
import {
  contextWithinBudget,
  MAX_AI_CONTEXT_BYTES,
} from "../../src/services/aiContext.service";

describe("AI context byte budget", () => {
  it("bounds UTF-8 bytes and preserves the required steering tail", () => {
    const priority = Array.from({ length: 100 }, (_, index) => `${index}: ${"₱🚚".repeat(80)}`);
    const tail = ["", "Stay scoped to Expense Insights.", "Today's date: 2026-10-04."];

    const context = contextWithinBudget(priority, tail, 1_000);

    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(1_000);
    expect(context).toContain("[Additional lower-priority context omitted to fit the request budget.]");
    expect(context.endsWith(tail.join("\n"))).toBe(true);
    expect(MAX_AI_CONTEXT_BYTES).toBe(24_000);
  });
});
