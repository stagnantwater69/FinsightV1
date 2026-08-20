/**
 * ALL FIVE feedback values, each reachable from every finding card.
 *
 * Only two were reachable on mobile before — the card had one "Duplicate" /
 * "Unusual" button and one "Not duplicate" / "Expected" button, and the
 * feedback sent was chosen by an inline ternary. Three of the five labels the
 * evaluation harness measures precision against could therefore never be
 * produced by an owner on a phone, which is most of FinSight's owners. The
 * feedback column looked populated while carrying almost no information.
 *
 * INCORRECT_MATCH is the one that mattered most and had no button at all: it
 * is the single most valuable signal for the duplicate detector, because
 * "these are two different purchases that happen to look alike" is a different
 * fact from "this happens all the time in my business".
 *
 * `status` is not a separate choice the owner makes: it follows from what they
 * said. Confirming keeps the finding, dismissing rejects it, and "no longer
 * relevant" resolves it — three states in the owner's own words.
 *
 * MIRRORS web/src/lib/findingPresentation.ts (`feedbackActions`) — same five
 * actions, same labels, same status for each, same ordering rule. The two
 * clients writing the same value under different labels would poison the very
 * dataset this exists to collect.
 */

import type { AnomalyFinding, AnomalyFindingFeedback, AnomalyFindingStatus } from "./types";

export interface FeedbackAction {
  feedback: AnomalyFindingFeedback;
  status: Extract<AnomalyFindingStatus, "CONFIRMED" | "DISMISSED" | "RESOLVED">;
  label: string;
  /** Announced after the action, echoing what the owner actually said. */
  toast: string;
  /**
   * Primary actions get their own buttons on the card; the rest live behind
   * "Something else…", which opens the full list as a sheet. A phone card
   * cannot carry five buttons without becoming a wall, and burying the two
   * most likely answers to make room for the three least likely would be a
   * worse trade than the sheet.
   */
  primary: boolean;
}

const CONFIRM_UNUSUAL: FeedbackAction = {
  feedback: "CONFIRMED_UNUSUAL",
  status: "CONFIRMED",
  label: "Yes — this was unusual",
  toast: "Noted — you confirmed this one was unusual",
  primary: true,
};
const EXPECTED: FeedbackAction = {
  feedback: "EXPECTED_TRANSACTION",
  status: "DISMISSED",
  label: "This is normal for my business",
  toast: "Noted — FinSight will treat this as normal for you",
  primary: true,
};
const IS_DUPLICATE: FeedbackAction = {
  feedback: "DUPLICATE",
  status: "CONFIRMED",
  label: "It is a duplicate",
  toast: "Noted — recorded as a duplicate",
  primary: true,
};
const INCORRECT_MATCH: FeedbackAction = {
  feedback: "INCORRECT_MATCH",
  status: "DISMISSED",
  label: "Wrong match — these are different",
  toast: "Noted — FinSight matched the wrong record",
  primary: true,
};
const NO_LONGER_RELEVANT: FeedbackAction = {
  feedback: "NO_LONGER_RELEVANT",
  status: "RESOLVED",
  label: "No longer relevant",
  toast: "Cleared from your review queue",
  primary: false,
};

/** Which question the finding is asking, which decides the answer order. */
export function findingCategory(type: AnomalyFinding["type"] | string): "duplicate" | "unusual" {
  return type === "POSSIBLE_DUPLICATE" ? "duplicate" : "unusual";
}

/** Ordered by how likely the owner is to mean it, per category. */
export function feedbackActions(category: "duplicate" | "unusual"): FeedbackAction[] {
  if (category === "duplicate") {
    return [IS_DUPLICATE, INCORRECT_MATCH, EXPECTED, CONFIRM_UNUSUAL, NO_LONGER_RELEVANT];
  }
  return [CONFIRM_UNUSUAL, EXPECTED, INCORRECT_MATCH, IS_DUPLICATE, NO_LONGER_RELEVANT];
}

/**
 * The two answers that get their own buttons on the card.
 *
 * The first two of the ordered list rather than "everything marked primary":
 * four primaries on a phone card is the wall this avoids, and the ordering
 * already encodes which two an owner reaches for.
 */
export function quickActions(category: "duplicate" | "unusual"): FeedbackAction[] {
  return feedbackActions(category).slice(0, 2);
}
