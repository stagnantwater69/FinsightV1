/**
 * "Ask FinSight about this" for a reduction-opportunity card — plan §11.1.
 *
 * Phase 3 of docs/EXPENSE-REDUCTION-OPPORTUNITIES-PLAN.md. The QUESTION goes
 * into the composer, same as every other deep-link entry point in this app
 * (SpendingImpactScreen's "Talk this through", FlaggedRecords' "Explain this
 * flag" on web). It is never sent for the owner — see AskFinSight.tsx's
 * `submit`.
 *
 * THE EVIDENCE. The plan requires "a compact, server-trusted context block
 * containing only the selected opportunity's structured fields... do not
 * rely on free-form client prose as the evidence source." That block is NOT
 * built here: `chatStore.ts`'s `prepareQuestion` takes the raw
 * `ReductionOpportunity` object straight from the card and queues it as
 * `pendingReductionOpportunity`, which the next send attaches to the request
 * body as a flat `reductionOpportunity` field — the exact same object
 * `GET /insights/reduction-opportunities` returned. That matches
 * `askSchema`/`createConversationSchema`/`appendMessageSchema`'s
 * `reductionOpportunity` field in backend/src/controllers/ai.controller.ts
 * (a zod schema typed against the real `ReductionOpportunity` interface) —
 * the server re-validates every field, re-checks `suggestedChecks` against
 * the real catalogue, and renders the prompt block itself
 * (`reductionOpportunityLines` in aiContext.service.ts). This file has no
 * hand in that rendering, on purpose: a client-serialized string is exactly
 * what the plan prohibits sending as evidence.
 */

/** The exact wording the plan specifies — same question for every card. */
export const REDUCTION_OPPORTUNITY_QUESTION =
  "Why was this reduction opportunity selected, and what should I check first?";
