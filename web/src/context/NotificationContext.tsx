import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useBusinessProfiles } from "./BusinessProfileContext";
import type { Notification } from "../lib/types";

/**
 * The notification centre's single source of truth.
 *
 * Lifted into context rather than fetched per-component because three places
 * read the same list — the topbar bell, the dashboard's alerts panel, and the
 * /notifications page. Fetching separately meant marking one read on the
 * dashboard left the bell's badge stale until a reload, which reads as the
 * app losing track.
 *
 * Scoped to the selected business profile: an alert belongs to a business,
 * and showing another business's alerts under the current one's header would
 * be actively misleading.
 */

interface NotificationContextValue {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

/** How often the bell re-checks the server for alerts raised elsewhere. */
const POLL_MS = 60_000;

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const businessProfileId = selected?.id;

  const refresh = useCallback(async () => {
    if (!businessProfileId) {
      setNotifications([]);
      setLoading(false);
      return;
    }
    try {
      const { data } = await api.get<Notification[]>("/notifications", {
        params: { businessProfileId },
      });
      setNotifications(data);
      setError(null);
    } catch {
      // Deliberately quiet. Alerts are ambient information, not something the
      // user asked for right now — an error banner across the app because a
      // background poll failed would be far more disruptive than a bell that
      // is briefly out of date. The /notifications page surfaces `error`
      // itself, where the user IS asking.
      setError("Couldn't load notifications.");
    } finally {
      setLoading(false);
    }
  }, [businessProfileId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  // Alerts are raised by work the user didn't necessarily start here — a CSV
  // import finishing, a duplicate detected on another device. Polling keeps
  // the badge honest without needing a socket.
  useEffect(() => {
    if (!businessProfileId) return;
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [businessProfileId, refresh]);

  const markRead = useCallback(async (id: number) => {
    // Optimistic: the badge drops immediately. Re-fetching first would leave
    // the count visibly lagging the click by a round trip.
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readStatus: true } : n)));
    try {
      await api.patch(`/notifications/${id}/read`);
    } catch {
      // Put it back rather than leave the UI claiming something it failed to
      // persist — an alert that silently un-reads itself on the next reload
      // is worse than one that never appeared to be read.
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readStatus: false } : n)));
    }
  }, []);

  const markAllRead = useCallback(async () => {
    if (!businessProfileId) return;
    const previous = notifications;
    setNotifications((prev) => prev.map((n) => ({ ...n, readStatus: true })));
    try {
      await api.patch("/notifications/read-all", null, { params: { businessProfileId } });
    } catch {
      setNotifications(previous);
    }
  }, [businessProfileId, notifications]);

  const unreadCount = notifications.reduce((n, item) => (item.readStatus ? n : n + 1), 0);

  return (
    <NotificationContext.Provider
      value={{ notifications, unreadCount, loading, error, markRead, markAllRead, refresh }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationProvider");
  return ctx;
}
