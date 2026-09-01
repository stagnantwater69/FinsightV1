import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { useToast } from "../components/Toast";
import { Button } from "../components/Button";
import { Checkbox, Field, FormError, TextInput } from "../components/Field";
import { Callout, FormPage, Panel } from "../components/ui";
import { SkeletonPanel } from "../components/Skeleton";
import type { RecoveryNotificationPreference } from "../lib/types";

/** Matches the backend's own effective defaults exactly — see
 * `recoveryNotificationPreference.service.ts`'s
 * `DEFAULT_RECOVERY_NOTIFICATION_PREFERENCE` — so a never-configured business
 * renders the same values the server would already report on GET, rather
 * than a blank form the owner has to fill in from nothing. */
function defaultPreference(): RecoveryNotificationPreference {
  return {
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
}

/**
 * Recovery Target notification preferences — plan §7.5/§10.8/§11 Phase 6.
 *
 * Its own sub-route off the business profile, the same pattern
 * `OperatingSchedule` already established: a settings surface with its own
 * read/write lifecycle against one endpoint, not a section stitched into the
 * profile edit form or the general Recovery Target page itself.
 *
 * This page only edits owner preferences. It never displays or claims to
 * generate a notification itself — that already happens wherever this app's
 * existing notification bell/list surfaces notifications.
 */
export function RecoveryNotificationPreferences() {
  const { id } = useParams<{ id: string }>();
  const { profiles } = useBusinessProfiles();
  const navigate = useNavigate();
  const toast = useToast();

  const profile = profiles.find((p) => p.id === Number(id));

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pref, setPref] = useState<RecoveryNotificationPreference>(defaultPreference());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!profile) return;
    setLoading(true);
    setLoadError(null);
    try {
      const { data } = await api.get<RecoveryNotificationPreference>(
        `/business-profiles/${profile.id}/recovery-notification-preferences`,
      );
      setPref(data);
    } catch (err) {
      setLoadError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  if (!profile) {
    return <p className="text-sm text-ink-500">Business profile not found.</p>;
  }

  const profileId = profile.id;

  // Both-or-neither, mirrored client-side against the backend's own rule in
  // `upsertRecoveryNotificationPreference` — checked here so the owner sees
  // the problem before a round trip, not just after a 400 comes back.
  const quietHoursMismatched =
    (pref.quietHoursStart === null || pref.quietHoursStart === "") !==
    (pref.quietHoursEnd === null || pref.quietHoursEnd === "");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (quietHoursMismatched) {
      setError("Set both a quiet-hours start and end, or leave both blank.");
      return;
    }
    const threshold = Number(pref.targetIncreaseThresholdPercent);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
      setError("Threshold must be a number between 1 and 100.");
      return;
    }
    const cooldown = Number(pref.minHoursBetweenNotifications);
    if (!Number.isFinite(cooldown) || cooldown < 1 || cooldown > 168) {
      setError("Hours between notifications must be between 1 and 168.");
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.put<RecoveryNotificationPreference>(
        `/business-profiles/${profileId}/recovery-notification-preferences`,
        {
          ...pref,
          targetIncreaseThresholdPercent: threshold,
          minHoursBetweenNotifications: cooldown,
          quietHoursStart: pref.quietHoursStart || null,
          quietHoursEnd: pref.quietHoursEnd || null,
        },
      );
      setPref(data);
      toast("Recovery Target notification preferences saved.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormPage
      eyebrow="Management"
      title={`Recovery Target notifications — ${profile.name}`}
      subtitle="Choose when FinSight should notify you about this business's Recovery Target. Nothing here changes your target, business profile, or recorded sales."
      wide
    >
      {loading ? (
        <SkeletonPanel lines={6} />
      ) : loadError ? (
        <Callout tone="warn">
          <b className="font-semibold">Couldn't load your notification preferences.</b> {loadError}
          <div className="mt-2">
            <Button type="button" variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-6" noValidate>
          <Panel title="Alerts" eyebrow="Choose which triggers can notify you">
            <div className="space-y-1">
              <Checkbox
                label="Target increased beyond a threshold"
                hint="Your adjusted daily target rose by more than the percentage below since the last time it was checked."
                checked={pref.targetIncreaseAlertEnabled}
                onChange={(checked) => setPref((p) => ({ ...p, targetIncreaseAlertEnabled: checked }))}
              />
              {pref.targetIncreaseAlertEnabled ? (
                <div className="ml-6 max-w-xs pb-1">
                  <Field
                    label="Threshold"
                    htmlFor="target-increase-threshold"
                    hint="A whole percentage from 1 to 100."
                  >
                    <div className="relative">
                      <TextInput
                        id="target-increase-threshold"
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={pref.targetIncreaseThresholdPercent}
                        onChange={(e) =>
                          setPref((p) => ({
                            ...p,
                            targetIncreaseThresholdPercent: Number(e.target.value),
                          }))
                        }
                        className="pr-8"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-400">
                        %
                      </span>
                    </div>
                  </Field>
                </div>
              ) : null}

              <Checkbox
                label="Behind pace for three days"
                hint="Recorded sales references have been below target for three completed open days in a row."
                checked={pref.behindThreeDaysAlertEnabled}
                onChange={(checked) => setPref((p) => ({ ...p, behindThreeDaysAlertEnabled: checked }))}
              />

              <Checkbox
                label="Open day ending with no sales (coming soon)"
                hint="Not active yet — FinSight can't yet reliably tell an open day is ending. This toggle is saved for when that capability ships; it does nothing today."
                checked={pref.openDayNoSalesAlertEnabled}
                onChange={(checked) => setPref((p) => ({ ...p, openDayNoSalesAlertEnabled: checked }))}
              />

              <Checkbox
                label="Projection crosses to shortfall (coming soon)"
                hint="Not active yet — this projection isn't available yet. This toggle is saved for when that capability ships; it does nothing today."
                checked={pref.projectionShortfallAlertEnabled}
                onChange={(checked) => setPref((p) => ({ ...p, projectionShortfallAlertEnabled: checked }))}
              />

              <Checkbox
                label="Monthly target reached"
                hint="Recorded sales references reach your full monthly coverage goal."
                checked={pref.coverageReachedAlertEnabled}
                onChange={(checked) => setPref((p) => ({ ...p, coverageReachedAlertEnabled: checked }))}
              />
            </div>
          </Panel>

          <Panel title="Quiet hours" eyebrow="Optional">
            <p className="mb-3 text-sm text-ink-500">
              No Recovery Target notifications will be sent during this window. Set both a start and an end,
              or leave both blank to allow notifications at any hour.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 sm:max-w-md">
              <Field label="Start" htmlFor="quiet-hours-start" optional>
                <TextInput
                  id="quiet-hours-start"
                  type="time"
                  value={pref.quietHoursStart ?? ""}
                  onChange={(e) => setPref((p) => ({ ...p, quietHoursStart: e.target.value || null }))}
                />
              </Field>
              <Field label="End" htmlFor="quiet-hours-end" optional>
                <TextInput
                  id="quiet-hours-end"
                  type="time"
                  value={pref.quietHoursEnd ?? ""}
                  onChange={(e) => setPref((p) => ({ ...p, quietHoursEnd: e.target.value || null }))}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Frequency" eyebrow="Cooldown between notifications">
            <div className="max-w-xs">
              <Field
                label="Minimum hours between notifications"
                htmlFor="min-hours-between"
                hint="From 1 to 168 hours (one week)."
              >
                <TextInput
                  id="min-hours-between"
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  value={pref.minHoursBetweenNotifications}
                  onChange={(e) =>
                    setPref((p) => ({ ...p, minHoursBetweenNotifications: Number(e.target.value) }))
                  }
                />
              </Field>
            </div>
          </Panel>

          {error ? <FormError>{error}</FormError> : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="button" variant="ghost" onClick={() => navigate(`/business-profiles/${profile.id}/edit`)}>
              Back to business profile
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save preferences"}
            </Button>
          </div>
        </form>
      )}
    </FormPage>
  );
}
