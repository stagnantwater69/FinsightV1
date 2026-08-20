import { useCallback, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Callout, Card, CategorySelect, Checkbox, ConfirmSheet, ErrorNote, Field, Screen, T } from "../components/ui";
import { DateField } from "../components/DateField";
import { useBusinessProfiles } from "../context/BusinessProfileContext";
import { api, errorMessage } from "../lib/api";
import { FIELD_LIMITS } from "../lib/fieldLimits";
import { setFlash } from "../lib/flash";
import * as haptics from "../lib/haptics";
import { dueDateISO, intervalDaysError } from "../lib/recurringAgenda";
import { brand, space } from "../theme/tokens";
import type { RecurringSchedule } from "../lib/types";

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
export function RecurringScheduleScreen({ navigation, route }: any) {
  const { selected, categories } = useBusinessProfiles();
  const scheduleId: number | undefined = route?.params?.scheduleId;
  const editing = typeof scheduleId === "number";

  const [label, setLabel] = useState("");
  const [vendor, setVendor] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [intervalDays, setIntervalDays] = useState("30");
  const [expectedAmount, setExpectedAmount] = useState("");
  const [nextDueDate, setNextDueDate] = useState("");
  const [isActive, setIsActive] = useState(true);

  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      if (!editing || !selected) return;
      let cancelled = false;
      (async () => {
        setLoading(true);
        try {
          const rows = await api.get<RecurringSchedule[]>("/insights/recurring-schedules", {
            businessProfileId: selected.id,
          });
          if (cancelled) return;
          const row = rows.find((r) => r.id === scheduleId);
          if (!row) {
            setError("This repeating payment is no longer on file.");
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
        } catch (err) {
          if (!cancelled) setError(errorMessage(err));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [editing, scheduleId, selected?.id]),
  );

  if (!selected) return null;

  async function submit() {
    const amount = Number(expectedAmount);
    const interval = Number(intervalDays);

    if (!label.trim()) return setError("Give this payment a name, so you recognise it on the list.");
    if (!categoryId) return setError("Choose the category this payment belongs to.");
    const intervalProblem = intervalDaysError(interval);
    if (intervalProblem) return setError(intervalProblem);
    if (!Number.isFinite(amount) || amount <= 0) return setError("Enter an amount greater than zero.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) return setError("Choose the date this is next due.");

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
        await api.patch(`/insights/recurring-schedules/${scheduleId}`, body);
      } else {
        await api.post("/insights/recurring-schedules", {
          ...body,
          businessProfileId: selected!.id,
          // POST's schema takes vendor as optional-absent, not nullable.
          vendor: body.vendor ?? undefined,
        });
      }
      haptics.succeeded();
      setFlash(editing ? "Repeating payment updated." : "FinSight is now watching this payment.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await api.delete(`/insights/recurring-schedules/${scheduleId}`);
      haptics.succeeded();
      setFlash("Repeating payment removed.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {/*
        The amount and the date sit low on the card and the keyboard is tall,
        so without this it opens straight over the field being typed into. Same
        shell every other form in the app uses.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          {loading ? (
            <ActivityIndicator color={brand[600]} style={{ marginTop: space.xl }} />
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
                  value={label}
                  maxLength={FIELD_LIMITS.recurringScheduleLabel}
                  onChangeText={setLabel}
                  placeholder="e.g. Shop rent"
                  returnKeyType="next"
                  submitBehavior="submit"
                />
                <Field
                  label="Paid to (optional)"
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
                  />
                </View>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmSheet
        visible={confirmDelete}
        title="Remove this repeating payment?"
        body="FinSight will stop watching for it. Your recorded expenses are not affected."
        confirmLabel="Remove"
        cancelLabel="Keep it"
        confirmVariant="danger"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </Screen>
  );
}
