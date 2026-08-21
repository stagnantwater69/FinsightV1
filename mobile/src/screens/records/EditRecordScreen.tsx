import { useCallback, useRef, useState } from "react";
import { Alert as RNAlert, KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Button, Card, ErrorNote, Field, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import { DateField } from "../../components/DateField";
import * as haptics from "../../lib/haptics";
import { RecordOriginPanel, type RecordOrigin } from "../../components/RecordOrigin";
import {
  buildExpenseUpdatePayload,
  buildSalesUpdatePayload,
  recordUpdatePath,
} from "../../lib/recordUpdate";
import { space } from "../../theme/tokens";
import { RECORD_SOURCE_LABELS, type RecordItem, type RecordSource } from "../../lib/types";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { setFlash } from "../../lib/flash";
import { badges, CategoryPicker } from "./shared";

export function EditRecordScreen({ route, navigation }: any) {
  const { selected, categories, refreshCategories } = useBusinessProfiles();
  const record: RecordItem = route.params.record;
  const isExpense = record.type === "expense";
  // The same test the list applies before it offers the swipe, so a record
  // that can be resolved by gesture can be resolved by tap and vice versa.
  const needsResolving = record.reviewStatus === "Needs Review" || record.duplicateStatus === "Flagged";

  const [categoryId, setCategoryId] = useState<number | null>(record.categoryId ?? null);
  const [date, setDate] = useState(record.date.slice(0, 10));
  const [description, setDescription] = useState(record.description);
  const [vendor, setVendor] = useState(record.vendor ?? "");
  const [amount, setAmount] = useState(String(record.amount));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Vendor only exists on an expense — a sales record has no such field
   * server-side, so it is not rendered at all. The chain therefore has to be
   * decided at hand-off time rather than written down once: on an expense
   * Description goes to Vendor, on a sales record it goes straight to Amount.
   * A chain hard-wired to `vendorRef` would simply dead-end on half the
   * records this screen opens, with the return key doing nothing.
   */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);
  const afterDescription = () => (isExpense ? vendorRef : amountRef).current?.focus();

  /**
   * Where this record came from.
   *
   * Only the single-record endpoint carries it, so it is fetched here rather
   * than travelling in the route params with the rest of the record. A
   * failure is silent: the panel is context, and losing it should degrade the
   * screen rather than block editing.
   */
  const [origin, setOrigin] = useState<RecordOrigin | null>(null);
  const [loadingOrigin, setLoadingOrigin] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const detail = await api.get<{ origin: RecordOrigin | null }>(
            recordUpdatePath(record.type, record.id),
          );
          if (!cancelled) setOrigin(detail.origin ?? null);
        } catch {
          // Context only — a record with no visible provenance is still fully
          // editable, which is what this screen is for.
        } finally {
          if (!cancelled) setLoadingOrigin(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [record.type, record.id]),
  );

  if (!selected) return null;

  async function save() {
    const value = Number(amount);
    if (!description.trim()) return setError("Give this record a description.");
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (isExpense && !categoryId) return setError("Choose a category first.");

    setError(null);
    setBusy(true);
    try {
      const input = { date, description, amount: value, categoryId, vendor };
      await api.patch(
        recordUpdatePath(record.type, record.id),
        // Expense and sales take DIFFERENT fields — a sales record has no
        // category and no vendor server-side. Built in lib/recordUpdate so
        // that distinction is tested rather than remembered.
        isExpense ? buildExpenseUpdatePayload(input) : buildSalesUpdatePayload(input),
      );
      haptics.succeeded();
      setFlash("Record updated.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Clearing a flag without the swipe.
   *
   * On the list this is a left-swipe, which is a gesture some owners cannot
   * make at all — with a screen reader driving the phone there is nothing to
   * swipe. The review queue offers the same action, but only for the records
   * `/records/flagged` hands back; this screen opens for every record, which
   * makes it the one place the alternative works for all of them. The gesture
   * stays exactly as it was: this is a second route to the action, not a
   * replacement for the first.
   */
  async function resolve() {
    setError(null);
    setBusy(true);
    try {
      // The identical patch the swipe action and the review queue both send.
      await api.patch(recordUpdatePath(record.type, record.id), {
        duplicateStatus: "Not a Duplicate",
        reviewStatus: "Reviewed",
      });
      haptics.succeeded();
      // Word for word what the list says when the swipe does this, so the app
      // does not describe one action two ways.
      setFlash("Marked reviewed and not a duplicate.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
      // Only on failure: the success path has already left this screen.
      setBusy(false);
    }
  }

  /**
   * Deleting asks first, through the platform's own dialog.
   *
   * Web offers an undo toast instead; mobile has no toast system yet, so the
   * confirmation comes BEFORE the deletion rather than the reprieve after it.
   * Either way the owner gets one chance to stop — what must not happen is a
   * tap that destroys a record with neither.
   */
  function confirmDelete() {
    RNAlert.alert(
      "Delete this record?",
      `"${record.description}" will be removed. This cannot be undone.`,
      [
        { text: "Keep it", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            setError(null);
            try {
              await api.delete(recordUpdatePath(record.type, record.id));
              haptics.committed();
              // A deletion leaves the screen the same way a save does, and the
              // record it removed is gone from the list behind it — so without
              // a line here the only evidence is an absence.
              setFlash("Record deleted.");
              navigation.goBack();
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}>
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>
              {isExpense ? "Edit expense" : "Edit sales"}
            </T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              {RECORD_SOURCE_LABELS[record.source as RecordSource] ?? record.source} ·{" "}
              {record.date.slice(0, 10)}
            </T>

            {badges(record)}

            {/*
              The evidence behind this record — the lines read off the receipt,
              or the file it was imported from. Fetched rather than passed in
              route params, because the list endpoint does not carry it.
            */}
            {origin ? (
              <View style={{ marginTop: space.md }}>
                <RecordOriginPanel origin={origin} recordAmount={record.amount} />
              </View>
            ) : loadingOrigin ? (
              <View style={{ marginTop: space.md }}>
                <T variant="caption">Loading where this came from…</T>
              </View>
            ) : null}

            <View style={{ marginTop: space.md }}>
              {isExpense ? (
                <CategoryPicker
                  categories={categories}
                  value={categoryId}
                  onChange={setCategoryId}
                  onCreated={refreshCategories}
                />
              ) : null}
              <DateField label="Date" value={date} onChange={setDate} />
              <Field
                label="Description"
                value={description}
                maxLength={FIELD_LIMITS.recordDescription}
                onChangeText={setDescription}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={afterDescription}
              />
              {isExpense ? (
                <Field
                  ref={vendorRef}
                  label="Vendor"
                  value={vendor}
                  maxLength={FIELD_LIMITS.vendor}
                  onChangeText={setVendor}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => amountRef.current?.focus()}
                />
              ) : null}
              {/* Decimal keypad: the return key exists on Android only. */}
              <Field
                ref={amountRef}
                label="Amount (PHP)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (!busy) save();
                }}
              />
            </View>

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <Button title="Save changes" variant="primary" onPress={save} loading={busy} style={{ marginTop: space.md }} />
            {/*
              Offered only when there is something to clear — the badges above
              are what it answers, and with none of them showing the button
              would be a control for a state the record is not in.
            */}
            {needsResolving ? (
              <Button title="Looks right — mark reviewed" variant="ghost" onPress={resolve} disabled={busy} />
            ) : null}
            <Button title="Delete record" variant="ghost" onPress={confirmDelete} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
