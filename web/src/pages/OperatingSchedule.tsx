import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Button } from "../components/Button";
import { Field, FormError, SelectInput, TextInput } from "../components/Field";
import { Callout, Card, FormPage, Panel } from "../components/ui";
import { EmptyState } from "../components/EmptyState";
import { SkeletonPanel } from "../components/Skeleton";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import type {
  OperatingDayOverride,
  OperatingDayOverrideInput,
  OperatingDayOverrideType,
  OperatingScheduleEntry,
} from "../lib/types";

/** 1=Monday .. 7=Sunday, matching `BusinessOperatingDay.weekday` exactly —
 * see the note on the type. */
const WEEKDAYS: { weekday: number; label: string; short: string }[] = [
  { weekday: 1, label: "Monday", short: "Mon" },
  { weekday: 2, label: "Tuesday", short: "Tue" },
  { weekday: 3, label: "Wednesday", short: "Wed" },
  { weekday: 4, label: "Thursday", short: "Thu" },
  { weekday: 5, label: "Friday", short: "Fri" },
  { weekday: 6, label: "Saturday", short: "Sat" },
  { weekday: 7, label: "Sunday", short: "Sun" },
];

/** All seven weekdays open — the sensible starting point when the owner has
 * never configured a schedule (plan §7.4: "do not guess weekdays"; an
 * explicit all-open default the owner can immediately see and edit is not a
 * guess, it's a starting point they confirm by pressing Save). */
function allOpenSchedule(): OperatingScheduleEntry[] {
  return WEEKDAYS.map((w) => ({ weekday: w.weekday, isOpen: true }));
}

/** Today plus the rest of this month and all of next — bounded, and enough
 * range for an owner planning upcoming closures without an unbounded fetch. */
function defaultOverrideRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Weekly schedule + date overrides — plan §7.2-§7.4/§10.2/§11 Phase 2.
 *
 * Its own sub-route rather than a section stitched into the business-profile
 * edit form: it is its own read/write lifecycle against two endpoints
 * (schedule, overrides) that have nothing to do with the profile PATCH the
 * edit form already submits, and it needs its own loading/list state — the
 * same reasoning Categories got its own page instead of a modal off Records.
 */
