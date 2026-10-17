import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Switch, TextInput, useWindowDimensions, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Card, ErrorNote, Field, T } from "../components/ui";
import { useTheme } from "../context/ThemeContext";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import {
  minHoursBetweenNotificationsError,
  parsePreferenceNumber,
  quietHourTimeError,
  quietHoursBothOrNeitherError,
  thresholdPercentError,
} from "../lib/recoveryNotificationPreferencesForm";
import { space, typeScale } from "../theme/tokens";
import type { RecoveryNotificationPreference } from "../lib/types";
import { FormScreen } from "../components/FormScreen";

/**
 * Recovery Target notification preferences — Recovery Target Improvement
 * Plan §7.5/§10.8/§11 Phase 6.
 *
 * REACHED FROM TWO PLACES, same as OperatingScheduleScreen: a "Notification
 * settings" row on Settings (this is one of the "how this app behaves for
 * this owner" screens Settings already collects), and a smaller entry point
 * on RecoveryTargetScreen itself, for an owner who just noticed an alert and
 * wants to tune it without leaving the insight they were reading.
 *
 * LOCAL STATE + AN EXPLICIT SAVE, not per-row autosave. SettingsScreen's
 * switches write immediately because each one is a single independent
 * account-level preference; this screen is one record with cross-field rules
 * (quiet hours both-or-neither, a threshold percent that only means anything
 * once its toggle is on) that only make sense evaluated together — the same
 * reasoning OperatingScheduleScreen's weekly pattern already follows.
 *
 * Upcoming alerts are informational, not interactive: neither trigger is
 * wired up server-side. Preserve their existing values when saving the
 * available preferences so this UI refinement does not change stored data.
 */

const DEFAULTS: RecoveryNotificationPreference = {
  targetIncreaseAlertEnabled: true,
  targetIncreaseThresholdPercent: 15,
  behindThreeDaysAlertEnabled: true,
  openDayNoSalesAlertEnabled: true,
  projectionShortfallAlertEnabled: true,
  coverageReachedAlertEnabled: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  minHoursBetweenNotifications: 24,
};

