/**
 * First-visit tips: which ones an owner has dismissed, and who gets them.
 *
 * Kept in localStorage per user id, like the tour's cache (lib/tourStorage.ts)
 * and for the same shared-computer reason. Unlike the tour these are not sent
 * to the account: a tip seen again on a second device costs one "Got it", and
 * that does not justify a new column and endpoint.
 *
 * Every access is wrapped in try/catch; a storage failure reads as "nothing
 * dismissed" and a failed write is ignored.
 */

export type PageTipId = "receipt-review" | "csv-import" | "recovery-target";

const KEY_PREFIX = "finsight.tips.";

/** How long after sign-up an account still counts as new enough for tips. */
export const NEW_ACCOUNT_DAYS = 30;

function keyFor(userId: number) {
  return `${KEY_PREFIX}${userId}`;
}

export function readDismissedTips(userId: number): PageTipId[] {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is PageTipId => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function dismissTip(userId: number, id: PageTipId) {
  const current = readDismissedTips(userId);
  if (current.includes(id)) return;
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify([...current, id]));
  } catch {
    // Intentionally ignored: see module comment.
  }
}

/**
 * Tips are for owners still finding their way. Someone who has used the app
 * for months does not need a tip on a page they already know, so accounts
 * older than NEW_ACCOUNT_DAYS never see them. An unparseable date counts as
 * not new, which errs toward showing nothing.
 */
export function isNewAccount(createdAt: string | undefined, now = Date.now()): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  return now - created <= NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
}
