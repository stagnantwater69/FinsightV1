import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { isServerStateAffected, subscribeToServerState } from "../lib/serverStateCache";
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

interface NotificationRefresh {
  businessProfileId: number;
  signal?: AbortSignal;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { selected } = useBusinessProfiles();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const refreshCycle = useRef<Promise<void> | null>(null);
  const activeRefreshBusinessId = useRef<number | null>(null);
  const activeRefreshSignal = useRef<AbortSignal | undefined>(undefined);
  const queuedRefresh = useRef<NotificationRefresh | null>(null);
  const notificationActionSequence = useRef(0);
  const rowActionVersions = useRef(new Map<number, number>());
  const notificationActionBusinessId = useRef<number | undefined>(selected?.id);

  const businessProfileId = selected?.id;
  if (notificationActionBusinessId.current !== businessProfileId) {
    notificationActionSequence.current += 1;
    rowActionVersions.current.clear();
    notificationActionBusinessId.current = businessProfileId;
  }

  const runRefresh = useCallback(async (request: NotificationRefresh) => {
    const requestId = refreshSequence.current;
    try {
      const { data } = await api.get<Notification[]>("/notifications", {
        signal: request.signal,
        params: { businessProfileId: request.businessProfileId },
      });
      if (request.signal?.aborted || requestId !== refreshSequence.current) return;
      setNotifications(data);
      setError(null);
    } catch (err) {
      if (request.signal?.aborted || requestId !== refreshSequence.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (!request.signal?.aborted && requestId === refreshSequence.current) setLoading(false);
    }
  }, []);

  /*
   * A poll and several mutation events can arrive together. Keep one request
   * active and collapse the burst into one follow-up, which must start after
   * the older snapshot settles. The sequence prevents that older snapshot
   * from publishing while a follow-up is queued.
   */
  const refresh = useCallback((signal?: AbortSignal, requiresFreshAfterActive = false): Promise<void> => {
    if (!businessProfileId) {
      refreshSequence.current += 1;
      queuedRefresh.current = null;
      setNotifications([]);
      setError(null);
      setLoading(false);
      return Promise.resolve();
    }

    const request = { businessProfileId, signal };
    if (refreshCycle.current) {
      if (
        requiresFreshAfterActive ||
        activeRefreshBusinessId.current !== businessProfileId ||
        activeRefreshSignal.current?.aborted
      ) {
        refreshSequence.current += 1;
        queuedRefresh.current = request;
      }
      return refreshCycle.current;
    }

    refreshSequence.current += 1;
    const runner = (async () => {
      let next: NotificationRefresh | null = request;
      while (next) {
        queuedRefresh.current = null;
        activeRefreshBusinessId.current = next.businessProfileId;
        activeRefreshSignal.current = next.signal;
        await runRefresh(next);
        next = queuedRefresh.current;
      }
    })();
    const cycle = runner.finally(() => {
      if (refreshCycle.current === cycle) {
        refreshCycle.current = null;
        activeRefreshBusinessId.current = null;
        activeRefreshSignal.current = undefined;
      }
    });
    refreshCycle.current = cycle;
    return cycle;
  }, [businessProfileId, runRefresh]);

  useEffect(() => {
    setLoading(true);
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // Alerts are raised by work the user didn't necessarily start here — a CSV
  // import finishing, a duplicate detected on another device. Polling keeps
  // the badge honest without needing a socket.
  useEffect(() => {
    if (!businessProfileId) return;
    // The poll gets a controller too: clearing the interval stops the NEXT
    // tick, not the request the current one already sent.
    const controller = new AbortController();
    const id = window.setInterval(() => void refresh(controller.signal), POLL_MS);
    return () => {
      window.clearInterval(id);
      controller.abort();
    };
  }, [businessProfileId, refresh]);

  useEffect(() => {
    if (!businessProfileId) return;
    const controller = new AbortController();
    const unsubscribe = subscribeToServerState((event) => {
      if (event.type !== "invalidate") return;
      if (
        event.target.businessProfileId !== undefined &&
        event.target.businessProfileId !== businessProfileId
      ) return;
      if (!isServerStateAffected(
        { resource: "/notifications", businessProfileId, tags: ["notifications"] },
        event.target,
      )) return;
      void refresh(controller.signal, true);
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [businessProfileId, refresh]);

  const markRead = useCallback(async (id: number) => {
    if (!businessProfileId) return;
    const action = ++notificationActionSequence.current;
    setError(null);
    const previousReadStatus = notifications.find((item) => item.id === id)?.readStatus ?? false;
    rowActionVersions.current.set(id, action);
    refreshSequence.current += 1;
    // Optimistic: the badge drops immediately. Re-fetching first would leave
    // the count visibly lagging the click by a round trip.
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readStatus: true } : n)));
    try {
      await api.patch(`/notifications/${id}/read`, undefined, {
        serverStateScope: { businessProfileId },
      });
      if (rowActionVersions.current.get(id) !== action) return;
      refreshSequence.current += 1;
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readStatus: true } : n)));
      rowActionVersions.current.delete(id);
      if (notificationActionSequence.current === action) setError(null);
    } catch (err) {
      if (rowActionVersions.current.get(id) !== action) return;
      refreshSequence.current += 1;
      // Put it back rather than leave the UI claiming something it failed to
      // persist — an alert that silently un-reads itself on the next reload
      // is worse than one that never appeared to be read.
      setNotifications((prev) => prev.map((n) => (
        n.id === id ? { ...n, readStatus: previousReadStatus } : n
      )));
      rowActionVersions.current.delete(id);
      if (notificationActionSequence.current === action) setError(getErrorMessage(err));
    }
  }, [businessProfileId, notifications]);

  const markAllRead = useCallback(async () => {
    if (!businessProfileId) return;
    const action = ++notificationActionSequence.current;
    setError(null);
    const previousReadStatus = new Map(notifications.map((item) => [item.id, item.readStatus]));
    const affectedIds = new Set(previousReadStatus.keys());
    for (const id of affectedIds) rowActionVersions.current.set(id, action);
    refreshSequence.current += 1;
    setNotifications((prev) => prev.map((n) => (
      affectedIds.has(n.id) ? { ...n, readStatus: true } : n
    )));
    try {
      await api.patch("/notifications/read-all", null, {
        params: { businessProfileId },
        serverStateScope: { businessProfileId },
      });
      const ownedIds = new Set([...affectedIds].filter(
        (id) => rowActionVersions.current.get(id) === action,
      ));
      if (ownedIds.size === 0) return;
      refreshSequence.current += 1;
      setNotifications((prev) => prev.map((n) => (
        ownedIds.has(n.id) ? { ...n, readStatus: true } : n
      )));
      for (const id of ownedIds) rowActionVersions.current.delete(id);
      if (notificationActionSequence.current === action) setError(null);
    } catch (err) {
      const ownedIds = new Set([...affectedIds].filter(
        (id) => rowActionVersions.current.get(id) === action,
      ));
      if (ownedIds.size === 0) return;
      refreshSequence.current += 1;
      setNotifications((prev) => prev.map((n) => (
        ownedIds.has(n.id)
          ? { ...n, readStatus: previousReadStatus.get(n.id) ?? n.readStatus }
          : n
      )));
      for (const id of ownedIds) rowActionVersions.current.delete(id);
      if (notificationActionSequence.current === action) setError(getErrorMessage(err));
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
