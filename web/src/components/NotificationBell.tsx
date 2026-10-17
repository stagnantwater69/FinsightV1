import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { useNotifications } from "../context/NotificationContext";
import { useDismiss } from "../lib/hooks";
import { STATUS_TEXT_COLORS } from "../lib/chartPalette";
import { IconBell } from "./icons";
import { NotificationEmpty, NotificationItem } from "./NotificationItem";
import { Button } from "./Button";

export function NotificationBell() {
  const {
    notifications,
    unreadCount,
    loading,
    error,
    markRead,
    markAllRead,
    refresh,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  const { ref, triggerRef } = useDismiss(open, () => setOpen(false));
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const preview = notifications.slice(0, 6);
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        data-tour="notifications"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={
          loading
            ? "Notifications — loading"
            : error
              ? "Notifications — updates unavailable"
              : unreadCount > 0
                ? `Notifications — ${unreadCount} unread`
                : "Notifications — none unread"
        }
        className="tap relative h-11 w-11 rounded-xl text-ink-600 transition hover:bg-paper-100 hover:text-ink-900"
      >
        <IconBell className="h-[18px] w-[18px]" />
        {unreadCount > 0 ? (
          <span
            aria-hidden
            className="absolute right-1 top-1 flex h-[17px] min-w-[17px] animate-badge-in items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-paper"
            style={{ backgroundColor: STATUS_TEXT_COLORS.critical }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          className="fixed inset-x-3 top-20 z-50 flex max-h-[calc(100dvh-10rem-env(safe-area-inset-bottom))] animate-pop-down flex-col overflow-hidden rounded-2xl bg-paper shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-[min(38rem,calc(100dvh-9rem-env(safe-area-inset-bottom)))] lg:max-h-[min(38rem,calc(100dvh-8rem))] sm:w-96"
        >
          <div className="flex shrink-0 items-start justify-between gap-2 border-b border-paper-200 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink-900">
                Notifications
              </h2>
              <p className="mt-1 text-xs text-ink-500">
                {loading
                  ? "Checking for updates…"
                  : error
                    ? "Updates unavailable"
                    : unreadCount > 0
                      ? `${unreadCount} unread`
                      : "No unread notifications"}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close notifications"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="tap -mr-2 -mt-1 h-11 w-11 rounded-lg text-ink-500 hover:bg-paper-100 hover:text-ink-900"
            >
              <X className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
          </div>
          {unreadCount > 0 && !loading ? (
            <div className="shrink-0 border-b border-paper-200 px-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-tone-brand"
                onClick={() => void markAllRead()}
              >
                Mark all as read
              </Button>
            </div>
          ) : null}
          <div className="scroll-slim min-h-0 overflow-y-auto overscroll-contain">
            {error ? (
              <div
                role="alert"
                className="m-4 rounded-xl bg-tint-danger p-4 text-sm text-tone-danger"
              >
                <p>{error}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => void refresh()}
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {loading ? (
              <div className="space-y-3 p-4" aria-busy="true" role="status">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="skeleton h-24 rounded-xl"
                    aria-hidden
                  />
                ))}
                <span className="sr-only">Loading notifications…</span>
              </div>
            ) : preview.length === 0 && !error ? (
              <NotificationEmpty title="You're all caught up">
                Duplicates, large expenses and finished imports appear here.
              </NotificationEmpty>
            ) : preview.length > 0 ? (
              <ul className="divide-y divide-paper-200">
                {preview.map((notification) => (
                  <li key={notification.id}>
                    <NotificationItem
                      compact
                      notification={notification}
                      onMarkRead={markRead}
                      onNavigate={() => setOpen(false)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="flex min-h-tap shrink-0 items-center justify-center border-t border-paper-200 bg-paper-100 px-4 py-3 text-sm font-semibold text-tone-brand transition hover:bg-tint-brand"
          >
            View all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}
