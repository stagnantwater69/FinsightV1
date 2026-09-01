import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, ErrorNote, Field, Screen, ScreenHeader, T } from "../components/ui";
import { Row, Section } from "../components/SettingsList";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import {
  minHoursBetweenNotificationsError,
  parsePreferenceNumber,
  quietHourTimeError,
  quietHoursBothOrNeitherError,
  thresholdPercentError,
} from "../lib/recoveryNotificationPreferencesForm";
import { space } from "../theme/tokens";
import type { RecoveryNotificationPreference } from "../lib/types";

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
 * TWO TOGGLES ARE MARKED "Coming soon". `openDayNoSalesAlertEnabled` and
 * `projectionShortfallAlertEnabled` are real, saved settings — flipping them
 * on does reach the server — but neither trigger is wired up yet server-side
 * (see the interface note on RecoveryNotificationPreference), so the copy
 * here must never suggest they are doing anything today.
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
    if (!selected) return;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await api.get<RecoveryNotificationPreference>(
        `/business-profiles/${selected.id}/recovery-notification-preferences`,
      );
      setPref(loaded);
      setThresholdRaw(String(loaded.targetIncreaseThresholdPercent));
      setQuietStartRaw(loaded.quietHoursStart ?? "");
      setQuietEndRaw(loaded.quietHoursEnd ?? "");
      setMinHoursRaw(String(loaded.minHoursBetweenNotifications));
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function toggle(key: keyof RecoveryNotificationPreference) {
    setSaved(false);
    setPref((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function save() {
    if (!selected) return;
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
    if (Object.keys(errors).length > 0) return;

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
      setPref(updated);
      setThresholdRaw(String(updated.targetIncreaseThresholdPercent));
      setQuietStartRaw(updated.quietHoursStart ?? "");
      setQuietEndRaw(updated.quietHoursEnd ?? "");
      setMinHoursRaw(String(updated.minHoursBetweenNotifications));
      setSaved(true);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (!selected) return null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}>
        <ScreenHeader
          eyebrow="Recovery target"
          title="Notification settings"
          subtitle="Choose when FinSight lets you know about changes to your Sales Coverage Target. These are optional — leave anything off you don't want."
        />

        {loading ? (
          <T variant="caption">Loading…</T>
        ) : loadError ? (
          <View style={{ gap: space.md }}>
            <ErrorNote>{loadError}</ErrorNote>
            <Button title="Retry" variant="secondary" onPress={load} />
          </View>
        ) : (
          <>
            <Section title="Alerts">
              <Row
                first
                icon="trending-up-outline"
                label="Target increased beyond a threshold"
                detail="Let you know when your adjusted daily target rises by more than the percentage below."
                toggle={{ value: pref.targetIncreaseAlertEnabled }}
                onPress={() => toggle("targetIncreaseAlertEnabled")}
              />
              <Row
                icon="trending-down-outline"
                label="Behind pace for three days"
                detail="Let you know after three completed open days below target."
                toggle={{ value: pref.behindThreeDaysAlertEnabled }}
                onPress={() => toggle("behindThreeDaysAlertEnabled")}
              />
              <Row
                icon="time-outline"
                label="Open day ending with no sales (Coming soon)"
                detail="Not active yet — this alert isn't generated by FinSight today, even if turned on here."
                toggle={{ value: pref.openDayNoSalesAlertEnabled }}
                onPress={() => toggle("openDayNoSalesAlertEnabled")}
              />
              <Row
                icon="analytics-outline"
                label="Projection crosses to shortfall (Coming soon)"
                detail="Not active yet — this alert isn't generated by FinSight today, even if turned on here."
                toggle={{ value: pref.projectionShortfallAlertEnabled }}
                onPress={() => toggle("projectionShortfallAlertEnabled")}
              />
              <Row
                icon="checkmark-circle-outline"
                label="Monthly target reached"
                detail="Let you know when your Sales Coverage Target is fully met for the month."
                toggle={{ value: pref.coverageReachedAlertEnabled }}
                onPress={() => toggle("coverageReachedAlertEnabled")}
              />
            </Section>

            {pref.targetIncreaseAlertEnabled ? (
              <Card>
                <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
                  Increase threshold
                </T>
                <T variant="caption" style={{ marginBottom: space.sm }}>
                  How much your adjusted daily target has to rise before you're alerted.
                </T>
                <Field
                  label="Threshold percent"
                  value={thresholdRaw}
                  onChangeText={(v) => {
                    setThresholdRaw(v);
                    setFieldErrors((e) => ({ ...e, threshold: undefined }));
                  }}
                  keyboardType="decimal-pad"
                  error={fieldErrors.threshold}
                  placeholder="15"
                />
              </Card>
            ) : null}

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
                Quiet hours
              </T>
              <T variant="caption" style={{ marginBottom: space.sm }}>
                No alerts are sent between these times. Leave both blank for no quiet hours. 24-hour time, e.g. 21:00.
              </T>
              <Field
                label="Start"
                value={quietStartRaw}
                onChangeText={(v) => {
                  setQuietStartRaw(v);
                  setFieldErrors((e) => ({ ...e, quiet: undefined }));
                }}
                placeholder="21:00"
                accessibilityLabel="Quiet hours start"
              />
              <Field
                label="End"
                value={quietEndRaw}
                onChangeText={(v) => {
                  setQuietEndRaw(v);
                  setFieldErrors((e) => ({ ...e, quiet: undefined }));
                }}
                placeholder="07:00"
                accessibilityLabel="Quiet hours end"
                error={fieldErrors.quiet}
              />
            </Card>

            <Card>
              <T variant="heading" accessibilityRole="header" style={{ marginBottom: 4 }}>
                Frequency
              </T>
              <T variant="caption" style={{ marginBottom: space.sm }}>
                The shortest time FinSight waits between two of these alerts, so you're not notified repeatedly for
                the same thing.
              </T>
              <Field
                label="Hours between notifications"
                value={minHoursRaw}
                onChangeText={(v) => {
                  setMinHoursRaw(v);
                  setFieldErrors((e) => ({ ...e, minHours: undefined }));
                }}
                keyboardType="number-pad"
                error={fieldErrors.minHours}
                placeholder="24"
              />
            </Card>

            {(pref.openDayNoSalesAlertEnabled || pref.projectionShortfallAlertEnabled) ? (
              <Callout tone="info">
                Two of the alerts above are coming soon and don't do anything yet, even when turned on.
              </Callout>
            ) : null}

            {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
            {saved ? <T variant="caption">Saved.</T> : null}

            <Button title="Save preferences" variant="primary" onPress={save} loading={saving} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
