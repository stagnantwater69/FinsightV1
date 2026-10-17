import { useMemo, useState } from "react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useNotifications } from "../context/NotificationContext";
import { Button, ButtonLink } from "../components/Button";
import {
  NotificationEmpty,
  NotificationItem,
} from "../components/NotificationItem";
import { PageHead } from "../components/ui";
import { dayLabel } from "../lib/notificationPresentation";
import { IconSettings } from "../components/icons";

type FilterKey = "all" | "unread";

export function Notifications() {
  const { selected } = useBusinessProfiles();
  const {
    notifications,
    unreadCount,
    loading,
    error,
    markRead,
    markAllRead,
    refresh,
  } = useNotifications();
  const [filter, setFilter] = useState<FilterKey>("all");
  const visible = useMemo(
    () =>
      filter === "unread"
        ? notifications.filter((item) => !item.readStatus)
        : notifications,
    [notifications, filter],
  );
  const groups = useMemo(() => {
    const result: { label: string; items: typeof visible }[] = [];
    // Keep the server's newest-first ordering within each date group.
    for (const item of visible) {
      const label = dayLabel(item.dateCreated);
      const group = result.find((entry) => entry.label === label);
      if (group) group.items.push(item);
      else result.push({ label, items: [item] });
    }
    return result;
  }, [visible]);

  return (
    <div className="max-w-5xl">
      <PageHead
        title="Notifications"
        subtitle={
          selected ? (
            <span className="block break-words [overflow-wrap:anywhere]">
              Updates and record alerts for{" "}
              <span className="font-medium text-ink-700">{selected.name}</span>.
            </span>
          ) : (
            "Updates and record alerts from FinSight."
          )
        }
        actions={
          selected ? (
            <ButtonLink
              to={`/business-profiles/${selected.id}/recovery-notifications`}
              variant="secondary"
              size="sm"
            >
              <IconSettings className="h-4 w-4" />
              Recovery alerts
            </ButtonLink>
          ) : null
        }
      />
      <div className="overflow-hidden rounded-2xl border border-paper-200 bg-paper">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-paper-200 px-4 py-3 sm:px-6">
          <div
            role="group"
            aria-label="Filter notifications"
            className="flex gap-1 rounded-xl bg-paper-100 p-1"
          >
            {(
              [
                {
                  key: "all",
                  label: `All${notifications.length ? ` (${notifications.length})` : ""}`,
                },
                {
                  key: "unread",
                  label: `Unread${unreadCount ? ` (${unreadCount})` : ""}`,
                },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={filter === option.key}
                onClick={() => setFilter(option.key)}
                className={`flex min-h-tap items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition ${filter === option.key ? "bg-paper text-tone-brand" : "text-ink-600 hover:text-tone-brand"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {unreadCount > 0 && !loading ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-tone-brand"
              onClick={() => void markAllRead()}
            >
              Mark all as read
            </Button>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-tint-danger px-4 py-3 text-sm text-tone-danger sm:mx-6"
          >
            <p>{error}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {loading ? (
          <div className="space-y-3 p-4 sm:p-6" aria-busy="true" role="status">
            <span className="sr-only">Loading notifications…</span>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-24 rounded-xl" aria-hidden />
            ))}
          </div>
        ) : visible.length === 0 && !error ? (
          <NotificationEmpty
            title={
              filter === "unread"
                ? "Nothing unread"
                : "Nothing needs your attention"
            }
          >
            {filter === "unread"
              ? "Switch to All to see earlier alerts."
              : "Duplicates, large expenses and finished imports appear here."}
          </NotificationEmpty>
        ) : (
          <div>
            {groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h2 className="border-b border-paper-200 bg-paper-100 px-4 py-3 text-xs font-semibold text-ink-600 sm:px-6">
                  {group.label}
                </h2>
                <ul className="divide-y divide-paper-200">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <NotificationItem
                        notification={item}
                        onMarkRead={markRead}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
