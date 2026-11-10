import { extractScenario } from "./scenario";
import type { ReductionSpec } from "../services/reductionOpportunity.service";

/**
 * What an Ask FinSight message asks FinSight to calculate or offer, read from
 * its words. Every reader here returns null unless the message is unmistakable:
 * a wrong guess runs the wrong simulation, and its figures would then reach the
 * owner looking just as authoritative as a right one.
 */

/** "What if", "if I", "kung" — the message describes something that has not happened. */
export const HYPOTHETICAL_CUE = /\b(?:what\s?if|if (?:i|we|my|our)|suppose|afford|plan(?:ning)? to|thinking of|(?:paano )?kung)\b/i;
export const PURCHASE_WORD = /\b(?:buy|buying|spend|spending|purchase|purchasing|pay|paying|afford|invest|investing|bibili|bumili|gagastos|magbabayad)\b/i;

const ASKING = /\?\s*$|^\s*(?:how|what|why|when|where|which|who|did|do|does|is|are|was|were|can|could|should|would|magkano|bakit|ano|anong|paano|kailan|saan|ilan)\b/i;
const PAID = /\b(?:paid|bought|spent|purchased|nagbayad|binayaran|bumili|binili|gumastos|ginastos)\b/i;
const SOLD = /\b(?:sold|earned|nabenta|naibenta|nakabenta|kumita|kinita)\b/i;
const TIME_WORDS = /\s+(?:today|yesterday|this morning|this afternoon|last night|kanina|kahapon|ngayon|kagabi)\s*$/i;

export interface RecordedTransaction {
  recordType: "expense" | "sales";
  amount: number;
  description: string;
}

/**
 * "I paid 500 for rice today", "nabenta ko 3,000 kanina". A statement that
 * something already happened, with an amount, so FinSight can offer to record
 * it. Questions and hypotheticals are not statements: "how much did I spend?"
 * and "what if I buy…" never qualify.
 */
export function recordedTransaction(message: string): RecordedTransaction | null {
  if (ASKING.test(message) || HYPOTHETICAL_CUE.test(message)) return null;
  const recordType = PAID.test(message) ? "expense" : SOLD.test(message) ? "sales" : null;
  if (!recordType) return null;
  const { amount, label } = extractScenario(message);
  if (amount === null) return null;
  const item = label?.replace(TIME_WORDS, "").trim().slice(0, 255) ?? "";
  return { recordType, amount, description: item || (recordType === "sales" ? "Daily sales" : "") };
}

export type RecoveryWhatIf = { kind: "daily-sales"; amount: number } | { kind: "monthly-costs"; amount: number };

const DAILY = /\b(?:a|per|each|every|kada|bawat)\s+(?:open\s+)?(?:day|araw)\b|\bdaily\b|\barawan\b/i;
const SELLING = /\b(?:sell|selling|make|making|benta|magbenta|makabenta|kumita|kikita)\b/i;
const MONTHLY_COSTS = /\b(?:monthly (?:costs?|expenses?|gastos)|(?:costs?|expenses?|gastos) (?:a|per|each|every|kada|bawat) (?:month|buwan))\b/i;

/** "What if I sell 3,000 a day?" or "what if my monthly costs were 100k?" — Recovery Target's two levers. */
export function recoveryWhatIf(message: string): RecoveryWhatIf | null {
  if (!HYPOTHETICAL_CUE.test(message)) return null;
  const { amount } = extractScenario(message);
  if (amount === null) return null;
  if (MONTHLY_COSTS.test(message)) return { kind: "monthly-costs", amount };
  if (SELLING.test(message) && DAILY.test(message)) return { kind: "daily-sales", amount };
  return null;
}

const CUTTING = /\b(?:cut|cutting|reduce|reducing|lower|lowering|lessen|trim|bawasan|babaan|bawas)\b/i;
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|porsyento)/i;

/**
 * "What if I cut Supplies by 10%?" — the size of the cut. Which category is
 * cut is decided against the owner's own category names by the caller.
 */
export function reductionWhatIf(message: string): ReductionSpec | null {
  if (!CUTTING.test(message) || !(HYPOTHETICAL_CUE.test(message) || /\bwould\b/i.test(message))) return null;
  const percent = message.match(PERCENT);
  if (percent) {
    const value = Number(percent[1]);
    return value > 0 && value <= 100 ? { kind: "percent", value } : null;
  }
  const { amount } = extractScenario(message);
  return amount === null ? null : { kind: "amount", value: amount };
}

/** "Is my data complete?", "did I forget anything?" */
export const COMPLETENESS_CUE =
  /\b(?:complete|missing|forgot|forget|up to date|accurate|correct|kulang|nakalimutan|tama ba|kumpleto)\b/i;

/** "What are my regular bills?", "anything that repeats every month?" */
export const RECURRING_CUE =
  /\b(?:recurring|repeat\w*|regular|subscriptions?|bills?|monthly payments?|every (?:week|month)|due|bayarin|buwan-buwan|linggo-linggo)\b/i;
