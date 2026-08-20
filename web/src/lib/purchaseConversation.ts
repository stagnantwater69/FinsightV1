import { formatMoney } from "../components/Money";
import { FIELD_LIMITS } from "./fieldLimits";
import type { PurchaseKind, PurchaseReview } from "./types";

/** The classification as a clause inside a sentence, not as a chip. */
const PURCHASE_KIND_SENTENCE: Record<PurchaseKind, string> = {
  asset: "something the business keeps and uses",
  "running-cost": "something that gets used up and bought again",
  mixed: "partly something kept and partly something used up",
  unclear: "hard to classify from the description",
};

/**
 * The question the "talk this through" button hands to Ask FinSight.
 *
 * WHY THE CONTEXT TRAVELS IN THE QUESTION rather than in the API's `context`
 * field. That field REPLACES the server-built context and turns the call into
 * a one-shot with no conversation history (see askAndRecord in
 * backend/src/services/ai.service.ts) — which is precisely what "continue the
 * conversation" must not be. Going through the drawer's ordinary path keeps
 * the figures fresh (rebuilt server-side at send time, so an expense recorded
 * twenty seconds ago is in them) and keeps the earlier turns threaded. The
 * item and what FinSight said about it ride along inside the question, which
 * is the one part the server cannot rebuild — nothing about this scenario is
 * saved anywhere.
 *
 * CAPPED at the same 500 characters the API enforces, by dropping the running
 * costs clause first: the classification and the item are what the follow-up
 * hangs on, the costs line is the elaboration. A truncated question would be
 * rejected by the field's own maxLength and leave the owner holding a
 * half-sentence they did not write.
 */
export function discussionPrompt(
  item: string,
  review: PurchaseReview,
  amount: number | "",
): string {
  const kind = PURCHASE_KIND_SENTENCE[review.kind];
  const priced = amount === "" ? item : `${item} at ${formatMoney(amount)}`;
  const withCosts = review.ongoingCosts
    ? `You described ${priced} as ${kind}, with ongoing costs: ${review.ongoingCosts} Given my figures, what should I weigh before deciding?`
    : "";
  const withoutCosts = `You described ${priced} as ${kind}. Given my figures, what should I weigh before deciding?`;

  if (withCosts && withCosts.length <= FIELD_LIMITS.aiQuestion) return withCosts;
  if (withoutCosts.length <= FIELD_LIMITS.aiQuestion) return withoutCosts;
  // A pathologically long item name. The question still has to be a question.
  return `What should I weigh before deciding on this purchase?`;
}
