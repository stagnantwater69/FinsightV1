import { useCallback, useState } from "react";
import { Alert as RNAlert, Pressable, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Card,
  Checkbox,
  ErrorNote,
  Field,
  Screen,
  ScreenHeader,
  SegmentedControl,
  T,
} from "../components/ui";
import { DateField } from "../components/DateField";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { space, typeScale, font } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";

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
type Override = { id: number; businessProfileId: number; date: string; type: "OPEN" | "CLOSED"; reason: string | null };

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
function defaultOverrideRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return { from: toISO(from), to: toISO(to) };
}

export function OperatingScheduleScreen() {
  const t = useTheme();
  const { paper } = t;
  const { selected } = useBusinessProfiles();

  const [entries, setEntries] = useState<WeekdayEntry[]>(defaultAllOpen());
  const [loadingSchedule, setLoadingSchedule] = useState(true);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSaved, setScheduleSaved] = useState(false);

  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loadingOverrides, setLoadingOverrides] = useState(true);
  const [overridesError, setOverridesError] = useState<string | null>(null);

  const [newDate, setNewDate] = useState("");
  const [newType, setNewType] = useState<"OPEN" | "CLOSED">("CLOSED");
  const [newReason, setNewReason] = useState("");
  const [addingOverride, setAddingOverride] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busyOverrideId, setBusyOverrideId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoadingSchedule(true);
    setScheduleError(null);
    try {
      const schedule = await api.get<WeekdayEntry[]>(`/business-profiles/${selected.id}/operating-schedule`);
      // Empty means never configured — the plan's default here is all-open,
      // pre-checked but NOT auto-submitted, so nothing is saved until the
      // owner reviews it and taps Save.
      setEntries(schedule.length === 7 ? schedule : defaultAllOpen());
    } catch (err) {
      setScheduleError(errorMessage(err));
    } finally {
      setLoadingSchedule(false);
    }

    setLoadingOverrides(true);
    setOverridesError(null);
    try {
      const { from, to } = defaultOverrideRange();
      const list = await api.get<Override[]>(`/business-profiles/${selected.id}/operating-overrides`, { from, to });
      setOverrides([...list].sort((a, b) => a.date.localeCompare(b.date)));
    } catch (err) {
      setOverridesError(errorMessage(err));
    } finally {
      setLoadingOverrides(false);
    }
  }, [selected]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function toggleWeekday(weekday: number) {
    setEntries((prev) => prev.map((e) => (e.weekday === weekday ? { ...e, isOpen: !e.isOpen } : e)));
    setScheduleSaved(false);
  }

  async function saveSchedule() {
    if (!selected) return;
    setSavingSchedule(true);
    setScheduleError(null);
    setScheduleSaved(false);
    try {
      await api.put(`/business-profiles/${selected.id}/operating-schedule`, { entries });
      setScheduleSaved(true);
    } catch (err) {
      setScheduleError(errorMessage(err));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function addOverride() {
    if (!selected || !newDate) return;
    setAddingOverride(true);
    setAddError(null);
    try {
      const created = await api.post<Override>(`/business-profiles/${selected.id}/operating-overrides`, {
        date: newDate,
        type: newType,
        reason: newReason.trim() || undefined,
      });
      setOverrides((prev) => [...prev, created].sort((a, b) => a.date.localeCompare(b.date)));
      setNewDate("");
      setNewType("CLOSED");
      setNewReason("");
    } catch (err) {
      setAddError(errorMessage(err));
    } finally {
      setAddingOverride(false);
    }
  }

  function confirmDeleteOverride(o: Override) {
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
            if (!selected) return;
            setBusyOverrideId(o.id);
            try {
              await api.delete(`/business-profiles/${selected.id}/operating-overrides/${o.id}`);
              setOverrides((prev) => prev.filter((x) => x.id !== o.id));
            } catch (err) {
              setOverridesError(errorMessage(err));
            } finally {
              setBusyOverrideId(null);
            }
          },
        },
      ],
    );
  }

  if (!selected) return null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
        <ScreenHeader
          eyebrow="Business profile"
          title="Operating schedule"
          subtitle="Set which days of the week your business is normally open. FinSight uses this to calculate exact operating days instead of an estimate."
        />

        <Card>
          <T variant="heading" accessibilityRole="header" style={{ marginBottom: space.sm }}>
            Weekly pattern
          </T>
          {loadingSchedule ? (
            <T variant="caption">Loading…</T>
          ) : (
            <>
              {WEEKDAY_LABELS.map(({ weekday, label }) => {
                const entry = entries.find((e) => e.weekday === weekday);
                return (
                  <Checkbox
                    key={weekday}
                    label={label}
                    checked={entry?.isOpen ?? true}
                    onChange={() => toggleWeekday(weekday)}
                  />
                );
              })}
              {scheduleError ? <ErrorNote>{scheduleError}</ErrorNote> : null}
              {scheduleSaved ? (
                <T variant="caption" style={{ marginBottom: space.sm }}>
                  Saved.
                </T>
              ) : null}
              <Button title="Save weekly schedule" variant="primary" onPress={saveSchedule} loading={savingSchedule} />
            </>
          )}
        </Card>

        <Card>
          <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
            Holidays and one-off closures
          </T>
          <T variant="caption" style={{ marginBottom: space.md }}>
            A specific date always overrides the weekly pattern above — mark a holiday closure or a special opening
            day here.
          </T>

          <DateField label="Date" value={newDate} onChange={setNewDate} allowFuture />

          <View style={{ marginBottom: space.md }}>
            <T variant="label" style={{ marginBottom: 6 }}>
              This date is
            </T>
            <SegmentedControl
              options={[
                { label: "Closed", value: "CLOSED" },
                { label: "Open", value: "OPEN" },
              ]}
              value={newType}
              onChange={setNewType}
              accessibilityLabel="Closed or open on this date"
            />
          </View>

          <Field
            label="Reason (optional)"
            value={newReason}
            onChangeText={setNewReason}
            maxLength={FIELD_LIMITS.operatingOverrideReason}
            placeholder="e.g. Typhoon, fiesta, inventory day"
          />

          {addError ? <ErrorNote>{addError}</ErrorNote> : null}

          <Button title="Add" variant="secondary" onPress={addOverride} loading={addingOverride} disabled={!newDate} />

          <View style={{ marginTop: space.lg }}>
            {loadingOverrides ? (
              <T variant="caption">Loading…</T>
            ) : overridesError ? (
              <ErrorNote>{overridesError}</ErrorNote>
            ) : overrides.length === 0 ? (
              <T variant="caption">No holidays or closures set for this range yet.</T>
            ) : (
              overrides.map((o, i) => (
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
                    disabled={busyOverrideId === o.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove the ${o.type === "CLOSED" ? "closure" : "opening"} on ${o.date}`}
                    style={{ padding: space.sm }}
                  >
                    <Ionicons name="trash-outline" size={18} color={t.statusText.critical} />
                  </Pressable>
                </View>
              ))
            )}
          </View>
        </Card>
      </ScrollView>
    </Screen>
  );
}
