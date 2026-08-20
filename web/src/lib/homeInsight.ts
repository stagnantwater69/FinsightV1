import { formatMoney } from "../components/Money";
import type { DashboardSummary } from "./types";

/** What Fin says on the dashboard, and how urgent it is. */
export interface Headline {
  text: string;
  tone: "plain" | "warn";
}

/**
 * The one thing Fin says on the dashboard.
 *
 * Ported from `mobile/src/lib/homeInsight.ts` so both clients put the same
 * sentence in the mascot's mouth for the same data. The branches, their order,
 * and the wording are deliberately identical — if this drifts, the two apps
 * start describing the same business differently, which is worse than either
 * wording alone. Change them together or not at all.
 *
 * WHY ONE MESSAGE, NOT A LIST: the dashboard already renders every one of these
 * facts somewhere below — the KPI row, the Recovery Meter, the review count.
 * This is not a summary of them, it is the single line worth saying out loud
 * first, and there is only room for one.
 *
 * ONE SENTENCE, NOT A FRAGMENT. Read next to a mascot that is supposedly
 * SAYING it, "3 records." reads as a label; a full sentence reads as speech.
 *
 * PRIORITY IS ACTIONABLE FIRST. A single sentence has no "further down" for the
 * eye to find the urgent line in, so `recordsNeedingReview` — the branch with a
 * specific next step — outranks the informational ones.
 *
 * Returns null when there is nothing worth saying, and the caller shows Fin
 * without a message rather than forcing a sentence out of no data.
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

/**
 * Which half of the day it is, in the owner's own timezone.
 *
 * Split out from the component so the boundaries are testable without
 * mounting anything or faking a clock at the React level.
 */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The date line above the greeting.
 *
 * en-PH to match the rest of the app's date rendering and mobile's greeting.
 */
export function dateLine(now: Date): string {
  return now.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" });
}
