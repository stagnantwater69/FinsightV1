import { formatMoney } from "./money";
import type { DashboardSummary } from "./types";

/** What Fin says on Home, and how urgent it is. */
export interface Headline {
  text: string;
  tone: "plain" | "warn";
}

/**
 * The one thing Fin says on Home.
 *
 * WHY ONE MESSAGE, NOT A LIST: this used to be "At a glance", a card of up to
 * four bullet points — biggest cost, recovery gap, records needing review,
 * unread alerts — all shown at once. That reads well when there is time to
 * scan a paragraph. Folded into the greeting as one line spoken by Fin, there
 * is room for exactly one, so the choice of WHICH one now matters in a way it
 * did not when everything was shown together.
 *
 * ONE SENTENCE, NOT A FRAGMENT. An early version of this trimmed each line to
 * a bare noun phrase — "3 unread alerts." — to keep it short. Read next to a
 * mascot that is supposedly SAYING it, a fragment reads as a label, not as
 * something Fin told you; a full sentence is what makes the speech bubble
 * read as speech. Short and complete are not the same trade-off.
 *
 * PRIORITY IS ACTIONABLE FIRST, not "easiest to say" first. A list can afford
 * to lead with the mildest fact and let the reader's eye find the urgent line
 * further down; a single sentence cannot, because there is no further down.
 * So `recordsNeedingReview` — a thing with a specific next step — outranks the
 * informational lines below it, which the old ordering put first.
 *
 * IT NEVER MENTIONS UNREAD ALERTS, though it used to, ranked second. The count
 * of unread alerts is already on screen at the same moment, as the badge on the
 * header's bell, and this message is now shown hanging off that very bell — so
 * the old second branch had Fin reading the badge it was attached to back to
 * the owner, and spending the screen's one sentence doing it. The bell owns
 * that fact; this says something the icons cannot. Nothing here is invented:
 * every remaining branch is one the card already computed, reworded for one
 * spoken line instead of a paragraph.
 *
 * Returns null when there is nothing worth saying — a fresh business with no
 * records yet trends toward this — and the caller shows Fin without a
 * message rather than forcing a sentence out of no data.
 */
export function pickHeadline(summary: DashboardSummary): Headline | null {
  const { overview, recoveryStatus, expenseCategoryBreakdown, recordsNeedingReview } = summary;
  const spent = overview.totalExpenses;
  const remaining = recoveryStatus?.remainingTarget ?? 0;
  const daysLeft = recoveryStatus?.remainingOperatingDays ?? 0;

  if (recordsNeedingReview > 0) {
    // "waiting for a second look" rather than "need(s) a second look" —
    // singular and plural read naturally off the same template this way,
    // with no separate verb-agreement branch to keep in sync.
    return {
      text: `You have ${recordsNeedingReview} record${recordsNeedingReview === 1 ? "" : "s"} waiting for a second look.`,
      tone: "warn",
    };
  }

  if (remaining > 0 && daysLeft > 0) {
    return {
      text: `You still need ${formatMoney(remaining)} more this month, about ${formatMoney(remaining / daysLeft)} a day.`,
      tone: "plain",
    };
  }

  if (remaining <= 0 && recoveryStatus) {
    return { text: "This month's expenses are already covered — nice work!", tone: "plain" };
  }

  const topCategory = [...expenseCategoryBreakdown].sort((a, b) => b.total - a.total)[0];
  if (spent > 0 && topCategory) {
    const share = Math.round((topCategory.total / spent) * 100);
    return {
      text: `${topCategory.categoryName} is your biggest cost so far, at ${share}% of what you've spent.`,
      tone: "plain",
    };
  }

  if (spent === 0) {
    return { text: "Nothing's been recorded yet this period — add your first expense or sale.", tone: "plain" };
  }

  return null;
}
