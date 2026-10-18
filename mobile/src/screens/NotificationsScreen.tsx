import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Screen, T } from "../components/ui";
import { CONTENT_WIDTH } from "../components/ContentScrollView";
import { TAP_FLOOR } from "../components/touchTarget";
import { SubpageCard, SubpageHeader, SubpageIcon } from "../components/SubpageKit";
import { groupByDay, relativeTime } from "../lib/notificationGroups";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { LastUpdated } from "../components/ConnectionNotice";
import {
  describeActionFailure,
  describeLoadFailure,
  toLoadFailure,
  type LoadFailure,
} from "../lib/connectionState";
import { alertKindFromType } from "../lib/money";
import { recordPath } from "../lib/chatLinks";
import { font, radius, space, typeScale } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { Notification, RecordItem } from "../lib/types";
import type { NotificationsScreenProps } from "../navigation/types";

/** GET /notifications returns at most this many rows (NOTIFICATION_LIST_LIMIT on the server). */
const NOTIFICATION_LIST_CAP = 500;

function presentationFor(type: string): { title: string; icon: keyof typeof Ionicons.glyphMap } {
  const kind = alertKindFromType(type);
  if (kind === "duplicate") return { title: "Possible duplicate", icon: "copy-outline" };
  if (kind === "large-expense") return { title: "Large expense", icon: "warning-outline" };
  if (kind === "needs-review") return { title: "Needs review", icon: "alert-circle-outline" };
  if (kind === "recurring") return { title: "Recurring payment", icon: "repeat-outline" };
  if (type.toLowerCase().includes("recovery")) return { title: "Recovery target", icon: "locate-outline" };
  const readable = type.trim().replace(/[_-]+/g, " ").toLowerCase();
  return {
    title: readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : "Alert",
    icon: readable.includes("anomaly") ? "pulse-outline" : "information-circle-outline",
  };
}