export function OperatingSchedule() {
  const { id } = useParams<{ id: string }>();
  const { profiles } = useBusinessProfiles();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();

  const profile = profiles.find((p) => p.id === Number(id));

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<OperatingScheduleEntry[]>(allOpenSchedule());
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleSaved, setScheduleSaved] = useState(false);

  const [overrides, setOverrides] = useState<OperatingDayOverride[]>([]);
  const [overrideDate, setOverrideDate] = useState(todayIso());
  const [overrideType, setOverrideType] = useState<OperatingDayOverrideType>("CLOSED");
  const [overrideReason, setOverrideReason] = useState("");
  const [addingOverride, setAddingOverride] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  async function load() {
    if (!profile) return;
    setLoading(true);
    setLoadError(null);
    try {
      const { from, to } = defaultOverrideRange();
      const [scheduleRes, overridesRes] = await Promise.all([
        api.get<OperatingScheduleEntry[]>(`/business-profiles/${profileId}/operating-schedule`),
        api.get<OperatingDayOverride[]>(`/business-profiles/${profileId}/operating-overrides`, {
          params: { from, to },
        }),
      ]);
      // Empty means "never configured" — pre-check all-open rather than
      // leaving the toggles blank, per plan §11: a sensible starting point
      // the owner confirms by saving, not a value silently submitted for them.
      setEntries(scheduleRes.data.length === 7 ? scheduleRes.data : allOpenSchedule());
      setOverrides(
        [...overridesRes.data].sort((a, b) => a.date.localeCompare(b.date)),
      );
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

  // Captured as a plain number rather than read off `profile.id` inside the
  // functions below: those are declared (and can be invoked) after this
  // guard, but a function's own body is checked independently of the
  // narrowing above it, so `profile` still reads as possibly-undefined there.
  const profileId = profile.id;

  function toggleDay(weekday: number) {
    setEntries((prev) =>
      prev.map((e) => (e.weekday === weekday ? { ...e, isOpen: !e.isOpen } : e)),
    );
    setScheduleSaved(false);
  }

  async function handleSaveSchedule(e: FormEvent) {
    e.preventDefault();
    setSavingSchedule(true);
    setScheduleError(null);
    setScheduleSaved(false);
    try {
      await api.put(`/business-profiles/${profileId}/operating-schedule`, { entries });
      setScheduleSaved(true);
      toast("Operating schedule saved.");
    } catch (err) {
      setScheduleError(getErrorMessage(err));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleAddOverride(e: FormEvent) {
    e.preventDefault();
    if (!overrideDate) {
      setOverrideError("Choose a date.");
      return;
    }
    setAddingOverride(true);
    setOverrideError(null);
    try {
      const input: OperatingDayOverrideInput = {
        date: overrideDate,
        type: overrideType,
        reason: overrideReason.trim() || undefined,
      };
      const { data } = await api.post<OperatingDayOverride>(
        `/business-profiles/${profileId}/operating-overrides`,
        input,
      );
      setOverrides((prev) => [...prev, data].sort((a, b) => a.date.localeCompare(b.date)));
      setOverrideReason("");
      toast("Date override added.");
    } catch (err) {
      setOverrideError(getErrorMessage(err));
    } finally {
      setAddingOverride(false);
    }
  }

  async function handleDeleteOverride(override: OperatingDayOverride) {
    const ok = await confirm({
      title: `Remove the ${override.type === "CLOSED" ? "closure" : "special opening"} on ${override.date}?`,
      body: "This date goes back to following your regular weekly schedule.",
      confirmLabel: "Remove override",
      tone: "danger",
    });
    if (!ok) return;

    const previous = overrides;
    setOverrides((prev) => prev.filter((o) => o.id !== override.id));
    try {
      await api.delete(`/business-profiles/${profileId}/operating-overrides/${override.id}`);
    } catch (err) {
      setOverrides(previous);
      toast(getErrorMessage(err));
    }
  }

  return (
    <FormPage
      eyebrow="Management"
      title={`Operating schedule — ${profile.name}`}
      subtitle="Set which days this business is normally open, plus any one-off holidays or special openings. FinSight uses this to calculate exact operating days instead of an estimate."
      wide
    >
      {loading ? (
        <div className="space-y-6">
          <SkeletonPanel lines={4} />
          <SkeletonPanel lines={3} />
        </div>
      ) : loadError ? (
        <Callout tone="warn">
          <b className="font-semibold">Couldn't load your operating schedule.</b> {loadError}
          <div className="mt-2">
            <Button type="button" variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : (
        <div className="space-y-6">
          <Panel
            title="Weekly schedule"
            eyebrow="Recurring"
          >
            <p className="mb-4 text-sm text-ink-500">
              Set which days of the week your business is normally open. FinSight uses this to calculate
              exact operating days instead of an estimate.
            </p>
            <form onSubmit={handleSaveSchedule} className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((w) => {
                  const entry = entries.find((e) => e.weekday === w.weekday);
                  const isOpen = entry?.isOpen ?? true;
                  return (
                    <button
                      key={w.weekday}
                      type="button"
                      aria-pressed={isOpen}
                      onClick={() => toggleDay(w.weekday)}
                      className={`tap min-w-[4.5rem] rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${
                        isOpen
                          ? "border-edge-brand bg-tint-brand text-tone-brand"
                          : "border-ink-200 bg-paper-100 text-ink-400"
                      }`}
                    >
                      <span className="block">{w.short}</span>
                      <span className="mt-0.5 block text-[11px] font-normal">
                        {isOpen ? "Open" : "Closed"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {scheduleError ? <FormError>{scheduleError}</FormError> : null}
              {scheduleSaved ? <Callout tone="brand">Operating schedule saved.</Callout> : null}

              <div className="flex justify-end">
                <Button type="submit" variant="primary" disabled={savingSchedule}>
                  {savingSchedule ? "Saving…" : "Save weekly schedule"}
                </Button>
              </div>
            </form>
          </Panel>

          <Panel title="Holidays and closures" eyebrow="One-off dates">
            <p className="mb-4 text-sm text-ink-500">
              Mark a specific date as closed (a holiday, an emergency) or open (a special opening on a day
              you'd normally be closed). A date override always takes precedence over the weekly schedule.
            </p>

            <Card as="form" onSubmit={handleAddOverride} className="mb-4 p-4">
              <div className="grid gap-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
                <Field label="Date" htmlFor="override-date">
                  <TextInput
                    id="override-date"
                    type="date"
                    value={overrideDate}
                    onChange={(e) => setOverrideDate(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Type" htmlFor="override-type">
                  <SelectInput
                    id="override-type"
                    value={overrideType}
                    onChange={(e) => setOverrideType(e.target.value as OperatingDayOverrideType)}
                  >
                    <option value="CLOSED">Closed</option>
                    <option value="OPEN">Open</option>
                  </SelectInput>
                </Field>
                <Field label="Reason" htmlFor="override-reason" optional>
                  <TextInput
                    id="override-reason"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    maxLength={FIELD_LIMITS.operatingOverrideReason}
                    placeholder="e.g. Typhoon, Fiesta"
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={addingOverride}>
                  {addingOverride ? "Adding…" : "Add"}
                </Button>
              </div>
              {overrideError ? (
                <div className="mt-3">
                  <FormError>{overrideError}</FormError>
                </div>
              ) : null}
            </Card>

            {overrides.length === 0 ? (
              <EmptyState compact title="No date overrides yet" icon="📅">
                Holidays and special openings you add will show up here, soonest first.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-paper-200">
                {overrides.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-900">
                        {o.date}{" "}
                        <span
                          className={`ml-1 text-xs font-semibold ${
                            o.type === "CLOSED" ? "text-tone-danger" : "text-tone-brand"
                          }`}
                        >
                          {o.type === "CLOSED" ? "Closed" : "Open"}
                        </span>
                      </p>
                      {o.reason ? <p className="mt-0.5 text-xs text-ink-500">{o.reason}</p> : null}
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove override for ${o.date}`}
                      onClick={() => handleDeleteOverride(o)}
                      className="tap-inline shrink-0 rounded-lg px-2 py-1 text-ink-400 transition hover:bg-tint-danger hover:text-tone-danger"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={() => navigate(`/business-profiles/${profile.id}/edit`)}>
              Back to business profile
            </Button>
          </div>
        </div>
      )}
    </FormPage>
  );
}
