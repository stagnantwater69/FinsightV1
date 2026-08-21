import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput } from "react-native";
import { Button, Card, ErrorNote, Field, Screen, T } from "../../components/ui";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { api, errorMessage } from "../../lib/api";
import { setFlash } from "../../lib/flash";
import { DateField } from "../../components/DateField";
import * as haptics from "../../lib/haptics";
import { space } from "../../theme/tokens";
import { FIELD_LIMITS } from "../../lib/fieldLimits";
import { todayISO } from "./shared";

export function AddSalesScreen({ navigation }: any) {
  const { selected } = useBusinessProfiles();
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("Daily sales");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The date field is a pressable, so the chain is Description → Amount.
  const amountRef = useRef<TextInput>(null);

  if (!selected) return null;

  async function submit() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setError(null);
    setBusy(true);
    try {
      await api.post("/records/sales", {
        businessProfileId: selected!.id,
        date,
        description: description.trim(),
        amount: value,
      });
      haptics.succeeded();
      setFlash("Sales record saved.");
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.lg }}>
          <Card>
            <T variant="title" style={{ marginBottom: 4 }}>Add sales reference</T>
            <T variant="caption" style={{ marginBottom: space.md }}>
              A sales figure you record for monitoring — not a receipt for a customer.
            </T>
            <DateField label="Date" value={date} onChange={setDate} />
            <Field
              label="Description"
              value={description}
              maxLength={FIELD_LIMITS.recordDescription}
              onChangeText={setDescription}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => amountRef.current?.focus()}
            />
            {/* Decimal keypad: the return key exists on Android only. */}
            <Field
              ref={amountRef}
              label="Amount (PHP)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!busy) submit();
              }}
            />
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button title="Save sales record" variant="primary" onPress={submit} loading={busy} style={{ marginTop: space.md }} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
