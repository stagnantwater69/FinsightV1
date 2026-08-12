import { useState } from "react";
import { Link } from "react-router-dom";
import { useNotifications } from "../context/NotificationContext";
import { useDismiss, useMenuKeys } from "../lib/hooks";
import { alertKindFromType } from "./Alert";
import { IconBell } from "./icons";
import type { Notification } from "../lib/types";

/**
 * The notification centre.
 *
 * The badge is the point of it: an alert FinSight raises — a possible
 * duplicate, an unusually large expense, a finished import — is worthless if
 * the owner only discovers it by happening to open the dashboard. The bell
 * puts the count on every screen.
 *
 * The count is capped at "9+". A two- or three-digit badge stops being a
 * count and becomes a smudge, and the difference between 14 and 40 unread
 * doesn't change what you do next.
 */

const KIND_STYLES: Record<string, { chip: string; glyph: string }> = {
  duplicate: { chip: "bg-tint-info text-tone-info", glyph: "⧉" },
  "needs-review": { chip: "bg-tint-accent text-tone-accent", glyph: "⚑" },
  "large-expense": { chip: "bg-tint-danger text-tone-danger", glyph: "▲" },
  info: { chip: "bg-tint-neutral text-tone-neutral", glyph: "ⓘ" },
};

/** "3m ago" / "2d ago" — a relative stamp reads faster than a date here. */
export function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationRow({
  notification,
  onMarkRead,
  onNavigate,
}: {
  notification: Notification;
  onMarkRead: (id: number) => void;
  /** Closes whatever chrome is showing this row (the bell's dropdown) once
   * the click has actually navigated away. The full /notifications page has
   * nothing to close, so it simply doesn't pass this. */
  onNavigate?: () => void;
}) {
  const kind = alertKindFromType(notification.type);
  const style = KIND_STYLES[kind] ?? KIND_STYLES.info!;

  // Only expense-record flags (a possible duplicate, a large expense) have
  // somewhere specific to send the owner — a batch summary (a finished CSV
  // import) isn't about one record, so it stays a plain, unclickable row.
  const target = notification.expenseRecordId
    ? `/records?highlightRecordId=${notification.expenseRecordId}`
    : null;

  const body = (
    <>
      <span
        aria-hidden
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs ${style.chip}`}
      >
        {style.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold text-ink-900">{notification.type}</p>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-600">{notification.message}</p>
        <p className="mt-1 text-[11px] text-ink-400">{relativeTime(notification.dateCreated)}</p>
      </div>
    </>
  );

  return (
    <div
      className={`flex items-start gap-3 rounded-xl px-2.5 py-2.5 transition ${
        notification.readStatus ? "opacity-60" : "bg-paper-100/60"
      }`}
    >
      {target ? (
        <Link
          to={target}
          onClick={() => {
            if (!notification.readStatus) onMarkRead(notification.id);
            onNavigate?.();
          }}
          className="-m-1 flex min-w-0 flex-1 items-start gap-3 rounded-lg p-1 transition hover:bg-paper-200/60"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-3">{body}</div>
      )}
      {!notification.readStatus ? (
        <button
          type="button"
          onClick={() => onMarkRead(notification.id)}
          className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] font-medium text-ink-500 transition hover:bg-paper-200 hover:text-ink-800"
        >
          Mark read
          <span className="sr-only"> — {notification.message}</span>
        </button>
      ) : null}
    </div>
  );
}

export function NotificationBell() {
  const { notifications, unreadCount, loading, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const { ref, triggerRef } = useDismiss(open, () => setOpen(false));
  const onMenuKeys = useMenuKeys();

  // The dropdown is a preview, not the archive — the full list lives on
  // /notifications. Six is roughly what fits without the panel needing its
  // own scrollbar on a laptop.
  const preview = notifications.slice(0, 6);

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          unreadCount > 0 ? `Notifications — ${unreadCount} unread` : "Notifications — none unread"
        }
        className="tap relative h-10 w-10 min-h-0 min-w-0 rounded-xl text-ink-600 transition hover:bg-paper-100 hover:text-ink-900"
      >
        <IconBell className="h-[18px] w-[18px]" />
        {unreadCount > 0 ? (
          <span
            aria-hidden
            className="absolute right-1 top-1 flex h-[17px] min-w-[17px] animate-badge-in items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-paper"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Notifications"
          onKeyDown={onMenuKeys}
          className="absolute right-0 top-full z-50 mt-2 w-[21rem] max-w-[calc(100vw-1.5rem)] animate-pop-down overflow-hidden rounded-2xl border border-paper-200 bg-paper shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-paper-200 px-3.5 py-2.5">
            <p className="text-[13px] font-semibold text-ink-900">
              Notifications
              {unreadCount > 0 ? (
                <span className="ml-1.5 font-normal text-ink-500">({unreadCount} unread)</span>
              ) : null}
            </p>
            {unreadCount > 0 ? (
              <button
                type="button"
                role="menuitem"
                onClick={markAllRead}
                className="rounded-lg px-2 py-1 text-[11.5px] font-semibold text-tone-brand transition hover:bg-tint-brand"
              >
                Mark all as read
              </button>
            ) : null}
          </div>

          <div className="scroll-slim max-h-[22rem] overflow-y-auto p-1.5">
            {loading ? (
              <div className="space-y-2 p-2" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-12 rounded-xl" aria-hidden />
                ))}
                <span className="sr-only">Loading notifications…</span>
              </div>
            ) : preview.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <span aria-hidden className="text-xl">
                  ✓
                </span>
                <p className="mt-1.5 text-[13px] font-medium text-ink-700">You're all caught up</p>
                <p className="mx-auto mt-1 max-w-[15rem] text-[11.5px] leading-snug text-ink-500">
                  FinSight will flag possible duplicates, unusually large expenses and finished imports
                  here.
                </p>
              </div>
            ) : (
              preview.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onMarkRead={markRead}
                  onNavigate={() => setOpen(false)}
                />
              ))
            )}
          </div>

          <Link
            to="/notifications"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-tap items-center justify-center border-t border-paper-200 bg-paper-100 text-[12.5px] font-semibold text-tone-brand transition hover:bg-tint-brand"
          >
            View all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}
