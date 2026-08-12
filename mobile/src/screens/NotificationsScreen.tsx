import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, Button, EmptyState, ErrorNote, Screen, T } from "../components/ui";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { alertKindFromType } from "../lib/money";
import { brand, ink, paper, radius, space } from "../theme/tokens";
import type { Notification } from "../lib/types";

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
export function NotificationsScreen() {
  const { selected } = useBusinessProfiles();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (!selected) return;
      isRefresh ? setRefreshing(true) : setLoading(true);
      setError(null);
      try {
        setNotifications(
          await api.get<Notification[]>("/notifications", { businessProfileId: selected.id }),
        );
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [selected?.id],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function markRead(id: number) {
    const previous = notifications;
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readStatus: true } : n)));
    try {
      await api.patch(`/notifications/${id}/read`);
    } catch (err) {
      // Put it back. Leaving it looking read when the server still has it
      // unread would be lying about the state of their alerts.
      setNotifications(previous);
      setError(errorMessage(err));
    }
  }

  async function markAllRead() {
    if (!selected) return;
    const previous = notifications;
    setNotifications((prev) => prev.map((n) => ({ ...n, readStatus: true })));
    try {
      await api.patch("/notifications/read-all", undefined, { businessProfileId: selected.id });
    } catch (err) {
      setNotifications(previous);
      setError(errorMessage(err));
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
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.md,
            marginBottom: space.md,
          }}
        >
          <T variant="title" style={{ flex: 1 }}>
            Alerts{unread > 0 ? ` (${unread} unread)` : ""}
          </T>
          {unread > 0 ? <Button title="Mark all read" variant="secondary" onPress={markAllRead} /> : null}
        </View>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {loading ? (
          <ActivityIndicator color={brand[600]} style={{ marginTop: space.xxl }} />
        ) : notifications.length === 0 ? (
          <EmptyState
            title="Nothing needs your attention"
            body="FinSight will flag possible duplicates, unusually large expenses and anything else worth a second look here."
          />
        ) : (
          notifications.map((n) => (
            <Pressable
              key={n.id}
              onPress={() => (n.readStatus ? undefined : markRead(n.id))}
              disabled={n.readStatus}
              accessibilityRole="button"
              accessibilityLabel={
                n.readStatus ? `${n.message}. Already read.` : `${n.message}. Tap to mark as read.`
              }
              style={{
                marginBottom: space.sm,
                borderRadius: radius.md,
                // An unread alert is the one that still wants something. Read
                // ones stay visible but recede rather than disappearing.
                opacity: n.readStatus ? 0.55 : 1,
                backgroundColor: paper.DEFAULT,
              }}
            >
              <Alert kind={alertKindFromType(n.type)} label={n.type} meta={n.dateCreated.slice(0, 10)}>
                {n.message}
              </Alert>
              {!n.readStatus ? (
                <T variant="caption" style={{ color: ink[500], paddingHorizontal: space.md, paddingBottom: space.sm }}>
                  Tap to mark as read
                </T>
              ) : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
