import type { Conversation } from "./types";

/**
 * Buckets conversations into the five date headings the chat history list
 * shows: Today, Yesterday, Previous 7 Days, Previous 30 Days, Older.
 *
 * DELIBERATELY COPIED FROM web/src/lib/conversationGroups.ts, the same way
 * confidenceBands.ts and fieldLimits.ts are — the two projects share no build
 * (see theme/tokens.ts for why). Copied logic drifts, so the labels and both
 * boundaries are pinned against web's copy in tests/webParity.test.ts.
 *
 * WHY CALENDAR DAYS, NOT ELAPSED HOURS. "Yesterday" is a thing an owner says
 * about a date on a calendar, not about a 24-hour window. A conversation at
 * 23:59 last night is twelve minutes old when they open the app at 00:11, and
 * it still belongs under Yesterday — bucketing on elapsed time would file it
 * under Today, which is the one label it can never be.
 *
 * THE TWO NAMED BOUNDARIES. Both headings describe a window that includes
 * today, so both are counted from today's date rather than from the end of the
 * preceding bucket:
 *
 *   days ago  0        Today
 *   days ago  1        Yesterday
 *   days ago  2..6     Previous 7 Days   (inside the 7-day window)
 *   days ago  7..29    Previous 30 Days  (exactly 7 days ago has left it)
 *   days ago 30+       Older             (exactly 30 days ago has left it)
 *
 * So a conversation from exactly seven days ago reads as Previous 30 Days and
 * one from exactly thirty days ago reads as Older. Picking the other side of
 * each boundary would put an eighth day inside a heading that says seven.
 *
 * Empty buckets are omitted rather than rendered as a heading with nothing
 * under it, and the order within a bucket is newest first.
 */

export interface ConversationGroup {
  label: string;
  conversations: Conversation[];
}

const LABELS = ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days between two instants, in LOCAL time.
 *
 * Both are flattened to local midnight first, so the subtraction cannot be
 * thrown off by a partial day — and dividing midnights rather than raw
 * timestamps means a daylight-saving shift (a 23- or 25-hour day) still counts
 * as one day rather than rounding to zero or two.
 */
function calendarDaysAgo(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / MS_PER_DAY);
}

function bucketIndex(daysAgo: number): number {
  // A clock skew or a future-dated row would land negative; it is still
  // "today" as far as a heading is concerned, never a sixth bucket.
  if (daysAgo <= 0) return 0;
  if (daysAgo === 1) return 1;
  if (daysAgo < 7) return 2;
  if (daysAgo < 30) return 3;
  return 4;
}

export function groupConversations(
  conversations: readonly Conversation[],
  now: Date = new Date(),
): ConversationGroup[] {
  const buckets: Conversation[][] = LABELS.map(() => []);

  for (const conversation of conversations) {
    const at = new Date(conversation.lastMessageAt);
    // An unparseable date is not a reason to drop someone's conversation off
    // the list entirely — it goes to the end, where it is still reachable.
    const index = Number.isNaN(at.getTime()) ? LABELS.length - 1 : bucketIndex(calendarDaysAgo(at, now));
    buckets[index]!.push(conversation);
  }

  return LABELS.map((label, index) => ({
    label,
    conversations: buckets[index]!.slice().sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    ),
  })).filter((group) => group.conversations.length > 0);
}
