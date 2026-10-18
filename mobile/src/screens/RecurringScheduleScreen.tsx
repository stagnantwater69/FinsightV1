import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, CategorySelect, Checkbox, ConfirmSheet, ErrorNote, Field, Screen, T } from "../components/ui";
import { DateField } from "../components/DateField";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { setFlash } from "../lib/flash";
import * as haptics from "../lib/haptics";
import { dueDateISO, intervalDaysError } from "../lib/recurringAgenda";
import { space } from "../theme/tokens";
import { useTheme } from "../context/ThemeContext";
import type { RecurringSchedule } from "../lib/types";
import { FormScreen } from "../components/FormScreen";
import type { InsightsScreenProps } from "../navigation/types";

/**
 * Declaring a repeating payment, and editing one.
 *
 * WHY THIS SCREEN EXISTS. FinSight could already infer that an expense repeats
 * and could be told "yes, watch this" — and then the confirmed thing was
 * invisible. It could not be seen, corrected, paused or removed, so a schedule
 * with the wrong amount or the wrong day was permanent. It also could not be
 * declared at all: an owner who knows rent is due on the 5th had to wait for
 * three months of records before FinSight would offer to watch it, which is
 * the whole cold-start problem in one sentence.
 *
 * ONE SCREEN FOR BOTH, keyed on a `scheduleId` route param, the same way the
 * business-profile form serves new and existing profiles. The fields are
 * identical and the difference is one PATCH versus one POST.
 *
 * WHAT IS NOT HERE: `amountTolerance`. It is how far the actual amount may
 * drift before FinSight calls it a change, expressed as a fraction, and asking
 * an owner to set it means asking them to reason about a number they have no
 * way to calibrate. The server's default covers it, and the finding it drives
 * is advisory either way.
 */
