import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, Button, EmptyState, ErrorNote, Screen, ScreenHeader, T } from "../components/ui";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { ConnectionNotice, LastUpdated } from "../components/ConnectionNotice";
import {
  describeActionFailure,
  describeLoadFailure,
  toLoadFailure,
  type LoadFailure,
} from "../lib/connectionState";
import { alertKindFromType } from "../lib/money";
import { recordPath } from "../lib/chatLinks";
import { radius, space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { Notification, RecordItem } from "../lib/types";

/**
 * Everything FinSight has flagged, and a way to clear it.
 *
 * The Dashboard already shows the five most recent alerts, but read-only —
 * there was no way to see the rest or to mark anything as read on mobile at
 * all, so the list only ever grew. This is the screen web has at
 * /notifications.
 *
 * Read state is updated OPTIMISTICALLY. Marking something read is a trivial,
 * idempotent action the owner has just requested, and making them watch a
 * spinner for it would be worse than the rare case of it failing — which is
 * reported and rolled back below.
 */
export function NotificationsScreen({ navigation }: any) {
  const t = useTheme();
  const { brand, ink, paper } = t;
  const { selected } = useBusinessProfiles();
  const selectedBusinessProfileId = selected?.id ?? null;
  const selectedBusinessProfileIdRef = useRef<number | null>(selectedBusinessProfileId);
  selectedBusinessProfileIdRef.current = selectedBusinessProfileId;
  const requestVersionRef = useRef(0);
  const loadingBusinessProfileIdRef = useRef<number | null>(null);
  const actionSequenceRef = useRef(0);
  const actionTokenByNotificationRef = useRef(new Map<number, number>());
  const openRequestVersionRef = useRef(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** A failed row action — a different reassurance from a failed list load. */
  const [error, setError] = useState<string | null>(null);
  /** A failed fetch, kept as a descriptor. See lib/connectionState.ts. */
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [openingNotificationId, setOpeningNotificationId] = useState<number | null>(null);

  useEffect(() => {
    openRequestVersionRef.current += 1;
    setOpeningNotificationId(null);
  }, [selectedBusinessProfileId]);

  useEffect(() => () => {
    selectedBusinessProfileIdRef.current = null;
    requestVersionRef.current += 1;
    loadingBusinessProfileIdRef.current = null;
    actionTokenByNotificationRef.current.clear();
    openRequestVersionRef.current += 1;
  }, []);

  const load = useCallback(
    async (isRefresh = false) => {
      if (selectedBusinessProfileId === null) return;
      const requestBusinessProfileId = selectedBusinessProfileId;
      if (loadingBusinessProfileIdRef.current === requestBusinessProfileId) return;
      loadingBusinessProfileIdRef.current = requestBusinessProfileId;
      const requestVersion = ++requestVersionRef.current;
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      setClock(Date.now());
      try {
        const next = await api.get<Notification[]>("/notifications", {
          businessProfileId: requestBusinessProfileId,
        });
        if (
          requestVersionRef.current !== requestVersion ||
          selectedBusinessProfileIdRef.current !== requestBusinessProfileId
        ) return;
        const pendingReadIds = actionTokenByNotificationRef.current;
        setNotifications(next.map((notification) => pendingReadIds.has(notification.id)
          ? { ...notification, readStatus: true }
          : notification));
        setLoadedAt(Date.now());
        setLoadFailure(null);
      } catch (err) {
        if (
          requestVersionRef.current !== requestVersion ||
          selectedBusinessProfileIdRef.current !== requestBusinessProfileId
        ) return;
        setLoadFailure(toLoadFailure(err));
      } finally {
        if (loadingBusinessProfileIdRef.current === requestBusinessProfileId) {
          loadingBusinessProfileIdRef.current = null;
          if (selectedBusinessProfileIdRef.current === requestBusinessProfileId) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }
    },
    [selectedBusinessProfileId],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function markRead(id: number) {
    if (!selected) return;
    requestVersionRef.current += 1;
    const token = ++actionSequenceRef.current;
    const previousReadStatus = notifications.find((notification) => notification.id === id)?.readStatus ?? false;
    actionTokenByNotificationRef.current.set(id, token);
    setError(null);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readStatus: true } : n)));
    try {
      await api.patch(
        `/notifications/${id}/read`,
        undefined,
        { cacheScope: { businessProfileId: selected.id } },
      );
      if (
        actionTokenByNotificationRef.current.get(id) === token &&
        selectedBusinessProfileIdRef.current === selected.id
      ) {
        // A refresh begun while this write was pending may have read the old
        // unread row before the server committed it. Its eventual response is
        // older than the successful mutation even if it arrives afterward.
        requestVersionRef.current += 1;
      }
    } catch (err) {
      // Roll back this row only if no newer action or successful load has
      // replaced its state in the meantime.
      if (actionTokenByNotificationRef.current.get(id) === token) {
        actionTokenByNotificationRef.current.delete(id);
        setNotifications((current) => current.map((notification) =>
          notification.id === id
            ? { ...notification, readStatus: previousReadStatus }
            : notification,
        ));
        setError(describeActionFailure(toLoadFailure(err), "The alert is still unread."));
      }
    } finally {
      if (actionTokenByNotificationRef.current.get(id) === token) {
        actionTokenByNotificationRef.current.delete(id);
      }
    }
  }

  async function markAllRead() {
    if (!selected) return;
    requestVersionRef.current += 1;
    const token = ++actionSequenceRef.current;
    const previousReadStatus = new Map(
      notifications.map((notification) => [notification.id, notification.readStatus]),
    );
    for (const notification of notifications) {
      actionTokenByNotificationRef.current.set(notification.id, token);
    }
    const cleared = notifications.filter((n) => !n.readStatus).length;
    setError(null);
    setNotifications((prev) => prev.map((n) => ({ ...n, readStatus: true })));
    try {
      await api.patch("/notifications/read-all", undefined, {
        query: { businessProfileId: selected.id },
        cacheScope: { businessProfileId: selected.id },
      });
      if (selectedBusinessProfileIdRef.current === selected.id) {
        requestVersionRef.current += 1;
      }
      /*
       * SAY SO. Marking everything read succeeds by making the button that did
       * it disappear and the eyebrow above it change to "All caught up" — a
       * clear enough confirmation to see, and nothing at all to hear. The
       * control the reader was parked on is simply gone, with no statement
       * that it worked.
       *
       * announceForAccessibility rather than a live region: the thing that
       * changed is the absence of a control, so there is no element left to
       * hang a region on. It is a no-op when no reader is running.
       */
      AccessibilityInfo.announceForAccessibility(
        cleared === 1 ? "1 alert marked as read." : `${cleared} alerts marked as read.`,
      );
    } catch (err) {
      const rollbackIds = new Set<number>();
      for (const id of previousReadStatus.keys()) {
        if (actionTokenByNotificationRef.current.get(id) === token) {
          rollbackIds.add(id);
          actionTokenByNotificationRef.current.delete(id);
        }
      }
      if (rollbackIds.size > 0) {
        setNotifications((current) => current.map((notification) =>
          rollbackIds.has(notification.id)
            ? { ...notification, readStatus: previousReadStatus.get(notification.id) ?? notification.readStatus }
            : notification,
        ));
        setError(describeActionFailure(toLoadFailure(err), "Your alerts are still unread."));
      }
    } finally {
      for (const id of previousReadStatus.keys()) {
        if (actionTokenByNotificationRef.current.get(id) === token) {
          actionTokenByNotificationRef.current.delete(id);
        }
      }
    }
  }

  async function openNotification(notification: Notification) {
    const businessProfileId = selectedBusinessProfileIdRef.current;
    if (businessProfileId === null || notification.businessProfileId !== businessProfileId) return;

    if (!notification.readStatus) void markRead(notification.id);
    if (notification.expenseRecordId === null || notification.expenseRecordId === undefined) return;

    const recordId = notification.expenseRecordId;
    const requestVersion = ++openRequestVersionRef.current;
    setOpeningNotificationId(notification.id);
    setError(null);
    try {
      const record = await api.get<RecordItem>(recordPath("expense", recordId));
      if (
        openRequestVersionRef.current !== requestVersion ||
        selectedBusinessProfileIdRef.current !== businessProfileId
      ) return;
      if (record.id !== recordId || record.businessProfileId !== businessProfileId) {
        setError("That alert no longer points to a record in this business.");
        return;
      }
      navigation?.navigate("Records", { screen: "EditRecord", params: { record } });
    } catch {
      if (
        openRequestVersionRef.current === requestVersion &&
        selectedBusinessProfileIdRef.current === businessProfileId
      ) {
        setError("That record couldn't be opened. It may have been deleted.");
      }
    } finally {
      if (openRequestVersionRef.current === requestVersion) setOpeningNotificationId(null);
    }
  }

  if (!selected) {
    return (
      <Screen>
        <View style={{ padding: space.lg }}>
          <EmptyState title="Set up a business first" body="Alerts belong to a business profile." />
        </View>
      </Screen>
    );
  }

  const unread = notifications.filter((n) => !n.readStatus).length;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={brand[600]} />
        }
      >
        <ScreenHeader
          eyebrow={unread > 0 ? `${unread} unread` : "All caught up"}
          title="Alerts"
          subtitle="Duplicates, large expenses, and changes that may need your attention."
          action={unread > 0 ? <Button title="Mark all read" variant="secondary" onPress={markAllRead} /> : undefined}
        />

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <ConnectionNotice
          notice={describeLoadFailure(loadFailure, {
            hasData: notifications.length > 0,
            lastUpdatedAt: loadedAt,
            now: clock,
            subject: "your alerts",
          })}
          onRetry={() => load(true)}
          busy={refreshing}
          style={{ marginBottom: space.md }}
        />

        {notifications.length > 0 ? (
          <LastUpdated at={loadedAt} now={clock} style={{ marginBottom: space.sm }} />
        ) : null}

        {loading ? (
          <ActivityIndicator color={brand[600]} style={{ marginTop: space.xxl }} />
        ) : notifications.length === 0 && loadFailure ? (
          /*
            "Nothing needs your attention" is the WORST possible sentence to
            show over a failed fetch: it is an all-clear on the screen whose
            entire job is to raise duplicates and unusually large expenses.
            The notice above says what actually happened instead.
          */
          null
        ) : notifications.length === 0 ? (
          <EmptyState
            title="Nothing needs your attention"
            body="FinSight will flag possible duplicates, unusually large expenses and anything else worth a second look here."
          />
        ) : (
          notifications.map((n) => {
            const kind = alertKindFromType(n.type);
            const hasRecord = n.expenseRecordId !== null && n.expenseRecordId !== undefined;
            const opening = openingNotificationId === n.id;
            const action = hasRecord
              ? kind === "duplicate" ? "Review duplicate" : "Review record"
              : n.readStatus ? null : "Tap to mark as read";
            const disabled = openingNotificationId !== null || (!hasRecord && n.readStatus);

            return (
              <Pressable
                key={n.id}
                onPress={() => void openNotification(n)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={
                  hasRecord
                    ? `${n.message}. ${opening ? "Opening record." : `${action}.`}${n.readStatus ? " Already read." : ""}`
                    : n.readStatus ? `${n.message}. Already read.` : `${n.message}. Tap to mark as read.`
                }
                accessibilityState={{ disabled, busy: opening }}
                style={{
                  marginBottom: space.sm,
                  borderRadius: radius.md,
                  // An unread alert is the one that still wants something. Read
                  // ones stay visible but recede rather than disappearing.
                  opacity: n.readStatus ? 0.55 : 1,
                  backgroundColor: paper.DEFAULT,
                }}
              >
                <Alert kind={kind} label={n.type} meta={n.dateCreated.slice(0, 10)}>
                  {n.message}
                </Alert>
                {action ? (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.sm,
                      paddingHorizontal: space.md,
                      paddingBottom: space.sm,
                    }}
                  >
                    {opening ? <ActivityIndicator color={brand[600]} size="small" /> : null}
                    <T variant="caption" style={{ color: ink[500] }}>
                      {opening ? "Opening record…" : action}
                    </T>
                  </View>
                ) : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
