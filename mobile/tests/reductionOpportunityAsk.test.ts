import { describe, expect, it } from "vitest";
import { REDUCTION_OPPORTUNITY_QUESTION } from "../src/lib/reductionOpportunityAsk";

/**
 * The "Ask FinSight about this" deep link — Expense Reduction Opportunities
 * plan §11.1.
 *
 * The evidence itself is no longer built or serialized here: `chatStore.ts`
 * queues the raw `ReductionOpportunity` object as the wire's flat
 * `reductionOpportunity` field, matching `createConversationSchema`/
 * `appendMessageSchema` in backend/src/controllers/ai.controller.ts exactly
 * (see `tests/chatStore.test.ts`'s "a queued reduction opportunity" suite).
 * This file only owns the fixed question text.
 */
describe("REDUCTION_OPPORTUNITY_QUESTION", () => {
  it("is the plan's exact wording", () => {
    expect(REDUCTION_OPPORTUNITY_QUESTION).toBe(
      "Why was this reduction opportunity selected, and what should I check first?",
    );
  });
});
