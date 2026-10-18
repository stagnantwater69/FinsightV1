import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Alert, TextInput } from "react-native";
import { Button, Card, ErrorNote, Field, ScreenHeader, T } from "../../components/ui";
import { FormScreen } from "../../components/FormScreen";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../lib/api";
import { saveFailureMessage } from "../../lib/connectionState";
import { setFlash } from "../../lib/flash";
import { DateField } from "../../components/DateField";
import * as haptics from "../../lib/haptics";
import { space } from "../../theme/tokens";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { businessToday } from "../../lib/businessDate";
import { AvailableFundsBaselineChoice, useAvailableFundsBaselineChoice } from "../../components/AvailableFundsBaselineChoice";
import { useImportOperation } from "../../lib/useImportOperation";
import { useManualRecordRecovery } from "../../lib/useManualRecordRecovery";
import { isDefiniteManualRecordRejection, verifiedManualRecordResult, type ManualRecordIntent } from "../../lib/manualRecordRecovery";
import { ManualRecordRecoveryNotice } from "../../components/ManualRecordRecoveryNotice";
import type { RecordsScreenProps } from "../../navigation/types";

export function AddSalesScreen({ navigation }: RecordsScreenProps<"AddSales">) {
  const { selected } = useBusinessProfiles();
  const { profile: owner } = useAuth();
  const [date, setDate] = useState(() => businessToday(selected?.timezone));
  const baselineChoice = useAvailableFundsBaselineChoice(date);
  const clearBaselineDecision = baselineChoice.setDecision;
  const [description, setDescription] = useState("Daily sales");
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
  const recovery = useManualRecordRecovery(owner?.id, selected?.id, "sales", (draft) => {
    setDate(draft.date); setDescription(draft.description); setAmount(draft.amount);
  }, { date, description, amount });
  frozen.current = busy || recovery.frozen;
  useEffect(() => {
    retryPrompt.current = null;
    setDate(businessToday(businessTimezone.current));
    setDescription("Daily sales");
    setAmount("");
    setError(null);
    setBusy(false);
    clearBaselineDecision(null);
    return () => { retryPrompt.current = null; };
  }, [owner?.id, selected?.id, clearBaselineDecision]);
  useFocusEffect(useCallback(() => () => { if (flight.current) flight.current.unknown = true; operation.cancel(); setBusy(false); }, [operation]));
  // The date field is a pressable, so the chain is Description → Amount.
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
        if (await recovery.confirm(pending, recovery.confirmedRecordId) && operation.current(task)) { setFlash("Sales record saved."); navigation.goBack(); }
      } finally { if (operation.current(task)) setBusy(false); operation.finish(task); }
      return;
    }
    if (pending && !retryApproval) {
      if (retryPrompt.current) return;
      retryPrompt.current = pending.key;
      Alert.alert("Check records before saving again", "The previous request may have saved this sales record. Retrying checks the same saved request and keeps its original details.", [
        { text: "Cancel", style: "cancel", onPress: () => { retryPrompt.current = null; } },
        { text: "Check records", onPress: () => { retryPrompt.current = null; if (recovery.current(pending)) navigation.push("RecordsList"); } },
        { text: "Retry previous save", onPress: () => { retryPrompt.current = null; if (recovery.current(pending)) void submit(pending); } },
      ], { cancelable: true, onDismiss: () => { if (retryPrompt.current === pending.key) retryPrompt.current = null; } });
      return;
    }
    const value = Number(amount);
    if (!retryApproval) {
      if (!description.trim()) return setError("Give this sales record a description.");
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
        date,
        description: description.trim(),
        amount: value,
        ...baselineChoice.requestFields(),
      }, { date, description, amount });
      if (!operation.current(task) || !recovery.current(intent)) return;
      attempt = { intent, unknown: false };
      flight.current = attempt;
      const result = await api.post("/records/sales", { ...intent.payload, idempotencyKey: intent.key }, { signal: task.controller.signal });
      const recordId = verifiedManualRecordResult(result, intent.scope);
      if (!operation.current(task) || !recovery.current(intent)) return;
      if (!await recovery.confirm(intent, recordId) || !operation.current(task)) return;
      haptics.succeeded();
      setFlash("Sales record saved.");
      navigation.goBack();
    } catch (err) {
      if (intent && !retryApproval && !attempt?.unknown && isDefiniteManualRecordRejection(err)) {
        try { await recovery.clear(intent); }
        catch { if (operation.current(task)) setError("The request was rejected, but its saved recovery could not be cleared. Check your records before starting another save."); return; }
      }
      // See the same catch in AddExpenseScreen: the typed figures survive, and
      // the wording says that without implying a later sync.
      if (operation.current(task) && (retryApproval || !(await baselineChoice.absorb(err))) && operation.current(task)) {
        setError(saveFailureMessage(err, "Save sales record"));
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
        eyebrow="Money in"
        title="Add sales reference"
        subtitle="Log a sales total so FinSight can measure recovery progress."
      />
      <Card>
        <ManualRecordRecoveryNotice recovery={recovery} busy={busy} onRetry={() => void submit()} onCheckRecords={() => navigation.push("RecordsList")} onResolve={resolvePrevious} />
        <T variant="caption" style={{ marginBottom: space.md }}>
          A sales figure you record for monitoring — not a receipt for a customer.
        </T>
        <DateField label="Date" value={date} today={businessToday(selected?.timezone)} onChange={(value) => { if (!frozen.current && currentFormScope.current === formScope) setDate(value); }} disabled={busy || recovery.frozen} />
        {!recovery.intent ? <AvailableFundsBaselineChoice choice={baselineChoice} disabled={busy || recovery.frozen} /> : null}
        <Field
          label="Description"
          editable={!busy && !recovery.frozen}
          value={description}
          maxLength={FIELD_LIMITS.recordDescription}
          onChangeText={(value) => { if (!frozen.current && currentFormScope.current === formScope) setDescription(value); }}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => amountRef.current?.focus()}
        />
        {/* Decimal keypad: the return key exists on Android only. */}
        <Field
          ref={amountRef}
          label="Amount (PHP)"
          editable={!busy && !recovery.frozen}
          value={amount}
          onChangeText={(value) => { if (!frozen.current && currentFormScope.current === formScope) setAmount(value); }}
          keyboardType="decimal-pad"
          returnKeyType="done"
          onSubmitEditing={() => {
            if (!busy) submit();
          }}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button title="Save sales record" variant="primary" onPress={() => void submit()} loading={busy} disabled={recovery.frozen} style={{ marginTop: space.md }} />
      </Card>
    </FormScreen>
  );
}
