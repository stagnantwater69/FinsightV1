import { prisma } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { requireOwnedBusinessProfile } from "../lib/ownership";
import type { Notification } from "@prisma/client";

// Matches the dictionary's own example text for Notification_Type
// ("Possible Duplicate, Needs Review, Large Expense Flag") — kept as
// Title Case strings for consistency with every other status field in
// this schema (reviewStatus, duplicateStatus, confirmationStatus, etc.),
// all of which are VARCHAR, not DB enums.
export const NOTIFICATION_TYPES = {
  POSSIBLE_DUPLICATE: "Possible Duplicate",
  LARGE_EXPENSE_FLAG: "Large Expense Flag",
  NEEDS_REVIEW: "Needs Review",
  ANOMALY_FINDING: "Anomaly Finding",
  RECURRING_SCHEDULE: "Recurring Schedule",
} as const;

/**
 * The most notifications one request will return.
 *
 * Set far above what anyone reads and far below what an old account holds, so
 * it never truncates something a person was looking for and never hands a
 * client an unbounded list. If this ever starts truncating in practice, the
 * answer is pagination rather than a bigger number.
 */
const NOTIFICATION_LIST_LIMIT = 500;

function toDTO(notification: Notification) {
  return {
    id: notification.id,
    businessProfileId: notification.businessProfileId,
    expenseRecordId: notification.expenseRecordId,
    message: notification.message,
    type: notification.type,
    dateCreated: notification.dateCreated,
    readStatus: notification.readStatus,
  };
}

export async function createNotification(
  userId: number,
  businessProfileId: number,
  type: string,
  message: string,
  expenseRecordId?: number
) {
  await prisma.notification.create({
    data: { userId, businessProfileId, type, message: message.slice(0, 255), expenseRecordId },
  });
}

export async function listNotifications(userId: number, businessProfileId?: number) {
  // Verify ownership when a profile is named, so an unowned or nonexistent id
  // both give 404. Filtering on userId alone already prevented any leak — it
  // returned an empty list — but that made this the only resource in the app
  // that answered 200 where everything else answers 404, and a caller could
  // not tell "you own this and it's quiet" from "that isn't yours".
  if (businessProfileId !== undefined) {
    await requireOwnedBusinessProfile(userId, businessProfileId);
  }

  const notifications = await prisma.notification.findMany({
    where: { userId, businessProfileId },
    orderBy: { dateCreated: "desc" },
    /*
     * A CEILING, not pagination.
     *
     * This grows for the life of the account — every duplicate warning, every
     * large-expense flag — and it was returning all of it, to the client, in
     * one response. An owner three years in would have been handed thousands of
     * rows to render a list nobody scrolls past the first screen of.
     *
     * Newest-first, so what is dropped is the oldest, and it is a LIST rather
     * than a total: nothing here is summed, so a cap cannot make a figure
     * wrong. That is the distinction that decides where these are safe — see
     * the note in docs/DEPLOYMENT-HARDENING-PLAN.md §3.3.
     */
    take: NOTIFICATION_LIST_LIMIT,
  });
  return notifications.map(toDTO);
}

export async function markNotificationRead(userId: number, id: number) {
  const existing = await prisma.notification.findFirst({ where: { id, userId } });
  if (!existing) {
    throw new ApiError(404, "Notification not found");
  }
  const notification = await prisma.notification.update({ where: { id }, data: { readStatus: true } });
  return toDTO(notification);
}

/**
 * Clears the unread badge in one call.
 *
 * A server-side updateMany rather than the client looping over ids: with a
 * few dozen unread alerts that loop is a few dozen round trips, and a partial
 * failure halfway through leaves the badge showing a count that matches
 * nothing. Here it either all clears or none of it does.
 *
 * Scoped by businessProfileId when one is given, matching listNotifications —
 * "mark all read" has to mean the same set the user is actually looking at,
 * and the bell only ever shows the active business.
 */
export async function markAllNotificationsRead(userId: number, businessProfileId?: number) {
  if (businessProfileId !== undefined) {
    await requireOwnedBusinessProfile(userId, businessProfileId);
  }

  const result = await prisma.notification.updateMany({
    where: { userId, businessProfileId, readStatus: false },
    data: { readStatus: true },
  });

  return { updated: result.count };
}