function AlertsEmpty({ title, body, icon, action }: {
  title: string;
  body: string;
  icon: keyof typeof Ionicons.glyphMap;
  action?: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  return (
    <SubpageCard style={{ alignItems: "center", paddingHorizontal: space.xl, paddingVertical: space.xxl, gap: space.lg }}>
      <View style={{ width: 80, height: 80, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: t.brandSurface }}>
        <Ionicons name={action ? "notifications-outline" : icon} size={40} color={t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
        {action ? (
          <View style={{ position: "absolute", right: space.lg, bottom: space.lg, borderRadius: radius.full, backgroundColor: t.surfaceMuted }}>
            <Ionicons name="checkmark-circle-outline" size={32} color={t.textPrimary} accessibilityElementsHidden importantForAccessibility="no" />
          </View>
        ) : null}
      </View>
      <T variant="title" accessibilityRole="header" style={{ textAlign: "center", color: t.textPrimary }}>{title}</T>
      <T style={{ textAlign: "center" }}>{body}</T>
      {action ? <Button title={action.label} variant="primary" onPress={action.onPress} style={{ width: "100%", maxWidth: 320, marginTop: space.sm }} /> : null}
    </SubpageCard>
  );
}

function AlertRow({ notification, clock, opening, disabled, onPress }: {
  notification: Notification;
  clock: number;
  opening: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [needsDisclosure, setNeedsDisclosure] = useState(false);
  const fullText = useRef<Text>(null);
  const presentation = presentationFor(notification.type);
  const warning = alertKindFromType(notification.type) === "large-expense";
  const time = relativeTime(notification.dateCreated, clock);
  const hasRecord = notification.expenseRecordId !== null && notification.expenseRecordId !== undefined;
  const action = hasRecord
    ? alertKindFromType(notification.type) === "duplicate" ? "Review duplicate" : "Review record"
    : notification.readStatus ? null : "Mark as read";
  const actionLabel = hasRecord
    ? `${notification.message}. ${opening ? "Opening record." : `${action}.`}${notification.readStatus ? " Already read." : ""}`
    : notification.readStatus ? `${notification.message}. Already read.` : `${notification.message}. Tap to mark as read.`;

  useEffect(() => {
    setExpanded(false);
    setNeedsDisclosure(false);
  }, [notification.businessProfileId, notification.id, notification.message]);

  const preview = (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <View style={{ width: 40, height: 40, flexShrink: 0, borderRadius: radius.md, backgroundColor: warning ? t.statusSurface.serious : t.surfaceMuted, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={presentation.icon} size={24} color={warning ? t.statusText.serious : t.brandText} accessibilityElementsHidden importantForAccessibility="no" />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: space.sm }}>
          <T style={{ flexGrow: 1, flexBasis: 130, minWidth: 0, color: t.textPrimary, fontFamily: font.sansSemibold }}>{presentation.title}</T>
          <View style={{ borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: notification.readStatus ? t.surfaceMuted : t.brandBorder }}>
            <T variant="caption" style={{ color: notification.readStatus ? t.textMuted : t.brandText }}>{notification.readStatus ? "Read" : "Unread"}</T>
          </View>
        </View>
        <View>
          <T selectable={expanded} numberOfLines={expanded ? undefined : 2} style={{ color: t.textSecondary, fontSize: typeScale.bodySm }}>{notification.message}</T>
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={{ position: "absolute", top: 0, left: 0, right: 0, height: 0, overflow: "hidden", opacity: 0 }}>
            <Text ref={fullText} accessible={false}
              style={{ position: "absolute", top: 0, left: 0, right: 0, fontFamily: font.sans, fontSize: typeScale.bodySm, lineHeight: 22 }}
              onTextLayout={({ nativeEvent }) => setNeedsDisclosure(nativeEvent.lines.length > 2)}
              onLayout={() => {
                const node = fullText.current as unknown as HTMLElement | null;
                if (typeof node?.getBoundingClientRect !== "function" || typeof globalThis.getComputedStyle !== "function") return;
                const lineHeight = Number.parseFloat(globalThis.getComputedStyle(node).lineHeight);
                if (lineHeight > 0) setNeedsDisclosure(node.getBoundingClientRect().height > lineHeight * 2.1);
              }}>
              {notification.message}
            </Text>
          </View>
        </View>
        <T variant="caption" style={{ marginTop: space.xs }}>{time}</T>
      </View>
    </View>
  );

  return (
    <SubpageCard tone={notification.readStatus ? "default" : "mint"} style={{ paddingBottom: action || needsDisclosure || expanded ? space.xs : space.lg }}>
      {action ? (
        <Pressable accessible={false} importantForAccessibility="no" accessibilityRole="button" onPress={onPress} disabled={disabled}
          style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}>
          {preview}
        </Pressable>
      ) : (
        <Pressable disabled accessibilityRole="button" accessibilityLabel={actionLabel} accessibilityHint="Read alert" accessibilityState={{ disabled: true }} style={{ minHeight: TAP_FLOOR }}>
          {preview}
        </Pressable>
      )}
      {action || needsDisclosure || expanded ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.md, marginTop: space.md, borderTopWidth: 1, borderTopColor: notification.readStatus ? t.border : t.brandBorder }}>
          {action ? (
            <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={actionLabel}
              accessibilityHint={notification.readStatus ? "Read alert" : "Unread alert"} accessibilityState={{ disabled, busy: opening }}
              style={({ pressed }) => ({ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: space.xs, opacity: pressed ? 0.65 : 1 })}>
              {opening ? <ActivityIndicator color={t.textPrimary} size="small" /> : null}
              <T style={{ color: t.brandText, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold, flexShrink: 1 }}>{opening ? "Opening record..." : action}</T>
              {!opening ? <Ionicons name="chevron-forward" size={16} color={t.textPrimary} accessibilityElementsHidden importantForAccessibility="no" /> : null}
            </Pressable>
          ) : null}
          {needsDisclosure || expanded ? (
            <Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button"
              accessibilityLabel={`${expanded ? "Show less" : "Read full alert"}: ${presentation.title}, ${time}`}
              accessibilityState={{ expanded }} aria-expanded={expanded}
              style={({ pressed }) => ({ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, maxWidth: "100%", justifyContent: "center", opacity: pressed ? 0.65 : 1 })}>
              <T variant="caption" style={{ color: t.textPrimary, fontFamily: font.sansSemibold, textDecorationLine: "underline" }}>{expanded ? "Show less" : "Read full alert"}</T>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </SubpageCard>
  );
}

function AlertsNotice({ title, body, onRetry, retryLabel, busy = false, assertive = false }: {
  title?: string;
  body: string;
  onRetry?: () => void;
  retryLabel?: string;
  busy?: boolean;
  assertive?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.surfaceMuted, padding: space.lg, borderRadius: radius.md, gap: space.md, marginBottom: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <Ionicons name="alert-circle-outline" size={22} color={t.textPrimary} accessibilityElementsHidden importantForAccessibility="no" />
        <View accessible accessibilityRole="alert" accessibilityLiveRegion={assertive ? "assertive" : "polite"}
          accessibilityLabel={title ? `${title}. ${body}` : body} style={{ flex: 1, gap: space.xs }}>
          {title ? <T style={{ color: t.textPrimary, fontFamily: font.sansSemibold }}>{title}</T> : null}
          <T style={{ fontSize: typeScale.bodySm }}>{body}</T>
        </View>
      </View>
      {onRetry ? <Button title={retryLabel ?? "Try again"} variant="secondary" loading={busy} onPress={onRetry} /> : null}
    </View>
  );
}

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
export function NotificationsScreen({ navigation }: NotificationsScreenProps) {
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { selected } = useBusinessProfiles();
  const selectedBusinessProfileId = selected?.id ?? null;
  const selectedBusinessProfileIdRef = useRef<number | null>(selectedBusinessProfileId);
  selectedBusinessProfileIdRef.current = selectedBusinessProfileId;
  const requestVersionRef = useRef(0);
  const loadingBusinessProfileIdRef = useRef<number | null>(null);
  const actionSequenceRef = useRef(0);
  const actionTokenByNotificationRef = useRef(new Map<number, number>());
  const openRequestVersionRef = useRef(0);
  const openingRequest = useRef<object | null>(null);
  const readAllRequest = useRef<object | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [loadedBusinessId, setLoadedBusinessId] = useState<number | null>(null);
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
    requestVersionRef.current += 1;
    actionTokenByNotificationRef.current.clear();
    readAllRequest.current = null;
    openingRequest.current = null;
    setMarkingAll(false);
    setNotifications([]);
    setLoadedBusinessId(null);
    setLoadedAt(null);
    setLoadFailure(null);
    setError(null);
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
        setLoadedBusinessId(requestBusinessProfileId);
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
    if (!selected || loadedBusinessId !== selected.id || actionTokenByNotificationRef.current.has(id)) return;
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
      if (actionTokenByNotificationRef.current.get(id) === token && selectedBusinessProfileIdRef.current === selected.id) {
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
    if (!selected || loadedBusinessId !== selected.id || readAllRequest.current) return;
    const request = {};
    readAllRequest.current = request;
    setMarkingAll(true);
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
      } else {
        return;
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
      if (rollbackIds.size > 0 && selectedBusinessProfileIdRef.current === selected.id) {
        setNotifications((current) => current.map((notification) =>
          rollbackIds.has(notification.id)
            ? { ...notification, readStatus: previousReadStatus.get(notification.id) ?? notification.readStatus }
            : notification,
        ));
        setError(describeActionFailure(toLoadFailure(err), "Your alerts are still unread."));
      }
    } finally {
      if (readAllRequest.current === request) {
        readAllRequest.current = null;
        setMarkingAll(false);
      }
      for (const id of previousReadStatus.keys()) {
        if (actionTokenByNotificationRef.current.get(id) === token) {
          actionTokenByNotificationRef.current.delete(id);
        }
      }
    }
  }

  async function openNotification(notification: Notification) {
    const businessProfileId = selectedBusinessProfileIdRef.current;
    if (businessProfileId === null || notification.businessProfileId !== businessProfileId || openingRequest.current) return;

    if (!notification.readStatus) void markRead(notification.id);
    if (notification.expenseRecordId === null || notification.expenseRecordId === undefined) return;

    const recordId = notification.expenseRecordId;
    const opening = {};
    openingRequest.current = opening;
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
      if (openingRequest.current === opening) {
        openingRequest.current = null;
        setOpeningNotificationId(null);
      }
    }
  }

  const currentNotifications = selected && loadedBusinessId === selected.id ? notifications : [];
  const hasLoaded = selected !== null && loadedBusinessId === selected.id;
  const unread = currentNotifications.filter((notification) => !notification.readStatus).length;
  // At the server's list cap, older alerts may exist beyond it, so both counts
  // become "at least" rather than exact.
  const capped = currentNotifications.length >= NOTIFICATION_LIST_CAP;
  const atLeast = (count: number) => (capped ? `${count}+` : String(count));
  const visible = filter === "unread" ? currentNotifications.filter((notification) => !notification.readStatus) : currentNotifications;
  const groups = groupByDay(visible, clock);
  const notice = describeLoadFailure(loadFailure, {
    hasData: currentNotifications.length > 0,
    lastUpdatedAt: loadedAt,
    now: clock,
    subject: "your alerts",
  });
  const initialLoading = loading && currentNotifications.length === 0;

  const header = (
    <SubpageHeader title="Alerts" onBack={() => {
      if (navigation?.canGoBack?.()) navigation.goBack();
      else navigation?.navigate("More", { screen: "MoreHome", initial: false });
    }} />
  );

  if (!selected) {
    return (
      <Screen>
        {header}
        <View style={{ padding: space.lg }}><AlertsEmpty title="Set up a business first" body="Alerts belong to a business profile." icon="business-outline" /></View>
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
      <SectionList
        style={{ flex: 1, width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center" }}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}
        sections={initialLoading ? [] : groups.map((group) => ({ title: group.label, data: group.items }))}
        keyExtractor={(notification) => `${notification.businessProfileId}:${notification.id}`}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={5}
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={t.textPrimary} colors={[t.textPrimary]} />}
        ListHeaderComponent={
          <View style={{ paddingTop: space.xs }}>
            <SubpageCard tone="mint" style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, marginBottom: space.md }}>
              <SubpageIcon name="storefront-outline" />
              <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                <T style={{ color: t.textPrimary, fontFamily: font.sansSemibold }}>{selected.name}</T>
                <T variant="caption" accessibilityLiveRegion="polite">{hasLoaded ? `${atLeast(unread)} unread` : loadFailure ? "Alerts unavailable" : "Checking alerts"}</T>
              </View>
            </SubpageCard>
            {hasLoaded ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm }}>
                {[
                    { label: `All (${atLeast(currentNotifications.length)})`, value: "all" },
                    { label: `Unread (${atLeast(unread)})`, value: "unread" },
                  ].map(({ label, value }) => {
                    const active = filter === value;
                    return (
                      <Pressable key={value} accessibilityRole="button" accessibilityLabel={`Filter alerts, ${label}`}
                        accessibilityState={{ selected: active }} aria-pressed={active} onPress={() => setFilter(value as "all" | "unread")}
                        style={({ pressed }) => ({ flexGrow: 1, flexBasis: 100, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: active ? t.brandBorder : t.border,
                          backgroundColor: active ? t.brandSurface : t.surface, opacity: pressed ? 0.75 : 1 })}>
                        <T style={{ textAlign: "center", color: active ? t.brandText : t.textPrimary, fontSize: typeScale.bodySm, fontFamily: font.sansSemibold }}>{label}</T>
                      </Pressable>
                    );
                  })}
                {unread > 0 || markingAll ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Mark all read" accessibilityState={{ disabled: markingAll, busy: markingAll }} disabled={markingAll} onPress={() => void markAllRead()}
                    style={({ pressed }) => ({ flexGrow: 1, minHeight: TAP_FLOOR, maxWidth: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.sm, paddingVertical: space.sm, opacity: markingAll ? 0.7 : pressed ? 0.65 : 1 })}>
                    {markingAll ? <ActivityIndicator color={t.brandText} size="small" /> : null}
                    <T style={{ color: t.brandText, fontFamily: font.sansMedium, fontSize: typeScale.bodySm, flexShrink: 1 }}>{markingAll ? "Marking read..." : "Mark all as read"}</T>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {error ? <AlertsNotice body={error} assertive /> : null}
            {notice ? <AlertsNotice title={notice.title} body={notice.body} onRetry={() => void load(true)} retryLabel={notice.retryLabel} busy={refreshing} assertive={notice.kind === "cannot-load"} /> : null}
            {hasLoaded ? <LastUpdated at={loadedAt} now={clock} style={{ alignItems: "center", marginBottom: space.xs }} /> : null}
            {initialLoading ? <ActivityIndicator accessibilityLabel="Loading alerts" color={t.textPrimary} style={{ marginVertical: space.xxl }} /> : null}
          </View>
        }
        ListEmptyComponent={loading || loadFailure || !hasLoaded ? null : currentNotifications.length === 0 ? (
          <AlertsEmpty title="No alerts yet" body="FinSight will flag possible duplicates, unusually large expenses and anything else worth a second look here." icon="notifications-outline" />
        ) : (
          <AlertsEmpty title="All alerts read" body="You can still review the records behind earlier alerts." icon="checkmark-circle-outline"
            action={{ label: "View all alerts", onPress: () => setFilter("all") }} />
        )}
        renderSectionHeader={({ section }) => (
          <T variant="heading" accessibilityRole="header" style={{ color: t.textPrimary, fontFamily: font.sansSemibold, paddingTop: space.lg, paddingBottom: space.sm }}>
            {section.title}
          </T>
        )}
        renderItem={({ item: notification }) => (
          <AlertRow notification={notification} clock={clock} opening={openingNotificationId === notification.id}
            disabled={openingNotificationId !== null || (notification.expenseRecordId == null && notification.readStatus)}
            onPress={() => void openNotification(notification)} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="Recovery alert settings"
        onPress={() => navigation?.navigate("More", { screen: "RecoveryNotificationPreferences", initial: false })}
        style={({ pressed }) => ({ width: "100%", maxWidth: CONTENT_WIDTH, alignSelf: "center", minHeight: TAP_FLOOR, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: Math.max(insets.bottom, space.md), borderTopWidth: 1, borderTopColor: t.border, backgroundColor: pressed ? t.surfaceMuted : t.surface })}>
        <Ionicons name="options-outline" size={24} color={t.textPrimary} accessibilityElementsHidden importantForAccessibility="no" />
        <T style={{ flex: 1, color: t.textPrimary, fontFamily: font.sansMedium }}>Recovery alert settings</T>
        <Ionicons name="chevron-forward" size={20} color={t.textPrimary} accessibilityElementsHidden importantForAccessibility="no" />
      </Pressable>
    </Screen>
  );
}
