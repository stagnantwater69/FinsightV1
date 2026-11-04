import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowLeft, X } from "lucide-react";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api } from "../lib/api";
import { apiPage } from "../lib/apiPage";
import { getErrorMessage } from "../lib/errors";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Button, ButtonLink } from "../components/Button";
import { Field, FormError, SelectInput, TextInput } from "../components/Field";
import { Callout, PageHead, Panel, Pill } from "../components/ui";
import { EmptyState } from "../components/EmptyState";
import { SkeletonPanel } from "../components/Skeleton";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { formatCalendarDate, todayIso, toLocalIsoDate } from "../lib/dates";
import type {
  OperatingDayOverride,
  OperatingDayOverrideInput,
  OperatingDayOverrideType,
  OperatingScheduleEntry,
  OperatingDayOverridePage,
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
  return { from: toLocalIsoDate(from), to: toLocalIsoDate(to) };
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
  const [range, setRange] = useState(defaultOverrideRange);
  const [visibleRange, setVisibleRange] = useState(defaultOverrideRange);
  const [overrideCursor, setOverrideCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const overrideControllerRef = useRef<AbortController | null>(null);
  const overrideSeenCursorsRef = useRef(new Set<string>());
  const failedOverrideRequestRef = useRef<{ profileId: number; cursor: string | null; range: { from: string; to: string } } | null>(null);

  async function load() {
    if (!profile) return;
    setLoading(true);
    setLoadError(null);
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    try {
      const [scheduleRes, overridesRes] = await Promise.all([
        api.get<OperatingScheduleEntry[]>(`/business-profiles/${profileId}/operating-schedule`, { signal: controller.signal }),
        api.get<OperatingDayOverridePage | OperatingDayOverride[]>(`/business-profiles/${profileId}/operating-overrides`, {
          params: { ...range, pageSize: 50 }, signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      // Empty means "never configured" — pre-check all-open rather than
      // leaving the toggles blank, per plan §11: a sensible starting point
      // the owner confirms by saving, not a value silently submitted for them.
      setEntries(scheduleRes.data.length === 7 ? scheduleRes.data : allOpenSchedule());
      const page = apiPage(overridesRes.data);
      overrideSeenCursorsRef.current.clear();
      if (page.nextCursor !== null) overrideSeenCursorsRef.current.add(page.nextCursor);
      failedOverrideRequestRef.current = null;
      setOverrides([...page.items].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id));
      setOverrideCursor(page.nextCursor);
      setVisibleRange(range);
      setHistoryError(null);
    } catch (err) {
      if (!controller.signal.aborted) setLoadError(getErrorMessage(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => { loadControllerRef.current?.abort(); overrideControllerRef.current?.abort(); };
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

  async function loadOverridePage(cursor: string | null = null, requestedRange = visibleRange) {
    if (!requestedRange.from || !requestedRange.to || requestedRange.from > requestedRange.to) {
      failedOverrideRequestRef.current = null;
      setHistoryError("Choose a start date on or before the end date.");
      return;
    }
    overrideControllerRef.current?.abort();
    const controller = new AbortController();
    overrideControllerRef.current = controller;
    const request = { profileId, cursor, range: { ...requestedRange } };
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const { data } = await api.get<OperatingDayOverridePage | OperatingDayOverride[]>(`/business-profiles/${profileId}/operating-overrides`, {
        params: { ...request.range, pageSize: 50, ...(cursor ? { cursor } : {}) }, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const page = apiPage(data);
      if (cursor !== null && page.nextCursor !== null && (page.nextCursor === cursor || overrideSeenCursorsRef.current.has(page.nextCursor))) {
        throw new Error("FinSight couldn't load more dates because the next page repeated. Your loaded dates are kept; try again.");
      }
      if (cursor === null) overrideSeenCursorsRef.current.clear();
      if (page.nextCursor !== null) overrideSeenCursorsRef.current.add(page.nextCursor);
      failedOverrideRequestRef.current = null;
      setOverrides((current) => (cursor ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))] : [...page.items]).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id));
      setOverrideCursor(page.nextCursor);
      setVisibleRange(request.range);
    } catch (err) {
      if (!controller.signal.aborted) {
        failedOverrideRequestRef.current = request;
        setHistoryError(getErrorMessage(err));
      }
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }

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
      if (data.date >= visibleRange.from && data.date <= visibleRange.to) setOverrides((prev) => [...prev.filter((item) => item.id !== data.id), data].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id));
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

  const openDays = entries.filter((e) => e.isOpen).length;

  return (
    <div>
      <PageHead
        eyebrow={profile.name}
        title="Operating schedule"
        subtitle="Set which days this business is normally open, plus any one-off holidays or special openings. FinSight uses this to calculate exact operating days instead of an estimate."
        actions={
          <ButtonLink to={`/business-profiles/${profile.id}/edit`} variant="secondary" size="sm">
            <ArrowLeft size={16} aria-hidden />
            Business profile
          </ButtonLink>
        }
      />
      {loading ? (
        <div className="space-y-4">
          <SkeletonPanel lines={3} />
          <SkeletonPanel lines={6} />
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
        // Stacked, each panel full width: side by side, the short weekly
        // panel left a tall empty gap beside the long holidays panel.
        <div className="space-y-4">
          <Panel
            title="Weekly schedule"
            eyebrow="Recurring"
          >
            <form onSubmit={handleSaveSchedule} className="space-y-4">
              <p className="text-sm text-ink-500">Select a day to switch it between open and closed.</p>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7 sm:gap-3">
                {WEEKDAYS.map((w) => {
                  const entry = entries.find((e) => e.weekday === w.weekday);
                  const isOpen = entry?.isOpen ?? true;
                  return (
                    <button
                      key={w.weekday}
                      type="button"
                      aria-pressed={isOpen}
                      onClick={() => toggleDay(w.weekday)}
                      // flex-col over `.tap`'s inline-flex row: stacked, the
                      // day and its state no longer run together as "MonOpen".
                      className={`tap flex-col rounded-xl border px-2 py-2.5 text-sm font-semibold sm:py-3.5 transition motion-safe:active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                        isOpen
                          ? "border-edge-brand bg-tint-brand text-tone-brand"
                          : "border-paper-200 bg-paper-100 text-ink-600 hover:text-ink-700"
                      }`}
                    >
                      <span>{w.short}</span>
                      <span className="mt-0.5 text-[11px] font-normal">
                        {isOpen ? "Open" : "Closed"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {scheduleError ? <FormError>{scheduleError}</FormError> : null}
              {scheduleSaved ? <Callout tone="brand">Operating schedule saved.</Callout> : null}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-paper-200 pt-4">
                <p className="text-sm text-ink-500">
                  <span className="font-semibold text-ink-900">{openDays}</span> open {openDays === 1 ? "day" : "days"} a week
                </p>
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

            <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
              {/* A tinted well rather than a nested Card: it groups the add
                  form without drawing a second card inside this one. */}
              <form onSubmit={handleAddOverride} className="rounded-xl border border-paper-200 bg-paper-50 p-4 sm:p-5">
                <h3 className="mb-3 text-sm font-semibold text-ink-900">Add a date</h3>
                <div className="grid gap-3 sm:grid-cols-2">
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
                  <div className="sm:col-span-2">
                    <Field label="Reason" htmlFor="override-reason" optional>
                      <TextInput
                        id="override-reason"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        maxLength={FIELD_LIMITS.operatingOverrideReason}
                        placeholder="e.g. Typhoon, Fiesta"
                      />
                    </Field>
                  </div>
                  <Button type="submit" variant="brand" disabled={addingOverride} className="sm:col-span-2">
                    {addingOverride ? "Adding…" : "Add"}
                  </Button>
                </div>
                {overrideError ? (
                  <div className="mt-3">
                    <FormError>{overrideError}</FormError>
                  </div>
                ) : null}
              </form>

              <div className="min-w-0">
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-ink-900">Saved dates</h3>
                  <p className="mt-0.5 text-xs text-ink-500">Showing {formatCalendarDate(visibleRange.from)} through {formatCalendarDate(visibleRange.to)}.</p>
                  <form className="mt-3 grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); void loadOverridePage(null, range); }}>
                    <Field label="From" htmlFor="override-range-from"><TextInput id="override-range-from" type="date" required value={range.from} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /></Field>
                    <Field label="To" htmlFor="override-range-to"><TextInput id="override-range-to" type="date" required value={range.to} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></Field>
                    <Button type="submit" variant="secondary" disabled={loadingOlder} className="col-span-2 sm:col-span-1">Show dates</Button>
                  </form>
                </div>
                {historyError ? <div className="mb-3"><p role="alert" className="text-sm text-tone-danger">{historyError}</p><Button type="button" variant="secondary" onClick={() => {
                  const failed = failedOverrideRequestRef.current;
                  if (failed?.profileId === profileId) void loadOverridePage(failed.cursor, failed.range);
                  else void loadOverridePage(null, range);
                }}>Retry dates</Button></div> : null}

                {overrides.length === 0 && !historyError && !loadingOlder ? (
                  <EmptyState compact title="No date overrides in this range" icon="📅">
                    Choose other dates to see earlier holidays and special openings.
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-paper-200">
                    {overrides.map((o) => (
                      <li key={o.id} className="flex animate-fade-up items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                            <time dateTime={o.date}>{formatCalendarDate(o.date)}</time>
                            <Pill tone={o.type === "CLOSED" ? "danger" : "ok"}>
                              {o.type === "CLOSED" ? "Closed" : "Open"}
                            </Pill>
                          </p>
                          {o.reason ? <p className="mt-1 text-xs text-ink-500">{o.reason}</p> : null}
                        </div>
                        <button
                          type="button"
                          aria-label={`Remove override for ${o.date}`}
                          onClick={() => handleDeleteOverride(o)}
                          className="tap shrink-0 rounded-lg text-ink-500 transition hover:bg-tint-danger hover:text-tone-danger"
                        >
                          <X size={18} aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {overrideCursor ? <Button type="button" variant="secondary" className="mt-3" disabled={loadingOlder} onClick={() => void loadOverridePage(overrideCursor)}>{loadingOlder ? "Loading dates…" : "More dates"}</Button> : null}
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
