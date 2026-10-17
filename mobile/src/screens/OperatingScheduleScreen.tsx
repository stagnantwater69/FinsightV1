import { useCallback, useEffect, useRef, useState } from "react";
import { Alert as RNAlert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Screen,
  SegmentedControl,
  T,
} from "../components/ui";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DateField } from "../components/DateField";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { radius, space, typeScale, font } from "../theme/tokens";
import { TAP_FLOOR } from "../components/touchTarget";
import { useTheme } from "../context/ThemeContext";
import { ContentScrollView } from "../components/ContentScrollView";
import { businessToday } from "../lib/businessDate";
import type { OperatingDayOverride, OperatingDayOverridePage } from "../lib/types";

/**
 * Operating schedule setup — Recovery Target Improvement Plan §7.2/§7.3, §10.5,
 * §11 Phase 2 "Web and mobile — Add operating-schedule setup/editing to the
 * business profile flow. Add closure/holiday override management."
 *
 * TWO INDEPENDENT THINGS ON ONE SCREEN, deliberately: a weekly pattern (which
 * weekdays this business normally opens) and date-specific exceptions
 * (holidays, one-off closures or special openings) that override that pattern
 * for a single date. The backend keeps them as two resources for the same
 * reason — an override should not have to rewrite the whole week to record one
 * closed Tuesday.
 *
 * WHY THIS IS ITS OWN SCREEN rather than a section bolted onto
 * BusinessProfileFormScreen: that form is already six chained fields plus a
 * photo upload, submitted as one PATCH. This is two separate resources with
 * their own save/add/delete actions and their own loading states — folding
 * them in would mean three different kinds of "saved" on one screen scrolling
 * past each other. Reached from a "Operating schedule" row on the business
 * profile form and from the Recovery Target screen's approximation notice.
 */

type WeekdayEntry = { weekday: number; isOpen: boolean };
type Override = OperatingDayOverride;

const WEEKDAY_LABELS: { weekday: number; label: string }[] = [
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
  { weekday: 7, label: "Sunday" },
];

