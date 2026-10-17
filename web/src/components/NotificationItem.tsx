import { Link } from "react-router-dom";
import { alertKindFromType } from "./Alert";
import {
  IconAlertTriangle,
  IconBell,
  IconCheck,
  IconDuplicate,
  IconRecords,
} from "./icons";
import {
  notificationTarget,
  relativeTime,
} from "../lib/notificationPresentation";
import type { Notification } from "../lib/types";

const PRESENTATION = {
  duplicate: {
    Icon: IconDuplicate,
    color: "bg-[rgb(var(--sev-warning-bg))] text-[rgb(var(--sev-warning-ink))]",
  },
  "needs-review": {
    Icon: IconAlertTriangle,
    color:
      "bg-[rgb(var(--sev-critical-bg))] text-[rgb(var(--sev-critical-ink))]",
  },
  "large-expense": {
    Icon: IconAlertTriangle,
    color: "bg-[rgb(var(--sev-serious-bg))] text-[rgb(var(--sev-serious-ink))]",
  },
  recurring: {
    Icon: IconRecords,
    color: "bg-[rgb(var(--sev-serious-bg))] text-[rgb(var(--sev-serious-ink))]",
  },
  info: { Icon: IconBell, color: "bg-tint-brand text-tone-brand" },
};

export function NotificationItem({
  notification,
  onMarkRead,
  onNavigate,
  compact = false,
}: {
  notification: Notification;
  onMarkRead: (id: number) => void;
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const { Icon, color } = PRESENTATION[alertKindFromType(notification.type)];
  const target = notificationTarget(notification);
  return (
    <article
      className={`flex gap-3 ${compact ? "px-4 py-4" : "px-4 py-5 sm:px-6"} ${notification.readStatus ? "bg-paper" : "bg-tint-brand/30"}`}
    >
      <span
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${color}`}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="break-words text-sm font-semibold text-ink-900 [overflow-wrap:anywhere]">
            {notification.type}
          </h3>
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${notification.readStatus ? "text-ink-500" : "text-tone-brand"}`}
          >
            {notification.readStatus ? (
              <IconCheck className="h-3.5 w-3.5" />
            ) : (
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-current"
              />
            )}
            {notification.readStatus ? "Read" : "Unread"}
          </span>
          <time
            dateTime={notification.dateCreated}
            className="text-xs text-ink-500 sm:ml-auto"
          >
            {relativeTime(notification.dateCreated)}
          </time>
        </div>
        <p className="mt-2 max-w-[70ch] break-words text-sm leading-relaxed text-ink-600 [overflow-wrap:anywhere]">
          {notification.message}
        </p>
        {target || !notification.readStatus ? (
          <div className="-ml-2 mt-2 flex flex-wrap items-center gap-x-2">
            {target ? (
              <Link
                to={target.to}
                onClick={() => {
                  if (!notification.readStatus) onMarkRead(notification.id);
                  onNavigate?.();
                }}
                className="tap rounded-lg px-2 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand"
              >
                {target.label}
                <span className="sr-only">: {notification.message}</span>
              </Link>
            ) : null}
            {!notification.readStatus ? (
              <button
                type="button"
                onClick={() => onMarkRead(notification.id)}
                className="tap rounded-lg px-2 text-xs font-medium text-ink-600 transition hover:bg-paper-100 hover:text-ink-900"
              >
                Mark read
                <span className="sr-only">: {notification.message}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function NotificationEmpty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-6 py-10 text-center">
      <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-tint-brand text-tone-brand">
        <IconCheck />
      </span>
      <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-500">
        {children}
      </p>
    </div>
  );
}
