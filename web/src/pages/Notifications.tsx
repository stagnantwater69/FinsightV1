import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { useNotifications } from "../context/NotificationContext";
import { Alert, alertKindFromType } from "../components/Alert";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { PageHead } from "../components/ui";
import { relativeTime } from "../components/NotificationBell";

type FilterKey = "all" | "unread";

/**
 * The full notification archive — the bell dropdown's "View all".
 *
 * Rendered through the shared <Alert> family rather than styled locally, so a
 * "possible duplicate" looks the same here as it does on a record row, in the
 * dashboard's panel, and in the bell. Law of Similarity: the same flag should
 * never need to be recognised twice.
 *
 * Grouped by day. A flat list of forty alerts gives no sense of whether
 * something is happening now or happened a fortnight ago, and "when" is most
 * of what makes an alert actionable.
 */

function dayLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 30) return "Earlier this month";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function Notifications() {
  const { selected } = useBusinessProfiles();
  const { notifications, unreadCount, loading, error, markRead, markAllRead } = useNotifications();
  const [filter, setFilter] = useState<FilterKey>("all");

  const visible = useMemo(
    () => (filter === "unread" ? notifications.filter((n) => !n.readStatus) : notifications),
    [notifications, filter],
  );

  // Server order is already newest-first, so grouping in sequence preserves it
  // without a second sort.
  const groups = useMemo(() => {
    const out: { label: string; items: typeof visible }[] = [];
    for (const item of visible) {
      const label = dayLabel(item.dateCreated);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(item);
      else out.push({ label, items: [item] });
    }
    return out;
  }, [visible]);

  if (!selected) return null;

  return (
    <div>
      <PageHead
        eyebrow="Account"
        title="Notifications"
        subtitle={`Everything FinSight has flagged for ${selected.name}.`}
        actions={
          unreadCount > 0 ? (
            <Button variant="secondary" size="sm" onClick={markAllRead}>
              Mark all as read
            </Button>
          ) : null
        }
      />

      {/* Two states only. A per-type filter would be four more controls for a
          list that is usually short, and the type is already legible on every
          row — "have I dealt with this?" is the only question worth a filter. */}
      <div
        role="tablist"
        aria-label="Filter notifications"
        className="mb-4 flex w-max gap-1 rounded-xl border border-paper-200 bg-paper-100 p-1"
      >
        {(
          [
            { key: "all", label: `All${notifications.length ? ` (${notifications.length})` : ""}` },
            { key: "unread", label: `Unread${unreadCount ? ` (${unreadCount})` : ""}` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={filter === tab.key}
            onClick={() => setFilter(tab.key)}
            className={`flex min-h-tap items-center whitespace-nowrap rounded-lg px-4 text-[13.5px] font-semibold transition ${
              filter === tab.key ? "bg-paper text-brand-800 shadow-sm" : "text-ink-500 hover:text-brand-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="mb-4 rounded-xl bg-tint-danger px-3.5 py-3 text-sm text-tone-danger ring-1 ring-edge-danger">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading notifications…</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-[4.5rem] rounded-xl" aria-hidden />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title={filter === "unread" ? "Nothing unread" : "Nothing needs your attention"}
          icon="✓"
        >
          {filter === "unread"
            ? "You've read everything FinSight has flagged. Switch to All to look back over them."
            : "FinSight will flag possible duplicates, unusually large expenses and finished imports here as you record them."}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">
                {group.label}
              </h2>
              <ul className="space-y-2">
                {group.items.map((item) => (
                  <li key={item.id} className={item.readStatus ? "opacity-60" : undefined}>
                    <Alert
                      kind={alertKindFromType(item.type)}
                      label={item.type}
                      meta={relativeTime(item.dateCreated)}
                      action={
                        <div className="flex items-center gap-1">
                          {item.expenseRecordId ? (
                            /*
                              A duplicate notification goes straight to the
                              decision, not to the list. "Review record" used
                              to land the owner on /records with the row
                              highlighted, which answered "which record?" but
                              not "what do you want me to do about it?" —
                              they still had to find the compare action
                              themselves. Every other notification kind has no
                              single decision attached, so those still open
                              the record in its list context.
                            */
                            <Link
                              to={
                                alertKindFromType(item.type) === "duplicate"
                                  ? `/records?reviewDuplicateId=${item.expenseRecordId}`
                                  : `/records?highlightRecordId=${item.expenseRecordId}`
                              }
                              onClick={() => {
                                if (!item.readStatus) markRead(item.id);
                              }}
                              className="tap rounded-lg px-2 text-xs font-semibold text-tone-brand transition hover:bg-tint-brand"
                            >
                              {alertKindFromType(item.type) === "duplicate"
                                ? "Review duplicate"
                                : "Review record"}
                              <span className="sr-only"> — {item.message}</span>
                            </Link>
                          ) : null}
                          {!item.readStatus ? (
                            <button
                              type="button"
                              onClick={() => markRead(item.id)}
                              className="tap rounded-lg px-2 text-xs font-medium text-ink-500 transition hover:bg-paper hover:text-ink-800"
                            >
                              Mark read
                              <span className="sr-only"> — {item.message}</span>
                            </button>
                          ) : null}
                        </div>
                      }
                    >
                      {item.message}
                    </Alert>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
