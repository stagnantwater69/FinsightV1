import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, TextInput } from "react-native";
import { Button, Card, ErrorNote, Field, ScreenHeader } from "../../components/ui";
import { FormScreen } from "../../components/FormScreen";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../lib/api";
import { saveFailureMessage } from "../../lib/connectionState";
import { setFlash } from "../../lib/flash";
import { DateField } from "../../components/DateField";
import { CategorySuggestionAction } from "../../components/CategorySuggestionAction";
import { useImportOperation } from "../../lib/useImportOperation";
import * as haptics from "../../lib/haptics";
import { space } from "../../theme/tokens";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { CategoryPicker } from "./shared";
import { businessToday } from "../../lib/businessDate";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../../components/AvailableFundsBaselineChoice";
import { useManualRecordRecovery } from "../../lib/useManualRecordRecovery";
import { isDefiniteManualRecordRejection, verifiedManualRecordResult, type ManualRecordIntent } from "../../lib/manualRecordRecovery";
import { ManualRecordRecoveryNotice } from "../../components/ManualRecordRecoveryNotice";

export function AddExpenseScreen({ navigation }: any) {
  const { selected, categories, refreshCategories } = useBusinessProfiles();
  const { profile: owner } = useAuth();
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [date, setDate] = useState(() => businessToday(selected?.timezone));
  const baselineChoice = useAvailableFundsBaselineChoice(date);
  const clearBaselineDecision = baselineChoice.setDecision;
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useImportOperation(selected?.id);
  const retryPrompt = useRef<string | null>(null);
  const flight = useRef<{ intent: ManualRecordIntent; unknown: boolean } | null>(null);
  const formScope = `${owner?.id}:${selected?.id}`;
  const currentFormScope = useRef(formScope);
  currentFormScope.current = formScope;
  const businessTimezone = useRef(selected?.timezone);
  businessTimezone.current = selected?.timezone;
  const frozen = useRef(true);
  const recovery = useManualRecordRecovery(owner?.id, selected?.id, "expense", (draft) => {
    setCategoryId(draft.categoryId ?? null); setDate(draft.date); setDescription(draft.description); setVendor(draft.vendor ?? ""); setAmount(draft.amount);
  }, { date, description, vendor, amount, categoryId });
  frozen.current = busy || recovery.frozen;
  useEffect(() => {
    retryPrompt.current = null;
    setCategoryId(null);
    setDate(businessToday(businessTimezone.current));
    setDescription("");
    setVendor("");
    setAmount("");
    setError(null);
    setBusy(false);
    clearBaselineDecision(null);
    return () => { retryPrompt.current = null; };
  }, [owner?.id, selected?.id, clearBaselineDecision]);
  useFocusEffect(useCallback(() => () => { if (flight.current) flight.current.unknown = true; operation.cancel(); setBusy(false); }, [operation]));
  /*
   * The category picker and the date field are pressables, not text inputs —
   * they cannot carry a return key at all. So the keyboard chain starts at the
   * first field that actually has one and runs to the end of the form.
   */
  const vendorRef = useRef<TextInput>(null);
  const amountRef = useRef<TextInput>(null);

  if (!selected) return null;

  async function submit(retryApproval?: ManualRecordIntent) {
    if (currentFormScope.current !== formScope) return;
    const pending = recovery.intent;
    if (recovery.loading || (recovery.error && recovery.confirmedRecordId === null)) return;
    if (retryApproval && (pending?.key !== retryApproval.key || !recovery.current(retryApproval))) return;
    if (pending && recovery.confirmedRecordId !== null) {
      const task = operation.begin();
      if (!task) return;
      setBusy(true);
      try {
        if (await recovery.confirm(pending, recovery.confirmedRecordId) && operation.current(task)) { setFlash("Expense saved."); navigation.goBack(); }
      } finally { if (operation.current(task)) setBusy(false); operation.finish(task); }
      return;
    }
    if (pending && !retryApproval) {
      if (retryPrompt.current) return;
      retryPrompt.current = pending.key;
      Alert.alert("Check records before saving again", "The previous request may have saved this expense. Retrying checks the same saved request and keeps its original details.", [
        { text: "Cancel", style: "cancel", onPress: () => { retryPrompt.current = null; } },
        { text: "Check records", onPress: () => { retryPrompt.current = null; if (recovery.current(pending)) navigation.push("RecordsList"); } },
        { text: "Retry previous save", onPress: () => { retryPrompt.current = null; if (recovery.current(pending)) void submit(pending); } },
      ], { cancelable: true, onDismiss: () => { if (retryPrompt.current === pending.key) retryPrompt.current = null; } });
      return;
    }
    const value = Number(amount);
    if (!retryApproval) {
      if (!categoryId) return setError("Choose a category first.");
      if (!description.trim()) return setError("Give this expense a description.");
      if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
      if (!baselineChoice.check()) return;
    }
    const task = operation.begin();
    if (!task) return;
    frozen.current = true;
    let intent = retryApproval;
    let attempt: { intent: ManualRecordIntent; unknown: boolean } | null = null;
    setError(null);
    setBusy(true);
    try {
      intent = retryApproval ? await recovery.retry(retryApproval) : await recovery.prepare({
        businessProfileId: selected!.id,
        categoryId: categoryId!,
        date,
        description: description.trim(),
        vendor: vendor.trim() || undefined,
        amount: value,
        ...baselineChoice.requestFields(),
      }, { date, description, vendor, amount, categoryId });
      if (!operation.current(task) || !recovery.current(intent)) return;
      attempt = { intent, unknown: false };
      flight.current = attempt;
      const result = await api.post("/records/expenses", { ...intent.payload, idempotencyKey: intent.key }, { signal: task.controller.signal });
      const recordId = verifiedManualRecordResult(result, intent.scope);
      if (!operation.current(task) || !recovery.current(intent)) return;
      if (!await recovery.confirm(intent, recordId) || !operation.current(task)) return;
      haptics.succeeded();
      // The haptic is silent for anyone who has haptics off; the flash is what
      // the owner actually sees once the list comes back.
      setFlash("Expense saved.");
      navigation.goBack();
    } catch (err) {
      if (intent && !retryApproval && !attempt?.unknown && isDefiniteManualRecordRejection(err)) {
        try { await recovery.clear(intent); }
        catch { if (operation.current(task)) setError("The request was rejected, but its saved recovery could not be cleared. Check your records before starting another save."); return; }
      }
      // The form keeps every field — nothing here is cleared on a failure and
      // the screen only navigates away on success — so the message is allowed
      // to say so. It stops short of promising a background retry, because
      // there is no queue behind it. See lib/connectionState.ts.
      if (operation.current(task) && (retryApproval || !(await baselineChoice.absorb(err))) && operation.current(task)) {
        setError(saveFailureMessage(err, "Save expense"));
      }
    } finally {
      if (operation.current(task)) setBusy(false);
      operation.finish(task);
      if (flight.current === attempt) flight.current = null;
    }
  }

  function resolvePrevious() {
    const expectedKey = recovery.error && recovery.confirmedRecordId === null ? null : recovery.intent?.key ?? null;
    Alert.alert("Start a new record?", "The previous save may have completed. Check your records first. Clearing its recovery lets you edit these details and create a separate record.", [
      { text: "Keep previous request", style: "cancel" },
      { text: "I checked; start new", onPress: async () => {
        if (currentFormScope.current !== formScope) return;
        const task = operation.begin(); if (!task) return;
        setBusy(true);
        try { await recovery.discard(expectedKey); if (operation.current(task)) setError(null); }
        catch { if (operation.current(task)) setError("The previous request could not be cleared. Check your records and try clearing it again."); }
        finally { if (operation.current(task)) setBusy(false); operation.finish(task); }
      } },
    ]);
  }

  return (
    <FormScreen>
      <ScreenHeader
        eyebrow="Money out"
        title="Add expense"
        subtitle="Record what the business paid and where it belongs."
      />
      <Card>
        <ManualRecordRecoveryNotice recovery={recovery} busy={busy} onRetry={() => void submit()} onCheckRecords={() => navigation.push("RecordsList")} onResolve={resolvePrevious} />
        <CategoryPicker
          disabled={busy || recovery.frozen}
          categories={categories}
          value={categoryId}
          onChange={(value) => { if (!frozen.current && currentFormScope.current === formScope) setCategoryId(value); }}
          onCreated={refreshCategories}
        />
        {!busy && !recovery.frozen ? <CategorySuggestionAction businessId={selected.id} description={description} vendor={vendor} categories={categories} value={categoryId} onApply={(value) => { if (!frozen.current && currentFormScope.current === formScope) setCategoryId(value); }} /> : null}
        <DateField label="Date" value={date} today={businessToday(selected?.timezone)} onChange={(value) => { if (!frozen.current && currentFormScope.current === formScope) setDate(value); }} disabled={busy || recovery.frozen} />
        {!recovery.intent ? <AvailableFundsBaselineChoice choice={baselineChoice} disabled={busy || recovery.frozen} /> : null}
        {/*
          `submitBehavior="submit"` keeps the keyboard up between fields so
          it does not flicker shut and open on every hop. It is the
          replacement for the prop React Native 0.86 deprecated; see the
          same note on the login form in AuthScreens.
        */}
        <Field
          label="Description"
          editable={!busy && !recovery.frozen}
          value={description}
          maxLength={FIELD_LIMITS.recordDescription}
          onChangeText={(value) => { if (!frozen.current && currentFormScope.current === formScope) setDescription(value); }}
          placeholder="e.g. Rice sacks"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => vendorRef.current?.focus()}
        />
        <Field
          ref={vendorRef}
          label="Vendor (optional)"
          editable={!busy && !recovery.frozen}
          value={vendor}
          maxLength={FIELD_LIMITS.vendor}
          onChangeText={(value) => { if (!frozen.current && currentFormScope.current === formScope) setVendor(value); }}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => amountRef.current?.focus()}
        />
        {/*
          A decimal keypad has no return key on iOS, so this hand-off only
          fires on Android. Wired anyway: it costs nothing where it does
          not apply, and the Save button is the reliable path on both.
        */}
        <Field
          ref={amountRef}
          label="Amount (PHP)"
          editable={!busy && !recovery.frozen}
          value={amount}
          onChangeText={(value) => { if (!frozen.current && currentFormScope.current === formScope) setAmount(value); }}
          keyboardType="decimal-pad"
          returnKeyType="done"
          // Mirrors the button's own `loading` guard, so a return key
          // pressed twice cannot post the expense twice.
          onSubmitEditing={() => {
            if (!busy) submit();
          }}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button title="Save expense" variant="primary" onPress={() => void submit()} loading={busy} disabled={recovery.frozen} style={{ marginTop: space.md }} />
      </Card>
    </FormScreen>
  );
}