export function RecurringScheduleScreen({ navigation, route }: InsightsScreenProps<"RecurringSchedule">) {
  const t = useTheme();
  const { brand } = t;
  const { selected, categories } = useBusinessProfiles();
  const scheduleId: number | undefined = route?.params?.scheduleId;
  const editing = typeof scheduleId === "number";
  const selectedBusinessProfileId = selected?.id ?? null;
  const selectedBusinessProfileIdRef = useRef(selectedBusinessProfileId);
  selectedBusinessProfileIdRef.current = selectedBusinessProfileId;
  const scope = useRef({ businessId: selectedBusinessProfileId, scheduleId, generation: 0 });
  if (scope.current.businessId !== selectedBusinessProfileId || scope.current.scheduleId !== scheduleId) {
    scope.current = { businessId: selectedBusinessProfileId, scheduleId, generation: scope.current.generation + 1 };
  }
  const mutation = useRef<object | null>(null);

  const [label, setLabel] = useState("");
  const [vendor, setVendor] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [intervalDays, setIntervalDays] = useState("30");
  const [expectedAmount, setExpectedAmount] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [loadedBusinessProfileId, setLoadedBusinessProfileId] = useState<number | null>(
    editing ? null : selectedBusinessProfileId,
  );

  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    mutation.current = null;
    setBusy(false);
    return () => { scope.current = { ...scope.current, generation: scope.current.generation + 1 }; };
  }, [scheduleId, selectedBusinessProfileId]);

  const clearDraft = useCallback(() => {
    setLabel("");
    setVendor("");
    setCategoryId(null);
    setIntervalDays("30");
    setExpectedAmount("");
    setNextDueDate("");
    setIsActive(true);
  }, []);

  useEffect(() => {
    if (editing || selectedBusinessProfileId === null) return;
    if (loadedBusinessProfileId === selectedBusinessProfileId) return;
    clearDraft();
    setLoadedBusinessProfileId(selectedBusinessProfileId);
    setError(null);
    setBusy(false);
    setConfirmDelete(false);
    setLoading(false);
  }, [clearDraft, editing, loadedBusinessProfileId, selectedBusinessProfileId]);

  useEffect(() => () => {
    selectedBusinessProfileIdRef.current = null;
  }, []);

  /*
   * The row is read back from the agenda list rather than from a
   * `GET /recurring-schedules/:id`, because no such endpoint exists — and one
   * screen filtering a list it is already entitled to is a fair use of the
   * endpoint that does, not a client-side reimplementation of anything.
   *
   * On focus rather than on mount so that returning here after any other
   * change shows what the server currently holds.
   */
  useFocusEffect(
    useCallback(() => {
      if (!editing || selectedBusinessProfileId === null) return;
      const requestBusinessProfileId = selectedBusinessProfileId;
      let cancelled = false;
      clearDraft();
      (async () => {
        setLoading(true);
        setLoadedBusinessProfileId(null);
        setError(null);
        setBusy(false);
        setConfirmDelete(false);
        try {
          const rows = await api.get<RecurringSchedule[]>("/insights/recurring-schedules", {
            businessProfileId: requestBusinessProfileId,
          });
          if (cancelled) return;
          const row = rows.find(
            (candidate) =>
              candidate.id === scheduleId &&
              candidate.businessProfileId === requestBusinessProfileId,
          );
          if (!row) {
            setError("This repeating payment is not available for the selected business.");
            return;
          }
          setLabel(row.label);
          setVendor(row.vendor ?? "");
          setCategoryId(row.categoryId);
          setIntervalDays(String(row.intervalDays));
          setExpectedAmount(String(row.expectedAmount));
          // Sliced, never re-parsed: nextDueDate is a date-only value and
          // reading it through a Date would apply the phone's own offset to a
          // value that has none. See lib/recurringAgenda.ts.
          setNextDueDate(dueDateISO(row.nextDueDate));
          setIsActive(row.isActive);
          setLoadedBusinessProfileId(row.businessProfileId);
        } catch (err) {
          if (!cancelled) setError(errorMessage(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [clearDraft, editing, scheduleId, selectedBusinessProfileId]),
  );

  if (!selected) return null;

  const formBelongsToSelectedBusiness = loadedBusinessProfileId === selected.id;

  async function submit() {
    if (mutation.current) return;
    const mutationBusinessProfileId = loadedBusinessProfileId;
    if (
      mutationBusinessProfileId === null ||
      selectedBusinessProfileIdRef.current !== mutationBusinessProfileId
    ) {
      setError("This repeating payment is not available for the selected business.");
      return;
    }
    const amount = Number(expectedAmount);
    const interval = Number(intervalDays);

    if (!label.trim()) return setError("Give this payment a name, so you recognise it on the list.");
    if (!categoryId) return setError("Choose the category this payment belongs to.");
    const intervalProblem = intervalDaysError(interval);
    if (intervalProblem) return setError(intervalProblem);
    if (!Number.isFinite(amount) || amount <= 0) return setError("Enter an amount greater than zero.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) return setError("Choose the date this is next due.");

    const request = {};
    const generation = scope.current.generation;
    mutation.current = request;
    setError(null);
    setBusy(true);
    try {
      /*
       * `vendor` is sent as null rather than omitted when cleared, because on
       * the PATCH an omitted field means "leave it alone" — omitting it would
       * make an emptied vendor box silently keep the old value.
       */
      const body = {
        label: label.trim(),
        vendor: vendor.trim() ? vendor.trim() : null,
        categoryId,
        intervalDays: interval,
        expectedAmount: amount,
        nextDueDate,
        isActive,
      };

      if (editing) {
        await api.patch(
          `/insights/recurring-schedules/${scheduleId}`,
          body,
          { cacheScope: { businessProfileId: mutationBusinessProfileId } },
        );
      } else {
        await api.post("/insights/recurring-schedules", {
          ...body,
          businessProfileId: mutationBusinessProfileId,
          // POST's schema takes vendor as optional-absent, not nullable.
          vendor: body.vendor ?? undefined,
        });
      }
      if (generation !== scope.current.generation || mutation.current !== request) return;
      haptics.succeeded();
      setFlash(editing ? "Repeating payment updated." : "FinSight is now watching this payment.");
      navigation.goBack();
    } catch (err) {
      if (generation === scope.current.generation && mutation.current === request) setError(errorMessage(err));
    } finally {
      if (mutation.current === request) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }

  async function remove() {
    if (mutation.current) return;
    const mutationBusinessProfileId = loadedBusinessProfileId;
    if (
      !editing ||
      mutationBusinessProfileId === null ||
      selectedBusinessProfileIdRef.current !== mutationBusinessProfileId
    ) {
      setError("This repeating payment is not available for the selected business.");
      return;
    }
    const request = {};
    const generation = scope.current.generation;
    mutation.current = request;
    setBusy(true);
    try {
      await api.delete(
        `/insights/recurring-schedules/${scheduleId}`,
        undefined,
        { cacheScope: { businessProfileId: mutationBusinessProfileId } },
      );
      if (generation !== scope.current.generation || mutation.current !== request) return;
      haptics.succeeded();
      setConfirmDelete(false);
      setFlash("Repeating payment removed.");
      navigation.goBack();
    } catch (err) {
      if (generation === scope.current.generation && mutation.current === request) setError(errorMessage(err));
    } finally {
      if (mutation.current === request) {
        mutation.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <Screen>
      <FormScreen>
          {loading || (!formBelongsToSelectedBusiness && !error) ? (
            <ActivityIndicator color={brand[600]} style={{ marginTop: space.xl }} />
          ) : !formBelongsToSelectedBusiness ? (
            <Card>
              <T variant="title" style={{ marginBottom: space.sm }}>Repeating payment unavailable</T>
              <ErrorNote>
                {error ?? "This repeating payment is not available for the selected business."}
              </ErrorNote>
              <Button
                title="Back to repeating payments"
                variant="primary"
                onPress={() => navigation.goBack()}
                style={{ marginTop: space.lg }}
              />
            </Card>
          ) : (
            <>
              <Card>
                <T variant="title" style={{ marginBottom: 4 }}>
                  {editing ? "Edit repeating payment" : "Add a repeating payment"}
                </T>
                <T variant="caption" style={{ marginBottom: space.md }}>
                  FinSight watches for it and tells you if the date passes with nothing recorded. It never
                  records the payment for you.
                </T>

                <Field
                  label="What is it"
                  editable={!busy}
                  value={label}
                  maxLength={FIELD_LIMITS.recurringScheduleLabel}
                  onChangeText={setLabel}
                  placeholder="e.g. Shop rent"
                  returnKeyType="next"
                  submitBehavior="submit"
                />
                <Field
                  label="Paid to (optional)"
                  editable={!busy}
                  value={vendor}
                  maxLength={FIELD_LIMITS.vendor}
                  onChangeText={setVendor}
                  placeholder="e.g. Meralco"
                  returnKeyType="next"
                  submitBehavior="submit"
                />

                <View style={{ marginBottom: space.md }}>
                  <T variant="label" style={{ marginBottom: 4 }}>Category</T>
                  <CategorySelect
                    options={categories}
                    disabled={busy}
                    value={categoryId}
                    onChange={setCategoryId}
                    accessibilityContext={label.trim() || "this repeating payment"}
                  />
                </View>

                {/* Days rather than "monthly": the server stores an interval in
                    days, and offering named cycles here would mean this screen
                    deciding what "monthly" is worth in days on its own. */}
                <Field
                  label="Repeats every (days)"
                  editable={!busy}
                  value={intervalDays}
                  onChangeText={setIntervalDays}
                  keyboardType="number-pad"
                  returnKeyType="next"
                  submitBehavior="submit"
                />
                {/* Money is a plain decimal-pad field — there is no mobile
                    MoneyInput, so the unit is carried by the label. */}
                <Field
                  label="Expected amount (PHP)"
                  editable={!busy}
                  value={expectedAmount}
                  onChangeText={setExpectedAmount}
                  keyboardType="decimal-pad"
                  returnKeyType="done"
                />
                {/*
                  `allowFuture` — the one date in this app that is meant to be
                  ahead of today. Without it the picker refuses every date this
                  field exists to hold.
                */}
                <DateField label="Next due" value={nextDueDate} onChange={setNextDueDate} allowFuture />

                <Checkbox
                  label="Watch this payment"
                  hint="Turn this off to keep the details without being told about it."
                  checked={isActive}
                  onChange={setIsActive}
                />

                {error ? <ErrorNote>{error}</ErrorNote> : null}
                <Button
                  title={editing ? "Save changes" : "Start watching"}
                  variant="primary"
                  onPress={submit}
                  loading={busy}
                  style={{ marginTop: space.md }}
                />
              </Card>

              {editing ? (
                <View style={{ marginTop: space.lg, gap: space.md }}>
                  <Callout tone="info">
                    Pausing keeps the payment on file and stops the reminders. Removing it deletes the
                    schedule only — the expenses you have already recorded are untouched.
                  </Callout>
                  <Button
                    title="Remove this payment"
                    variant="danger"
                    onPress={() => setConfirmDelete(true)}
                    disabled={busy}
                  />
                </View>
              ) : null}
            </>
          )}
      </FormScreen>

      <ConfirmSheet
        visible={confirmDelete && formBelongsToSelectedBusiness}
        title="Remove this repeating payment?"
        body="FinSight will stop watching for it. Your recorded expenses are not affected."
        confirmLabel="Remove"
        cancelLabel="Keep it"
        confirmVariant="danger"
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}