export function RecoveryNotificationPreferencesScreen() {
  const { selected } = useBusinessProfiles();
  const theme = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stackTimeFields = width < 360 || fontScale > 1.2;
  const businessId = selected?.id;
  const scope = useRef({ businessId, generation: 0 });
  if (scope.current.businessId !== businessId) {
    scope.current = { businessId, generation: scope.current.generation + 1 };
  }
  const loadRequest = useRef(0);
  const savingRequest = useRef<object | null>(null);
  const [loadedGeneration, setLoadedGeneration] = useState<number | null>(null);
  const thresholdRef = useRef<TextInput>(null);
  const quietStartRef = useRef<TextInput>(null);
  const quietEndRef = useRef<TextInput>(null);
  const minHoursRef = useRef<TextInput>(null);

  useEffect(() => {
    savingRequest.current = null;
    setSaving(false);
    setSaved(false);
    setSaveError(null);
    setFieldErrors({});
    return () => {
      scope.current = { ...scope.current, generation: scope.current.generation + 1 };
      loadRequest.current += 1;
    };
  }, [businessId]);

  const [pref, setPref] = useState<RecoveryNotificationPreference>(DEFAULTS);
  const [thresholdRaw, setThresholdRaw] = useState(String(DEFAULTS.targetIncreaseThresholdPercent));
  const [quietStartRaw, setQuietStartRaw] = useState("");
  const [quietEndRaw, setQuietEndRaw] = useState("");
  const [minHoursRaw, setMinHoursRaw] = useState(String(DEFAULTS.minHoursBetweenNotifications));

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ threshold?: string; minHours?: string; quiet?: string }>({});

  const load = useCallback(async () => {
    if (businessId === undefined) return;
    const generation = scope.current.generation;
    const request = ++loadRequest.current;
    const current = () => request === loadRequest.current && generation === scope.current.generation;
    setLoading(true);
    setLoadError(null);
    setSaved(false);
    setSaveError(null);
    setFieldErrors({});
    try {
      const loaded = await api.get<RecoveryNotificationPreference>(
        `/business-profiles/${businessId}/recovery-notification-preferences`,
      );
      if (!current()) return;
      setPref(loaded);
      setThresholdRaw(String(loaded.targetIncreaseThresholdPercent));
      setQuietStartRaw(loaded.quietHoursStart ?? "");
      setQuietEndRaw(loaded.quietHoursEnd ?? "");
      setMinHoursRaw(String(loaded.minHoursBetweenNotifications));
      setLoadedGeneration(generation);
    } catch (err) {
      if (current()) setLoadError(errorMessage(err));
    } finally {
      if (current()) setLoading(false);
    }
  }, [businessId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { loadRequest.current += 1; };
    }, [load]),
  );

  function toggle(key: keyof RecoveryNotificationPreference) {
    setSaved(false);
    setPref((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function save() {
    if (!selected || savingRequest.current || loadedGeneration !== scope.current.generation) return;
    const generation = scope.current.generation;
    setSaved(false);

    const errors: { threshold?: string; minHours?: string; quiet?: string } = {};
    if (pref.targetIncreaseAlertEnabled) {
      const err = thresholdPercentError(thresholdRaw);
      if (err) errors.threshold = err;
    }
    const minHoursErr = minHoursBetweenNotificationsError(minHoursRaw);
    if (minHoursErr) errors.minHours = minHoursErr;
    const startErr = quietHourTimeError(quietStartRaw);
    const endErr = quietHourTimeError(quietEndRaw);
    const bothErr = quietHoursBothOrNeitherError(quietStartRaw, quietEndRaw);
    if (startErr || endErr) errors.quiet = startErr ?? endErr ?? undefined;
    else if (bothErr) errors.quiet = bothErr;

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      (errors.threshold ? thresholdRef : errors.quiet ? endErr ? quietEndRef : quietStartRef : minHoursRef).current?.focus();
      return;
    }

    const request = {};
    savingRequest.current = request;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        targetIncreaseAlertEnabled: pref.targetIncreaseAlertEnabled,
        targetIncreaseThresholdPercent: pref.targetIncreaseAlertEnabled
          ? (parsePreferenceNumber(thresholdRaw) ?? pref.targetIncreaseThresholdPercent)
          : pref.targetIncreaseThresholdPercent,
        behindThreeDaysAlertEnabled: pref.behindThreeDaysAlertEnabled,
        openDayNoSalesAlertEnabled: pref.openDayNoSalesAlertEnabled,
        projectionShortfallAlertEnabled: pref.projectionShortfallAlertEnabled,
        coverageReachedAlertEnabled: pref.coverageReachedAlertEnabled,
        quietHoursStart: quietStartRaw.trim() === "" ? null : quietStartRaw.trim(),
        quietHoursEnd: quietEndRaw.trim() === "" ? null : quietEndRaw.trim(),
        minHoursBetweenNotifications: parsePreferenceNumber(minHoursRaw) ?? pref.minHoursBetweenNotifications,
      };
      const updated = await api.put<RecoveryNotificationPreference>(
        `/business-profiles/${selected.id}/recovery-notification-preferences`,
        payload,
      );
      if (generation !== scope.current.generation || savingRequest.current !== request) return;
      setPref(updated);
      setThresholdRaw(String(updated.targetIncreaseThresholdPercent));
      setQuietStartRaw(updated.quietHoursStart ?? "");
      setQuietEndRaw(updated.quietHoursEnd ?? "");
      setMinHoursRaw(String(updated.minHoursBetweenNotifications));
      setSaved(true);
    } catch (err) {
      if (generation === scope.current.generation && savingRequest.current === request) setSaveError(errorMessage(err));
    } finally {
      if (savingRequest.current === request) {
        savingRequest.current = null;
        setSaving(false);
      }
    }
  }

  if (!selected) return null;

  return (
    <FormScreen
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.xxl }}
      >
        <T style={{ fontSize: typeScale.bodySm }}>
          Choose Sales Coverage Target alerts for {selected.name}. All alerts are optional.
        </T>

        {loading || (loadedGeneration !== scope.current.generation && !loadError) ? (
          <T variant="caption">Loading…</T>
        ) : loadError ? (
          <View style={{ gap: space.md }}>
            <ErrorNote>{loadError}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={load} />
          </View>
        ) : (
          <>
            <View style={{ gap: space.sm }}>
              <T variant="heading" accessibilityRole="header" style={{ color: theme.brandHeading }}>
                Alert preferences
              </T>
              <Card>
                <NotificationToggle
                  label="Daily target increase"
                  detail="When your adjusted daily target rises above the percentage you choose."
                  value={pref.targetIncreaseAlertEnabled}
                  disabled={saving}
                  onPress={() => toggle("targetIncreaseAlertEnabled")}
                />
                {pref.targetIncreaseAlertEnabled ? (
                  <View style={{ marginTop: space.md }}>
                    <Field
                      ref={thresholdRef}
                      label="Increase threshold (%)"
                      value={thresholdRaw}
                      editable={!saving}
                      onChangeText={(v) => {
                        setSaved(false);
                        setThresholdRaw(v);
                        setFieldErrors((e) => ({ ...e, threshold: undefined }));
                      }}
                      keyboardType="decimal-pad"
                      error={fieldErrors.threshold}
                      placeholder="15"
                    />
                  </View>
                ) : null}
                <View style={{ borderTopWidth: 1, borderTopColor: theme.border, marginVertical: space.lg }} />
                <NotificationToggle
                  label="Behind pace for three days"
                  detail="After three completed open days below target."
                  value={pref.behindThreeDaysAlertEnabled}
                  disabled={saving}
                  onPress={() => toggle("behindThreeDaysAlertEnabled")}
                />
                <View style={{ borderTopWidth: 1, borderTopColor: theme.border, marginVertical: space.lg }} />
                <NotificationToggle
                  label="Monthly target reached"
                  detail="When your Sales Coverage Target is fully met for the month."
                  value={pref.coverageReachedAlertEnabled}
                  disabled={saving}
                  onPress={() => toggle("coverageReachedAlertEnabled")}
                />
              </Card>
            </View>

            <View style={{ gap: space.sm }}>
              <T variant="heading" accessibilityRole="header" style={{ color: theme.brandHeading }}>
                Delivery schedule
              </T>
              <Card>
                <T variant="heading" style={{ color: theme.textPrimary }}>Quiet hours</T>
                <T style={{ fontSize: typeScale.bodySm, marginTop: space.xs, marginBottom: space.md }}>
                  Pause alerts between these times. Use 24-hour time, or leave both blank for no quiet hours.
                </T>
                <View style={{ flexDirection: stackTimeFields ? "column" : "row", gap: space.md }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      ref={quietStartRef}
                      label="Start"
                      value={quietStartRaw}
                      editable={!saving}
                      onChangeText={(v) => {
                        setSaved(false);
                        setQuietStartRaw(v);
                        setFieldErrors((e) => ({ ...e, quiet: undefined }));
                      }}
                      placeholder="21:00"
                      accessibilityLabel="Quiet hours start"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      ref={quietEndRef}
                      label="End"
                      value={quietEndRaw}
                      editable={!saving}
                      onChangeText={(v) => {
                        setSaved(false);
                        setQuietEndRaw(v);
                        setFieldErrors((e) => ({ ...e, quiet: undefined }));
                      }}
                      placeholder="07:00"
                      accessibilityLabel="Quiet hours end"
                    />
                  </View>
                </View>
                {fieldErrors.quiet ? <ErrorNote>{fieldErrors.quiet}</ErrorNote> : null}
                <View style={{ borderTopWidth: 1, borderTopColor: theme.border, marginTop: space.sm, marginBottom: space.lg }} />
                <T variant="heading" style={{ color: theme.textPrimary }}>
                  Frequency
                </T>
                <T style={{ fontSize: typeScale.bodySm, marginTop: space.xs, marginBottom: space.md }}>
                  Set the minimum time between alerts to avoid repeated notifications.
                </T>
                <Field
                  ref={minHoursRef}
                  label="Hours between notifications"
                  value={minHoursRaw}
                  editable={!saving}
                  onChangeText={(v) => {
                    setSaved(false);
                    setMinHoursRaw(v);
                    setFieldErrors((e) => ({ ...e, minHours: undefined }));
                  }}
                  keyboardType="number-pad"
                  error={fieldErrors.minHours}
                  placeholder="24"
                />
              </Card>
            </View>

            <View style={{ gap: space.xs }}>
              <T variant="heading" accessibilityRole="header">Coming soon</T>
              <T style={{ fontSize: typeScale.bodySm }}>
                No-sales days and projected shortfalls. These alerts are not available yet.
              </T>
            </View>

            <View style={{ gap: space.md }}>
              {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
              {saved ? (
                <T accessibilityLiveRegion="polite" style={{ color: theme.statusText.good }}>
                  Notification preferences saved.
                </T>
              ) : null}
              <Button title="Save preferences" variant="brand" onPress={save} loading={saving} />
            </View>
          </>
        )}
    </FormScreen>
  );
}

/** Full-width supporting copy keeps alert explanations readable at large text sizes. */
function NotificationToggle({ label, detail, value, onPress, disabled }: {
  label: string;
  detail: string;
  value: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ checked: value, disabled }}
      style={({ pressed }) => ({
        minHeight: 48,
        gap: space.xs,
        backgroundColor: pressed ? theme.surfaceRaised : "transparent",
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <T variant="heading" style={{ flex: 1, color: theme.textPrimary }}>{label}</T>
        <View style={{ pointerEvents: "none" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Switch
            accessible={false}
            value={value}
            disabled={disabled}
            trackColor={{ false: theme.ink[200], true: theme.brand[600] }}
            thumbColor={theme.paper.DEFAULT}
            ios_backgroundColor={theme.ink[200]}
          />
        </View>
      </View>
      <T style={{ fontSize: typeScale.bodySm }}>{detail}</T>
    </Pressable>
  );
}