/** All seven weekdays open — the starting point when nothing is configured yet. */
function defaultAllOpen(): WeekdayEntry[] {
  return WEEKDAY_LABELS.map(({ weekday }) => ({ weekday, isOpen: true }));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Current month through the end of next month — enough to plan ahead without an unbounded range. */
function defaultOverrideRange(timezone?: string): { from: string; to: string } {
  const [year, month, day] = businessToday(timezone).split("-").map(Number);
  const now = new Date(year!, month! - 1, day!);
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return { from: toISO(from), to: toISO(to) };
}

export function OperatingScheduleScreen({ route }: { route?: { params?: { businessProfileId?: number } } } = {}) {
  const t = useTheme();
  const { paper } = t;
  const insets = useSafeAreaInsets();
  const { selected, profiles } = useBusinessProfiles();
  const businessId = route?.params?.businessProfileId ?? selected?.id;
  const business = profiles.find((profile) => profile.id === businessId);
  const businessTimezone = useRef(business?.timezone);
  businessTimezone.current = business?.timezone;
  const scope = useRef({ businessId, generation: 0 });
  if (scope.current.businessId !== businessId) scope.current = { businessId, generation: scope.current.generation + 1 };
  const loadRequest = useRef(0);
  const scheduleMutation = useRef<object | null>(null);
  const overrideMutation = useRef<object | null>(null);
  const deleteMutation = useRef<object | null>(null);
  const [loadedScheduleGeneration, setLoadedScheduleGeneration] = useState<number | null>(null);
  const [loadedOverridesGeneration, setLoadedOverridesGeneration] = useState<number | null>(null);

  const [entries, setEntries] = useState<WeekdayEntry[]>(defaultAllOpen());
  const [loadingSchedule, setLoadingSchedule] = useState(true);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [scheduleConfigured, setScheduleConfigured] = useState(false);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [overrideRange, setOverrideRange] = useState(() => defaultOverrideRange(business?.timezone));
  const overrideRangeRef = useRef(overrideRange);
  overrideRangeRef.current = overrideRange;
  const [loadedOverrideRange, setLoadedOverrideRange] = useState<{ from: string; to: string } | null>(null);
  const loadedOverrideRangeRef = useRef(loadedOverrideRange);
  loadedOverrideRangeRef.current = loadedOverrideRange;
  const [overridesCursor, setOverridesCursor] = useState<string | null>(null);
  const [loadingMoreOverrides, setLoadingMoreOverrides] = useState(false);
  const overrideLoadRequest = useRef(0);
  const failedOverrideLoad = useRef<{ cursor?: string; range: { from: string; to: string }; generation: number } | null>(null);
  const overrideCursors = useRef(new Set<string>());
  const deletedOverrides = useRef(new Set<number>());
  const overrideFlight = useRef(false);
  const [specialDateOpen, setSpecialDateOpen] = useState(false);
  const [addedMessage, setAddedMessage] = useState<string | null>(null);

  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loadingOverrides, setLoadingOverrides] = useState(true);
  const [overridesError, setOverridesError] = useState<string | null>(null);

  const [newDate, setNewDate] = useState("");
  const [newType, setNewType] = useState<"OPEN" | "CLOSED">("CLOSED");
  const [newReason, setNewReason] = useState("");
  const [addingOverride, setAddingOverride] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyOverrideId, setBusyOverrideId] = useState<number | null>(null);

  useEffect(() => {
    overrideLoadRequest.current += 1;
    failedOverrideLoad.current = null;
    overrideFlight.current = false;
    overrideCursors.current.clear();
    deletedOverrides.current.clear();
    setOverridesCursor(null);
    setLoadedOverrideRange(null);
    setLoadingMoreOverrides(false);
    const range = defaultOverrideRange(businessTimezone.current);
    overrideRangeRef.current = range;
    setOverrideRange(range);
    scheduleMutation.current = null;
    overrideMutation.current = null;
    deleteMutation.current = null;
    setSpecialDateOpen(false);
    setAddedMessage(null);
    setNewDate("");
    setNewType("CLOSED");
    setNewReason("");
    setAddError(null);
    setAddingOverride(false);
    setSavingSchedule(false);
    setBusyOverrideId(null);
    return () => {
      scope.current = { ...scope.current, generation: scope.current.generation + 1 };
      loadRequest.current += 1;
      overrideLoadRequest.current += 1;
    };
  }, [businessId]);

  const loadOverrides = useCallback(async (cursor?: string, retryRange?: { from: string; to: string }) => {
    if (businessId === undefined || (cursor && overrideFlight.current)) return;
    const generation = scope.current.generation;
    const request = ++overrideLoadRequest.current;
    const range = retryRange ?? (cursor ? loadedOverrideRangeRef.current : overrideRangeRef.current);
    if (!range) return;
    const current = () => generation === scope.current.generation && request === overrideLoadRequest.current;
    overrideFlight.current = true;
    failedOverrideLoad.current = null;
    if (cursor) setLoadingMoreOverrides(true); else setLoadingOverrides(true);
    setOverridesError(null);
    try {
      if (range.from && range.to && range.from > range.to) throw new Error("Choose an end date on or after the start date.");
      const result = await api.get<OperatingDayOverridePage | Override[]>(`/business-profiles/${businessId}/operating-overrides`, { pageSize: 50, from: range.from || undefined, to: range.to || undefined, cursor });
      if (!current()) return;
      const page = Array.isArray(result) ? { items: result, nextCursor: null } : result;
      if (!page || !Array.isArray(page.items) || page.items.some((item) => item.businessProfileId !== businessId)) throw new Error("The special dates could not be verified for this business.");
      if (cursor && page.nextCursor !== null && (page.nextCursor === cursor || overrideCursors.current.has(page.nextCursor))) throw new Error("The special-date page did not advance. Reload this range before continuing.");
      if (cursor) overrideCursors.current.add(cursor); else overrideCursors.current.clear();
      setOverrides((previous) => [...new Map([...(cursor ? previous : []), ...page.items].filter((item) => !deletedOverrides.current.has(item.id)).map((item) => [item.id, item])).values()].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id));
      setLoadedOverrideRange({ ...range });
      setOverridesCursor(page.nextCursor);
      setLoadedOverridesGeneration(generation);
    } catch (err) {
      if (current()) {
        failedOverrideLoad.current = { cursor, range: { ...range }, generation };
        setOverridesError(errorMessage(err));
      }
    }
    finally {
      if (current()) { overrideFlight.current = false; setLoadingOverrides(false); setLoadingMoreOverrides(false); }
    }
  }, [businessId]);

  function changeOverrideRange(field: "from" | "to", value: string) {
    overrideLoadRequest.current += 1;
    overrideFlight.current = false;
    failedOverrideLoad.current = null;
    setLoadingOverrides(false);
    setLoadingMoreOverrides(false);
    setOverridesError(null);
    const range = { ...overrideRangeRef.current, [field]: value };
    overrideRangeRef.current = range;
    setOverrideRange(range);
  }

  function retryOverrides() {
    const failed = failedOverrideLoad.current;
    if (failed && failed.generation === scope.current.generation) void loadOverrides(failed.cursor, failed.range);
    else void loadOverrides();
  }

  const load = useCallback(async () => {
    if (businessId === undefined) return;
    const generation = scope.current.generation;
    const request = ++loadRequest.current;
    const current = () => request === loadRequest.current && generation === scope.current.generation;
    setLoadingSchedule(true);
    setScheduleError(null);
    await Promise.all([
    (async () => {
    try {
      const schedule = await api.get<WeekdayEntry[]>(`/business-profiles/${businessId}/operating-schedule`);
      if (!current()) return;
      // Empty means never configured — the plan's default here is all-open,
      // pre-checked but NOT auto-submitted, so nothing is saved until the
      // owner reviews it and taps Save.
      setEntries(schedule.length === 7 ? schedule : defaultAllOpen());
      setScheduleConfigured(schedule.length === 7);
      setScheduleDirty(false);
      setScheduleSaved(false);
      setLoadedScheduleGeneration(generation);
    } catch (err) {
      if (current()) setScheduleError(errorMessage(err));
    } finally {
      if (current()) setLoadingSchedule(false);
    }
    })(),
    loadOverrides(),
    ]);
  }, [businessId, loadOverrides]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { loadRequest.current += 1; overrideLoadRequest.current += 1; overrideFlight.current = false; };
    }, [load]),
  );

  function toggleWeekday(weekday: number) {
    setEntries((prev) => prev.map((e) => (e.weekday === weekday ? { ...e, isOpen: !e.isOpen } : e)));
    setScheduleSaved(false);
    setScheduleDirty(true);
  }

  async function saveSchedule() {
    if (businessId === undefined || scheduleMutation.current || loadedScheduleGeneration !== scope.current.generation) return;
    const generation = scope.current.generation;
    const request = {};
    scheduleMutation.current = request;
    setSavingSchedule(true);
    setScheduleError(null);
    setScheduleSaved(false);
    try {
      await api.put(`/business-profiles/${businessId}/operating-schedule`, { entries });
      if (generation !== scope.current.generation || scheduleMutation.current !== request) return;
      setScheduleSaved(true);
      setScheduleConfigured(true);
      setScheduleDirty(false);
    } catch (err) {
      if (generation === scope.current.generation) setScheduleError(errorMessage(err));
    } finally {
      if (scheduleMutation.current === request) {
        scheduleMutation.current = null;
        setSavingSchedule(false);
      }
    }
  }

  async function addOverride() {
    if (businessId === undefined || !newDate || overrideMutation.current || loadedOverridesGeneration !== scope.current.generation) return;
    const generation = scope.current.generation;
    const request = {};
    overrideMutation.current = request;
    setAddingOverride(true);
    setAddError(null);
    try {
      const created = await api.post<Override>(`/business-profiles/${businessId}/operating-overrides`, {
        date: newDate,
        type: newType,
        reason: newReason.trim() || undefined,
      });
      if (generation !== scope.current.generation || overrideMutation.current !== request) return;
      const range = loadedOverrideRangeRef.current;
      if (range && (!range.from || created.date >= range.from) && (!range.to || created.date <= range.to)) setOverrides((prev) => [...prev.filter((item) => item.id !== created.id), created].sort((a, b) => a.date.localeCompare(b.date)));
      setNewDate("");
      setNewType("CLOSED");
      setNewReason("");
      setSpecialDateOpen(false);
      setAddedMessage(`Special date added: ${created.date.slice(0, 10)}.`);
    } catch (err) {
      if (generation === scope.current.generation) setAddError(errorMessage(err));
    } finally {
      if (overrideMutation.current === request) {
        overrideMutation.current = null;
        setAddingOverride(false);
      }
    }
  }

  function confirmDeleteOverride(o: Override) {
    const generation = scope.current.generation;
    RNAlert.alert(
      `Remove ${o.date}?`,
      o.type === "CLOSED"
        ? "This date goes back to following your weekly schedule."
        : "This special opening date will be removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            if (businessId === undefined || generation !== scope.current.generation || deleteMutation.current) return;
            const request = {};
            deleteMutation.current = request;
            setBusyOverrideId(o.id);
            try {
              await api.delete(`/business-profiles/${businessId}/operating-overrides/${o.id}`);
              if (generation !== scope.current.generation || deleteMutation.current !== request) return;
              deletedOverrides.current.add(o.id);
              setOverrides((prev) => prev.filter((x) => x.id !== o.id));
            } catch (err) {
              if (generation === scope.current.generation) setOverridesError(errorMessage(err));
            } finally {
              if (deleteMutation.current === request) {
                deleteMutation.current = null;
                setBusyOverrideId(null);
              }
            }
          },
        },
      ],
    );
  }

  if (!business) return null;
  const scheduleReady = loadedScheduleGeneration === scope.current.generation;
  const overridesReady = loadedOverridesGeneration === scope.current.generation;
  const visibleOverrides = overridesReady ? overrides : [];
  const closeSpecialDate = () => { if (!overrideMutation.current) setSpecialDateOpen(false); };

  return (
    <Screen>
      <ContentScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
        <View style={{ gap: space.sm }}>
          <T variant="caption">{business.name}</T>
          <T style={{ color: t.textSecondary }}>Tell FinSight when your business is open.</T>
        </View>

        <View style={{ gap: space.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: t.brandSurface, borderRadius: radius.md, padding: space.lg }}>
            <Ionicons name="storefront-outline" size={32} color={t.brandText} />
            <View style={{ flex: 1, gap: space.xs }}>
              <T variant="heading" accessibilityRole="header">Your usual week</T>
              <T style={{ color: t.textSecondary }}>{loadingSchedule || !scheduleReady ? "Loading…" : `${entries.filter((entry) => entry.isOpen).length} open days · every week`}</T>
              {!loadingSchedule && scheduleReady && (!scheduleConfigured || scheduleDirty) ? <T variant="caption">{scheduleConfigured ? "Unsaved changes" : "Suggested starting week · not saved yet"}</T> : null}
            </View>
          </View>
          {scheduleReady ? <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ flexGrow: 1, justifyContent: "space-between", gap: space.xs }}>
              {WEEKDAY_LABELS.map(({ weekday, label }) => {
                const open = entries.find((entry) => entry.weekday === weekday)?.isOpen ?? true;
                return <Pressable key={weekday} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: open, disabled: savingSchedule }} disabled={savingSchedule} onPress={() => toggleWeekday(weekday)} style={({ pressed }) => ({ minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, flexShrink: 0, alignItems: "center", gap: space.sm, paddingVertical: space.xs, opacity: pressed ? 0.7 : 1 })}>
                  <T style={{ fontFamily: font.sansMedium, fontSize: typeScale.bodySm, color: t.textSecondary }}>{label.slice(0, 3)}</T>
                  <View style={{ width: 30, height: 30, borderRadius: radius.full, borderWidth: 1, borderColor: open ? t.brandFill : t.borderStrong, backgroundColor: open ? t.brandFill : t.surface, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name={open ? "checkmark" : "remove"} size={20} color={open ? t.onBrandFill : t.textMuted} />
                  </View>
                  <T style={{ fontSize: typeScale.caption, color: open ? t.brandText : t.textMuted }}>{open ? "Open" : "Closed"}</T>
                </Pressable>;
              })}
            </ScrollView>
            <T variant="caption">Tap a day to switch between open and closed.</T>
            {scheduleError ? <ErrorNote>{scheduleError}</ErrorNote> : null}
            {scheduleSaved ? <T variant="caption" accessibilityLiveRegion="polite">Saved.</T> : null}
            <Button title="Save weekly schedule" variant="primary" onPress={saveSchedule} loading={savingSchedule} />
          </> : scheduleError ? <View style={{ gap: space.sm }}><ErrorNote>{scheduleError}</ErrorNote><Button title="Retry weekly schedule" variant="secondary" onPress={() => void load()} /></View> : null}
        </View>

        <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: space.lg, gap: space.md }}>
          <T variant="heading" accessibilityRole="header">Special dates</T>
          <T style={{ color: t.textSecondary }}>Close for a holiday or open on a day you usually close.</T>
          <Pressable accessibilityRole="button" accessibilityLabel="Add special date" accessibilityState={{ disabled: !overridesReady }} disabled={!overridesReady} onPress={() => { setAddError(null); setSpecialDateOpen(true); }} style={({ pressed }) => ({ minHeight: TAP_FLOOR, paddingHorizontal: space.md, paddingVertical: space.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, borderWidth: 1, borderColor: t.brandText, borderRadius: radius.md, backgroundColor: t.surface, opacity: !overridesReady ? 0.6 : pressed ? 0.7 : 1 })}>
            <Ionicons name="add" size={22} color={t.brandText} />
            <T style={{ color: t.brandText, fontFamily: font.sansSemibold, fontSize: typeScale.bodySm }}>Add special date</T>
          </Pressable>
          <DateField label="Special dates from" value={overrideRange.from} onChange={(from) => changeOverrideRange("from", from)} onClear={() => changeOverrideRange("from", "")} allowFuture today={businessToday(business.timezone)} />
          <DateField label="Special dates through" value={overrideRange.to} onChange={(to) => changeOverrideRange("to", to)} onClear={() => changeOverrideRange("to", "")} allowFuture today={businessToday(business.timezone)} />
          <Button title="Load date range" variant="secondary" loading={loadingOverrides} onPress={() => void loadOverrides()} />
          {loadedOverrideRange ? <T variant="caption">Loaded special dates: {loadedOverrideRange.from || "any start date"} to {loadedOverrideRange.to || "any end date"}.</T> : null}
          {addedMessage ? <T variant="caption" accessibilityLiveRegion="polite" style={{ color: t.statusText.good }}>{addedMessage}</T> : null}
          <View style={{ marginTop: space.lg }}>
            {overridesError ? <View style={{ gap: space.sm }}><ErrorNote>{overridesError}</ErrorNote><Button title="Retry special dates" variant="secondary" onPress={retryOverrides} /></View> : null}
            {(loadingOverrides && visibleOverrides.length === 0) || (!overridesReady && !overridesError) ? (
              <T variant="caption">Loading…</T>
            ) : visibleOverrides.length === 0 && !overridesError ? (
              <View style={{ alignItems: "center", paddingVertical: space.lg, gap: space.sm }}>
                <Ionicons name="calendar-outline" size={36} color={t.textMuted} />
                <T variant="heading">No special dates yet</T>
                <T variant="caption" style={{ textAlign: "center" }}>Your usual week applies throughout this range.</T>
              </View>
            ) : (
              visibleOverrides.map((o, i) => (
                <View
                  key={o.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    paddingVertical: space.sm,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: paper[200],
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <T style={{ fontSize: typeScale.bodySm, fontFamily: font.sansMedium }}>{o.date}</T>
                    <T variant="caption">
                      {o.type === "CLOSED" ? "Closed" : "Open"}
                      {o.reason ? ` · ${o.reason}` : ""}
                    </T>
                  </View>
                  <Pressable
                    onPress={() => confirmDeleteOverride(o)}
                    disabled={busyOverrideId !== null}
                    accessibilityState={{ disabled: busyOverrideId !== null, busy: busyOverrideId === o.id }}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove the ${o.type === "CLOSED" ? "closure" : "opening"} on ${o.date}`}
                    style={{ padding: space.sm, minWidth: TAP_FLOOR, minHeight: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}
                  >
                    <Ionicons name="trash-outline" size={18} color={t.statusText.critical} />
                  </Pressable>
                </View>
              ))
            )}
            {overridesReady && overridesCursor ? <Button title="Load more special dates" variant="secondary" loading={loadingMoreOverrides} disabled={loadingOverrides} onPress={() => void loadOverrides(overridesCursor)} /> : null}
          </View>
        </View>
        <Card style={{ backgroundColor: t.brandSurface }}>
          <T variant="heading">Why this matters</T>
          <T style={{ color: t.textSecondary }}>FinSight uses your open days to calculate your daily sales target.</T>
        </Card>
      </ContentScrollView>
      <Modal visible={specialDateOpen} transparent animationType="slide" onRequestClose={closeSpecialDate} statusBarTranslucent>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end", backgroundColor: t.scrim }}>
          <Pressable accessible={false} importantForAccessibility="no-hide-descendants" onPress={closeSpecialDate} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
          <View accessibilityViewIsModal style={{ width: "100%", maxWidth: 720, alignSelf: "center", maxHeight: "90%", backgroundColor: t.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingBottom: insets.bottom }}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <T variant="heading" accessibilityRole="header" style={{ flex: 1 }}>Add special date</T>
                <Pressable accessibilityRole="button" accessibilityLabel="Close special date form" disabled={addingOverride} accessibilityState={{ disabled: addingOverride }} onPress={closeSpecialDate} style={{ minHeight: TAP_FLOOR, minWidth: TAP_FLOOR, alignItems: "center", justifyContent: "center" }}><Ionicons name="close" size={22} color={t.textSecondary} /></Pressable>
              </View>
              <DateField label="Date" value={newDate} onChange={setNewDate} allowFuture today={businessToday(business.timezone)} />
              <T variant="label">This date is</T>
              <SegmentedControl options={[{ label: "Closed", value: "CLOSED" }, { label: "Open", value: "OPEN" }]} value={newType} onChange={setNewType} accessibilityLabel="This date is" />
              <Field label="Reason (optional)" value={newReason} onChangeText={setNewReason} maxLength={FIELD_LIMITS.operatingOverrideReason} placeholder="e.g. Typhoon, fiesta, inventory day" />
              {addError ? <ErrorNote>{addError}</ErrorNote> : null}
              <Button title="Add" variant="primary" onPress={addOverride} loading={addingOverride} disabled={!newDate} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}
